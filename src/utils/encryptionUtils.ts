import { TabGroup, TabData, SupabaseTabGroup } from '@/types/tab';

// 加密数据的前缀标记，用于识别数据是否已加密
const ENCRYPTION_PREFIX = 'ENCRYPTED_V1:';

/**
 * 从用户ID生成加密密钥
 * @param userId 用户ID
 * @returns 生成的加密密钥
 */
async function generateKeyFromUserId(userId: string): Promise<CryptoKey> {
  // 使用用户ID作为种子生成密钥
  const encoder = new TextEncoder();
  const data = encoder.encode(userId);
  
  // 使用SHA-256哈希用户ID
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
 * @param data 要加密的数据
 * @param userId 用户ID，用于生成密钥
 * @returns 加密后的字符串
 */
export async function encryptData(data: any, userId: string): Promise<string> {
  try {
    // 将数据转换为JSON字符串
    const jsonString = JSON.stringify(data);
    const encoder = new TextEncoder();
    const plaintext = encoder.encode(jsonString);
    
    // 生成密钥
    const key = await generateKeyFromUserId(userId);
    
    // 生成随机IV（初始化向量）
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
    throw new Error('加密数据失败');
  }
}

/**
 * 解密数据
 * @param encryptedData 加密后的字符串
 * @param userId 用户ID，用于生成密钥
 * @returns 解密后的数据
 */
export async function decryptData<T>(encryptedData: string, userId: string): Promise<T> {
  try {
    // 检查是否是加密数据
    if (!encryptedData.startsWith(ENCRYPTION_PREFIX)) {
      // 如果不是加密数据，尝试直接解析JSON
      return JSON.parse(encryptedData) as T;
    }
    
    // 移除前缀
    const encryptedString = encryptedData.substring(ENCRYPTION_PREFIX.length);
    
    // 将Base64字符串转换回二进制数据
    const binaryString = atob(encryptedString);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    // 提取IV和密文
    const iv = bytes.slice(0, 12);
    const ciphertext = bytes.slice(12);
    
    // 生成密钥
    const key = await generateKeyFromUserId(userId);
    
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
    throw new Error('解密数据失败，可能是数据格式不正确或已损坏');
  }
}

/**
 * 检查数据是否已加密
 * @param data 要检查的数据
 * @returns 是否已加密
 */
export function isEncrypted(data: string): boolean {
  return typeof data === 'string' && data.startsWith(ENCRYPTION_PREFIX);
}

/**
 * 加密标签组数据
 * @param groups 标签组数组
 * @param userId 用户ID
 * @returns 加密后的字符串
 */
export async function encryptTabGroups(groups: TabGroup[], userId: string): Promise<string> {
  return encryptData(groups, userId);
}

/**
 * 解密标签组数据
 * @param encryptedData 加密后的字符串
 * @param userId 用户ID
 * @returns 解密后的标签组数组
 */
export async function decryptTabGroups(encryptedData: string, userId: string): Promise<TabGroup[]> {
  // 尝试解密数据
  try {
    return await decryptData<TabGroup[]>(encryptedData, userId);
  } catch (error) {
    console.error('解密标签组数据失败:', error);
    
    // 如果解密失败，尝试直接解析JSON（可能是旧的未加密数据）
    try {
      return JSON.parse(encryptedData) as TabGroup[];
    } catch (jsonError) {
      console.error('解析JSON失败:', jsonError);
      throw new Error('无法解密或解析数据');
    }
  }
}

/**
 * 加密Supabase标签组数据
 * @param group Supabase标签组
 * @param userId 用户ID
 * @returns 加密后的Supabase标签组
 */
export async function encryptSupabaseTabGroup(group: SupabaseTabGroup, userId: string): Promise<SupabaseTabGroup> {
  // 如果没有标签数据，直接返回原始组
  if (!group.tabs_data || group.tabs_data.length === 0) {
    return group;
  }
  
  // 加密标签数据
  const encryptedTabsData = await encryptData(group.tabs_data, userId);
  
  // 返回带有加密标签数据的组
  return {
    ...group,
    tabs_data: encryptedTabsData as any // 类型转换，实际存储的是加密字符串
  };
}

/**
 * 解密Supabase标签组数据
 * @param group Supabase标签组
 * @param userId 用户ID
 * @returns 解密后的Supabase标签组
 */
export async function decryptSupabaseTabGroup(group: SupabaseTabGroup, userId: string): Promise<SupabaseTabGroup> {
  // 如果没有标签数据，直接返回原始组
  if (!group.tabs_data) {
    return group;
  }
  
  // 检查标签数据是否是字符串（加密数据）
  if (typeof group.tabs_data === 'string') {
    try {
      // 解密标签数据
      const decryptedTabsData = await decryptData<TabData[]>(group.tabs_data, userId);
      
      // 返回带有解密标签数据的组
      return {
        ...group,
        tabs_data: decryptedTabsData
      };
    } catch (error) {
      console.error(`解密标签组 ${group.id} 的数据失败:`, error);
      // 如果解密失败，返回原始组但清空标签数据
      return {
        ...group,
        tabs_data: []
      };
    }
  }
  
  // 如果标签数据不是字符串，假设它已经是解密的数据（旧格式）
  return group;
}
