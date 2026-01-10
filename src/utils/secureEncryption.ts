/**
 * 安全加密模块 - 使用 PBKDF2 密钥派生
 * 
 * 改进点：
 * 1. 使用 PBKDF2 替代简单的 SHA-256 哈希
 * 2. 为每个用户生成唯一的随机盐值
 * 3. 迭代次数 >= 100000 次
 */

// 加密数据的前缀标记，V2 表示使用 PBKDF2
const ENCRYPTION_PREFIX_V2 = 'ENCRYPTED_V2:';
// 兼容旧版本
const ENCRYPTION_PREFIX_V1 = 'ENCRYPTED_V1:';

// PBKDF2 配置
const PBKDF2_CONFIG = {
  iterations: 100000,
  hash: 'SHA-256',
  keyLength: 256,
} as const;

// 盐值长度（字节）
const SALT_LENGTH = 16;

// 盐值存储键前缀
const SALT_STORAGE_KEY = 'user_salt_';

/**
 * 盐值信息接口
 */
interface SaltInfo {
  salt: string; // Base64 编码的盐值
  createdAt: string;
  version: number;
}

/**
 * 生成随机盐值
 */
export function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
}

/**
 * 将 Uint8Array 转换为 Base64 字符串
 */
function uint8ArrayToBase64(array: Uint8Array): string {
  return btoa(String.fromCharCode(...array));
}

/**
 * 将 Base64 字符串转换为 Uint8Array
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * 获取或创建用户盐值
 */
export async function getOrCreateSalt(userId: string): Promise<SaltInfo> {
  const storageKey = SALT_STORAGE_KEY + userId;
  
  try {
    // 尝试从存储中获取盐值
    const result = await chrome.storage.local.get(storageKey);
    const existingSalt = result[storageKey] as SaltInfo | undefined;
    
    if (existingSalt && existingSalt.salt) {
      return existingSalt;
    }
  } catch {
    // 存储访问失败，继续创建新盐值
  }
  
  // 创建新盐值
  const newSalt: SaltInfo = {
    salt: uint8ArrayToBase64(generateSalt()),
    createdAt: new Date().toISOString(),
    version: 2,
  };
  
  // 存储盐值
  try {
    await chrome.storage.local.set({ [storageKey]: newSalt });
  } catch {
    // 存储失败，但仍返回盐值（内存中使用）
  }
  
  return newSalt;
}

/**
 * 使用 PBKDF2 派生密钥
 */
export async function deriveKey(userId: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(userId),
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey']
  );
  
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_CONFIG.iterations,
      hash: PBKDF2_CONFIG.hash,
    },
    keyMaterial,
    { name: 'AES-GCM', length: PBKDF2_CONFIG.keyLength },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * 安全加密数据
 */
export async function secureEncrypt<T>(data: T, userId: string): Promise<string> {
  try {
    // 获取或创建盐值
    const saltInfo = await getOrCreateSalt(userId);
    const salt = base64ToUint8Array(saltInfo.salt);
    
    // 派生密钥
    const key = await deriveKey(userId, salt);
    
    // 将数据转换为 JSON 字符串
    const jsonString = JSON.stringify(data);
    const encoder = new TextEncoder();
    const plaintext = encoder.encode(jsonString);
    
    // 生成随机 IV
    const iv = crypto.getRandomValues(new Uint8Array(12));
    
    // 加密数据
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      plaintext
    );
    
    // 组合格式: salt(16) + iv(12) + ciphertext
    const result = new Uint8Array(salt.length + iv.length + ciphertext.byteLength);
    result.set(salt, 0);
    result.set(iv, salt.length);
    result.set(new Uint8Array(ciphertext), salt.length + iv.length);
    
    // 转换为 Base64 并添加前缀
    return ENCRYPTION_PREFIX_V2 + uint8ArrayToBase64(result);
  } catch {
    throw new Error('数据加密失败，请重试');
  }
}

/**
 * 安全解密数据
 */
export async function secureDecrypt<T>(encryptedData: string, userId: string): Promise<T> {
  try {
    // 检查版本前缀
    if (encryptedData.startsWith(ENCRYPTION_PREFIX_V2)) {
      return await decryptV2<T>(encryptedData, userId);
    } else if (encryptedData.startsWith(ENCRYPTION_PREFIX_V1)) {
      // 兼容旧版本
      return await decryptV1<T>(encryptedData, userId);
    } else {
      // 尝试直接解析 JSON（未加密数据）
      return JSON.parse(encryptedData) as T;
    }
  } catch {
    throw new Error('数据解密失败，数据可能已损坏');
  }
}

/**
 * V2 解密（PBKDF2）
 */
async function decryptV2<T>(encryptedData: string, userId: string): Promise<T> {
  // 移除前缀并解码
  const base64Data = encryptedData.substring(ENCRYPTION_PREFIX_V2.length);
  const bytes = base64ToUint8Array(base64Data);
  
  // 提取 salt、iv 和密文
  const salt = bytes.slice(0, SALT_LENGTH);
  const iv = bytes.slice(SALT_LENGTH, SALT_LENGTH + 12);
  const ciphertext = bytes.slice(SALT_LENGTH + 12);
  
  // 派生密钥
  const key = await deriveKey(userId, salt);
  
  // 解密
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );
  
  // 解析 JSON
  const decoder = new TextDecoder();
  const jsonString = decoder.decode(decrypted);
  return JSON.parse(jsonString) as T;
}

/**
 * V1 解密（兼容旧版本 SHA-256）
 */
async function decryptV1<T>(encryptedData: string, userId: string): Promise<T> {
  // 移除前缀
  const encryptedString = encryptedData.substring(ENCRYPTION_PREFIX_V1.length);
  
  // 解码 Base64
  const bytes = base64ToUint8Array(encryptedString);
  
  // 提取 IV 和密文
  const iv = bytes.slice(0, 12);
  const ciphertext = bytes.slice(12);
  
  // 使用旧的密钥生成方式
  const encoder = new TextEncoder();
  const data = encoder.encode(userId);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const key = await crypto.subtle.importKey(
    'raw',
    hashBuffer,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  
  // 解密
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );
  
  // 解析 JSON
  const decoder = new TextDecoder();
  const jsonString = decoder.decode(decrypted);
  return JSON.parse(jsonString) as T;
}

/**
 * 检查数据是否已加密
 */
export function isSecureEncrypted(data: string): boolean {
  return typeof data === 'string' && 
    (data.startsWith(ENCRYPTION_PREFIX_V2) || data.startsWith(ENCRYPTION_PREFIX_V1));
}

/**
 * 获取 PBKDF2 配置（用于测试验证）
 */
export function getPBKDF2Config() {
  return { ...PBKDF2_CONFIG };
}
