/**
 * 安全的本地存储工具
 * 对敏感数据进行加密存储
 */

// 加密前缀，用于识别加密数据
const ENCRYPTION_PREFIX = 'SECURE_V1:';

// 敏感数据的存储键
const SENSITIVE_KEYS = [
  'deviceId',
  'migration_flags',
  'auth_cache',
  'user_preferences',
  'sync_tokens'
];

/**
 * 生成存储密钥
 */
async function generateStorageKey(): Promise<CryptoKey> {
  // 使用扩展ID作为种子生成密钥
  const extensionId = chrome.runtime.id;
  const encoder = new TextEncoder();
  const data = encoder.encode(extensionId + 'storage_key_v1');

  // 使用SHA-256哈希
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);

  // 从哈希生成AES-GCM密钥
  return crypto.subtle.importKey(
    'raw',
    hashBuffer,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * 加密数据
 */
async function encryptData(data: any): Promise<string> {
  try {
    // 将数据转换为JSON字符串
    const jsonString = JSON.stringify(data);
    const encoder = new TextEncoder();
    const plaintext = encoder.encode(jsonString);

    // 生成密钥
    const key = await generateStorageKey();

    // 生成随机IV
    const iv = crypto.getRandomValues(new Uint8Array(12));

    // 加密数据
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv
      },
      key,
      plaintext
    );

    // 将IV和密文合并
    const result = new Uint8Array(iv.length + ciphertext.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(ciphertext), iv.length);

    // 转换为Base64字符串并添加前缀
    return ENCRYPTION_PREFIX + btoa(String.fromCharCode(...result));
  } catch (error) {
    console.error('加密数据失败:', error);
    throw new Error('数据加密失败');
  }
}

/**
 * 解密数据
 */
async function decryptData<T>(encryptedData: string): Promise<T> {
  try {
    // 检查是否为加密数据
    if (!encryptedData.startsWith(ENCRYPTION_PREFIX)) {
      // 如果不是加密数据，直接解析JSON（向后兼容）
      return JSON.parse(encryptedData) as T;
    }

    // 移除前缀并解码Base64
    const base64Data = encryptedData.substring(ENCRYPTION_PREFIX.length);
    const bytes = new Uint8Array(
      atob(base64Data).split('').map(char => char.charCodeAt(0))
    );

    // 提取IV和密文
    const iv = bytes.slice(0, 12);
    const ciphertext = bytes.slice(12);

    // 生成密钥
    const key = await generateStorageKey();

    // 解密数据
    const decrypted = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv
      },
      key,
      ciphertext
    );

    // 将解密后的数据转换为字符串
    const decoder = new TextDecoder();
    const jsonString = decoder.decode(decrypted);

    // 解析JSON
    return JSON.parse(jsonString) as T;
  } catch (error) {
    console.error('解密数据失败:', error);
    throw new Error('数据解密失败');
  }
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
  async set(key: string, value: any): Promise<void> {
    try {
      let dataToStore = value;

      // 如果是敏感数据，进行加密
      if (isSensitiveKey(key)) {
        dataToStore = await encryptData(value);
      }

      await chrome.storage.local.set({ [key]: dataToStore });
    } catch (error) {
      console.error(`存储数据失败 (${key}):`, error);
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

      // 如果是敏感数据，进行解密
      if (isSensitiveKey(key) && typeof storedValue === 'string') {
        try {
          return await decryptData<T>(storedValue);
        } catch (decryptError) {
          console.warn(`解密失败，使用原始数据 (${key}):`, decryptError);
          // 如果解密失败，可能是旧的未加密数据，直接返回
          return storedValue as T;
        }
      }

      return storedValue as T;
    } catch (error) {
      console.error(`获取数据失败 (${key}):`, error);
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
      console.error(`删除数据失败 (${key}):`, error);
      throw error;
    }
  }

  /**
   * 批量存储
   */
  async setMultiple(items: Record<string, any>): Promise<void> {
    try {
      const processedItems: Record<string, any> = {};

      for (const [key, value] of Object.entries(items)) {
        if (isSensitiveKey(key)) {
          processedItems[key] = await encryptData(value);
        } else {
          processedItems[key] = value;
        }
      }

      await chrome.storage.local.set(processedItems);
    } catch (error) {
      console.error('批量存储数据失败:', error);
      throw error;
    }
  }

  /**
   * 批量获取
   */
  async getMultiple<T extends Record<string, any>>(keys: string[]): Promise<Partial<T>> {
    try {
      const result = await chrome.storage.local.get(keys);
      const processedResult: Partial<T> = {};

      for (const key of keys) {
        const storedValue = result[key];

        if (storedValue !== undefined) {
          if (isSensitiveKey(key) && typeof storedValue === 'string') {
            try {
              processedResult[key as keyof T] = await decryptData(storedValue);
            } catch (decryptError) {
              console.warn(`解密失败，使用原始数据 (${key}):`, decryptError);
              (processedResult as any)[key] = storedValue;
            }
          } else {
            processedResult[key as keyof T] = storedValue;
          }
        }
      }

      return processedResult;
    } catch (error) {
      console.error('批量获取数据失败:', error);
      return {};
    }
  }

  /**
   * 清除所有数据
   */
  async clear(): Promise<void> {
    try {
      await chrome.storage.local.clear();
    } catch (error) {
      console.error('清除存储失败:', error);
      throw error;
    }
  }

  /**
   * 迁移现有数据到加密存储
   */
  async migrateToEncrypted(): Promise<void> {
    try {
      console.log('开始迁移敏感数据到加密存储...');

      for (const key of SENSITIVE_KEYS) {
        const result = await chrome.storage.local.get(key);
        const value = result[key];

        if (value !== undefined && typeof value !== 'string') {
          // 如果数据存在且不是字符串（未加密），则加密它
          console.log(`迁移敏感数据: ${key}`);
          await this.set(key, value);
        } else if (value !== undefined && typeof value === 'string' && !value.startsWith(ENCRYPTION_PREFIX)) {
          // 如果是字符串但不是加密数据，也需要加密
          console.log(`迁移字符串数据: ${key}`);
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

// 导出单例实例
export const secureStorage = new SecureStorage();
