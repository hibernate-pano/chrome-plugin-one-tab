/**
 * 分析工具 - 增强版
 * 提供用户行为分析和性能监控
 */

// 事件类型
export type AnalyticsEventType =
  | 'page_view'
  | 'user_action'
  | 'error'
  | 'performance'
  | 'feature_usage'
  | 'conversion';

// 事件数据
export interface AnalyticsEvent {
  type: AnalyticsEventType;
  name: string;
  timestamp: string;
  sessionId: string;
  properties?: Record<string, unknown>;
  duration?: number;
}

// 性能指标
export interface PerformanceMetrics {
  loadTime: number;
  renderTime: number;
  interactionTime: number;
  memoryUsage?: number;
}

// 用户行为追踪
export interface UserBehavior {
  totalSessions: number;
  lastActiveTime: string;
  featureUsage: Record<string, number>;
  preferences: Record<string, unknown>;
}

class AnalyticsService {
  private sessionId: string;
  private events: AnalyticsEvent[] = [];
  private featureUsage: Map<string, number> = new Map();
  private startTime: number;
  private isEnabled: boolean = true;

  constructor() {
    this.sessionId = this.generateSessionId();
    this.startTime = Date.now();
    this.loadFeatureUsage();
  }

  // 生成会话 ID
  private generateSessionId(): string {
    return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  // 启用/禁用分析
  setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
  }

  // 追踪事件
  track(name: string, properties?: Record<string, unknown>): void {
    if (!this.isEnabled) return;

    const event: AnalyticsEvent = {
      type: 'user_action',
      name,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      properties,
    };

    this.events.push(event);
    this.incrementFeatureUsage(name);

    // 在开发环境下输出
    if (process.env.NODE_ENV === 'development') {
      console.log('[Analytics]', name, properties);
    }
  }

  // 追踪页面浏览
  trackPageView(pageName: string, properties?: Record<string, unknown>): void {
    if (!this.isEnabled) return;

    const event: AnalyticsEvent = {
      type: 'page_view',
      name: pageName,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      properties,
    };

    this.events.push(event);
  }

  // 追踪功能使用
  trackFeature(featureName: string, properties?: Record<string, unknown>): void {
    if (!this.isEnabled) return;

    const event: AnalyticsEvent = {
      type: 'feature_usage',
      name: featureName,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      properties,
    };

    this.events.push(event);
    this.incrementFeatureUsage(featureName);
  }

  // 追踪性能
  trackPerformance(name: string, duration: number, properties?: Record<string, unknown>): void {
    if (!this.isEnabled) return;

    const event: AnalyticsEvent = {
      type: 'performance',
      name,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      duration,
      properties,
    };

    this.events.push(event);
  }

  // 追踪错误
  trackError(error: Error, properties?: Record<string, unknown>): void {
    if (!this.isEnabled) return;

    const event: AnalyticsEvent = {
      type: 'error',
      name: error.name,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      properties: {
        message: error.message,
        stack: error.stack,
        ...properties,
      },
    };

    this.events.push(event);
  }

  // 增加功能使用计数
  private incrementFeatureUsage(feature: string): void {
    const current = this.featureUsage.get(feature) || 0;
    this.featureUsage.set(feature, current + 1);
    this.saveFeatureUsage();
  }

  // 加载功能使用数据
  private loadFeatureUsage(): void {
    try {
      const saved = localStorage.getItem('analytics_feature_usage');
      if (saved) {
        const data = JSON.parse(saved);
        this.featureUsage = new Map(Object.entries(data));
      }
    } catch {
      // 忽略错误
    }
  }

  // 保存功能使用数据
  private saveFeatureUsage(): void {
    try {
      const data = Object.fromEntries(this.featureUsage);
      localStorage.setItem('analytics_feature_usage', JSON.stringify(data));
    } catch {
      // 忽略错误
    }
  }

  // 获取性能指标
  getPerformanceMetrics(): PerformanceMetrics {
    const loadTime = Date.now() - this.startTime;

    // 尝试获取更详细的性能数据
    let renderTime = 0;
    let interactionTime = 0;

    if (window.performance) {
      const entries = performance.getEntriesByType('paint');
      const fcp = entries.find(e => e.name === 'first-contentful-paint');
      if (fcp) {
        renderTime = fcp.startTime;
      }

      const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
      if (navigation) {
        interactionTime = navigation.domInteractive - navigation.startTime;
      }
    }

    return {
      loadTime,
      renderTime,
      interactionTime,
      memoryUsage: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize,
    };
  }

  // 获取功能使用统计
  getFeatureUsageStats(): Record<string, number> {
    return Object.fromEntries(this.featureUsage);
  }

  // 获取热门功能
  getTopFeatures(limit: number = 10): Array<{ feature: string; count: number }> {
    return Array.from(this.featureUsage.entries())
      .map(([feature, count]) => ({ feature, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  // 获取会话统计
  getSessionStats(): {
    sessionId: string;
    duration: number;
    eventCount: number;
    uniqueActions: number;
  } {
    const uniqueActions = new Set(
      this.events.filter(e => e.type === 'user_action').map(e => e.name)
    ).size;

    return {
      sessionId: this.sessionId,
      duration: Date.now() - this.startTime,
      eventCount: this.events.length,
      uniqueActions,
    };
  }

  // 导出分析数据
  exportData(): {
    events: AnalyticsEvent[];
    featureUsage: Record<string, number>;
    performance: PerformanceMetrics;
    session: {
      sessionId: string;
      duration: number;
      eventCount: number;
      uniqueActions: number;
    };
  } {
    return {
      events: this.events,
      featureUsage: this.getFeatureUsageStats(),
      performance: this.getPerformanceMetrics(),
      session: this.getSessionStats(),
    };
  }

  // 清除数据
  clearData(): void {
    this.events = [];
    this.featureUsage.clear();
    localStorage.removeItem('analytics_feature_usage');
  }
}

// 单例实例
export const analytics = new AnalyticsService();

// 便捷方法
export const track = analytics.track.bind(analytics);
export const trackFeature = analytics.trackFeature.bind(analytics);
export const trackPerformance = analytics.trackPerformance.bind(analytics);
export const trackError = analytics.trackError.bind(analytics);
