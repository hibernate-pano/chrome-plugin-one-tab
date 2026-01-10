/**
 * 增强的用户反馈工具
 * 提供统一的成功/错误/信息提示
 */

export interface FeedbackOptions {
  duration?: number;
  position?: 'top' | 'bottom' | 'top-right' | 'bottom-right';
  showIcon?: boolean;
  showProgress?: boolean;
}

export type FeedbackType = 'success' | 'error' | 'info' | 'warning';

export interface FeedbackMessage {
  id: string;
  type: FeedbackType;
  message: string;
  options: FeedbackOptions;
  timestamp: number;
}

class UserFeedbackManager {
  private static instance: UserFeedbackManager;
  private listeners: Set<(messages: FeedbackMessage[]) => void> = new Set();
  private messages: FeedbackMessage[] = [];
  private messageCounter = 0;

  private constructor() {}

  static getInstance(): UserFeedbackManager {
    if (!UserFeedbackManager.instance) {
      UserFeedbackManager.instance = new UserFeedbackManager();
    }
    return UserFeedbackManager.instance;
  }

  /**
   * 订阅反馈消息更新
   */
  subscribe(listener: (messages: FeedbackMessage[]) => void): () => void {
    this.listeners.add(listener);
    // 立即返回当前消息
    listener(this.messages);

    // 返回取消订阅函数
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 通知所有订阅者
   */
  private notify(): void {
    this.listeners.forEach(listener => listener([...this.messages]));
  }

  /**
   * 显示成功消息
   */
  success(message: string, options: FeedbackOptions = {}): string {
    return this.show('success', message, options);
  }

  /**
   * 显示错误消息
   */
  error(message: string, options: FeedbackOptions = {}): string {
    return this.show('error', message, { duration: 5000, ...options });
  }

  /**
   * 显示信息消息
   */
  info(message: string, options: FeedbackOptions = {}): string {
    return this.show('info', message, options);
  }

  /**
   * 显示警告消息
   */
  warning(message: string, options: FeedbackOptions = {}): string {
    return this.show('warning', message, options);
  }

  /**
   * 显示反馈消息
   */
  private show(
    type: FeedbackType,
    message: string,
    options: FeedbackOptions
  ): string {
    const id = `feedback-${++this.messageCounter}`;
    const duration = options.duration ?? 3000;

    const feedbackMessage: FeedbackMessage = {
      id,
      type,
      message,
      options: {
        position: 'top-right',
        showIcon: true,
        showProgress: true,
        ...options,
      },
      timestamp: Date.now(),
    };

    this.messages.push(feedbackMessage);
    this.notify();

    // 自动移除消息
    if (duration > 0) {
      setTimeout(() => {
        this.dismiss(id);
      }, duration);
    }

    return id;
  }

  /**
   * 关闭指定消息
   */
  dismiss(id: string): void {
    const index = this.messages.findIndex(m => m.id === id);
    if (index !== -1) {
      this.messages.splice(index, 1);
      this.notify();
    }
  }

  /**
   * 关闭所有消息
   */
  dismissAll(): void {
    this.messages = [];
    this.notify();
  }

  /**
   * 获取当前所有消息
   */
  getMessages(): FeedbackMessage[] {
    return [...this.messages];
  }
}

export const feedback = UserFeedbackManager.getInstance();

// 便捷函数
export const showSuccess = (message: string, options?: FeedbackOptions) =>
  feedback.success(message, options);

export const showError = (message: string, options?: FeedbackOptions) =>
  feedback.error(message, options);

export const showInfo = (message: string, options?: FeedbackOptions) =>
  feedback.info(message, options);

export const showWarning = (message: string, options?: FeedbackOptions) =>
  feedback.warning(message, options);
