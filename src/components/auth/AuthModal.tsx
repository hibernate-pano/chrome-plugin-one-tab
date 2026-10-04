import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LoginForm } from './LoginForm';
import { RegisterForm } from './RegisterForm';
import { useDialogA11y } from '@/hooks/useKeyboardNavigation';

export type AuthTab = 'login' | 'register';

interface AuthModalProps {
  visible: boolean;
  initialTab?: AuthTab;
  onClose: () => void;
}

/**
 * 登录 / 注册弹窗（应用级，不寄生在「⋯ 菜单」里）。
 *
 * 【为什么必须 portal 到 body】
 * 之前它渲染在 `<header class="header">` 内部，而 `.header` 带 `backdrop-filter: blur(12px)`。
 * 按 CSS 规范，`backdrop-filter`（以及 filter/transform/perspective/contain）会让该元素
 * 成为 **`position: fixed` 后代的包含块** —— 弹窗的 `fixed inset-0` 于是相对那个
 * 只有几十像素高的 header 定位，面板被居中在细条里、大半顶到视口外，表现为
 * 「登录页不见了 / 像在另一个图层」。portal 到 body 后 fixed 才真正相对视口。
 *
 * 同时也解耦了生命周期：菜单可以随点击关闭，弹窗独立存活。
 */
export const AuthModal: React.FC<AuthModalProps> = ({ visible, initialTab = 'login', onClose }) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<AuthTab>(initialTab);

  // 钩子必须在 `if (!visible) return null` 之前调用：visible 是渲染开关，
  // 焦点/键盘契约要跟着它开合（与 ModalFrame 同一约定）。
  useDialogA11y(panelRef, visible, onClose);

  // 每次打开都回到调用方指定的页签（未登录入口默认「登录」）。
  useEffect(() => {
    if (visible) setActiveTab(initialTab);
  }, [visible, initialTab]);

  if (!visible) return null;

  return createPortal(
    // 外层负责滚动、内层 min-h-full 居中：视口放得下就居中，放不下就从顶部起排并可滚动。
    <div className="fixed inset-0 z-[100] overflow-y-auto bg-black/50">
      <div className="flex min-h-full items-center justify-center p-4">
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label="登录或注册账号"
          tabIndex={-1}
          className="ts-modal theme-bg-elevated rounded-lg shadow-xl w-full max-w-md focus:outline-none"
        >
          <div className="flex border-b border-gray-300 dark:border-gray-700">
            <button
              type="button"
              className={`flex-1 py-3 transition-all font-medium ${activeTab === 'login' ? 'text-primary-600 border-b-2 border-primary-600' : 'text-gray-600 dark:text-gray-300 hover:text-primary-600 dark:hover:text-primary-400'}`}
              onClick={() => setActiveTab('login')}
            >
              登录
            </button>
            <button
              type="button"
              className={`flex-1 py-3 transition-all font-medium ${activeTab === 'register' ? 'text-primary-600 border-b-2 border-primary-600' : 'text-gray-600 dark:text-gray-300 hover:text-primary-600 dark:hover:text-primary-400'}`}
              onClick={() => setActiveTab('register')}
            >
              注册
            </button>
            <button
              type="button"
              className="p-3 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-400"
              onClick={onClose}
              aria-label="关闭登录弹窗"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="p-6">
            {activeTab === 'login' ? (
              <LoginForm onSuccess={onClose} />
            ) : (
              <RegisterForm onSuccess={onClose} />
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default AuthModal;
