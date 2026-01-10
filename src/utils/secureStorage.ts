/**
 * 安全的本地存储工具
 * 对敏感数据进行加密存储
 * 
 * 改进：使用 Web Crypto API 生成随机主密钥，而非扩展 ID
 */

import { logSanitizer } from './logSanitizer';

// 加密前缀，V2 表示使用随机密钥
const ENCRYPTION_PREFIX_V2 = 'SECURE_V2:';
// 兼容旧版本
const ENCRYPTION_PREFIX_V1 = 'SECURE_V1:';

// 主密钥存储键
const MASTER_KEY_STORAGE = 'secure_master_key';

// 敏感数据的存储键
const SENSITIVE_KEYS = [
  'deviceId',
  'migration_flags',
  'auth_cache',
  'user_preferences',
  'sync_tokens'
];

// 缓存的主密钥
let cachedMasterKey: CryptoKey | null = null;

/**
 * 获取或创建主密钥
 * 使用 Web Crypto API 生成真正随机的密钥
 */
async function getOrCreateMasterKey(): Promise<CryptoKey> {
  // 如果有缓存，直接返回
  if (cachedMasterKey) {
    return cachedMasterKey;
  }

  try {
    // 尝试从 session storage 获取（更安全，浏览器关闭后清除）
    const result = await chrome.storage.session?.get(MASTER_KEY_STORAGE);
    if (result?.[MASTER_KEY_STORAGE]) {
      const keyData = result[MASTER_KEY_STORAGE];
      cachedMasterKey = await crypto.subtle.importKey(
        'raw',
        new Uint8Array(keyData),
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt']
      );
      return cachedMasterKey;
    }
  } catch {
    // session storage 可能不可用
  }

  try {
    // 尝试从 local storage 获取
    const result = await chrome.storage.local.get(MASTER_KEY_STORAGE);
    if (result[MASTER_KEY_STORAGE]) {
      const keyData = result[MASTER_KEY_STORAGE];
      cachedMasterKey = await crypto.subtle.importKey(
        'raw',
        new Uint8Array(keyData),
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt']
      );
      return cachedMasterKey;
    }
  } catch {
    // 继续创建新密钥
  }

  // 生成新的随机密钥
  cachedMasterKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );

  // 导出密钥以便存储
  const exportedKey = await crypto.subtle.exportKey('raw', cachedMasterKey);
  const keyArray = Array.from(new Uint8Array(exportedKey));

  // 存储到 session storage（如果可用）和 local storage
  try {
    await chrome.storage.session?.set({ [MASTER_KEY_STORAGE]: keyArray });
  } catch {
    // session storage 可能不可用
  }
  
  try {
    await chrome.storage.local.set({ [MASTER_KEY_STORAGE]: keyArray });
  } catch {
    // 存储失败，但密钥仍在内存中可用
  }

  return cachedMasterKey;
}

/**
 * 生成存储密钥（兼容旧版本）
 */
async function generateStorageKeyV1(): Promise<CryptoKey> {
  const extensionId = chrome.runtime.id;
  const encoder = new TextEncoder();
  const data = encoder.encode(extensionId + 'storage_key_v1');
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return crypto.subtle.importKey(
    'raw',
    hashBuffer,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
}

/**
 * 加密数据（V2 - 使用随机主密钥）
 */
async function encryptData(data: unknown): Promise<string> {
  try {
    const jsonString = JSON.stringify(data);
    const encoder = new TextEncoder();
    const plaintext = encoder.encode(jsonString);

    const key = await getOrCreateMasterKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      plaintext
    );

    const result = new Uint8Array(iv.length + ciphertext.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(ciphertext), iv.length);

    return ENCRYPTION_PREFIX_V2 + btoa(String.fromCharCode(...result));
  } catch {
    throw new Error('数据加密失败');
  }
}

/**
 * 解密数据（支持 V1 和 V2）
 */
async function decryptData<T>(encryptedData: string): Promise<T> {
  try {
    if (encryptedData.startsWith(ENCRYPTION_PREFIX_V2)) {
      return await decryptDataV2<T>(encryptedData);
    } else if (encryptedData.startsWith(ENCRYPTION_PREFIX_V1)) {
      return await decryptDataV1<T>(encryptedData);
    } else {
      return JSON.parse(encryptedData) as T;
    }
  } catch {
    throw new Error('数据解密失败');
  }
}

/**
 * V2 解密
 */
async function decryptDataV2<T>(encryptedData: string): Promise<T> {
  const base64Data = encryptedData.substring(ENCRYPTION_PREFIX_V2.length);
  const bytes = new Uint8Array(
    atob(base64Data).split('').map(char => char.charCodeAt(0))
  );

  const iv = bytes.slice(0, 12);
  const ciphertext = bytes.slice(12);

  const key = await getOrCreateMasterKey();
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );

  const decoder = new TextDecoder();
  const jsonString = decoder.decode(decrypted);
  return JSON.parse(jsonString) as T;
}

/**
 * V1 解密（兼容旧版本）
 */
async function decryptDataV1<T>(encryptedData: string): Promise<T> {
  const base64Data = encryptedData.substring(ENCRYPTION_PREFIX_V1.length);
  const bytes = new Uint8Array(
    atob(base64Data).split('').map(char => char.charCodeAt(0))
  );

  const iv = bytes.slice(0, 12);
  const ciphertext = bytes.slice(12);

  const key = await generateStorageKeyV1();
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );

  const decoder = new TextDecoder();
  const jsonString = decoder.decode(decrypted);
  return JSON.parse(jsonString) as T;
}

/**
 * 检查是否为敏感数据键
 */
function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.some(sensitiveKey =>
    key === sensitiveKey || key.includes(sensitiveKey)
  );
}

/**
 * 安全存储类
 */
export class SecureStorage {
  /**
   * 存储数据
   */
  async set(key: string, value: unknown): Promise<void> {
    try {
      let dataToStore = value;

      if (isSensitiveKey(key)) {
        dataToStore = await encryptData(value);
      }

      await chrome.storage.local.set({ [key]: dataToStore });
    } catch (error) {
      logSanitizer.error('存储数据失败', key);
      throw error;
    }
  }

  /**
   * 获取数据
   */
  async get<T>(key: string, defaultValue?: T): Promise<T | undefined> {
    try {
      const result = await chrome.storage.local.get(key);
      const storedValue = result[key];

      if (storedValue === undefined) {
        return defaultValue;
      }

      if (isSensitiveKey(key) && typeof storedValue === 'string') {
        try {
          return await decryptData<T>(storedValue);
        } catch {
          logSanitizer.warn('解密失败，使用原始数据', key);
          return storedValue as T;
        }
      }

      return storedValue as T;
    } catch {
      logSanitizer.error('获取数据失败', key);
      return defaultValue;
    }
  }

  /**
   * 删除数据
   */
  async remove(key: string): Promise<void> {
    try {
      await chrome.storage.local.remove(key);
    } catch (error) {
      logSanitizer.error('删除数据失败', key);
      throw error;
    }
  }

  /**
   * 批量存储
   */
  async setMultiple(items: Record<string, unknown>): Promise<void> {
    try {
      const processedItems: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(items)) {
        if (isSensitiveKey(key)) {
          processedItems[key] = await encryptData(value);
        } else {
          processedItems[key] = value;
        }
      }

      await chrome.storage.local.set(processedItems);
    } catch (error) {
      logSanitizer.error('批量存储数据失败');
      throw error;
    }
  }

  /**
   * 批量获取
   */
  async getMultiple<T extends Record<string, unknown>>(keys: string[]): Promise<Partial<T>> {
    try {
      const result = await chrome.storage.local.get(keys);
      const processedResult: Partial<T> = {};

      for (const key of keys) {
        const storedValue = result[key];

        if (storedValue !== undefined) {
          if (isSensitiveKey(key) && typeof storedValue === 'string') {
            try {
              processedResult[key as keyof T] = await decryptData(storedValue);
            } catch {
              logSanitizer.warn('解密失败，使用原始数据', key);
              (processedResult as Record<string, unknown>)[key] = storedValue;
            }
          } else {
            processedResult[key as keyof T] = storedValue;
          }
        }
      }

      return processedResult;
    } catch {
      logSanitizer.error('批量获取数据失败');
      return {};
    }
  }

  /**
   * 清除所有数据
   */
  async clear(): Promise<void> {
    try {
      await chrome.storage.local.clear();
      cachedMasterKey = null;
    } catch (error) {
      logSanitizer.error('清除存储失败');
      throw error;
    }
  }

  /**
   * 迁移现有数据到加密存储
   */
  async migrateToEncrypted(): Promise<void> {
    try {
      logSanitizer.info('开始迁移敏感数据到加密存储...');

      for (const key of SENSITIVE_KEYS) {
        const result = await chrome.storage.local.get(key);
        const value = result[key];

        if (value !== undefined && typeof value !== 'string') {
          logSanitizer.info('迁移敏感数据', key);
          await this.set(key, value);
        } else if (value !== undefined && typeof value === 'string' && 
                   !value.startsWith(ENCRYPTION_PREFIX_V1) && 
                   !value.startsWith(ENCRYPTION_PREFIX_V2)) {
          logSanitizer.info('迁移字符串数据', key);
          await this.set(key, value);
        }
      }

      logSanitizer.info('敏感数据迁移完成');
    } catch (error) {
      logSanitizer.error('迁移敏感数据失败');
      throw error;
    }
  }
}

// 导出单例实例
export const secureStorage = new SecureStorage();
