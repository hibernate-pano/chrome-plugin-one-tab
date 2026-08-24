const V1_PREFIX = 'SECURE_V1:';
const V2_PREFIX = 'SECURE_V2:';
const V3_PREFIX = 'SECURE_V3:';
const PBKDF2_ITERATIONS = 100_000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const KEY_LENGTH = 256;

// V3 持久化密钥的 chrome.storage.local 键。
// V3 与 V2 的关键区别：V2 的 key 派生自 chrome.runtime.id（unpacked 开发模式
// 重新加载扩展时 ID 会变化 → 旧 blob 全部解不开 → 用户数据"消失"）。
// V3 使用首次生成的随机密钥，持久化存储，扩展 ID 变化不影响。
const LOCAL_KEY_STORAGE_KEY = 'ts_local_encryption_key_v3';

const SENSITIVE_KEYS: readonly string[] = [
  'deviceId',
  'migration_flags',
  'auth_cache',
  'user_preferences',
  'sync_tokens',
];

function base64Encode(bytes: Uint8Array): string {
  // 分块处理避免 String.fromCharCode(...chunk) 在大数组时的栈溢出。
  // ⚠️ 块大小必须是 3 的倍数：base64 每 3 字节映射 4 字符，非 3 倍数块的
  // 独立 btoa 会在末尾产生 '=' padding 并拼进结果中间，产出非法 base64 ——
  // 写入成功但 atob 解码必失败（v1.15.5~v1.15.6 大于 16KB 的数据全部中招，
  // 表现为「保存成功、刷新后读取本地会话失败」）。
  const CHUNK_SIZE = 3 * 8192; // 24576，3 的倍数
  let result = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.slice(i, Math.min(i + CHUNK_SIZE, bytes.length));
    result += btoa(String.fromCharCode(...chunk));
  }
  return result;
}

function base64Decode(b64: string): Uint8Array {
  try {
    return new Uint8Array(atob(b64).split('').map(c => c.charCodeAt(0)));
  } catch (e) {
    // 兼容 v1.15.5/v1.15.6 的历史坏数据：旧 base64Encode 以 16384（非 3 倍数）
    // 分块，每块末尾带 '=' padding 拼在字符串中间。按旧的块字符长度切分，
    // 各段独立 atob 后拼接二进制。
    // 旧块 16384 字节 → ceil(16384/3)*4 = 21848 个 base64 字符/块。
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

function concatArrays(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

async function deriveKeyPBKDF2(extensionId: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(extensionId + 'storage_key_v2'),
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

async function deriveKeySHA256(extensionId: string): Promise<CryptoKey> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(extensionId + 'storage_key_v1'));
  return crypto.subtle.importKey('raw', hashBuffer, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function encryptValue(data: any): Promise<string> {
  const key = await getOrCreateLocalKey();
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return V3_PREFIX + base64Encode(concatArrays(iv, new Uint8Array(ciphertext)));
}

async function decryptValue<T>(encryptedStr: string): Promise<T> {
  // V3：持久化密钥（首选）
  if (encryptedStr.startsWith(V3_PREFIX)) {
    try {
      const key = await getOrCreateLocalKey();
      const bytes = base64Decode(encryptedStr.substring(V3_PREFIX.length));
      const iv = bytes.slice(0, IV_LENGTH);
      const ciphertext = bytes.slice(IV_LENGTH);
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
      return JSON.parse(new TextDecoder().decode(decrypted)) as T;
    } catch {
      try {
        return JSON.parse(encryptedStr) as T;
      } catch {
        throw new Error('解密数据失败，已损坏或格式错误');
      }
    }
  }

  // V2 / V1：旧派生密钥（向后兼容；扩展 ID 未变时可解）
  if (encryptedStr.startsWith(V2_PREFIX)) {
    const v2 = await tryDecryptV2<T>(encryptedStr);
    if (v2 !== null) return v2;
  }
  if (encryptedStr.startsWith(V1_PREFIX)) {
    const v1 = await tryDecryptV1<T>(encryptedStr);
    if (v1 !== null) return v1;
  }

  // 明文（更老的未加密历史数据）
  return JSON.parse(encryptedStr) as T;
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.some(k => key === k || key.startsWith(k + '_'));
}

export class SecureStorage {
  async set(key: string, value: any): Promise<void> {
    try {
      let dataToStore = value;
      if (isSensitiveKey(key)) {
        dataToStore = await encryptValue(value);
      }
      await chrome.storage.local.set({ [key]: dataToStore });
    } catch (error) {
      console.error(`存储数据失败 (${key}):`, error);
      throw error;
    }
  }

  async get<T>(key: string, defaultValue?: T): Promise<T | undefined> {
    try {
      const result = await chrome.storage.local.get(key);
      const storedValue = result[key];
      if (storedValue === undefined) return defaultValue;

      if (isSensitiveKey(key) && typeof storedValue === 'string') {
        try {
          return await decryptValue<T>(storedValue);
        } catch {
          return storedValue as T;
        }
      }

      return storedValue as T;
    } catch (error) {
      console.error(`获取数据失败 (${key}):`, error);
      return defaultValue;
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await chrome.storage.local.remove(key);
    } catch (error) {
      console.error(`删除数据失败 (${key}):`, error);
      throw error;
    }
  }

  async setMultiple(items: Record<string, any>): Promise<void> {
    try {
      const processedItems: Record<string, any> = {};
      for (const [key, value] of Object.entries(items)) {
        processedItems[key] = isSensitiveKey(key) ? await encryptValue(value) : value;
      }
      await chrome.storage.local.set(processedItems);
    } catch (error) {
      console.error('批量存储数据失败:', error);
      throw error;
    }
  }

  async getMultiple<T extends Record<string, any>>(keys: string[]): Promise<Partial<T>> {
    try {
      const result = await chrome.storage.local.get(keys);
      const processedResult: any = {};
      for (const key of keys) {
        const storedValue = result[key];
        if (storedValue !== undefined) {
          if (isSensitiveKey(key) && typeof storedValue === 'string') {
            try {
              processedResult[key] = await decryptValue(storedValue);
            } catch {
              processedResult[key] = storedValue;
            }
          } else {
            processedResult[key] = storedValue;
          }
        }
      }
      return processedResult;
    } catch (error) {
      console.error('批量获取数据失败:', error);
      return {};
    }
  }

  async clear(): Promise<void> {
    await chrome.storage.local.clear();
  }
}

export const secureStorage = new SecureStorage();

// ── V3 持久化密钥（不依赖 chrome.runtime.id）────────────────────────

let cachedLocalKey: CryptoKey | null = null;
/** single-flight：并发首次调用共享同一个初始化 Promise */
let localKeyPromise: Promise<CryptoKey> | null = null;

/**
 * 加载或生成本地加密密钥（实际执行体，由 getOrCreateLocalKey 做 single-flight）。
 *
 * 失败语义：
 * - 读取 chrome.storage.local 抛错（环境错误）→ 向上抛，绝不静默生成新密钥
 *   （否则瞬时读失败会轮换密钥、砖化全部既有 V3 数据）。
 * - 持久化写入失败 → 向上抛。用未持久化的临时密钥加密等于产出
 *   下次启动必然不可解的密文——宁可本次保存失败。
 */
async function loadOrCreateLocalKey(): Promise<CryptoKey> {
  const result = await chrome.storage.local.get(LOCAL_KEY_STORAGE_KEY);
  const stored = result[LOCAL_KEY_STORAGE_KEY];
  if (typeof stored === 'string' && stored.length > 0) {
    const raw = base64Decode(stored);
    const key = await crypto.subtle.importKey(
      'raw',
      raw,
      { name: 'AES-GCM', length: KEY_LENGTH },
      false,
      ['encrypt', 'decrypt']
    );
    cachedLocalKey = key;
    return key;
  }

  // 键不存在（已确认读到存储且无此键）→ 生成新密钥并持久化
  const raw = crypto.getRandomValues(new Uint8Array(KEY_LENGTH / 8));
  const encoded = base64Encode(raw);
  await chrome.storage.local.set({ [LOCAL_KEY_STORAGE_KEY]: encoded });

  // 写后回读校验：popup 与 service worker 是两个独立 JS context，
  // 冷启动竞态下可能各自生成密钥互相覆盖（last-write-wins）。
  // 若存储中的值不是我们刚写的，说明另一个 context 先写了——
  // 以存储为准采用对方的密钥（本份还没加密过任何数据，直接丢弃）。
  const verify = await chrome.storage.local.get(LOCAL_KEY_STORAGE_KEY);
  const verified = verify[LOCAL_KEY_STORAGE_KEY];
  if (typeof verified !== 'string' || verified.length === 0) {
    throw new Error('[secureStorage] 密钥持久化校验失败：写入后无法读回');
  }
  if (verified !== encoded) {
    console.warn('[secureStorage] 检测到并发密钥生成冲突，采用存储中已有的密钥');
    cachedLocalKey = null;
    localKeyPromise = null;
    return loadOrCreateLocalKey();
  }

  const key = await crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'AES-GCM', length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
  cachedLocalKey = key;
  return key;
}

/**
 * 获取（或首次生成）本地加密密钥。
 *
 * V3 密钥与扩展 ID 解耦：首次使用时生成随机 256-bit 密钥，
 * 以 base64 存到 chrome.storage.local。之后所有加解密复用该密钥。
 * 这样即使 unpacked 扩展重新加载后 runtime.id 变化，数据仍可解密。
 *
 * 并发安全：single-flight —— 同一 context 内的并发调用共享同一个
 * 初始化 Promise；跨 context 竞态由写后回读校验兜底。
 */
function getOrCreateLocalKey(): Promise<CryptoKey> {
  if (cachedLocalKey) return Promise.resolve(cachedLocalKey);
  localKeyPromise ??= loadOrCreateLocalKey().catch(e => {
    // 失败后清空 in-flight，允许下次调用重试
    localKeyPromise = null;
    throw e;
  });
  return localKeyPromise;
}

/**
 * 测试辅助：清空进程内密钥缓存，模拟 popup / service worker 重新启动。
 * chrome.storage.local 中的持久化密钥保留 —— 用于验证「重启后仍可解密」。
 */
export function __resetKeyCacheForTesting(): void {
  cachedLocalKey = null;
  localKeyPromise = null;
}

/**
 * 尝试用 V2 时代的派生密钥解密（extensionId + salt）。
 * 仅用于 V2 blob 的向后兼容读取；若扩展 ID 已变化则返回 null。
 */
async function tryDecryptV2<T>(stored: string): Promise<T | null> {
  const extensionId = chrome.runtime.id;
  try {
    const bytes = base64Decode(stored.substring(V2_PREFIX.length));
    const salt = bytes.slice(0, SALT_LENGTH);
    const iv = bytes.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const ciphertext = bytes.slice(SALT_LENGTH + IV_LENGTH);
    const key = await deriveKeyPBKDF2(extensionId, salt);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return JSON.parse(new TextDecoder().decode(decrypted)) as T;
  } catch {
    return null;
  }
}

/**
 * 尝试用 V1 时代的派生密钥解密（extensionId + SHA-256）。
 * 仅用于 V1 blob 的向后兼容读取。
 */
async function tryDecryptV1<T>(stored: string): Promise<T | null> {
  const extensionId = chrome.runtime.id;
  try {
    const bytes = base64Decode(stored.substring(V1_PREFIX.length));
    const iv = bytes.slice(0, IV_LENGTH);
    const ciphertext = bytes.slice(IV_LENGTH);
    const key = await deriveKeySHA256(extensionId);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return JSON.parse(new TextDecoder().decode(decrypted)) as T;
  } catch {
    return null;
  }
}

/**
 * 加密本地大数据块（V3 格式，密钥与扩展 ID 解耦）
 */
export async function encryptLocalBlob(data: unknown): Promise<string> {
  const key = await getOrCreateLocalKey();
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return V3_PREFIX + base64Encode(concatArrays(iv, new Uint8Array(ciphertext)));
}

/**
 * 解密本地大数据块
 * 自动兼容 V3/V2/V1/明文四种格式；损坏数据返回 null
 */
export async function decryptLocalBlob<T>(stored: unknown): Promise<T | null> {
  if (typeof stored !== 'string' || stored.length === 0) {
    return null;
  }

  // V3：持久化密钥（首选）
  if (stored.startsWith(V3_PREFIX)) {
    try {
      const key = await getOrCreateLocalKey();
      const bytes = base64Decode(stored.substring(V3_PREFIX.length));
      const iv = bytes.slice(0, IV_LENGTH);
      const ciphertext = bytes.slice(IV_LENGTH);
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
      return JSON.parse(new TextDecoder().decode(decrypted)) as T;
    } catch (e) {
      console.error('[decryptLocalBlob] V3 解密失败:', e);
      return null;
    }
  }

  // V2：旧派生密钥（向后兼容，扩展 ID 未变时可解）
  if (stored.startsWith(V2_PREFIX)) {
    return tryDecryptV2<T>(stored);
  }

  // V1：更旧派生密钥
  if (stored.startsWith(V1_PREFIX)) {
    return tryDecryptV1<T>(stored);
  }

  // 明文（向后兼容未加密的历史数据）
  try {
    return JSON.parse(stored) as T;
  } catch {
    return null;
  }
}
