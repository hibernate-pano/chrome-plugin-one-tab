import { TabGroup, TabData, SupabaseTabGroup } from '@/types/tab';
import { 
  secureEncrypt, 
  secureDecrypt, 
  isSecureEncrypted 
} from './secureEncryption';

/**
 * 加密数据 - 使用安全的 PBKDF2 密钥派生
 * @param data 要加密的数据
 * @param userId 用户ID，用于生成密钥
 * @returns 加密后的字符串
 */
export async function encryptData<T>(data: T, userId: string): Promise<string> {
  return secureEncrypt(data, userId);
}

/**
 * 解密数据 - 支持 V1 和 V2 格式
 * @param encryptedData 加密后的字符串
 * @param userId 用户ID，用于生成密钥
 * @returns 解密后的数据
 */
export async function decryptData<T>(encryptedData: string, userId: string): Promise<T> {
  return secureDecrypt<T>(encryptedData, userId);
}

/**
 * 检查数据是否已加密
 * @param data 要检查的数据
 * @returns 是否已加密
 */
export function isEncrypted(data: string): boolean {
  return isSecureEncrypted(data);
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
    tabs_data: encryptedTabsData as unknown as TabData[] // 类型转换，实际存储的是加密字符串
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
