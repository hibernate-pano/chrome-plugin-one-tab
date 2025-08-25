/**
 * 错误恢复管理器
 * 管理错误恢复指南的显示和执行
 */

import { mapError } from './errorMapping';
import { feedback } from './feedback';
import { RecoveryStep } from './errorMapping';

export interface ErrorRecoverySession {
  id: string;
  error: any;
  steps: RecoveryStep[];
  startTime: number;
  completedSteps: string[];
  isActive: boolean;
}

class ErrorRecoveryManager {
  private sessions: Map<string, ErrorRecoverySession> = new Map();
  private listeners: Set<(sessions: ErrorRecoverySession[]) => void> = new Set();

  /**
   * 开始错误恢复会话
   */
  startRecoverySession(error: any): string | null {
    const errorInfo = mapError(error);
    
    if (!errorInfo.recoverySteps || errorInfo.recoverySteps.length === 0) {
      return null; // 没有恢复步骤
    }

    const sessionId = `recovery-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    const session: ErrorRecoverySession = {
      id: sessionId,
      error,
      steps: errorInfo.recoverySteps,
      startTime: Date.now(),
      completedSteps: [],
      isActive: true,
    };

    this.sessions.set(sessionId, session);
    this.notifyListeners();

    return sessionId;
  }

  /**
   * 获取恢复会话
   */
  getRecoverySession(sessionId: string): ErrorRecoverySession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * 获取所有活跃的恢复会话
   */
  getActiveSessions(): ErrorRecoverySession[] {
    return Array.from(this.sessions.values()).filter(session => session.isActive);
  }

  /**
   * 标记步骤为已完成
   */
  markStepCompleted(sessionId: string, stepId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    if (!session.completedSteps.includes(stepId)) {
      session.completedSteps.push(stepId);
      this.notifyListeners();
    }

    return true;
  }

  /**
   * 执行恢复步骤
   */
  async executeStep(sessionId: string, stepId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const step = session.steps.find(s => s.id === stepId);
    if (!step || !step.action) return false;

    try {
      await step.action.handler();
      this.markStepCompleted(sessionId, stepId);
      
      feedback.success(`步骤"${step.title}"执行成功`);
      return true;
    } catch (error) {
      feedback.error(`步骤"${step.title}"执行失败: ${error.message}`);
      return false;
    }
  }

  /**
   * 完成恢复会话
   */
  completeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.isActive = false;
    this.notifyListeners();

    // 记录恢复会话统计
    const completionRate = session.completedSteps.length / session.steps.length;
    const duration = Date.now() - session.startTime;

    console.log(`Recovery session completed:`, {
      sessionId,
      completionRate,
      duration,
      totalSteps: session.steps.length,
      completedSteps: session.completedSteps.length,
    });

    return true;
  }

  /**
   * 取消恢复会话
   */
  cancelSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.isActive = false;
    this.notifyListeners();

    return true;
  }

  /**
   * 清理旧的会话
   */
  cleanupOldSessions(maxAge: number = 24 * 60 * 60 * 1000): void {
    const now = Date.now();
    const toDelete: string[] = [];

    this.sessions.forEach((session, sessionId) => {
      if (now - session.startTime > maxAge) {
        toDelete.push(sessionId);
      }
    });

    toDelete.forEach(sessionId => {
      this.sessions.delete(sessionId);
    });

    if (toDelete.length > 0) {
      this.notifyListeners();
    }
  }

  /**
   * 添加监听器
   */
  addListener(listener: (sessions: ErrorRecoverySession[]) => void): void {
    this.listeners.add(listener);
  }

  /**
   * 移除监听器
   */
  removeListener(listener: (sessions: ErrorRecoverySession[]) => void): void {
    this.listeners.delete(listener);
  }

  /**
   * 通知监听器
   */
  private notifyListeners(): void {
    const activeSessions = this.getActiveSessions();
    this.listeners.forEach(listener => {
      try {
        listener(activeSessions);
      } catch (error) {
        console.error('Error in recovery session listener:', error);
      }
    });
  }

  /**
   * 获取恢复统计
   */
  getRecoveryStats() {
    const allSessions = Array.from(this.sessions.values());
    const completedSessions = allSessions.filter(s => !s.isActive);
    
    const totalSteps = allSessions.reduce((sum, s) => sum + s.steps.length, 0);
    const completedSteps = allSessions.reduce((sum, s) => sum + s.completedSteps.length, 0);
    
    const avgCompletionRate = completedSessions.length > 0
      ? completedSessions.reduce((sum, s) => sum + (s.completedSteps.length / s.steps.length), 0) / completedSessions.length
      : 0;

    return {
      totalSessions: allSessions.length,
      activeSessions: this.getActiveSessions().length,
      completedSessions: completedSessions.length,
      totalSteps,
      completedSteps,
      avgCompletionRate,
    };
  }

  /**
   * 导出恢复会话数据（用于调试）
   */
  exportSessionData(): any {
    return {
      sessions: Array.from(this.sessions.entries()),
      stats: this.getRecoveryStats(),
      timestamp: Date.now(),
    };
  }

  /**
   * 重置所有会话
   */
  reset(): void {
    this.sessions.clear();
    this.notifyListeners();
  }
}

// 创建全局实例
export const errorRecoveryManager = new ErrorRecoveryManager();

// 定期清理旧会话
if (typeof window !== 'undefined') {
  setInterval(() => {
    errorRecoveryManager.cleanupOldSessions();
  }, 60 * 60 * 1000); // 每小时清理一次
}

// 便捷函数
export function startErrorRecovery(error: any): string | null {
  return errorRecoveryManager.startRecoverySession(error);
}

export function getErrorRecoverySteps(error: any): RecoveryStep[] {
  const errorInfo = mapError(error);
  return errorInfo.recoverySteps || [];
}

export function hasRecoverySteps(error: any): boolean {
  const steps = getErrorRecoverySteps(error);
  return steps.length > 0;
}

// 默认导出
export default errorRecoveryManager;
