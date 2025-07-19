import React, { createContext, useContext, useState, ReactNode, useEffect, useCallback } from 'react';
import Toast, { ToastType, ToastAction } from '../components/common/Toast';
import { toast, ToastOptions } from '@/shared/utils/toast';

interface ToastContextType {
  showToast: (message: string, options?: ToastOptions) => void;
  dismissToast: (id?: string) => void;
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
  action?: ToastAction;
  id?: string;
  closable: boolean;
}

export const ToastProvider: React.FC<ToastProviderProps> = ({ children }) => {
  const [toasts, setToasts] = useState<Map<string, ToastState>>(new Map());

  const showToast = useCallback((message: string, options: ToastOptions = {}) => {
    const {
      type = 'success',
      duration = 3000,
      action,
      id = `toast-${Date.now()}-${Math.random()}`,
      closable = true
    } = options;

    const newToast: ToastState = {
      visible: true,
      message,
      type,
      duration,
      action,
      id,
      closable,
    };

    setToasts(prev => new Map(prev).set(id, newToast));
  }, []);

  const dismissToast = useCallback((id?: string) => {
    if (id) {
      setToasts(prev => {
        const newToasts = new Map(prev);
        const toast = newToasts.get(id);
        if (toast) {
          newToasts.set(id, { ...toast, visible: false });
        }
        return newToasts;
      });

      // 延迟删除以允许动画完成
      setTimeout(() => {
        setToasts(prev => {
          const newToasts = new Map(prev);
          newToasts.delete(id);
          return newToasts;
        });
      }, 300);
    } else {
      // 关闭所有toast
      setToasts(prev => {
        const newToasts = new Map();
        prev.forEach((toast, toastId) => {
          newToasts.set(toastId, { ...toast, visible: false });
        });
        return newToasts;
      });

      setTimeout(() => {
        setToasts(new Map());
      }, 300);
    }
  }, []);

  // 连接全局toast管理器
  useEffect(() => {
    toast._addListener(showToast);
    toast._addDismissListener(dismissToast);

    return () => {
      toast._removeListener(showToast);
      toast._removeDismissListener(dismissToast);
    };
  }, [showToast, dismissToast]);

  const handleClose = (id: string) => {
    dismissToast(id);
  };

  return (
    <ToastContext.Provider value={{ showToast, dismissToast }}>
      {children}
      {/* 渲染所有活跃的toast */}
      <div className="fixed top-4 right-4 z-50 space-y-2">
        {Array.from(toasts.entries()).map(([id, toast]) => (
          <div key={id} style={{ transform: `translateY(${Array.from(toasts.keys()).indexOf(id) * 80}px)` }}>
            <Toast
              visible={toast.visible}
              message={toast.message}
              type={toast.type}
              duration={toast.duration}
              action={toast.action}
              id={toast.id}
              closable={toast.closable}
              onClose={() => handleClose(id)}
            />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};
