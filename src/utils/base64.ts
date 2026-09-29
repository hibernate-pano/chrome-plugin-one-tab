/**
 * base64 编解码原语（单源）。
 *
 * 为什么收敛到这里：src/utils/secureStorage.ts 与 src/utils/encryptionUtils.ts
 * 曾经各持一份逐字节相同的 concatArrays / base64Encode / base64Decode，注释写着
 * 「与 secureStorage.base64Encode 保持一致」。两份实现在 v1.15.5~v1.15.6 各自被
 * 单独修过同一个 bug（分块大小必须是 3 的倍数），任何一边再漂移一次就是
 * 「写得进去、读不出来、用户丢会话」。现在只有这一份实现。
 *
 * ⚠️ base64Decode 里的 legacy 分块兼容分支不是冗余代码，是救历史数据的：
 * v1.15.5/v1.15.6 写出的 blob 里，每 16384 字节（3 的倍数？不是）之后都跟着 '='
 * padding 拼在字符串中间，直接 atob 必失败。改动这段的任何一行（包括「顺手简化」
 * 掉 try/catch 或把 16384 改成 3*8192）都会让那批存量数据永久解不开。
 * 证据锚点见 tests/base64AndUrlPolicy.test.ts 的 legacy 往返用例。
 */

/** 编码分块大小。必须是 3 的倍数，否则每块独立 btoa 会在末尾产生 '=' padding 并拼进结果中间。 */
const ENCODE_CHUNK_SIZE = 3 * 8192; // 24576

/**
 * 旧版（v1.15.5/v1.15.6）的分块字节数——非 3 的倍数，这是历史坏数据的根因。
 * 16384 字节 → ceil(16384/3)*4 = 21848 个 base64 字符/块。
 */
const LEGACY_CHUNK_BYTES = 16384;
const LEGACY_CHUNK_CHARS = Math.ceil(LEGACY_CHUNK_BYTES / 3) * 4;

export function concatArrays(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

export function base64Encode(bytes: Uint8Array): string {
  // 分块处理避免 String.fromCharCode(...chunk) 在大数组时的栈溢出。
  // ⚠️ 块大小必须是 3 的倍数：base64 每 3 字节映射 4 字符，非 3 倍数块的
  // 独立 btoa 会在末尾产生 '=' padding 并拼进结果中间，产出非法 base64 ——
  // 写入成功但 atob 解码必失败（v1.15.5~v1.15.6 大于 16KB 的数据全部中招，
  // 表现为「保存成功、刷新后读取本地会话失败」）。
  let result = '';
  for (let i = 0; i < bytes.length; i += ENCODE_CHUNK_SIZE) {
    const chunk = bytes.slice(i, Math.min(i + ENCODE_CHUNK_SIZE, bytes.length));
    result += btoa(String.fromCharCode(...chunk));
  }
  return result;
}

export function base64Decode(b64: string): Uint8Array {
  try {
    return new Uint8Array(atob(b64).split('').map(c => c.charCodeAt(0)));
  } catch (e) {
    // 兼容 v1.15.5/v1.15.6 的历史坏数据：旧 base64Encode 以 16384（非 3 倍数）
    // 分块，每块末尾带 '=' padding 拼在字符串中间。按旧的块字符长度切分，
    // 各段独立 atob 后拼接二进制。
    if (b64.length > LEGACY_CHUNK_CHARS && b64.indexOf('=', LEGACY_CHUNK_CHARS - 4) !== -1) {
      let binary = '';
      for (let i = 0; i < b64.length; i += LEGACY_CHUNK_CHARS) {
        binary += atob(b64.slice(i, i + LEGACY_CHUNK_CHARS));
      }
      return new Uint8Array(binary.split('').map(c => c.charCodeAt(0)));
    }
    throw e;
  }
}

/*
 * 反面样板（已删除，注释留档以防重建）：
 *
 * 被删掉的死导出 encryptionUtils.encryptSupabaseTabGroup 开头是这样的——
 *
 *   if (!group.tabs_data || group.tabs_data.length === 0) return group;
 *
 * 「空数据就不加密，原样返回」。这让同一张表里混着明文行和密文行，读侧只能靠
 * 猜（typeof === 'string' 到底是 base64 还是 JSON），而任何解密失败的处理
 * （返回空数组 / 返回明文）都会静默吞掉用户的会话。对照真正的 live 路径
 * src/utils/supabase/upload.ts 的做法：空/异常数据一律 fail-closed 抛错，绝不
 * 产出明文。
 *
 * 教训：任何「跳过加密」的早退分支都是把明文推进持久层的入口，不是优化。
 * 加密与否是数据形状的属性（有没有 rows 就写不写 row），不是「值恰好为空」的函数。
 */
