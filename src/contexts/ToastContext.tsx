import React, { createContext, useContext, useState, ReactNode, useEffect, useCallback } from 'react';
import Toast, { ToastType } from '../components/common/Toast';
import ConfirmDialog, { ConfirmDialogProps } from '../components/common/ConfirmDialog';
import AlertDialog, { AlertDialogProps } from '../components/common/AlertDialog';
import { errorHandler } from '@/utils/errorHandler';
import { logError } from '../utils/log';

interface ToastContextType {
  showToast: (message: string, type?: ToastType, duration?: number) => void;
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
}

let toastSeq = 0;

/**
 * Toast 队列（2026-10-14 UI 打磨）：
 * 原先单例存一条，删除广播警告 + 成功提示连发时互相顶掉。
 * 现最多同时堆叠 3 条：error 常驻（duration 0 = 不自动消失）、其余 3s 自动退场。
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

  const showToast = useCallback((message: string, type: ToastType = 'success', duration: number = 3000) => {
    const id = ++toastSeq;
    // error 默认常驻，需用户手动关闭，避免关键失败一闪而过
    const effectiveDuration = type === 'error' && duration === 3000 ? 0 : duration;
    setQueue(prev => [...prev.slice(-2), { id, visible: true, message, type, duration: effectiveDuration }]);
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
