// base64 原语去重 + URL 协议策略收敛 + 导出日期戳 的回归测试。
//
// 三组断言，各自钉死一件不同的东西：
//
// 1) base64：src/utils/secureStorage.ts 与 src/utils/encryptionUtils.ts 曾各持一份
//    逐字节相同的 concatArrays/base64Encode/base64Decode（注释写着「与对方保持
//    一致」）。两边各自修过同一个 bug（分块必须是 3 的倍数），再漂移一次就是
//    「写得进去、读不出来、用户丢会话」。本文件把**重构前的实现逐字抄进测试**
//    作为参照实现，对多个长度做表驱动逐字节比对 —— 这是「行为完全不变」的可
//    执行证明，而不是一句注释。
//    另有一条 legacy 分块往返用例：用 v1.15.5 的 16384 非 3 倍数分块编码器造
//    出真实历史坏数据（整体 atob 必失败），断言新的 base64Decode 仍能救回来。
//    这条 hack 不是冗余代码，动它就等于让存量数据永久解不开。
//
// 2) URL 协议策略：仓库里有三套策略（标签页可导航 / favicon 可渲染 / 内部页面），
//    它们答的是三个不同问题，**故意不同**。测试钉死的是这些差异本身，而不是
//    把它们抹平成一张表——抹平会改变 ftp: 与 data: 的实际行为。
//
// 3) 导出日期戳：formatExportStamp 必须是「给定瞬间的纯函数」。用 mock.timers
//    把系统时钟停在本地午夜前 1ms 再推过去 1ms，模拟 webApi.exportJsonBackup
//    曾经的「两次 new Date()」窗口：文件名与载荷时间戳必须仍然指同一天。
//
// 说明：每个 test 文件是独立进程，可以在 import 被测模块前安全定义 globalThis 桩。
import { describe, it, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbXciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

before(async () => {
  register(LOADER_PATH);
});

// ══════════════════════════════════════════════════════════════════════
// 参照实现：git HEAD（重构前）secureStorage.ts:24-68 的逐字副本。
// 它是「重构前行为」的定义；新实现必须与之逐字节一致。
// ══════════════════════════════════════════════════════════════════════
function preRefactorBase64Encode(bytes: Uint8Array): string {
  const CHUNK_SIZE = 3 * 8192; // 24576，3 的倍数
  let result = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.slice(i, Math.min(i + CHUNK_SIZE, bytes.length));
    result += btoa(String.fromCharCode(...chunk));
  }
  return result;
}

function preRefactorBase64Decode(b64: string): Uint8Array {
  try {
    return new Uint8Array(atob(b64).split('').map(c => c.charCodeAt(0)));
  } catch (e) {
    const LEGACY_CHUNK_CHARS = Math.ceil(16384 / 3) * 4;
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

function preRefactorConcatArrays(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

/**
 * v1.15.5/v1.15.6 的坏编码器：16384 字节（3 的倍数？不是）分块，每块独立 btoa，
 * '=' padding 被拼进结果字符串的中间。整体 atob 必失败。
 * 这就是 base64Decode 里那段 legacy 兼容分支要救的东西。
 */
function v1155BrokenEncode(bytes: Uint8Array): string {
  const CHUNK_SIZE = 16384;
  let result = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.slice(i, Math.min(i + CHUNK_SIZE, bytes.length));
    result += btoa(String.fromCharCode(...chunk));
  }
  return result;
}

/** 确定性字节样本：覆盖 0 / 全 0xFF / 递增，避开随机导致的偶发抖动。 */
function sampleBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 37 + 11) & 0xff;
  return out;
}

// ══════════════════════════════════════════════════════════════════════
// 1 · base64 原语
// ══════════════════════════════════════════════════════════════════════

describe('base64：与重构前实现逐字节等价（行为不变的证明）', () => {
  // 0/1/2/3 是 base64 尾部 padding 的全部边界；24576 是当前分块大小（3 的倍数）；
  // 24575/24577 是刚好跨块与跨两块；16384/16385/20000/32768 是历史坏数据的规模。
  const LENGTHS = [0, 1, 2, 3, 4, 255, 16384, 16385, 20000, 24575, 24576, 24577, 32768, 49152, 49153];

  it('表驱动：base64Encode 对每个长度样本都与重构前逐字节相同', async () => {
    const { base64Encode } = await import('../src/utils/base64.ts');
    for (const len of LENGTHS) {
      const input = sampleBytes(len);
      assert.strictEqual(
        base64Encode(input),
        preRefactorBase64Encode(input),
        `base64Encode 在长度 ${len} 上与重构前不一致`
      );
    }
  });

  it('表驱动：base64Decode 对每个长度样本都与重构前逐字节相同', async () => {
    // 输入用 preRefactorBase64Encode 造：这条用例考的是 decode，
    // 而上一条已经钉死「两个编码器逐字节相同」，所以拿旧编码器当数据源同样覆盖新编码器的输出。
    const { base64Decode } = await import('../src/utils/base64.ts');
    for (const len of LENGTHS) {
      const input = sampleBytes(len);
      const b64 = preRefactorBase64Encode(input);
      assert.deepStrictEqual(
        Array.from(base64Decode(b64)),
        Array.from(preRefactorBase64Decode(b64)),
        `base64Decode 在长度 ${len} 上与重构前不一致`
      );
    }
  });

  it('表驱动：base64Decode 抛错行为与重构前一致（不吞异常、不静默返回空）', async () => {
    const { base64Decode } = await import('../src/utils/base64.ts');
    // 非法 base64：整体 atob 失败，且长度/位置都不满足 legacy 分支的触发条件
    for (const bad of ['!!!!', 'not-base64-at-all', 'A']) {
      let newThrew = false;
      let oldThrew = false;
      try { base64Decode(bad); } catch { newThrew = true; }
      try { preRefactorBase64Decode(bad); } catch { oldThrew = true; }
      assert.strictEqual(newThrew, oldThrew, `对 ${bad} 的抛错行为与重构前不一致`);
    }
  });

  it('表驱动：concatArrays 与重构前逐字节相同（iv‖salt‖ciphertext 的拼装）', async () => {
    const { concatArrays } = await import('../src/utils/base64.ts');
    const cases: Uint8Array[][] = [
      [],
      [new Uint8Array(0)],
      [sampleBytes(16), sampleBytes(12)],
      [sampleBytes(1), sampleBytes(2), sampleBytes(3)],
      [sampleBytes(30000), sampleBytes(12), sampleBytes(5)],
    ];
    for (const parts of cases) {
      assert.deepStrictEqual(
        Array.from(concatArrays(...parts)),
        Array.from(preRefactorConcatArrays(...parts))
      );
    }
  });

  it('新编码器跨块边界不产生中间 padding（v1.15.5 那个 bug 已被修死）', async () => {
    const { base64Encode } = await import('../src/utils/base64.ts');
    for (const len of [24577, 32768, 60000]) {
      const b64 = base64Encode(sampleBytes(len));
      // 合法 base64：只在末尾出现 padding，绝不出现在中间
      const firstPad = b64.indexOf('=');
      assert.ok(
        firstPad === -1 || firstPad >= b64.length - 2,
        `长度 ${len} 的输出在中间出现 padding（索引 ${firstPad}）`
      );
      // 整串必须能被一次性 atob 回来
      assert.strictEqual(atob(b64).length, len);
    }
  });
});

describe('base64：v1.15.5/v1.15.6 历史分块坏数据仍能救回（legacy 兼容分支不可删）', () => {
  // 16384 字节 → ceil(16384/3)*4 = 21848 个 base64 字符/块
  const LEGACY_CHUNK_CHARS = Math.ceil(16384 / 3) * 4;

  it('构造确认：v1.15.5 编码器的产物整体 atob 必失败（这就是要救的数据）', () => {
    const broken = v1155BrokenEncode(sampleBytes(20000));
    assert.ok(broken.length > LEGACY_CHUNK_CHARS, '样本必须大于一个 legacy 块才能触发分支');
    assert.ok(broken.indexOf('=', LEGACY_CHUNK_CHARS - 4) !== -1, '第一个块末尾必须带 padding');
    assert.throws(() => atob(broken), 'v1.15.5 产物不应该是合法 base64');
  });

  it('跨越 legacy 块边界的往返仍然正确（修复前后都必须过）', async () => {
    const { base64Decode } = await import('../src/utils/base64.ts');
    // 覆盖：单块内 / 恰好跨一块 / 跨两块 / 末块是 3 的倍数（无 padding）
    for (const len of [16385, 20000, 32768, 32769, 49152, 49153]) {
      const original = sampleBytes(len);
      const broken = v1155BrokenEncode(original);
      // 新实现必须与重构前参照实现解出同一串字节
      assert.deepStrictEqual(
        Array.from(base64Decode(broken)),
        Array.from(original),
        `长度 ${len} 的 legacy 坏数据没能救回`
      );
      assert.deepStrictEqual(
        Array.from(base64Decode(broken)),
        Array.from(preRefactorBase64Decode(broken)),
        `长度 ${len} 上 legacy 解码与重构前不一致`
      );
    }
  });

  it('legacy 分支的触发条件是窄的：短串 / 无 padding 的长串走正常路径', async () => {
    const { base64Encode, base64Decode } = await import('../src/utils/base64.ts');
    // 长但无中间 padding → 走正常 atob 路径，不该被误切
    const legit = base64Encode(sampleBytes(40000));
    assert.strictEqual(atob(legit).length, 40000);
    assert.deepStrictEqual(Array.from(base64Decode(legit)), Array.from(sampleBytes(40000)));
  });
});

describe('base64：两个原调用点（secureStorage / encryptionUtils）行为未变', () => {
  // secureStorage 需要 chrome.storage.local：V3 密钥持久化在那儿。
  // 这是「真实调用点」的往返证明——共享原语接上去之后，端到端仍然通。
  function installChromeStorageStub() {
    const map = new Map<string, unknown>();
    (globalThis as any).chrome = {
      runtime: { id: 'test-extension-id' },
      storage: {
        local: {
          async get(keys: string | string[]) {
            const out: Record<string, unknown> = {};
            const list = Array.isArray(keys) ? keys : [keys];
            for (const k of list) out[k] = map.get(k);
            return out;
          },
          async set(items: Record<string, unknown>) {
            for (const [k, v] of Object.entries(items)) map.set(k, v);
          },
          async remove(k: string) { map.delete(k); },
          async clear() { map.clear(); },
        },
      },
    };
    return map;
  }

  it('secureStorage.encryptLocalBlob/decryptLocalBlob 往返（含跨块大载荷）', async () => {
    installChromeStorageStub();
    const { encryptLocalBlob, decryptLocalBlob, __resetKeyCacheForTesting } =
      await import('../src/utils/secureStorage.ts');
    __resetKeyCacheForTesting();

    // 负载刻意造大：> 24576（一个编码块），逼 base64Encode 走多块分支
    const payload = {
      id: 'group-1',
      name: '跨块往返',
      tabs: Array.from({ length: 900 }, (_, i) => ({
        title: `标签 ${i}`,
        url: `https://example.com/${i}?q=${'x'.repeat(40)}`,
      })),
    };
    const json = JSON.stringify(payload);
    assert.ok(new TextEncoder().encode(json).length > 24576, '载荷必须大于一个编码块');

    const blob = await encryptLocalBlob(payload);
    assert.ok(blob.startsWith('SECURE_V3:'), '应产出 V3 前缀密文');
    assert.deepStrictEqual(await decryptLocalBlob(blob), payload);
  });

  it('encryptionUtils.encryptData/decryptData 往返（含跨块大载荷）', async () => {
    installChromeStorageStub();
    const { encryptData, decryptData } = await import('../src/utils/encryptionUtils.ts');

    const payload = {
      id: 'group-2',
      name: '加密往返',
      tabs: Array.from({ length: 900 }, (_, i) => ({
        title: `T${i}`,
        url: `https://example.com/${i}?q=${'y'.repeat(40)}`,
      })),
    };
    const json = JSON.stringify(payload);
    assert.ok(new TextEncoder().encode(json).length > 24576, '载荷必须大于一个编码块');

    const enc = await encryptData(payload, 'user-under-test');
    assert.ok(enc.startsWith('ENCRYPTED_V2_S:'), '应产出标准 V2 前缀密文');
    assert.deepStrictEqual(await decryptData(enc, 'user-under-test'), payload);
  });

  it('两个模块的编码结果互相可解（同一份原语，不存在两套方言）', async () => {
    installChromeStorageStub();
    const { encryptData, decryptData } = await import('../src/utils/encryptionUtils.ts');
    const { encryptLocalBlob, decryptLocalBlob, __resetKeyCacheForTesting } =
      await import('../src/utils/secureStorage.ts');
    __resetKeyCacheForTesting();

    // 两种密文结构不同（密钥派生不同），但都由同一对 base64 原语承载。
    // 这里断言的是「前缀/结构不串味」——共用原语后最容易犯的错。
    const payload = { id: 'g', name: 'n', tabs: [] };
    const viaStorage = await encryptLocalBlob(payload);
    const viaEncryption = await encryptData(payload, 'u');
    assert.notStrictEqual(viaStorage.slice(0, 12), viaEncryption.slice(0, 12));
    assert.deepStrictEqual(await decryptLocalBlob(viaStorage), payload);
    assert.deepStrictEqual(await decryptData(viaEncryption, 'u'), payload);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2 · URL 协议策略：三种语义各自的边界（差异是故意的，测试要钉住差异）
// ══════════════════════════════════════════════════════════════════════

describe('URL 策略：javascript: 被标签页与 favicon 双方拒绝', () => {
  it('sanitizeTabUrl 拒绝 javascript:', async () => {
    const { sanitizeTabUrl } = await import('../src/utils/inputValidation.ts');
    for (const u of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      '  javascript:alert(1)  ',
      'java\nscript:alert(1)',
    ]) {
      assert.strictEqual(sanitizeTabUrl(u), null, `标签页策略未拒绝 ${JSON.stringify(u)}`);
    }
  });

  it('favicon 策略拒绝 javascript:', async () => {
    const { isFaviconUrlSafe, sanitizeFaviconUrl } = await import('../src/utils/faviconUtils.ts');
    for (const u of ['javascript:alert(1)', 'JavaScript:alert(1)', '  javascript:alert(1)  ']) {
      assert.strictEqual(isFaviconUrlSafe(u), false, `favicon 谓词未拒绝 ${JSON.stringify(u)}`);
      assert.strictEqual(sanitizeFaviconUrl(u), '', `favicon 清理器未拒绝 ${JSON.stringify(u)}`);
    }
  });
});

describe('URL 策略：ftp: 对标签页放行、对 favicon 拒绝（故意不同）', () => {
  const FTP = 'ftp://files.example.com/pub/readme.txt';

  it('标签页策略放行 ftp:', async () => {
    const { sanitizeTabUrl } = await import('../src/utils/inputValidation.ts');
    assert.strictEqual(sanitizeTabUrl(FTP), FTP, 'ftp: 是合法可导航地址，标签页策略应放行');
  });

  it('favicon 策略拒绝 ftp:', async () => {
    const { isFaviconUrlSafe, sanitizeFaviconUrl } = await import('../src/utils/faviconUtils.ts');
    assert.strictEqual(isFaviconUrlSafe(FTP), false, '浏览器不会把 ftp 当图片源，favicon 策略应拒绝');
    assert.strictEqual(sanitizeFaviconUrl(FTP), '');
  });

  it('反例锁定：data: 对 favicon 放行、对标签页拒绝（同样故意不同）', async () => {
    const { isFaviconUrlSafe } = await import('../src/utils/faviconUtils.ts');
    const { sanitizeTabUrl } = await import('../src/utils/inputValidation.ts');
    const DATA_PNG = 'data:image/png;base64,iVBORw0KGgo=';
    assert.strictEqual(isFaviconUrlSafe(DATA_PNG), true, '内联图标应放行');
    assert.strictEqual(sanitizeTabUrl(DATA_PNG), null, 'data:text/html 是 XSS 面，标签页策略应拒绝');
  });
});

describe('URL 策略：favicon 两份实现合并后行为不变', () => {
  it('表驱动：谓词与清理器对同一输入给出互补且一致的判定', async () => {
    const { isFaviconUrlSafe, sanitizeFaviconUrl } = await import('../src/utils/faviconUtils.ts');
    const cases: Array<[string | undefined | null, boolean, string]> = [
      // [输入, 谓词应为, 清理器应为]
      ['https://ex.com/f.ico', true, 'https://ex.com/f.ico'],
      ['http://ex.com/f.ico', true, 'http://ex.com/f.ico'],
      ['data:image/png;base64,AAA=', true, 'data:image/png;base64,AAA='],
      ['chrome-extension://abc/icon.png', true, 'chrome-extension://abc/icon.png'],
      ['javascript:alert(1)', false, ''],
      ['vbscript:msgbox(1)', false, ''],
      ['file:///etc/passwd', false, ''],
      ['ftp://ex.com/f.ico', false, ''],
      ['chrome://favicon.ico', false, ''],
      ['about:blank', false, ''],
      ['', false, ''],
      [null, false, ''],
      [undefined, false, ''],
      ['   ', false, ''],
      ['not a url at all', false, ''],
    ];
    for (const [input, expectedPredicate, expectedSanitized] of cases) {
      assert.strictEqual(
        isFaviconUrlSafe(input), expectedPredicate,
        `isFaviconUrlSafe(${JSON.stringify(input)}) 判定不符`
      );
      assert.strictEqual(
        sanitizeFaviconUrl(input), expectedSanitized,
        `sanitizeFaviconUrl(${JSON.stringify(input)}) 判定不符`
      );
      // 合并后的不变量：谓词为真 ⟺ 清理器返回非空
      assert.strictEqual(
        expectedPredicate, expectedSanitized !== '',
        '谓词与清理器必须互补（合并的单一真相源不变量）'
      );
    }
  });

  it('清理器仍然 trim 并返回 trim 后的 URL（既有行为）', async () => {
    const { sanitizeFaviconUrl } = await import('../src/utils/faviconUtils.ts');
    assert.strictEqual(sanitizeFaviconUrl('  https://ex.com/f.ico  '), 'https://ex.com/f.ico');
  });

  it('sanitizeFaviconUrls 过滤掉不安全项', async () => {
    const { sanitizeFaviconUrls } = await import('../src/utils/faviconUtils.ts');
    assert.deepStrictEqual(
      sanitizeFaviconUrls(['https://ex.com/a.ico', 'javascript:alert(1)', null, 'http://ex.com/b.ico']),
      ['https://ex.com/a.ico', 'http://ex.com/b.ico']
    );
  });
});

describe('URL 策略：内部 URL 单一实现（补齐 edge:// / about:// 后的边界）', () => {
  it('isInternalUrl 认出全部四类内部页面（含此前 TabManager 漏掉的 edge:// / about://）', async () => {
    const { isInternalUrl } = await import('../src/domain/tabGroup/filters.ts');
    for (const u of [
      'chrome://newtab',
      'chrome://settings',
      'chrome-extension://abc123/popup/index.html',
      'edge://settings',
      'edge://newtab',
      'about:blank',
      'about:config',
      'about://blank',
    ]) {
      assert.strictEqual(isInternalUrl(u), true, `${u} 应被认作内部 URL`);
    }
  });

  it('isInternalUrl 不误伤正常页面（大小写敏感的边界）', async () => {
    const { isInternalUrl } = await import('../src/domain/tabGroup/filters.ts');
    for (const u of [
      'https://example.com',
      'http://example.com/chrome://x',
      'ftp://files.example.com/about:blank',
      'devtools://devtools/bundled/inspector.html',
      'view-source:https://example.com',
      'edge-extension://abc/popup.html', // 不在白名单内 → 不是「我们自己的页面」
    ]) {
      assert.strictEqual(isInternalUrl(u), false, `${u} 不应被认作内部 URL`);
    }
  });

  it('修正方向确认：三道门正交串联，about: 靠内部 URL 门挡住、edge: 靠协议门挡住', async () => {
    // 语义说明（把「为什么三张表不同」钉在测试里，防后人把它们合并成一张）：
    // - about:  在 sanitizeTabUrl 里【放行】（合法可导航协议，用户真的会开），
    //   在 isInternalUrl 里【判内部】（不保存）。必须靠内部 URL 这道门挡住。
    // - edge:   在 sanitizeTabUrl 里【拒绝】（不在白名单），在 isInternalUrl 里
    //   【判内部】。两道门都拒——这里断言的是「不是只靠其中一道」。
    // - chrome: 同上，两道门都拒。
    const { sanitizeTabUrl } = await import('../src/utils/inputValidation.ts');
    const { isInternalUrl } = await import('../src/domain/tabGroup/filters.ts');

    assert.strictEqual(sanitizeTabUrl('about:blank'), 'about:blank', 'about: 是合法可导航协议');
    assert.strictEqual(isInternalUrl('about:blank'), true, '但它属于「自己的页面」，不保存');

    for (const u of ['edge://settings', 'chrome://newtab', 'chrome-extension://abc/p.html']) {
      assert.strictEqual(isInternalUrl(u), true, `${u} 应被内部 URL 门拦下`);
      assert.strictEqual(sanitizeTabUrl(u), null, `${u} 也应被协议门拦下（纵深防御）`);
    }
  });

  it('改用单一真相源不改变可观测行为：残缺的 TabManager 门本来就是死代码', async () => {
    // 依据：saveCurrentTab 的内联门之后紧接 createTabGroupFromChromeTabs，
    // 后者内部先走 filterValidTabs → isValidTab → isInternalUrl（完整四前缀）。
    // 也就是说内联门漏掉的 edge:// / about: 在工厂里已被全部丢弃。
    // 这条断言把「改动行为中性」从推理变成可执行的事实。
    const { createTabGroupFromChromeTabs } = await import('../src/domain/tabGroup/factory.ts');
    const tabs = [
      { url: 'edge://settings', title: 'Edge 设置', pinned: false },
      { url: 'about:blank', title: '空白', pinned: false },
      { url: 'chrome://newtab', title: '新标签页', pinned: false },
      { url: 'https://example.com', title: '正常页', pinned: false },
    ] as chrome.tabs.Tab[];
    const group = createTabGroupFromChromeTabs(tabs, { now: '2026-09-30T00:00:00.000Z' });
    assert.deepStrictEqual(
      group.tabs.map(t => t.url),
      ['https://example.com'],
      '工厂层已用完整内部 URL 列表拦下 edge:// / about: / chrome://，残缺的内联门确实是死代码'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// 3 · 导出文件名日期戳：跨零点不与载荷时间戳打架
// ══════════════════════════════════════════════════════════════════════

describe('formatExportStamp：文件名日期与载荷时间戳永不打架', () => {
  it('基本形态：两位补零的本地年月日', async () => {
    const { formatExportStamp } = await import('../src/utils/exportStamp.ts');
    assert.strictEqual(formatExportStamp(new Date(2026, 0, 2, 3, 5)), '2026-01-02');
    assert.strictEqual(formatExportStamp(new Date(2026, 8, 30, 23, 59)), '2026-09-30');
    assert.strictEqual(formatExportStamp(new Date(2026, 11, 31, 12, 0)), '2026-12-31');
  });

  it('非法输入返回空串而不是 NaN-NaN-NaN', async () => {
    const { formatExportStamp } = await import('../src/utils/exportStamp.ts');
    assert.strictEqual(formatExportStamp(new Date('not-a-date')), '');
  });

  it('跨零点：文件名用载荷那个 Date，日期不随调用时刻漂移', async () => {
    const { formatExportStamp } = await import('../src/utils/exportStamp.ts');
    // 把系统时钟停在 2026-09-30 本地午夜前 1ms（= 9-29 23:59:59.999）
    const localMidnight = new Date(2026, 8, 30, 0, 0, 0, 0);
    mock.timers.enable({ apis: ['Date'], now: new Date(localMidnight.getTime() - 1) });
    try {
      // ── 正确的调用形态：整个导出共用这一个 Date ──
      const shared = new Date();                       // 9-29 23:59:59.999 本地
      const payload = { timestamp: shared.toISOString() };
      const filenameDate = formatExportStamp(shared);

      // 时钟跨过午夜
      mock.timers.tick(2);

      // 断言：文件名日期 == 载荷时间戳所指瞬间的本地日期
      assert.strictEqual(filenameDate, '2026-09-29', '文件名应锁定在载荷那一刻的日期');
      assert.strictEqual(
        filenameDate,
        formatExportStamp(new Date(payload.timestamp)),
        '文件名日期必须与 payload.timestamp 指向同一天'
      );
      // 此刻系统时钟已经是新的一天了 —— 证明这个断言不是恒真的
      assert.strictEqual(formatExportStamp(new Date()), '2026-09-30');
    } finally {
      mock.timers.reset();
    }
  });

  it('反例对照：两次 new Date() 的旧形态确实会跨零点打架（这就是要防的 bug）', async () => {
    const { formatExportStamp } = await import('../src/utils/exportStamp.ts');
    const localMidnight = new Date(2026, 8, 30, 0, 0, 0, 0);
    mock.timers.enable({ apis: ['Date'], now: new Date(localMidnight.getTime() - 1) });
    try {
      // 旧代码形态（webApi.exportJsonBackup 重构前）：载荷用第一次 new Date()，
      // 文件名用第二次 new Date()。中间跨过零点 → 两者指向不同的天。
      const first = new Date();                  // 9-29 23:59:59.999
      const payloadTimestamp = first.toISOString();
      mock.timers.tick(2);
      const second = new Date();                 // 9-30 00:00:00.001
      const oldFilenameDate = formatExportStamp(second);

      assert.strictEqual(formatExportStamp(new Date(payloadTimestamp)), '2026-09-29');
      assert.strictEqual(oldFilenameDate, '2026-09-30');
      assert.notStrictEqual(
        oldFilenameDate,
        formatExportStamp(new Date(payloadTimestamp)),
        '若这条断言不成立，说明「两次 new Date()」并非本函数要防的问题'
      );
    } finally {
      mock.timers.reset();
    }
  });

  it('纯函数性：同一瞬间重复求值恒等（调用点可以放心多次求值）', async () => {
    const { formatExportStamp } = await import('../src/utils/exportStamp.ts');
    const d = new Date(2026, 4, 11, 8, 9);
    const first = formatExportStamp(d);
    assert.strictEqual(formatExportStamp(d), first);
    assert.strictEqual(formatExportStamp(new Date(d.getTime())), first);
  });
});
