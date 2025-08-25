/**
 * 错误恢复Hook
 * 在React组件中使用错误恢复功能
 */

import { useState, useEffect, useCallback } from 'react';
import { errorRecoveryManager, ErrorRecoverySession } from '@/shared/utils/errorRecoveryManager';
import { getErrorRecoverySteps, hasRecoverySteps } from '@/shared/utils/errorRecoveryManager';
import { RecoveryStep } from '@/shared/utils/errorMapping';

export interface UseErrorRecoveryReturn {
  // 状态
  activeSessions: ErrorRecoverySession[];
  currentSession: ErrorRecoverySession | null;
  isRecoveryAvailable: (error: any) => boolean;
  
  // 操作
  startRecovery: (error: any) => string | null;
  executeStep: (sessionId: string, stepId: string) => Promise<boolean>;
  markStepCompleted: (sessionId: string, stepId: string) => boolean;
  completeSession: (sessionId: string) => boolean;
  cancelSession: (sessionId: string) => boolean;
  
  // 工具函数
  getRecoverySteps: (error: any) => RecoveryStep[];
  getSessionProgress: (sessionId: string) => { completed: number; total: number; percentage: number };
}

export function useErrorRecovery(): UseErrorRecoveryReturn {
  const [activeSessions, setActiveSessions] = useState<ErrorRecoverySession[]>([]);
  const [currentSession, setCurrentSession] = useState<ErrorRecoverySession | null>(null);

  // 监听会话变化
  useEffect(() => {
    const handleSessionsChange = (sessions: ErrorRecoverySession[]) => {
      setActiveSessions(sessions);
      
      // 如果当前会话不在活跃列表中，清除它
      if (currentSession && !sessions.find(s => s.id === currentSession.id)) {
        setCurrentSession(null);
      }
    };

    errorRecoveryManager.addListener(handleSessionsChange);
    
    // 初始化当前活跃会话
    setActiveSessions(errorRecoveryManager.getActiveSessions());

    return () => {
      errorRecoveryManager.removeListener(handleSessionsChange);
    };
  }, [currentSession]);

  // 检查错误是否有恢复方案
  const isRecoveryAvailable = useCallback((error: any): boolean => {
    return hasRecoverySteps(error);
  }, []);

  // 开始恢复会话
  const startRecovery = useCallback((error: any): string | null => {
    const sessionId = errorRecoveryManager.startRecoverySession(error);
    
    if (sessionId) {
      const session = errorRecoveryManager.getRecoverySession(sessionId);
      if (session) {
        setCurrentSession(session);
      }
    }
    
    return sessionId;
  }, []);

  // 执行恢复步骤
  const executeStep = useCallback(async (sessionId: string, stepId: string): Promise<boolean> => {
    const result = await errorRecoveryManager.executeStep(sessionId, stepId);
    
    // 更新当前会话状态
    if (currentSession && currentSession.id === sessionId) {
      const updatedSession = errorRecoveryManager.getRecoverySession(sessionId);
      if (updatedSession) {
        setCurrentSession(updatedSession);
      }
    }
    
    return result;
  }, [currentSession]);

  // 标记步骤完成
  const markStepCompleted = useCallback((sessionId: string, stepId: string): boolean => {
    const result = errorRecoveryManager.markStepCompleted(sessionId, stepId);
    
    // 更新当前会话状态
    if (currentSession && currentSession.id === sessionId) {
      const updatedSession = errorRecoveryManager.getRecoverySession(sessionId);
      if (updatedSession) {
        setCurrentSession(updatedSession);
      }
    }
    
    return result;
  }, [currentSession]);

  // 完成会话
  const completeSession = useCallback((sessionId: string): boolean => {
    const result = errorRecoveryManager.completeSession(sessionId);
    
    if (currentSession && currentSession.id === sessionId) {
      setCurrentSession(null);
    }
    
    return result;
  }, [currentSession]);

  // 取消会话
  const cancelSession = useCallback((sessionId: string): boolean => {
    const result = errorRecoveryManager.cancelSession(sessionId);
    
    if (currentSession && currentSession.id === sessionId) {
      setCurrentSession(null);
    }
    
    return result;
  }, [currentSession]);

  // 获取错误的恢复步骤
  const getRecoverySteps = useCallback((error: any): RecoveryStep[] => {
    return getErrorRecoverySteps(error);
  }, []);

  // 获取会话进度
  const getSessionProgress = useCallback((sessionId: string) => {
    const session = errorRecoveryManager.getRecoverySession(sessionId);
    
    if (!session) {
      return { completed: 0, total: 0, percentage: 0 };
    }
    
    const completed = session.completedSteps.length;
    const total = session.steps.length;
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
    
    return { completed, total, percentage };
  }, []);

  return {
    activeSessions,
    currentSession,
    isRecoveryAvailable,
    startRecovery,
    executeStep,
    markStepCompleted,
    completeSession,
    cancelSession,
    getRecoverySteps,
    getSessionProgress,
  };
}

// 简化版Hook，只用于检查和启动恢复
export function useSimpleErrorRecovery() {
  const { isRecoveryAvailable, startRecovery, getRecoverySteps } = useErrorRecovery();
  
  const handleError = useCallback((error: any) => {
    if (isRecoveryAvailable(error)) {
      return startRecovery(error);
    }
    return null;
  }, [isRecoveryAvailable, startRecovery]);
  
  return {
    isRecoveryAvailable,
    handleError,
    getRecoverySteps,
  };
}

// 自动恢复Hook，在错误发生时自动尝试恢复
export function useAutoErrorRecovery(error: any | null, autoStart: boolean = false) {
  const { isRecoveryAvailable, startRecovery, currentSession, getSessionProgress } = useErrorRecovery();
  const [sessionId, setSessionId] = useState<string | null>(null);
  
  useEffect(() => {
    if (error && autoStart && isRecoveryAvailable(error) && !sessionId) {
      const newSessionId = startRecovery(error);
      setSessionId(newSessionId);
    }
  }, [error, autoStart, isRecoveryAvailable, startRecovery, sessionId]);
  
  const progress = sessionId ? getSessionProgress(sessionId) : null;
  
  return {
    sessionId,
    currentSession,
    progress,
    hasRecovery: error ? isRecoveryAvailable(error) : false,
  };
}

export default useErrorRecovery;
