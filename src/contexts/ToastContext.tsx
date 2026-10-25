import React, { createContext, useContext, useState, ReactNode, useEffect, useCallback } from 'react';
import Toast, { ToastType, ToastAction } from '../components/common/Toast';
import ConfirmDialog, { ConfirmDialogProps } from '../components/common/ConfirmDialog';
import AlertDialog, { AlertDialogProps } from '../components/common/AlertDialog';
import { errorHandler } from '@/utils/errorHandler';
import { logError } from '@/utils/log';
import {
  installInputModalityTracker,
  resolveToastDuration,
} from '@/components/common/toastPolicy';
import { admitToast } from '@/components/common/toastQueuePolicy';

interface ToastContextType {
  /**
   * 弹一条提示。
   *
   * 第 4 个参数是**可选的动作按钮**（2026-10-22 审计 P0-4）：
   * 不可逆的操作（恢复会话 = 消费掉那条记录）必须给用户一条**点得回去**的路。
   * 用位置参数而不是 options 对象，是因为这个函数有 100+ 处调用点，
   * 改签名会让每一次调用都变成一次无谓的改写。
   */
  showToast: (
    message: string,
    type?: ToastType,
    duration?: number,
    action?: ToastAction,
  ) => void;
  showConfirm: (options: Omit<ConfirmDialogProps, 'visible'>) => void;
  showAlert: (options: Omit<AlertDialogProps, 'visible'>) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export const useToast = () => {
  const context = useContext(ToastContext);
  if (context === undefined) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
};

interface ToastProviderProps {
  children: ReactNode;
}

interface QueuedToast {
  id: number;
  visible: boolean;
  message: string;
  type: ToastType;
  duration: number;
  /** 可选的「撤销」动作按钮（2026-10-22 审计 P0-4）。 */
  action?: ToastAction;
}

let toastSeq = 0;

/**
 * Toast 队列（2026-10-14 UI 打磨）：
 * 原先单例存一条，删除广播警告 + 普通提示连发时互相顶掉。
 * 现最多同时堆叠 3 条：error 常驻（duration 0 = 不自动消失）、其余 3s 自动退场。
 *
 * ⚠️ 「带动作」的提示时长由**有没有动作**决定（见 resolveToastDuration），
 * 不是写死一个数 —— 3 秒对一条「需要用户决定退不退回」的提示太短。
 */
export const ToastProvider: React.FC<ToastProviderProps> = ({ children }) => {
  const [queue, setQueue] = useState<QueuedToast[]>([]);

  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogProps>({
    visible: false,
    title: '',
    message: '',
    onConfirm: () => { },
    onCancel: () => { },
  });

  const [alertDialog, setAlertDialog] = useState<AlertDialogProps>({
    visible: false,
    title: '',
    message: '',
    onClose: () => { },
  });

  const showToast = useCallback((
    message: string,
    type: ToastType = 'info',
    duration: number = 3000,
    action?: ToastAction,
  ) => {
    const id = ++toastSeq;
    // 时长策略收在 toastPolicy.resolveToastDuration 里（纯函数，可单测）：
    //   · error 且用了默认时长且**没有**动作 ⇒ 常驻（需用户手动关闭，
    //     避免关键失败一闪而过）；
    //   · **带动作** ⇒ 至少给一个「能做决定」的窗口（撤销的退路够不着
    //     就等于没有 —— 见 toastPolicy.ts 的文件头）；
    //   · 其余 ⇒ 调用方给的时长（普通提示仍是 3 秒）。
    const effectiveDuration = resolveToastDuration(type, duration, action !== undefined);
    // ── 队列准入：不是「最老的 2 条 + 新的」而是「挤掉可挤掉的那条」─────
    // 原先的 `prev.slice(-2)` 会**静默丢掉**最老的那条 ——
    // 而带动作的提示（「撤销」= 恢复即消费的唯一退路）与错误提示
    // （「失败始终会通知」是本仓既有承诺）**都不该被静默挤掉**。
    // 策略与理由见 toastQueuePolicy.ts 的文件头。
    const entry = {
      id,
      visible: true,
      message,
      type,
      duration: effectiveDuration,
      action,
    };
    setQueue(prev => admitToast(
      prev.map(item => ({
        value: item,
        hasAction: item.action !== undefined,
        isError: item.type === 'error',
      })),
      {
        value: entry,
        hasAction: action !== undefined,
        isError: type === 'error',
      },
    ));
  }, []);

  const dismissToast = useCallback((id: number) => {
    setQueue(prev => prev.filter(t => t.id !== id));
  }, []);

  const showConfirm = (options: Omit<ConfirmDialogProps, 'visible'>) => {
    setConfirmDialog({
      ...options,
      visible: true,
    });
  };

  const showAlert = (options: Omit<AlertDialogProps, 'visible'>) => {
    setAlertDialog({
      ...options,
      visible: true,
    });
  };

  const handleConfirmClose = () => {
    setConfirmDialog(prev => ({ ...prev, visible: false }));
  };

  const handleAlertClose = () => {
    setAlertDialog(prev => ({ ...prev, visible: false }));
  };

  // 集成错误处理器
  useEffect(() => {
    errorHandler.setToastCallback((message: string, type: 'error' | 'warning') => {
      showToast(message, type);
    });
  }, [showToast]);

  // 输入方式嗅探（键盘 vs 指针）—— 焦点接管只对键盘用户做，
  // 判据见 toastPolicy.decideFocusClaim。
  useEffect(() => installInputModalityTracker(), []);

  return (
    <ToastContext.Provider value={{ showToast, showConfirm, showAlert }}>
      {children}
      {queue.map((item, index) => (
        <Toast
          key={item.id}
          visible={item.visible}
          message={item.message}
          type={item.type}
          duration={item.duration}
          action={item.action}
          stackIndex={queue.length - 1 - index}
          onClose={() => dismissToast(item.id)}
        />
      ))}
      <ConfirmDialog
        {...confirmDialog}
        onConfirm={async () => {
          try {
            // 支持异步的onConfirm回调
            await confirmDialog.onConfirm();
          } catch (error) {
            logError('确认操作失败:', error);
          } finally {
            handleConfirmClose();
          }
        }}
        onCancel={() => {
          confirmDialog.onCancel();
          handleConfirmClose();
        }}
      />
      <AlertDialog
        {...alertDialog}
        onClose={() => {
          alertDialog.onClose();
          handleAlertClose();
        }}
      />
    </ToastContext.Provider>
  );
};
