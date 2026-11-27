import React, { useEffect, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LoginForm } from './LoginForm';
import { RegisterForm } from './RegisterForm';
import { InlineNotice } from '@/components/common/InlineNotice';
import { useAppDispatch } from '@/store/hooks';
import {
  resetFailureNotice,
  sendPasswordResetCode,
  submitPasswordReset,
} from '@/store/slices/authSlice';
import { validateEmail, validatePassword } from '@/utils/inputValidation';
import { useToast } from '@/contexts/ToastContext';
import { restoreAfterLogin } from './restoreAfterLogin';
import { loginRestoreFeedback } from './restoreFeedbackCopy';
import { useDialogA11y } from '@/hooks/useKeyboardNavigation';

export type AuthTab = 'login' | 'register';

/**
 * 重置视图的全部用户可见文案（v1.33，设计说明「四」逐字照用）。
 *
 * 集中在这里是为了让判据层能**逐字**断言（文案散在 JSX 里就只能靠
 * 正则从源码里抠，改一个标点守卫就假绿）。
 */
export const RESET_COPY = {
  headerTitle: '重置密码',
  backToLogin: '返回登录',
  emailDescription: '输入你注册时用的邮箱，我们会发一条 6 位验证码。',
  emailLabel: '邮箱',
  emailPlaceholder: '你的邮箱地址',
  sendCode: '发送验证码',
  sending: '发送中…',
  sentTitle: '验证码已发送',
  changeEmail: '改邮箱',
  codeLabel: '验证码',
  newPasswordLabel: '新密码',
  confirmPasswordLabel: '确认新密码',
  passwordHint: '至少 8 位，且包含大写字母、小写字母、数字、特殊字符中的至少 3 种',
  submit: '重置密码',
  resend: '重新发送验证码',
  successTitle: '密码已更新',
  successMessage: '你已用新密码登录。',
  startUsing: '开始使用',
} as const;

/**
 * R2 顶部提示的正文（邮箱回显为用户输入的邮箱）。
 *
 * ⚠️ 措辞是「**如果** … 已注册」：`resetPasswordForEmail` 对存在 / 不存在的
 * 邮箱返回同一结果，界面**不许**据此区分该邮箱是否注册（避免撞库探测）。
 */
export const resetSentMessage = (email: string): string =>
  `如果 ${email} 已注册，验证码已发到该邮箱。没收到请检查垃圾邮件。`;

/* ── 重置流程的视图状态（纯 reducer，判据层可直接断言逐屏切换）────────── */

export type ResetScreen = 'email' | 'code' | 'success';

export type ResetField = 'email' | 'code' | 'password' | 'confirmPassword';

export type ResetFieldErrors = Partial<Record<ResetField, string>>;

export interface ResetFlowState {
  screen: ResetScreen;
  /** R1 输入框里的邮箱（「改邮箱」回到 R1 时**保留**）。 */
  emailInput: string;
  /** 已发出验证码的邮箱（R2 回显）。 */
  sentEmail: string;
  code: string;
  password: string;
  confirmPassword: string;
  fieldErrors: ResetFieldErrors;
  /** 表单级错误（标题 + 正文）；字段级错误走 `fieldErrors`，两者不混用。 */
  formError: { title: string; message: string } | null;
}

export const initialResetFlowState: ResetFlowState = {
  screen: 'email',
  emailInput: '',
  sentEmail: '',
  code: '',
  password: '',
  confirmPassword: '',
  fieldErrors: {},
  formError: null,
};

export type ResetFlowAction =
  | { type: 'editEmail'; value: string }
  | { type: 'editCode'; value: string }
  | { type: 'editPassword'; value: string }
  | { type: 'editConfirmPassword'; value: string }
  | { type: 'fieldErrors'; errors: ResetFieldErrors }
  | { type: 'sent'; email: string }
  | { type: 'changeEmail' }
  | { type: 'formError'; title: string; message: string }
  | { type: 'clearFormError' }
  | { type: 'succeeded' };

const withoutFieldError = (
  errors: ResetFieldErrors,
  field: ResetField,
): ResetFieldErrors => {
  if (!errors[field]) return errors;
  const next = { ...errors };
  delete next[field];
  return next;
};

/**
 * 重置流程的状态机。
 *
 * 逐屏：`email`（R1）→ `sent`（R2）→ `succeeded`（R3）。
 * `changeEmail` 回 R1 时**保留 `emailInput`**（设计说明明确要求）。
 * `succeeded` 只切视图 —— **不**关闭弹窗（关闭只由 R3 的「开始使用」触发）。
 */
export const resetFlowReducer = (
  state: ResetFlowState,
  action: ResetFlowAction,
): ResetFlowState => {
  switch (action.type) {
    case 'editEmail':
      return {
        ...state,
        emailInput: action.value,
        fieldErrors: withoutFieldError(state.fieldErrors, 'email'),
      };
    case 'editCode':
      return {
        ...state,
        code: action.value,
        fieldErrors: withoutFieldError(state.fieldErrors, 'code'),
      };
    case 'editPassword':
      return {
        ...state,
        password: action.value,
        fieldErrors: withoutFieldError(state.fieldErrors, 'password'),
      };
    case 'editConfirmPassword':
      return {
        ...state,
        confirmPassword: action.value,
        fieldErrors: withoutFieldError(state.fieldErrors, 'confirmPassword'),
      };
    case 'fieldErrors':
      return { ...state, fieldErrors: action.errors, formError: null };
    case 'sent':
      return {
        ...state,
        screen: 'code',
        sentEmail: action.email,
        emailInput: action.email,
        fieldErrors: {},
        formError: null,
      };
    case 'changeEmail':
      // 邮箱**保留**（emailInput 不动）；验证码 / 密码属于上一条邮件，清掉。
      return {
        ...state,
        screen: 'email',
        code: '',
        password: '',
        confirmPassword: '',
        fieldErrors: {},
        formError: null,
      };
    case 'formError':
      return { ...state, formError: { title: action.title, message: action.message } };
    case 'clearFormError':
      return { ...state, formError: null };
    case 'succeeded':
      return { ...state, screen: 'success', fieldErrors: {}, formError: null };
    default:
      return state;
  }
};

/* ── 字段校验（文案逐字来自设计说明「四」的错误表）────────────────────── */

/** 验证码：空 / 非 6 位数字（返回字段级错误文案；合法返回 null）。 */
export const validateResetCode = (code: string): string | null => {
  const trimmed = code.trim();
  if (!trimmed) return '请输入验证码';
  if (!/^\d{6}$/.test(trimmed)) return '验证码是 6 位数字';
  return null;
};

/**
 * 新密码 + 确认新密码。
 *
 * 密码四条（空 / <8 / >128 / 字符种类 <3）直接复用 `validatePassword` 的
 * 现有文案 —— 不在这里另写一份（两份迟早漂）。
 */
export const validateResetPasswords = (
  password: string,
  confirmPassword: string,
): { password?: string; confirmPassword?: string } => {
  const result = validatePassword(password);
  if (!result.isValid) {
    return { password: result.error ?? '密码不符合要求' };
  }
  if (password !== confirmPassword) {
    return { confirmPassword: '两次输入的密码不一致' };
  }
  return {};
};

/** 既有 spinner（与登录 / 注册按钮同一形状）。 */
const ButtonSpinner: React.FC = () => (
  <svg
    className="animate-spin -ml-1 mr-2 h-4 w-4"
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
  >
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
    <path
      className="opacity-75"
      fill="currentColor"
      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
    ></path>
  </svg>
);

const inputClassName = (hasError: boolean) =>
  // 与 LoginForm 同一条焦点规则：不声明 outline ⇒ 全局 :focus-visible 的
  // 2px 焦点环照常画出来（详见 LoginForm 同处注释）。
  `w-full theme-radius-input theme-bg-elevated border px-4 py-3 text-sm shadow-sm transition text-gray-900 dark:text-gray-100 ${
    hasError
      ? 'border-rose-300 focus:ring-4 focus:ring-rose-100 dark:border-rose-700 dark:focus:ring-rose-950/60'
      : 'theme-border-default theme-focus'
  }`;

/** 字段级错误（与既有表单同一条写法）。 */
const FieldError: React.FC<{ message?: string }> = ({ message }) =>
  message ? (
    <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{message}</p>
  ) : null;

interface ResetViewProps {
  onClose: () => void;
}

/**
 * 重置密码视图（R1 输入邮箱 → R2 验证码 + 新密码 → R3 成功）。
 *
 * ⚠️ 它是**视图**而不是第三个页签：激活时由 AuthModal 用一行头部**替换**
 * 整条页签栏（设计说明「四」）。
 */
const PasswordResetView: React.FC<ResetViewProps> = ({ onClose }) => {
  const dispatch = useAppDispatch();
  const { showToast } = useToast();
  const [state, rawDispatch] = useReducer(resetFlowReducer, initialResetFlowState);
  const [isSending, setIsSending] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const sendCode = async (email: string) => {
    setIsSending(true);
    rawDispatch({ type: 'clearFormError' });
    try {
      await dispatch(sendPasswordResetCode({ email })).unwrap();
      rawDispatch({ type: 'sent', email });
    } catch (error) {
      const notice = resetFailureNotice((error as { code?: string } | null)?.code);
      rawDispatch({ type: 'formError', title: notice.title, message: notice.message });
    } finally {
      setIsSending(false);
    }
  };

  const handleSendEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = validateEmail(state.emailInput);
    if (!result.isValid) {
      rawDispatch({
        type: 'fieldErrors',
        errors: { email: result.error ?? '邮箱格式不正确' },
      });
      return;
    }
    await sendCode(result.sanitized ?? state.emailInput.trim());
  };

  /** 「重新发送验证码」：**始终可点**（不做倒计时；服务端间隔由项目设置决定）。 */
  const handleResend = () => {
    if (isSending) return;
    void sendCode(state.sentEmail);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const errors: ResetFieldErrors = {};
    const codeError = validateResetCode(state.code);
    if (codeError) errors.code = codeError;
    const passwordErrors = validateResetPasswords(state.password, state.confirmPassword);
    if (passwordErrors.password) errors.password = passwordErrors.password;
    if (passwordErrors.confirmPassword) errors.confirmPassword = passwordErrors.confirmPassword;

    if (Object.keys(errors).length > 0) {
      rawDispatch({ type: 'fieldErrors', errors });
      return;
    }

    setIsSubmitting(true);
    rawDispatch({ type: 'clearFormError' });
    try {
      await dispatch(
        submitPasswordReset({
          email: state.sentEmail,
          code: state.code.trim(),
          password: state.password,
        }),
      ).unwrap();

      // ── 与登录成功**同一条**链路：拉回云端会话 + 三种结果各一条 toast ──
      // 文案一个字不改（restoreFeedbackCopy 是单源）。
      void restoreAfterLogin(dispatch).then((outcome) => {
        const feedback = loginRestoreFeedback(outcome);
        showToast(feedback.text, feedback.tone);
      });

      rawDispatch({ type: 'succeeded' });
    } catch (error) {
      const notice = resetFailureNotice((error as { code?: string } | null)?.code);
      rawDispatch({ type: 'formError', title: notice.title, message: notice.message });
    } finally {
      setIsSubmitting(false);
    }
  };

  // R3 · 成功：**不自动关闭**（关闭只由「开始使用」触发）。
  if (state.screen === 'success') {
    return (
      <div className="max-w-md mx-auto">
        <InlineNotice
          tone="success"
          title={RESET_COPY.successTitle}
          message={RESET_COPY.successMessage}
          className="mb-6"
        />
        <button
          type="button"
          onClick={onClose}
          className="theme-cta theme-radius-input w-full py-3 text-sm font-semibold shadow-sm transition"
        >
          {RESET_COPY.startUsing}
        </button>
      </div>
    );
  }

  // R2 · 已发送：验证码 + 新密码 + 确认新密码
  if (state.screen === 'code') {
    return (
      <div className="max-w-md mx-auto">
        <InlineNotice
          tone="info"
          title={RESET_COPY.sentTitle}
          message={
            <div className="flex items-start justify-between gap-3">
              <span className="min-w-0 flex-1">{resetSentMessage(state.sentEmail)}</span>
              <button
                type="button"
                onClick={() => rawDispatch({ type: 'changeEmail' })}
                className="inline-flex min-h-9 min-w-9 shrink-0 items-center justify-center rounded px-2 text-sm font-medium theme-accent-text hover:underline"
              >
                {RESET_COPY.changeEmail}
              </button>
            </div>
          }
          className="mb-6"
        />
        {state.formError && (
          <InlineNotice
            tone="error"
            title={state.formError.title}
            message={state.formError.message}
            className="mb-6"
          />
        )}
        <form
          onSubmit={handleSubmit}
          noValidate
          className="theme-radius-panel theme-panel-translucent theme-panel-blur theme-border-default theme-shadow-panel border p-6"
        >
          <div className="mb-5">
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              {RESET_COPY.codeLabel}
            </label>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              className={inputClassName(Boolean(state.fieldErrors.code))}
              value={state.code}
              onChange={(e) => rawDispatch({ type: 'editCode', value: e.target.value })}
              placeholder="6 位数字"
              required
            />
            <FieldError message={state.fieldErrors.code} />
          </div>
          <div className="mb-5">
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              {RESET_COPY.newPasswordLabel}
            </label>
            <input
              type="password"
              autoComplete="new-password"
              className={inputClassName(Boolean(state.fieldErrors.password))}
              value={state.password}
              onChange={(e) => rawDispatch({ type: 'editPassword', value: e.target.value })}
              placeholder="请输入新密码"
              required
            />
            <FieldError message={state.fieldErrors.password} />
            <p className="mt-2 text-xs theme-text-muted">
              {RESET_COPY.passwordHint}
            </p>
          </div>
          <div className="mb-6">
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              {RESET_COPY.confirmPasswordLabel}
            </label>
            <input
              type="password"
              autoComplete="new-password"
              className={inputClassName(Boolean(state.fieldErrors.confirmPassword))}
              value={state.confirmPassword}
              onChange={(e) =>
                rawDispatch({ type: 'editConfirmPassword', value: e.target.value })
              }
              placeholder="请再次输入新密码"
              required
            />
            <FieldError message={state.fieldErrors.confirmPassword} />
          </div>
          <button
            type="submit"
            className="theme-cta theme-radius-input w-full py-3 text-sm font-semibold shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isSubmitting}
          >
            {isSubmitting ? (
              <span className="flex items-center justify-center">
                <ButtonSpinner />
                {RESET_COPY.submit}
              </span>
            ) : (
              RESET_COPY.submit
            )}
          </button>
          <div className="mt-4 text-center">
            {/* 始终可点（不做倒计时）：服务端发送间隔由项目设置决定。 */}
            <button
              type="button"
              onClick={handleResend}
              className="inline-flex min-h-9 min-w-9 items-center justify-center rounded px-2 text-sm font-medium theme-accent-text hover:underline"
            >
              {RESET_COPY.resend}
            </button>
          </div>
        </form>
      </div>
    );
  }

  // R1 · 输入邮箱（标题由头部那一行承担，这里只放说明）
  return (
    <div className="max-w-md mx-auto">
      <p className="mb-5 text-sm text-gray-600 dark:text-gray-300">
        {RESET_COPY.emailDescription}
      </p>
      {state.formError && (
        <InlineNotice
          tone="error"
          title={state.formError.title}
          message={state.formError.message}
          className="mb-6"
        />
      )}
      <form
        onSubmit={handleSendEmail}
        noValidate
        className="theme-radius-panel theme-panel-translucent theme-panel-blur theme-border-default theme-shadow-panel border p-6"
      >
        <div className="mb-6">
          <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
            {RESET_COPY.emailLabel}
          </label>
          <input
            type="email"
            autoComplete="email"
            className={inputClassName(Boolean(state.fieldErrors.email))}
            value={state.emailInput}
            onChange={(e) => rawDispatch({ type: 'editEmail', value: e.target.value })}
            placeholder={RESET_COPY.emailPlaceholder}
            required
          />
          <FieldError message={state.fieldErrors.email} />
        </div>
        <button
          type="submit"
          className="theme-cta theme-radius-input w-full py-3 text-sm font-semibold shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50"
          disabled={isSending}
        >
          {isSending ? (
            <span className="flex items-center justify-center">
              <ButtonSpinner />
              {RESET_COPY.sending}
            </span>
          ) : (
            RESET_COPY.sendCode
          )}
        </button>
      </form>
    </div>
  );
};

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
  /**
   * 重置视图是否激活。
   *
   * ⚠️ 它是**视图**状态，不是第三个页签：`AuthTab` 保持两个值，
   * 重置视图激活时整条页签栏被一行头部**替换**（设计说明「四」）。
   */
  const [showReset, setShowReset] = useState(false);

  // 钩子必须在 `if (!visible) return null` 之前调用：visible 是渲染开关，
  // 焦点/键盘契约要跟着它开合（与 ModalFrame 同一约定）。
  useDialogA11y(panelRef, visible, onClose);

  // 每次打开都回到调用方指定的页签（未登录入口默认「登录」），并退出重置视图。
  useEffect(() => {
    if (visible) {
      setActiveTab(initialTab);
      setShowReset(false);
    }
  }, [visible, initialTab]);

  if (!visible) return null;

  const backToLogin = () => {
    setShowReset(false);
    setActiveTab('login');
  };

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
          className="ts-modal theme-bg-elevated theme-radius-card theme-shadow-panel border theme-border-default w-full max-w-md focus:outline-none"
        >
          {showReset ? (
            // 重置视图：一行头部**替换**整条页签栏（不是第三个页签）。
            <div className="flex items-center justify-between border-b theme-border-default">
              <span className="py-3 pl-6 text-base font-semibold theme-text-primary">
                {RESET_COPY.headerTitle}
              </span>
              <div className="flex items-center">
                <button
                  type="button"
                  onClick={backToLogin}
                  className="inline-flex min-h-9 min-w-9 items-center justify-center rounded px-2 text-sm font-medium theme-accent-text hover:underline"
                >
                  {RESET_COPY.backToLogin}
                </button>
                <button
                  type="button"
                  className="p-3 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                  onClick={onClose}
                  aria-label="关闭登录弹窗"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          ) : (
            <div
              className="flex border-b theme-border-default"
              role="tablist"
              aria-label="登录或注册"
            >
              {/* 激活态：2026-10-20 审计 P1-2 —— 原先写死 `text-primary-600`
                  （Tailwind 的 #2563eb，**在 6 个深色主题下都不变**），而深色底
                  亮度只有 17–44 级 ⇒ 实测塌到 2.17–2.96:1，低于 AA 的 4.5:1。
                  现在文字走 --color-text-primary（主题的最强文字色），
                  2px 激活下划线走 --color-accent-text（≥3:1 的非文本对比）。 */}
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'login'}
                className={`flex-1 py-3 transition-all font-medium ${activeTab === 'login' ? 'theme-text-primary border-b-2 theme-accent-ink-border' : 'text-gray-600 dark:text-gray-300 hover:text-primary-600 dark:hover:text-primary-400'}`}
                onClick={() => setActiveTab('login')}
              >
                登录
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'register'}
                className={`flex-1 py-3 transition-all font-medium ${activeTab === 'register' ? 'theme-text-primary border-b-2 theme-accent-ink-border' : 'text-gray-600 dark:text-gray-300 hover:text-primary-600 dark:hover:text-primary-400'}`}
                onClick={() => setActiveTab('register')}
              >
                注册
              </button>
              <button
                type="button"
                className="p-3 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                onClick={onClose}
                aria-label="关闭登录弹窗"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}
          <div className="p-6">
            {showReset ? (
              <PasswordResetView onClose={onClose} />
            ) : activeTab === 'login' ? (
              <LoginForm onSuccess={onClose} onForgotPassword={() => setShowReset(true)} />
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
