import { TabGroup, TabData, SupabaseTabGroup } from '@/types/tab';
import { secureStorage } from '@/utils/secureStorage';

const V1_PREFIX = 'ENCRYPTED_V1:';
const V2_STANDARD_PREFIX = 'ENCRYPTED_V2_S:';  // 标准 V2 密钥（无 deviceId）
const V2_DEVICE_PREFIX = 'ENCRYPTED_V2_D:';    // 设备绑定 V2 密钥（有 deviceId，用于向后兼容）
const V2_LEGACY_PREFIX = 'ENCRYPTED_V2:';      // 旧版 V2 前缀（无 _S/_D 后缀），语义上等同于 V2_DEVICE，向后兼容老用户云端数据
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
    console.error('加密数据失败:', error);
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
 * 根据前缀解密数据（直接路由，无需 try-catch 版本猜测）
 */
export async function decryptData<T>(encryptedData: string, userId: string): Promise<T> {
  try {
    // V2 标准格式：标准 V2 密钥（无 deviceId）
    if (encryptedData.startsWith(V2_STANDARD_PREFIX)) {
      return decryptV2WithKey<T>(encryptedData, V2_STANDARD_PREFIX, userId, false);
    }

    // V2 设备格式：设备绑定 V2 密钥（有 deviceId，向后兼容）
    if (encryptedData.startsWith(V2_DEVICE_PREFIX)) {
      return decryptV2WithKey<T>(encryptedData, V2_DEVICE_PREFIX, userId, true);
    }

    // V2 旧版前缀（无 _S/_D 后缀）：老用户云端数据，语义等同 V2_DEVICE
    if (encryptedData.startsWith(V2_LEGACY_PREFIX)) {
      return decryptV2WithKey<T>(encryptedData, V2_LEGACY_PREFIX, userId, true);
    }

    // V1 格式：SHA-256（向后兼容）
    if (encryptedData.startsWith(V1_PREFIX)) {
      return decryptV1<T>(encryptedData, userId);
    }

    // 未加密数据
    return JSON.parse(encryptedData) as T;
  } catch (error) {
    console.error('解密数据失败:', error);
    throw new Error('解密数据失败，可能是数据格式不正确或已损坏');
  }
}

export function isEncrypted(data: unknown): boolean {
  return typeof data === 'string' && (
    data.startsWith(V1_PREFIX) ||
    data.startsWith(V2_STANDARD_PREFIX) ||
    data.startsWith(V2_DEVICE_PREFIX) ||
    data.startsWith(V2_LEGACY_PREFIX)
  );
}

export async function encryptTabGroups(groups: TabGroup[], userId: string): Promise<string> {
  return encryptData(groups, userId);
}

export async function decryptTabGroups(encryptedData: string, userId: string): Promise<TabGroup[]> {
  try {
    return await decryptData<TabGroup[]>(encryptedData, userId);
  } catch (error) {
    console.error('解密标签组数据失败:', error);
    try {
      return JSON.parse(encryptedData) as TabGroup[];
    } catch {
      throw new Error('无法解密或解析数据');
    }
  }
}

export async function encryptSupabaseTabGroup(group: SupabaseTabGroup, userId: string): Promise<SupabaseTabGroup> {
  if (!group.tabs_data || group.tabs_data.length === 0) return group;

  const encryptedTabsData = await encryptData(group.tabs_data, userId);
  return { ...group, tabs_data: encryptedTabsData as unknown as TabData[] };
}

export async function decryptSupabaseTabGroup(group: SupabaseTabGroup, userId: string): Promise<SupabaseTabGroup> {
  if (!group.tabs_data) return group;

  if (typeof group.tabs_data === 'string') {
    try {
      const decryptedTabsData = await decryptData<TabData[]>(group.tabs_data, userId);
      return { ...group, tabs_data: decryptedTabsData };
    } catch (error) {
      console.error(`解密标签组 ${group.id} 的数据失败:`, error);
      return { ...group, tabs_data: [] };
    }
  }

  return group;
}
