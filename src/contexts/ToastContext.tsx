import React, { createContext, useContext, useState, ReactNode, useEffect } from 'react';
import Toast, { ToastType } from '../components/common/Toast';
import ConfirmDialog, { ConfirmDialogProps } from '../components/common/ConfirmDialog';
import AlertDialog, { AlertDialogProps } from '../components/common/AlertDialog';
import { errorHandler } from '@/utils/errorHandler';

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

export const ToastProvider: React.FC<ToastProviderProps> = ({ children }) => {
  const [toast, setToast] = useState({
    visible: false,
    message: '',
    type: 'success' as ToastType,
    duration: 3000,
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

  const showToast = (message: string, type: ToastType = 'success', duration: number = 3000) => {
    setToast({
      visible: true,
      message,
      type,
      duration,
    });
  };

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

  const handleToastClose = () => {
    setToast(prev => ({ ...prev, visible: false }));
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
  }, []);

  return (
    <ToastContext.Provider value={{ showToast, showConfirm, showAlert }}>
      {children}
      <Toast
        visible={toast.visible}
        message={toast.message}
        type={toast.type}
        duration={toast.duration}
        onClose={handleToastClose}
      />
      <ConfirmDialog
        {...confirmDialog}
        onConfirm={() => {
          confirmDialog.onConfirm();
          handleConfirmClose();
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
