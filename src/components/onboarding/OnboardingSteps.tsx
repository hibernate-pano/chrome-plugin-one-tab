import React from 'react';

// SVG icon components (replacing emoji for Chrome Web Store compatibility)
const CompassIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-8 h-8">
    <circle cx="12" cy="12" r="10"/>
    <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>
  </svg>
);
const SaveIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-8 h-8">
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
    <polyline points="17 21 17 13 7 13 7 21"/>
    <polyline points="7 3 7 8 15 8"/>
  </svg>
);
const SearchIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-8 h-8">
    <circle cx="11" cy="11" r="8"/>
    <line x1="21" y1="21" x2="16.65" y2="16.65"/>
  </svg>
);
const RocketIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-8 h-8">
    <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09zM12 15l-3-3a22 22 0 0 1 2-2.95c.37-1.68-.35-3.05-2.11-2.95-1.13-.05-2.31.35-3.16 1.27L3 10l1.41-1.41c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09L2 5.59"/>
    <path d="M14 11.5c1 1 2 2.5 2 2.5s1.5-1 2.5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/>
    <path d="M17 7l-3 3M17 17l-3-3M7 7L4 4M7 17L4 20"/>
  </svg>
);
const WindowIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-8 h-8">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
    <line x1="3" y1="9" x2="21" y2="9"/>
    <line x1="9" y1="21" x2="9" y2="9"/>
  </svg>
);
const PinIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-8 h-8">
    <line x1="12" y1="17" x2="12" y2="22"/>
    <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17z"/>
  </svg>
);
const EditIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-8 h-8">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
  </svg>
);
const FolderIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-8 h-8">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
  </svg>
);
const ClockIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-8 h-8">
    <circle cx="12" cy="12" r="10"/>
    <polyline points="12 6 12 12 16 14"/>
  </svg>
);
const StarIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-8 h-8">
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
  </svg>
);
const WandIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-8 h-8">
    <path d="M15 4V2"/>
    <path d="M15 16v-2"/>
    <path d="M8 9h2"/>
    <path d="M20 9h2"/>
    <path d="M17.8 11.8L19 13"/>
    <path d="M15 9h0"/>
    <path d="M17.8 6.2L19 5"/>
    <path d="M3 21l9-9"/>
    <path d="M12.2 6.2L11 5"/>
  </svg>
);
const LocationIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-8 h-8">
    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
    <circle cx="12" cy="10" r="3"/>
  </svg>
);
const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-8 h-8">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
);

export const WelcomeStep: React.FC<{ version: string }> = ({ version }) => (
  <div className="flex flex-col items-center gap-6 p-8">
    <div className="onboarding-icon-wrapper rounded-xl shadow-md bg-primary/10 w-12 h-12 flex items-center justify-center">
      <CompassIcon />
    </div>
    <h2 className="text-xl font-semibold text-gray-900 dark:text-white">欢迎使用 TabStack</h2>
    <div className="flex justify-center">
      <span className="text-xs font-medium px-3 py-1 bg-primary/10 text-primary rounded-full">v{version}</span>
    </div>
    <p className="text-sm text-gray-500 dark:text-gray-400">
      把当前窗口保存成可找回、可恢复的工作会话
      <br />
      让中断后的继续工作变得更快、更稳
    </p>
    <div className="onboarding-feature-grid grid grid-cols-1 sm:grid-cols-3 gap-4 w-full max-w-3xl">
      <div className="onboarding-feature-card rounded-xl shadow-sm bg-white dark:bg-gray-800 p-6 flex flex-col items-center text-center gap-3 transition-all duration-200 hover:scale-105 hover:shadow-md focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:outline-none animate-fade-in">
        <div className="onboarding-feature-icon bg-primary/5 w-12 h-12 flex items-center justify-center rounded-xl"><SaveIcon /></div>
        <div className="onboarding-feature-title font-medium text-gray-900 dark:text-white">保存</div>
        <div className="onboarding-feature-desc text-sm text-gray-500 dark:text-gray-400">先把工作现场收起来</div>
      </div>
      <div className="onboarding-feature-card rounded-xl shadow-sm bg-white dark:bg-gray-800 p-6 flex flex-col items-center text-center gap-3 transition-all duration-200 hover:scale-105 hover:shadow-md focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:outline-none animate-fade-in animation-delay-100">
        <div className="onboarding-feature-icon bg-primary/5 w-12 h-12 flex items-center justify-center rounded-xl"><SearchIcon /></div>
        <div className="onboarding-feature-title font-medium text-gray-900 dark:text-white">搜索</div>
        <div className="onboarding-feature-desc text-sm text-gray-500 dark:text-gray-400">按会话、备注或标签找回</div>
      </div>
      <div className="onboarding-feature-card rounded-xl shadow-sm bg-white dark:bg-gray-800 p-6 flex flex-col items-center text-center gap-3 transition-all duration-200 hover:scale-105 hover:shadow-md focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:outline-none animate-fade-in animation-delay-200">
        <div className="onboarding-feature-icon bg-primary/5 w-12 h-12 flex items-center justify-center rounded-xl"><RocketIcon /></div>
        <div className="onboarding-feature-title font-medium text-gray-900 dark:text-white">恢复</div>
        <div className="onboarding-feature-desc text-sm text-gray-500 dark:text-gray-400">默认在新窗口里继续工作</div>
      </div>
    </div>
  </div>
);

export const SaveTabsStep: React.FC = () => (
  <div className="flex flex-col items-center gap-6 p-8">
    <div className="onboarding-icon-wrapper rounded-xl shadow-md bg-primary/10 w-12 h-12 flex items-center justify-center">
      <SaveIcon />
    </div>
    <h2 className="text-xl font-semibold text-gray-900 dark:text-white">先保存一个会话</h2>
    <p className="text-sm text-gray-500 dark:text-gray-400">
      点击顶部的"保存会话"按钮
      <br />
      当前窗口会被收成一个可找回的工作会话
    </p>
    <div className="onboarding-feature-grid grid grid-cols-1 sm:grid-cols-3 gap-4 w-full max-w-3xl">
      <div className="onboarding-feature-card rounded-xl shadow-sm bg-white dark:bg-gray-800 p-6 flex flex-col items-center text-center gap-3 transition-all duration-200 hover:scale-105 hover:shadow-md focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:outline-none animate-fade-in">
        <div className="onboarding-feature-icon bg-primary/5 w-12 h-12 flex items-center justify-center rounded-xl"><WindowIcon /></div>
        <div className="onboarding-feature-title font-medium text-gray-900 dark:text-white">保存当前窗口</div>
        <div className="onboarding-feature-desc text-sm text-gray-500 dark:text-gray-400">把此刻的工作上下文完整留住</div>
      </div>
      <div className="onboarding-feature-card rounded-xl shadow-sm bg-white dark:bg-gray-800 p-6 flex flex-col items-center text-center gap-3 transition-all duration-200 hover:scale-105 hover:shadow-md focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:outline-none animate-fade-in animation-delay-100">
        <div className="onboarding-feature-icon bg-primary/5 w-12 h-12 flex items-center justify-center rounded-xl"><PinIcon /></div>
        <div className="onboarding-feature-title font-medium text-gray-900 dark:text-white">Pinned 可选</div>
        <div className="onboarding-feature-desc text-sm text-gray-500 dark:text-gray-400">固定标签页可保留，也可一并保存</div>
      </div>
      <div className="onboarding-feature-card rounded-xl shadow-sm bg-white dark:bg-gray-800 p-6 flex flex-col items-center text-center gap-3 transition-all duration-200 hover:scale-105 hover:shadow-md focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:outline-none animate-fade-in animation-delay-200">
        <div className="onboarding-feature-icon bg-primary/5 w-12 h-12 flex items-center justify-center rounded-xl"><EditIcon /></div>
        <div className="onboarding-feature-title font-medium text-gray-900 dark:text-white">备注与收藏</div>
        <div className="onboarding-feature-desc text-sm text-gray-500 dark:text-gray-400">给重要会话补一句上下文说明</div>
      </div>
    </div>
  </div>
);

export const SearchStep: React.FC = () => (
  <div className="flex flex-col items-center gap-6 p-8">
    <div className="onboarding-icon-wrapper rounded-xl shadow-md bg-primary/10 w-12 h-12 flex items-center justify-center">
      <SearchIcon />
    </div>
    <h2 className="text-xl font-semibold text-gray-900 dark:text-white">需要时快速找回</h2>
    <p className="text-sm text-gray-500 dark:text-gray-400">
      搜索会话名、备注、标签标题或 URL
      <br />
      结果会先按会话归组，再展开具体标签
    </p>
    <div className="onboarding-feature-grid grid grid-cols-1 sm:grid-cols-3 gap-4 w-full max-w-3xl">
      <div className="onboarding-feature-card rounded-xl shadow-sm bg-white dark:bg-gray-800 p-6 flex flex-col items-center text-center gap-3 transition-all duration-200 hover:scale-105 hover:shadow-md focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:outline-none animate-fade-in">
        <div className="onboarding-feature-icon bg-primary/5 w-12 h-12 flex items-center justify-center rounded-xl"><FolderIcon /></div>
        <div className="onboarding-feature-title font-medium text-gray-900 dark:text-white">先找会话</div>
        <div className="onboarding-feature-desc text-sm text-gray-500 dark:text-gray-400">同一批相关标签会一起出现</div>
      </div>
      <div className="onboarding-feature-card rounded-xl shadow-sm bg-white dark:bg-gray-800 p-6 flex flex-col items-center text-center gap-3 transition-all duration-200 hover:scale-105 hover:shadow-md focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:outline-none animate-fade-in animation-delay-100">
        <div className="onboarding-feature-icon bg-primary/5 w-12 h-12 flex items-center justify-center rounded-xl"><ClockIcon /></div>
        <div className="onboarding-feature-title font-medium text-gray-900 dark:text-white">按时间过滤</div>
        <div className="onboarding-feature-desc text-sm text-gray-500 dark:text-gray-400">快速收敛到较新的会话或更久之前</div>
      </div>
      <div className="onboarding-feature-card rounded-xl shadow-sm bg-white dark:bg-gray-800 p-6 flex flex-col items-center text-center gap-3 transition-all duration-200 hover:scale-105 hover:shadow-md focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:outline-none animate-fade-in animation-delay-200">
        <div className="onboarding-feature-icon bg-primary/5 w-12 h-12 flex items-center justify-center rounded-xl"><StarIcon /></div>
        <div className="onboarding-feature-title font-medium text-gray-900 dark:text-white">收藏重要会话</div>
        <div className="onboarding-feature-desc text-sm text-gray-500 dark:text-gray-400">关键上下文更容易二次定位</div>
      </div>
    </div>
  </div>
);

export const RestoreStep: React.FC = () => (
  <div className="flex flex-col items-center gap-6 p-8">
    <div className="onboarding-icon-wrapper rounded-xl shadow-md bg-primary/10 w-12 h-12 flex items-center justify-center">
      <RocketIcon />
    </div>
    <h2 className="text-xl font-semibold text-gray-900 dark:text-white">恢复时继续，而不是重来</h2>
    <p className="text-sm text-gray-500 dark:text-gray-400">
      恢复整个会话时，会默认在新窗口中打开
      <br />
      需要时也可以从会话列表里再次打开刚刚整理过的内容
    </p>
    <div className="onboarding-feature-grid grid grid-cols-1 sm:grid-cols-3 gap-4 w-full max-w-3xl">
      <div className="onboarding-feature-card rounded-xl shadow-sm bg-white dark:bg-gray-800 p-6 flex flex-col items-center text-center gap-3 transition-all duration-200 hover:scale-105 hover:shadow-md focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:outline-none animate-fade-in">
        <div className="onboarding-feature-icon bg-primary/5 w-12 h-12 flex items-center justify-center rounded-xl"><WandIcon /></div>
        <div className="onboarding-feature-title font-medium text-gray-900 dark:text-white">新窗口恢复</div>
        <div className="onboarding-feature-desc text-sm text-gray-500 dark:text-gray-400">尽量不打断你当前正在做的事</div>
      </div>
      <div className="onboarding-feature-card rounded-xl shadow-sm bg-white dark:bg-gray-800 p-6 flex flex-col items-center text-center gap-3 transition-all duration-200 hover:scale-105 hover:shadow-md focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:outline-none animate-fade-in animation-delay-100">
        <div className="onboarding-feature-icon bg-primary/5 w-12 h-12 flex items-center justify-center rounded-xl"><LocationIcon /></div>
        <div className="onboarding-feature-title font-medium text-gray-900 dark:text-white">保留 pinned</div>
        <div className="onboarding-feature-desc text-sm text-gray-500 dark:text-gray-400">固定标签页状态会跟着一起回来</div>
      </div>
      <div className="onboarding-feature-card rounded-xl shadow-sm bg-white dark:bg-gray-800 p-6 flex flex-col items-center text-center gap-3 transition-all duration-200 hover:scale-105 hover:shadow-md focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:outline-none animate-fade-in animation-delay-200">
        <div className="onboarding-feature-icon bg-primary/5 w-12 h-12 flex items-center justify-center rounded-xl"><ClockIcon /></div>
        <div className="onboarding-feature-title font-medium text-gray-900 dark:text-white">时间戳命名</div>
        <div className="onboarding-feature-desc text-sm text-gray-500 dark:text-gray-400">新会话默认按保存时间命名，回看更直接</div>
      </div>
    </div>
  </div>
);

export const ReadyStep: React.FC = () => (
  <div className="flex flex-col items-center gap-6 p-8 text-center">
    <div className="onboarding-icon-wrapper rounded-xl shadow-md bg-primary/10 w-12 h-12 flex items-center justify-center">
      <span className="rounded-full w-8 h-8 flex items-center justify-center font-bold text-sm bg-primary/10 text-primary"><CheckIcon /></span>
    </div>
    <h2 className="text-xl font-semibold text-gray-900 dark:text-white">核心闭环已经齐了</h2>
    <p className="text-sm text-gray-500 dark:text-gray-400">
      现在开始保存、搜索、恢复你的工作会话
      <br />
      需要跨设备时，再按需手动同步
    </p>
  </div>
);