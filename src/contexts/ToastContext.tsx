import React, { createContext, useContext, useState, ReactNode, useEffect, useCallback } from 'react';
import Toast, { ToastType } from '../components/common/Toast';
import ConfirmDialog, { ConfirmDialogProps } from '../components/common/ConfirmDialog';
import AlertDialog, { AlertDialogProps } from '../components/common/AlertDialog';
import { errorHandler } from '@/utils/errorHandler';

/**
 * 撤销按钮配置（S3 §4）。点击后调用 onClick + 关闭 toast。
 * 用于"删除会话 → 撤销"等延迟操作（useDeferredDelete 配合）。
 */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

/**
 * S3 §4: 新的 showToast options 形式 —— 支持 action 按钮。
 * 双签名兼容：旧调用 `(message, type?, duration?)` 与新调用 `(options)` 均可。
 */
export type ShowToastOptions = {
  message: string;
  type?: ToastType;
  duration?: number;
  action?: ToastAction | null;
};

interface ToastContextType {
  showToast: (
    messageOrOptions: string | ShowToastOptions,
    type?: ToastType,
    duration?: number,
    action?: ToastAction | null
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

interface ToastState {
  visible: boolean;
  message: string;
  type: ToastType;
  duration: number;
  action: ToastAction | null;
}

export const ToastProvider: React.FC<ToastProviderProps> = ({ children }) => {
  const [toast, setToast] = useState<ToastState>({
    visible: false,
    message: '',
    type: 'success',
    duration: 3000,
    action: null,
  });

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

  const showToast = useCallback(
    (
      messageOrOptions: string | ShowToastOptions,
      type: ToastType = 'success',
      duration: number = 3000,
      action: ToastAction | null = null
    ) => {
      if (typeof messageOrOptions === 'object' && messageOrOptions !== null) {
        const opts = messageOrOptions;
        setToast({
          visible: true,
          message: opts.message,
          type: opts.type ?? 'success',
          duration: opts.duration ?? 3000,
          action: opts.action ?? null,
        });
        return;
      }
      setToast({
        visible: true,
        message: messageOrOptions,
        type,
        duration,
        action,
      });
    },
    []
  );

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

  const handleToastClose = useCallback(() => {
    setToast(prev => ({ ...prev, visible: false }));
  }, []);

  const handleToastAction = useCallback(() => {
    // 触发撤销回调后立即关闭 toast —— 撤销动作的"什么也不做"语义
    // 由 useDeferredDelete 持有真实状态，外部 cancel 已经取消 timer。
    setToast(prev => {
      // 在 updater 内同步触发 onClick：保证 setter 闭包内的 action 引用新鲜，
      // 避免 updater 外 capturedAction?.onClick() 的类型收窄为 never。
      prev.action?.onClick();
      return { ...prev, visible: false };
    });
  }, []);

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

  return (
    <ToastContext.Provider value={{ showToast, showConfirm, showAlert }}>
      {children}
      <Toast
        visible={toast.visible}
        message={toast.message}
        type={toast.type}
        duration={toast.duration}
        action={toast.action}
        onAction={handleToastAction}
        onClose={handleToastClose}
      />
      <ConfirmDialog
        {...confirmDialog}
        onConfirm={async () => {
          try {
            // 支持异步的onConfirm回调
            await confirmDialog.onConfirm();
          } catch (error) {
            console.error('确认操作失败:', error);
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
