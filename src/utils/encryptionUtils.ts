import { secureStorage } from '@/utils/secureStorage';
import { base64Decode, base64Encode, concatArrays } from './base64';
import { logError } from './log';

const V1_PREFIX = 'ENCRYPTED_V1:';
const V2_STANDARD_PREFIX = 'ENCRYPTED_V2_S:';  // 标准 V2 密钥（无 deviceId）
const V2_DEVICE_PREFIX = 'ENCRYPTED_V2_D:';    // 设备绑定 V2 密钥（有 deviceId，用于向后兼容）
const V2_LEGACY_PREFIX = 'ENCRYPTED_V2:';      // 旧版 V2 前缀（无 _S/_D 后缀），语义上等同于 V2_DEVICE，向后兼容老用户云端数据
const V3_COMPRESSED_PREFIX = 'ENCRYPTED_V3_Z:'; // V3：gzip 压缩**之后**再加密（2026-10-23 第 54 轮）
const PBKDF2_ITERATIONS = 100_000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const KEY_LENGTH = 256;

/**
 * PBKDF2 密钥派生（V2）
 * 使用 userId + deviceId 进行设备绑定的密钥派生
 */
async function deriveKeyPBKDF2(userId: string, salt: Uint8Array, useDeviceId = false): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  let keyString = userId;
  
  if (useDeviceId) {
    // 获取设备ID用于向后兼容的旧设备绑定密钥派生
    const deviceId = await secureStorage.get<string>('deviceId').catch(() => '');
    keyString = userId + (deviceId || '');
  }

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(keyString),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * SHA-256 密钥派生（V1，保留用于解密旧数据）
 */
async function deriveKeySHA256(userId: string): Promise<CryptoKey> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(userId));
  return crypto.subtle.importKey('raw', hashBuffer, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function encryptBytes(plaintext: Uint8Array, key: CryptoKey): Promise<{ iv: Uint8Array; ciphertext: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { iv, ciphertext };
}

/**
 * gzip 压缩（原生 CompressionStream）。
 *
 * 为什么用原生 API 而不是引一个库：brotli 的 wasm 实现几百 KB，
 * 而这个扩展的包体有硬上限（185 KB 闸门）⇒ 引库是净亏。
 * Chrome 80+ 就有 CompressionStream/DecompressionStream，
 * manifest 声明的 minimum_chrome_version=120 远高于它。
 */
async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream('gzip');
  const writer = stream.writable.getWriter();
  const written = writer.write(bytes as unknown as BufferSource);
  const closed = writer.close();
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  await written;
  await closed;
  return concatArrays(...chunks);
}

/** gzip 解压（原生 DecompressionStream）。解压失败必须抛出，不可返回半截数据。 */
async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream('gzip');
  const writer = stream.writable.getWriter();
  const written = writer.write(bytes as unknown as BufferSource);
  const closed = writer.close();
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  await written;
  await closed;
  return concatArrays(...chunks);
}

/**
 * 加密数据（始终使用 PBKDF2 V2 格式）
 * @param data 要加密的数据
 * @param userId 用户 ID
 * @param useDeviceId 是否使用设备绑定密钥（仅用于向后兼容加密旧数据，新数据应使用标准密钥）
 */
export async function encryptData<T>(data: T, userId: string, useDeviceId = false): Promise<string> {
  try {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const key = await deriveKeyPBKDF2(userId, salt, useDeviceId);
    const plaintext = new TextEncoder().encode(JSON.stringify(data));
    const { iv, ciphertext } = await encryptBytes(plaintext, key);

    const prefix = useDeviceId ? V2_DEVICE_PREFIX : V2_STANDARD_PREFIX;
    return prefix + base64Encode(concatArrays(salt, iv, new Uint8Array(ciphertext)));
  } catch (error) {
    logError('加密数据失败:', error);
    throw new Error('加密数据失败');
  }
}

/**
 * 压缩后再加密（V3 格式，2026-10-23 第 54 轮）。
 *
 * ── 为什么必须「先压缩、后加密」 ────────────────────────────────────────
 * 云端出网（egress）按**发出去的字节**计费，而 Supabase 的 Free 档
 * 超配额是**项目级封禁**（连 /auth/v1/health 都返回 402 ⇒ 整个项目不可用）。
 *
 * 旧顺序是「JSON → AES-GCM」：JSON 里全是重复（10 条标签各重复一遍 key 名、
 * 同格式的 ISO 时间、同域名的 favicon URL），而 AES-GCM 会把明文**打散成高熵密文**
 * ⇒ 这份重复在加密之后就**再也压不动了** —— 服务器端再 gzip 也只能回收
 * base64 自身的 25%。
 *
 * 把 gzip 挪到加密**之前**，重复在变成密文之前就被压掉：
 * 实测 10 标签/组 4291 B → 635 B（-85%），整表下载 457.9 KB → 100.9 KB（-81%）。
 *
 * ── 为什么要有独立前缀 ──────────────────────────────────────────────────
 * 载荷的**编码**变了（密文里装的是 gzip 而不是 JSON）⇒ 不能沿用 V2 前缀：
 * 老客户端按前缀路由解密，遇到 V3 会走「未加密」分支而解析失败
 * ⇒ 那一组会显示成「读不出来」（数据不丢，UI 已有这个提示）。
 * 用独立前缀 V3 ⇒ **新版本读旧行完全不受影响**（V1/V2 分支一字未动）。
 *
 * ── 自适应：压了反而大就不用压 ──────────────────────────────────────────
 * gzip 头 ~20 B + salt/iv/tag 44 B 的固定开销，对**极小载荷**是净负担
 * （实测：空组 `[]` 压完反而更大；1 条标签的组就已经省了 8%）⇒ 压完不比
 * 原文小就退回原格式（V2）。混着写 V2/V3 是安全的：读端按前缀路由，两种都能读。
 */
export async function encryptCompressedData<T>(data: T, userId: string): Promise<string> {
  try {
    const plaintext = new TextEncoder().encode(JSON.stringify(data));
    const compressed = await gzipBytes(plaintext);
    if (compressed.length >= plaintext.length) {
      // 压不划算 ⇒ 用旧格式（极小载荷的常态：空组）
      return encryptData(data, userId);
    }
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const key = await deriveKeyPBKDF2(userId, salt, false);
    const { iv, ciphertext } = await encryptBytes(compressed, key);
    return V3_COMPRESSED_PREFIX + base64Encode(concatArrays(salt, iv, new Uint8Array(ciphertext)));
  } catch (error) {
    logError('压缩加密失败:', error);
    throw new Error('加密数据失败');
  }
}

/**
 * 解密 V2 格式数据
 * @param encryptedData 加密数据
 * @param prefix 前缀（用于截取数据部分）
 * @param userId 用户 ID
 * @param useDeviceId 是否使用设备绑定密钥
 */
async function decryptV2WithKey<T>(
  encryptedData: string,
  prefix: string,
  userId: string,
  useDeviceId: boolean
): Promise<T> {
  const bytes = base64Decode(encryptedData.substring(prefix.length));
  const salt = bytes.slice(0, SALT_LENGTH);
  const iv = bytes.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const ciphertext = bytes.slice(SALT_LENGTH + IV_LENGTH);

  const key = await deriveKeyPBKDF2(userId, salt, useDeviceId);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(decrypted)) as T;
}

/**
 * 解密 V1 格式数据
 */
async function decryptV1<T>(encryptedData: string, userId: string): Promise<T> {
  const bytes = base64Decode(encryptedData.substring(V1_PREFIX.length));
  const iv = bytes.slice(0, IV_LENGTH);
  const ciphertext = bytes.slice(IV_LENGTH);
  const key = await deriveKeySHA256(userId);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(decrypted)) as T;
}

/**
 * 解密 V3（gzip 之后加密）：解密 → gunzip → JSON.parse。
 *
 * ⚠️ 解压失败必须抛出（由 decryptData 的 catch 统一转成「解密失败」），
 *   绝不能返回半截数据 —— 半截数据会被下游 normalizeTabsData 归一化成
 *   「空数组」，而「空数组」会被当成「这组本来就没标签」**硬删云端行**。
 */
async function decryptV3WithKey<T>(
  encryptedData: string,
  prefix: string,
  userId: string
): Promise<T> {
  const bytes = base64Decode(encryptedData.substring(prefix.length));
  const salt = bytes.slice(0, SALT_LENGTH);
  const iv = bytes.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const ciphertext = bytes.slice(SALT_LENGTH + IV_LENGTH);

  const key = await deriveKeyPBKDF2(userId, salt, false);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  const plain = await gunzipBytes(new Uint8Array(decrypted));
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

/**
 * 根据前缀解密数据（直接路由，无需 try-catch 版本猜测）
 */
export async function decryptData<T>(encryptedData: string, userId: string): Promise<T> {
  try {
    // ⚠️ 这里必须 `await` 而不是 `return promise` ——
    //   `try { return p } catch {}` **捕获不到 p 的 rejection**（同步 throw 才捕获得到）
    //   ⇒ 坏数据会以原始 DOMException（"The operation failed..."）抛出去，
    //   本函数承诺的「统一抛『解密数据失败』」根本没兑现。
    //   V1/V2/V3 三条分支原本都是 `return`（同一个坑），一并改成 await。

    // V3 压缩格式（2026-10-23 第 54 轮）：gzip 后加密
    if (encryptedData.startsWith(V3_COMPRESSED_PREFIX)) {
      return await decryptV3WithKey<T>(encryptedData, V3_COMPRESSED_PREFIX, userId);
    }

    // V2 标准格式：标准 V2 密钥（无 deviceId）
    if (encryptedData.startsWith(V2_STANDARD_PREFIX)) {
      return await decryptV2WithKey<T>(encryptedData, V2_STANDARD_PREFIX, userId, false);
    }

    // V2 设备格式：设备绑定 V2 密钥（有 deviceId，向后兼容）
    if (encryptedData.startsWith(V2_DEVICE_PREFIX)) {
      return await decryptV2WithKey<T>(encryptedData, V2_DEVICE_PREFIX, userId, true);
    }

    // V2 旧版前缀（无 _S/_D 后缀）：老用户云端数据，语义等同 V2_DEVICE
    if (encryptedData.startsWith(V2_LEGACY_PREFIX)) {
      return await decryptV2WithKey<T>(encryptedData, V2_LEGACY_PREFIX, userId, true);
    }

    // V1 格式：SHA-256（向后兼容）
    if (encryptedData.startsWith(V1_PREFIX)) {
      return await decryptV1<T>(encryptedData, userId);
    }

    // 未加密数据
    return JSON.parse(encryptedData) as T;
  } catch (error) {
    logError('解密数据失败:', error);
    throw new Error('解密数据失败，可能是数据格式不正确或已损坏');
  }
}

export function isEncrypted(data: unknown): boolean {
  return typeof data === 'string' && (
    data.startsWith(V1_PREFIX) ||
    data.startsWith(V2_STANDARD_PREFIX) ||
    data.startsWith(V2_DEVICE_PREFIX) ||
    data.startsWith(V2_LEGACY_PREFIX) ||
    // ⚠️ V3 必须列进来：否则一行 V3 密文解压失败时，会被当成「明文行」去
    //   JSON.parse —— 解析失败还好，**解析成功**就意味着把一段密文当成了
    //   标签数据。列进来 ⇒ 解压失败一律走「读不出来」的 fail-closed 路径。
    data.startsWith(V3_COMPRESSED_PREFIX)
  );
}
