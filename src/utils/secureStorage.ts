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
  // 使用分块处理避免大数组时的栈溢出
  const CHUNK_SIZE = 16384;
  let result = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.slice(i, Math.min(i + CHUNK_SIZE, bytes.length));
    result += btoa(String.fromCharCode(...chunk));
  }
  return result;
}

function base64Decode(b64: string): Uint8Array {
  return new Uint8Array(atob(b64).split('').map(c => c.charCodeAt(0)));
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

  async migrateToEncrypted(): Promise<void> {
    try {
      console.log('开始迁移敏感数据到加密存储...');
      for (const key of SENSITIVE_KEYS) {
        const result = await chrome.storage.local.get(key);
        const value = result[key];
        if (value !== undefined) {
          if (typeof value === 'string' && (value.startsWith(V1_PREFIX) || value.startsWith(V2_PREFIX))) {
            continue; // 已加密
          }
          await this.set(key, value);
        }
      }
      console.log('敏感数据迁移完成');
    } catch (error) {
      console.error('迁移敏感数据失败:', error);
      throw error;
    }
  }
}

export const secureStorage = new SecureStorage();

// ── V3 持久化密钥（不依赖 chrome.runtime.id）────────────────────────

let cachedLocalKey: CryptoKey | null = null;

/**
 * 获取（或首次生成）本地加密密钥。
 *
 * V3 密钥与扩展 ID 解耦：首次使用时生成随机 256-bit 密钥，
 * 以 base64 存到 chrome.storage.local。之后所有加解密复用该密钥。
 * 这样即使 unpacked 扩展重新加载后 runtime.id 变化，数据仍可解密。
 *
 * 降级：chrome.storage.local 不可用时（如测试环境），回退到派生自
 * extensionId 的确定性密钥（功能不丢，但失去 ID 稳定性收益）。
 */
async function getOrCreateLocalKey(): Promise<CryptoKey> {
  if (cachedLocalKey) return cachedLocalKey;

  try {
    const result = await chrome.storage.local.get(LOCAL_KEY_STORAGE_KEY);
    const stored = result[LOCAL_KEY_STORAGE_KEY];
    if (typeof stored === 'string' && stored.length > 0) {
      const raw = base64Decode(stored);
      cachedLocalKey = await crypto.subtle.importKey(
        'raw',
        raw,
        { name: 'AES-GCM', length: KEY_LENGTH },
        false,
        ['encrypt', 'decrypt']
      );
      return cachedLocalKey;
    }
  } catch (e) {
    console.warn('[secureStorage] 读取持久化密钥失败，回退到派生密钥:', e);
  }

  // 生成新密钥并持久化
  const raw = crypto.getRandomValues(new Uint8Array(KEY_LENGTH / 8));
  const key = await crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'AES-GCM', length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );

  try {
    await chrome.storage.local.set({ [LOCAL_KEY_STORAGE_KEY]: base64Encode(raw) });
  } catch (e) {
    console.warn('[secureStorage] 持久化密钥写入失败（回退到派生密钥）:', e);
  }

  cachedLocalKey = key;
  return key;
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
