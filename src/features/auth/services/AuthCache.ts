/**
 * 认证状态缓存服务
 * 提供安全的本地认证状态缓存和恢复机制
 */
import { logger } from '@/shared/utils/logger';
import { User, AuthSession } from '../store/authSlice';

export interface CachedAuthState {
  user: User;
  session?: AuthSession;
  timestamp: number;
  deviceFingerprint: string;
}

class AuthCache {
  private readonly CACHE_KEY = 'onetab_auth_cache';
  private readonly CACHE_EXPIRY = 30 * 24 * 60 * 60 * 1000; // 30天
  private readonly FINGERPRINT_KEY = 'onetab_device_fp';
  private deviceFingerprint: string | null = null;

  constructor() {
    this.initializeDeviceFingerprint();
  }

  /**
   * 缓存认证状态
   */
  async cacheAuthState(user: User, session?: AuthSession): Promise<void> {
    try {
      const fingerprint = await this.getDeviceFingerprint();
      
      const cacheData: CachedAuthState = {
        user,
        session,
        timestamp: Date.now(),
        deviceFingerprint: fingerprint,
      };

      // 加密敏感数据
      const encryptedData = await this.encryptData(JSON.stringify(cacheData));
      
      // 存储到Chrome扩展存储
      await chrome.storage.local.set({
        [this.CACHE_KEY]: encryptedData,
      });

      logger.debug('认证状态已缓存', { 
        userId: user.id,
        hasSession: !!session,
        timestamp: cacheData.timestamp,
      });

    } catch (error) {
      logger.error('缓存认证状态失败', error);
      // 不抛出错误，缓存失败不应该影响正常登录流程
    }
  }

  /**
   * 获取缓存的认证状态
   */
  async getAuthState(): Promise<CachedAuthState | null> {
    try {
      const result = await chrome.storage.local.get(this.CACHE_KEY);
      const encryptedData = result[this.CACHE_KEY];

      if (!encryptedData) {
        logger.debug('没有找到缓存的认证状态');
        return null;
      }

      // 解密数据
      const decryptedData = await this.decryptData(encryptedData);
      const cacheData: CachedAuthState = JSON.parse(decryptedData);

      // 验证缓存时效性
      const now = Date.now();
      if (now - cacheData.timestamp > this.CACHE_EXPIRY) {
        logger.debug('缓存的认证状态已过期', { 
          age: now - cacheData.timestamp,
          expiry: this.CACHE_EXPIRY,
        });
        await this.clearAuthState();
        return null;
      }

      // 验证设备指纹
      const currentFingerprint = await this.getDeviceFingerprint();
      if (cacheData.deviceFingerprint !== currentFingerprint) {
        logger.warn('设备指纹不匹配，清除缓存的认证状态', {
          cached: cacheData.deviceFingerprint.substring(0, 8) + '...',
          current: currentFingerprint.substring(0, 8) + '...',
        });
        await this.clearAuthState();
        return null;
      }

      // 验证会话有效性
      if (cacheData.session && this.isSessionExpired(cacheData.session)) {
        logger.debug('缓存的会话已过期');
        // 保留用户信息，但清除会话
        return {
          ...cacheData,
          session: undefined,
        };
      }

      logger.debug('成功获取缓存的认证状态', { 
        userId: cacheData.user.id,
        hasSession: !!cacheData.session,
        age: now - cacheData.timestamp,
      });

      return cacheData;

    } catch (error) {
      logger.error('获取缓存认证状态失败', error);
      // 清理可能损坏的缓存
      await this.clearAuthState();
      return null;
    }
  }

  /**
   * 清除缓存的认证状态
   */
  async clearAuthState(): Promise<void> {
    try {
      await chrome.storage.local.remove(this.CACHE_KEY);
      logger.debug('认证状态缓存已清除');
    } catch (error) {
      logger.error('清除认证状态缓存失败', error);
    }
  }

  /**
   * 更新缓存的用户信息
   */
  async updateCachedUser(userUpdates: Partial<User>): Promise<void> {
    try {
      const cachedState = await this.getAuthState();
      if (!cachedState) {
        return;
      }

      const updatedUser = { ...cachedState.user, ...userUpdates };
      await this.cacheAuthState(updatedUser, cachedState.session);

      logger.debug('缓存的用户信息已更新', userUpdates);

    } catch (error) {
      logger.error('更新缓存用户信息失败', error);
    }
  }

  /**
   * 获取或生成设备指纹
   */
  private async getDeviceFingerprint(): Promise<string> {
    if (this.deviceFingerprint) {
      return this.deviceFingerprint;
    }

    try {
      const result = await chrome.storage.local.get(this.FINGERPRINT_KEY);
      let fingerprint = result[this.FINGERPRINT_KEY];

      if (!fingerprint) {
        fingerprint = await this.generateDeviceFingerprint();
        await chrome.storage.local.set({
          [this.FINGERPRINT_KEY]: fingerprint,
        });
        logger.debug('生成新的设备指纹');
      }

      this.deviceFingerprint = fingerprint;
      return fingerprint;

    } catch (error) {
      logger.error('获取设备指纹失败', error);
      // 返回一个临时指纹
      return 'temp_fingerprint_' + Date.now();
    }
  }

  /**
   * 生成设备指纹
   */
  private async generateDeviceFingerprint(): Promise<string> {
    try {
      // 收集设备特征
      const features = [
        navigator.userAgent,
        navigator.language,
        navigator.platform,
        screen.width + 'x' + screen.height,
        new Date().getTimezoneOffset().toString(),
        navigator.hardwareConcurrency?.toString() || '0',
      ];

      // 添加扩展ID（如果可用）
      if (chrome.runtime?.id) {
        features.push(chrome.runtime.id);
      }

      // 生成随机salt
      const randomBytes = new Uint8Array(16);
      crypto.getRandomValues(randomBytes);
      const salt = Array.from(randomBytes, byte => 
        byte.toString(16).padStart(2, '0')
      ).join('');

      features.push(salt);

      // 计算哈希
      const combinedFeatures = features.join('|');
      const encoder = new TextEncoder();
      const data = encoder.encode(combinedFeatures);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    } catch (error) {
      logger.error('生成设备指纹失败', error);
      // 回退到简单的随机指纹
      return 'fallback_' + Math.random().toString(36).substring(2, 15);
    }
  }

  /**
   * 初始化设备指纹
   */
  private async initializeDeviceFingerprint(): Promise<void> {
    try {
      await this.getDeviceFingerprint();
    } catch (error) {
      logger.error('初始化设备指纹失败', error);
    }
  }

  /**
   * 检查会话是否过期
   */
  private isSessionExpired(session: AuthSession): boolean {
    try {
      const expiresAt = new Date(session.expiresAt).getTime();
      const now = Date.now();
      // 提前5分钟判断过期，给刷新token留时间
      const bufferTime = 5 * 60 * 1000;
      
      return now >= (expiresAt - bufferTime);
    } catch (error) {
      logger.error('检查会话过期状态失败', error);
      return true; // 出错时认为已过期
    }
  }

  /**
   * 加密数据
   */
  private async encryptData(data: string): Promise<string> {
    try {
      // 生成密钥
      const password = await this.getDeviceFingerprint();
      const encoder = new TextEncoder();
      const passwordData = encoder.encode(password);
      
      const key = await crypto.subtle.importKey(
        'raw',
        passwordData.slice(0, 32), // 使用前32字节作为密钥
        { name: 'AES-GCM' },
        false,
        ['encrypt']
      );

      // 生成IV
      const iv = crypto.getRandomValues(new Uint8Array(12));
      
      // 加密
      const dataBuffer = encoder.encode(data);
      const encryptedBuffer = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        dataBuffer
      );

      // 组合IV和加密数据
      const combined = new Uint8Array(iv.length + encryptedBuffer.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(encryptedBuffer), iv.length);

      // 转换为Base64
      return btoa(String.fromCharCode.apply(null, Array.from(combined)));

    } catch (error) {
      logger.error('数据加密失败', error);
      // 回退到Base64编码（不安全，但至少可用）
      return btoa(data);
    }
  }

  /**
   * 解密数据
   */
  private async decryptData(encryptedData: string): Promise<string> {
    try {
      // 生成密钥
      const password = await this.getDeviceFingerprint();
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const passwordData = encoder.encode(password);
      
      const key = await crypto.subtle.importKey(
        'raw',
        passwordData.slice(0, 32),
        { name: 'AES-GCM' },
        false,
        ['decrypt']
      );

      // 解析Base64
      const combined = new Uint8Array(
        atob(encryptedData).split('').map(char => char.charCodeAt(0))
      );

      // 分离IV和加密数据
      const iv = combined.slice(0, 12);
      const encrypted = combined.slice(12);

      // 解密
      const decryptedBuffer = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        encrypted
      );

      return decoder.decode(decryptedBuffer);

    } catch (error) {
      logger.error('数据解密失败', error);
      // 回退到Base64解码
      try {
        return atob(encryptedData);
      } catch (fallbackError) {
        throw new Error('数据解密失败，缓存可能已损坏');
      }
    }
  }
}

// 导出单例实例
export const authCache = new AuthCache();

// 为了方便测试，也导出类
export { AuthCache };