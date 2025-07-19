/**
 * CSS类名常量
 * 统一管理项目中使用的CSS类名，避免硬编码
 */

// 基础样式类
export const BASE_CLASSES = {
  // 布局
  FLEX: 'flex',
  FLEX_COL: 'flex-col',
  FLEX_ROW: 'flex-row',
  GRID: 'grid',
  BLOCK: 'block',
  INLINE: 'inline',
  INLINE_BLOCK: 'inline-block',
  HIDDEN: 'hidden',
  
  // 定位
  RELATIVE: 'relative',
  ABSOLUTE: 'absolute',
  FIXED: 'fixed',
  STICKY: 'sticky',
  
  // 尺寸
  FULL_WIDTH: 'w-full',
  FULL_HEIGHT: 'h-full',
  FULL_SIZE: 'w-full h-full',
  
  // 对齐
  CENTER: 'justify-center items-center',
  CENTER_X: 'justify-center',
  CENTER_Y: 'items-center',
  
  // 溢出
  OVERFLOW_HIDDEN: 'overflow-hidden',
  OVERFLOW_AUTO: 'overflow-auto',
  OVERFLOW_SCROLL: 'overflow-scroll',
} as const;

// 交互状态类
export const INTERACTION_CLASSES = {
  // 悬停效果
  HOVER_BG_GRAY: 'hover:bg-gray-100 dark:hover:bg-gray-700',
  HOVER_BG_BLUE: 'hover:bg-blue-50 dark:hover:bg-blue-900',
  HOVER_TEXT_BLUE: 'hover:text-blue-600 dark:hover:text-blue-400',
  HOVER_SCALE: 'hover:scale-105',
  HOVER_SHADOW: 'hover:shadow-lg',
  
  // 焦点效果
  FOCUS_RING: 'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2',
  FOCUS_VISIBLE: 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
  
  // 激活效果
  ACTIVE_SCALE: 'active:scale-95',
  ACTIVE_BG: 'active:bg-gray-200 dark:active:bg-gray-600',
  
  // 选中状态
  SELECTED_BG: 'bg-blue-100 dark:bg-blue-900',
  SELECTED_BORDER: 'border-blue-500',
  SELECTED_TEXT: 'text-blue-700 dark:text-blue-300',
  
  // 禁用状态
  DISABLED: 'opacity-50 cursor-not-allowed',
  DISABLED_BG: 'bg-gray-100 dark:bg-gray-800',
} as const;

// 动画类
export const ANIMATION_CLASSES = {
  // 过渡效果
  TRANSITION_ALL: 'transition-all duration-200 ease-in-out',
  TRANSITION_COLORS: 'transition-colors duration-200 ease-in-out',
  TRANSITION_TRANSFORM: 'transition-transform duration-200 ease-in-out',
  TRANSITION_OPACITY: 'transition-opacity duration-200 ease-in-out',
  
  // 动画效果
  ANIMATE_SPIN: 'animate-spin',
  ANIMATE_PULSE: 'animate-pulse',
  ANIMATE_BOUNCE: 'animate-bounce',
  ANIMATE_FADE_IN: 'animate-in fade-in-0',
  ANIMATE_FADE_OUT: 'animate-out fade-out-0',
  ANIMATE_SLIDE_IN: 'animate-in slide-in-from-bottom-2',
  ANIMATE_SLIDE_OUT: 'animate-out slide-out-to-bottom-2',
  ANIMATE_ZOOM_IN: 'animate-in zoom-in-95',
  ANIMATE_ZOOM_OUT: 'animate-out zoom-out-95',
  
  // 持续时间
  DURATION_75: 'duration-75',
  DURATION_100: 'duration-100',
  DURATION_150: 'duration-150',
  DURATION_200: 'duration-200',
  DURATION_300: 'duration-300',
  DURATION_500: 'duration-500',
} as const;

// 组件特定类
export const COMPONENT_CLASSES = {
  // 按钮
  BUTTON_BASE: 'inline-flex items-center justify-center rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none',
  BUTTON_PRIMARY: 'bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800',
  BUTTON_SECONDARY: 'bg-gray-200 text-gray-900 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600',
  BUTTON_DANGER: 'bg-red-600 text-white hover:bg-red-700 active:bg-red-800',
  BUTTON_GHOST: 'hover:bg-gray-100 dark:hover:bg-gray-800',
  BUTTON_LINK: 'text-blue-600 underline-offset-4 hover:underline dark:text-blue-400',
  
  // 输入框
  INPUT_BASE: 'flex h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm ring-offset-white file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-gray-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:placeholder:text-gray-400',
  INPUT_ERROR: 'border-red-500 focus-visible:ring-red-500',
  INPUT_SUCCESS: 'border-green-500 focus-visible:ring-green-500',
  
  // 卡片
  CARD_BASE: 'rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800',
  CARD_HEADER: 'flex flex-col space-y-1.5 p-6',
  CARD_CONTENT: 'p-6 pt-0',
  CARD_FOOTER: 'flex items-center p-6 pt-0',
  
  // 模态框
  MODAL_OVERLAY: 'fixed inset-0 z-50 bg-black/50 backdrop-blur-sm',
  MODAL_CONTENT: 'fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border border-gray-200 bg-white p-6 shadow-lg duration-200 dark:border-gray-700 dark:bg-gray-800',
  MODAL_HEADER: 'flex flex-col space-y-1.5 text-center sm:text-left',
  MODAL_FOOTER: 'flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2',
  
  // 下拉菜单
  DROPDOWN_CONTENT: 'z-50 min-w-[8rem] overflow-hidden rounded-md border border-gray-200 bg-white p-1 text-gray-950 shadow-md dark:border-gray-700 dark:bg-gray-800 dark:text-gray-50',
  DROPDOWN_ITEM: 'relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-gray-100 focus:text-gray-900 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 dark:focus:bg-gray-700 dark:focus:text-gray-100',
  DROPDOWN_SEPARATOR: 'mx-1 my-1 h-px bg-gray-200 dark:bg-gray-700',
  
  // 工具提示
  TOOLTIP_CONTENT: 'z-50 overflow-hidden rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-950 shadow-md animate-in fade-in-0 zoom-in-95 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-50',
  
  // 通知
  TOAST_BASE: 'group pointer-events-auto relative flex w-full items-center justify-between space-x-4 overflow-hidden rounded-md border border-gray-200 p-6 pr-8 shadow-lg transition-all dark:border-gray-700',
  TOAST_SUCCESS: 'border-green-200 bg-green-50 text-green-900 dark:border-green-700 dark:bg-green-900 dark:text-green-100',
  TOAST_ERROR: 'border-red-200 bg-red-50 text-red-900 dark:border-red-700 dark:bg-red-900 dark:text-red-100',
  TOAST_WARNING: 'border-yellow-200 bg-yellow-50 text-yellow-900 dark:border-yellow-700 dark:bg-yellow-900 dark:text-yellow-100',
  TOAST_INFO: 'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-700 dark:bg-blue-900 dark:text-blue-100',
} as const;

// 状态指示类
export const STATUS_CLASSES = {
  // 加载状态
  LOADING: 'animate-pulse',
  LOADING_SPINNER: 'animate-spin',
  LOADING_DOTS: 'animate-pulse',
  
  // 成功状态
  SUCCESS_BG: 'bg-green-100 dark:bg-green-900',
  SUCCESS_TEXT: 'text-green-700 dark:text-green-300',
  SUCCESS_BORDER: 'border-green-300 dark:border-green-600',
  
  // 错误状态
  ERROR_BG: 'bg-red-100 dark:bg-red-900',
  ERROR_TEXT: 'text-red-700 dark:text-red-300',
  ERROR_BORDER: 'border-red-300 dark:border-red-600',
  
  // 警告状态
  WARNING_BG: 'bg-yellow-100 dark:bg-yellow-900',
  WARNING_TEXT: 'text-yellow-700 dark:text-yellow-300',
  WARNING_BORDER: 'border-yellow-300 dark:border-yellow-600',
  
  // 信息状态
  INFO_BG: 'bg-blue-100 dark:bg-blue-900',
  INFO_TEXT: 'text-blue-700 dark:text-blue-300',
  INFO_BORDER: 'border-blue-300 dark:border-blue-600',
} as const;

// 拖拽相关类
export const DRAG_DROP_CLASSES = {
  // 拖拽源
  DRAGGABLE: 'cursor-move',
  DRAGGING: 'opacity-50 transform rotate-2',
  DRAG_HANDLE: 'cursor-grab active:cursor-grabbing',
  
  // 拖拽目标
  DROP_ZONE: 'border-2 border-dashed border-gray-300 dark:border-gray-600',
  DROP_ZONE_ACTIVE: 'border-blue-500 bg-blue-50 dark:bg-blue-900/20',
  DROP_ZONE_INVALID: 'border-red-500 bg-red-50 dark:bg-red-900/20',
  
  // 拖拽预览
  DRAG_PREVIEW: 'pointer-events-none z-50 transform rotate-2 shadow-lg',
  DRAG_GHOST: 'opacity-60',
} as const;

// 搜索高亮类
export const SEARCH_CLASSES = {
  HIGHLIGHT: 'bg-yellow-200 dark:bg-yellow-800 text-yellow-900 dark:text-yellow-100 px-1 rounded',
  HIGHLIGHT_CURRENT: 'bg-orange-300 dark:bg-orange-700 text-orange-900 dark:text-orange-100 px-1 rounded',
  SEARCH_RESULT: 'border-l-4 border-blue-500 bg-blue-50 dark:bg-blue-900/20',
} as const;

// 响应式类
export const RESPONSIVE_CLASSES = {
  // 隐藏/显示
  HIDE_ON_MOBILE: 'hidden sm:block',
  HIDE_ON_DESKTOP: 'block sm:hidden',
  SHOW_ON_MOBILE: 'block sm:hidden',
  SHOW_ON_DESKTOP: 'hidden sm:block',
  
  // 布局
  MOBILE_STACK: 'flex-col sm:flex-row',
  DESKTOP_GRID: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  
  // 间距
  MOBILE_PADDING: 'p-4 sm:p-6',
  MOBILE_MARGIN: 'm-4 sm:m-6',
} as const;

// 工具类组合
export const UTILITY_COMBINATIONS = {
  // 居中容器
  CENTER_CONTAINER: `${BASE_CLASSES.FLEX} ${BASE_CLASSES.CENTER}`,
  
  // 卡片悬停效果
  CARD_HOVER: `${INTERACTION_CLASSES.HOVER_SHADOW} ${ANIMATION_CLASSES.TRANSITION_ALL}`,
  
  // 按钮基础样式
  BUTTON_FOCUS: `${INTERACTION_CLASSES.FOCUS_RING} ${ANIMATION_CLASSES.TRANSITION_COLORS}`,
  
  // 输入框焦点
  INPUT_FOCUS: `${INTERACTION_CLASSES.FOCUS_VISIBLE} ${ANIMATION_CLASSES.TRANSITION_COLORS}`,
  
  // 模态框动画
  MODAL_ANIMATION: `${ANIMATION_CLASSES.ANIMATE_FADE_IN} ${ANIMATION_CLASSES.DURATION_200}`,
  
  // 加载状态
  LOADING_STATE: `${STATUS_CLASSES.LOADING} ${BASE_CLASSES.FLEX} ${BASE_CLASSES.CENTER}`,
} as const;

// 类名构建器函数
export function buildClassName(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(' ');
}

// 条件类名函数
export function conditionalClass(condition: boolean, trueClass: string, falseClass?: string): string {
  return condition ? trueClass : (falseClass || '');
}

// 状态类名映射
export function getStatusClass(status: 'success' | 'error' | 'warning' | 'info'): string {
  const statusMap = {
    success: STATUS_CLASSES.SUCCESS_BG,
    error: STATUS_CLASSES.ERROR_BG,
    warning: STATUS_CLASSES.WARNING_BG,
    info: STATUS_CLASSES.INFO_BG,
  };
  
  return statusMap[status] || '';
}

// 按钮变体类名映射
export function getButtonClass(variant: 'primary' | 'secondary' | 'danger' | 'ghost' | 'link'): string {
  const variantMap = {
    primary: COMPONENT_CLASSES.BUTTON_PRIMARY,
    secondary: COMPONENT_CLASSES.BUTTON_SECONDARY,
    danger: COMPONENT_CLASSES.BUTTON_DANGER,
    ghost: COMPONENT_CLASSES.BUTTON_GHOST,
    link: COMPONENT_CLASSES.BUTTON_LINK,
  };
  
  return `${COMPONENT_CLASSES.BUTTON_BASE} ${variantMap[variant] || COMPONENT_CLASSES.BUTTON_PRIMARY}`;
}
