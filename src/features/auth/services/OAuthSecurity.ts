/**
 * OAuth安全服务
 * 提供更强的OAuth状态验证和安全机制
 */
import { logger } from '@/shared/utils/logger';

export interface OAuthState {
  value: string;
  timestamp: number;
  provider: string;
  nonce: string;
}

export interface OAuthConfig {
  clientId: string;
  redirectUri: string;
  scope: string[];
  provider: string;
}

class OAuthSecurity {
  private readonly stateStorage = new Map<string, OAuthState>();
  private readonly STATE_EXPIRY = 10 * 60 * 1000; // 10分钟过期
  private readonly NONCE_LENGTH = 32;

  /**
   * 生成安全的OAuth状态码
   */
  async generateSecureState(provider: string): Promise<string> {
    try {
      // 生成随机字节
      const randomBytes = new Uint8Array(32);
      crypto.getRandomValues(randomBytes);
      
      // 转换为十六进制字符串
      const randomHex = Array.from(randomBytes, byte => 
        byte.toString(16).padStart(2, '0')
      ).join('');
      
      // 生成nonce
      const nonceBytes = new Uint8Array(this.NONCE_LENGTH);
      crypto.getRandomValues(nonceBytes);
      const nonce = Array.from(nonceBytes, byte => 
        byte.toString(16).padStart(2, '0')
      ).join('');
      
      // 添加时间戳和提供商信息
      const timestamp = Date.now();
      const combinedData = `${provider}:${timestamp}:${randomHex}:${nonce}`;
      
      // 使用SHA-256哈希
      const hash = await this.hashString(combinedData);
      const state = `${hash.substring(0, 32)}.${timestamp}`;
      
      // 存储状态信息
      this.stateStorage.set(state, {
        value: state,
        timestamp,
        provider,
        nonce,
      });
      
      logger.debug('生成OAuth状态码', { provider, state: state.substring(0, 16) + '...' });
      
      return state;
      
    } catch (error) {
      logger.error('生成OAuth状态码失败', error);
      throw new Error('无法生成安全的状态码');
    }
  }

  /**
   * 验证OAuth回调状态码
   */
  validateCallback(state: string, provider: string): boolean {
    try {
      const storedState = this.stateStorage.get(state);
      
      if (!storedState) {
        logger.warn('OAuth状态验证失败：状态码不存在', { state: state.substring(0, 16) + '...' });
        return false;
      }
      
      // 检查过期时间
      const now = Date.now();
      if (now - storedState.timestamp > this.STATE_EXPIRY) {
        logger.warn('OAuth状态验证失败：状态码已过期', { 
          state: state.substring(0, 16) + '...',
          age: now - storedState.timestamp,
        });
        this.stateStorage.delete(state);
        return false;
      }
      
      // 检查提供商匹配
      if (storedState.provider !== provider) {
        logger.warn('OAuth状态验证失败：提供商不匹配', { 
          expected: storedState.provider,
          actual: provider,
        });
        this.stateStorage.delete(state);
        return false;
      }
      
      // 验证通过，清理状态
      this.stateStorage.delete(state);
      
      logger.success('OAuth状态验证成功', { provider });
      return true;
      
    } catch (error) {
      logger.error('OAuth状态验证异常', error);
      return false;
    }
  }

  /**
   * 构建OAuth授权URL
   */
  buildAuthUrl(config: OAuthConfig, state: string): string {
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: config.scope.join(' '),
      state,
    });

    // 根据不同提供商构建URL
    const baseUrls = {
      google: 'https://accounts.google.com/oauth/authorize',
      github: 'https://github.com/login/oauth/authorize',
      wechat: 'https://open.weixin.qq.com/connect/qrconnect',
    };

    const baseUrl = baseUrls[config.provider as keyof typeof baseUrls];
    if (!baseUrl) {
      throw new Error(`不支持的OAuth提供商: ${config.provider}`);
    }

    // 为微信添加特殊参数
    if (config.provider === 'wechat') {
      params.set('appid', config.clientId);
      params.delete('client_id');
      params.set('scope', 'snsapi_login');
      params.append('state', '#wechat_redirect');
    }

    const authUrl = `${baseUrl}?${params.toString()}`;
    
    logger.debug('构建OAuth授权URL', { 
      provider: config.provider,
      url: authUrl.substring(0, 100) + '...',
    });
    
    return authUrl;
  }

  /**
   * 解析OAuth回调参数
   */
  parseCallbackParams(url: string): Record<string, string> {
    try {
      const urlObj = new URL(url);
      const params: Record<string, string> = {};
      
      // 检查查询参数（用于授权码流程）
      urlObj.searchParams.forEach((value, key) => {
        params[key] = value;
      });
      
      // 检查片段参数（用于隐式流程）
      if (urlObj.hash) {
        const fragment = urlObj.hash.substring(1);
        const fragmentParams = new URLSearchParams(fragment);
        fragmentParams.forEach((value, key) => {
          params[key] = value;
        });
      }
      
      logger.debug('解析OAuth回调参数', { 
        url: url.substring(0, 100) + '...',
        paramCount: Object.keys(params).length,
      });
      
      return params;
      
    } catch (error) {
      logger.error('解析OAuth回调参数失败', error);
      throw new Error('无效的回调URL');
    }
  }

  /**
   * 清理过期的状态码
   */
  cleanupExpiredStates(): void {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [state, stateData] of this.stateStorage.entries()) {
      if (now - stateData.timestamp > this.STATE_EXPIRY) {
        this.stateStorage.delete(state);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      logger.debug('清理过期OAuth状态码', { cleanedCount });
    }
  }

  /**
   * 获取存储的状态数量（用于监控）
   */
  getStoredStateCount(): number {
    return this.stateStorage.size;
  }

  /**
   * 清理所有状态（用于登出等场景）
   */
  clearAllStates(): void {
    const count = this.stateStorage.size;
    this.stateStorage.clear();
    
    if (count > 0) {
      logger.debug('清理所有OAuth状态码', { count });
    }
  }

  /**
   * 哈希字符串
   */
  private async hashString(input: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * 定期清理过期状态（应该在应用启动时调用）
   */
  startPeriodicCleanup(): () => void {
    const interval = setInterval(() => {
      this.cleanupExpiredStates();
    }, 5 * 60 * 1000); // 每5分钟清理一次
    
    logger.debug('启动OAuth状态定期清理');
    
    return () => {
      clearInterval(interval);
      logger.debug('停止OAuth状态定期清理');
    };
  }
}

// 导出单例实例
export const oauthSecurity = new OAuthSecurity();

// 为了方便测试，也导出类
export { OAuthSecurity };