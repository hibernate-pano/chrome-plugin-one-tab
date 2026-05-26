import { TabGroup, TabData, SupabaseTabGroup } from '@/types/tab';
import { secureStorage } from '@/utils/secureStorage';

const V1_PREFIX = 'ENCRYPTED_V1:';
const V2_PREFIX = 'ENCRYPTED_V2:';
const PBKDF2_ITERATIONS = 100_000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const KEY_LENGTH = 256;

/**
 * PBKDF2 密钥派生（V2）
 * 使用 userId + deviceId 进行设备绑定的密钥派生
 */
async function deriveKeyPBKDF2(userId: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  // 获取设备ID用于设备绑定的密钥派生
  const deviceId = await secureStorage.get<string>('deviceId').catch(() => '');
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(userId + (deviceId || '')),
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
  return btoa(String.fromCharCode(...bytes));
}

function base64Decode(b64: string): Uint8Array {
  return new Uint8Array(atob(b64).split('').map(c => c.charCodeAt(0)));
}

/**
 * 加密数据（始终使用 PBKDF2 V2 格式）
 */
export async function encryptData<T>(data: T, userId: string): Promise<string> {
  try {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const key = await deriveKeyPBKDF2(userId, salt);
    const plaintext = new TextEncoder().encode(JSON.stringify(data));
    const { iv, ciphertext } = await encryptBytes(plaintext, key);

    return V2_PREFIX + base64Encode(concatArrays(salt, iv, new Uint8Array(ciphertext)));
  } catch (error) {
    console.error('加密数据失败:', error);
    throw new Error('加密数据失败');
  }
}

/**
 * 解密数据（自动识别 V1/V2 格式）
 */
export async function decryptData<T>(encryptedData: string, userId: string): Promise<T> {
  try {
    // V2 格式：PBKDF2 + salt
    if (encryptedData.startsWith(V2_PREFIX)) {
      const bytes = base64Decode(encryptedData.substring(V2_PREFIX.length));
      const salt = bytes.slice(0, SALT_LENGTH);
      const iv = bytes.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
      const ciphertext = bytes.slice(SALT_LENGTH + IV_LENGTH);

      const key = await deriveKeyPBKDF2(userId, salt);
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
      return JSON.parse(new TextDecoder().decode(decrypted)) as T;
    }

    // V1 格式：SHA-256（向后兼容）
    if (encryptedData.startsWith(V1_PREFIX)) {
      const bytes = base64Decode(encryptedData.substring(V1_PREFIX.length));
      const iv = bytes.slice(0, IV_LENGTH);
      const ciphertext = bytes.slice(IV_LENGTH);
      const key = await deriveKeySHA256(userId);
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
      return JSON.parse(new TextDecoder().decode(decrypted)) as T;
    }

    // 未加密数据
    return JSON.parse(encryptedData) as T;
  } catch (error) {
    console.error('解密数据失败:', error);
    throw new Error('解密数据失败，可能是数据格式不正确或已损坏');
  }
}

export function isEncrypted(data: unknown): boolean {
  return typeof data === 'string' && (data.startsWith(V1_PREFIX) || data.startsWith(V2_PREFIX));
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
