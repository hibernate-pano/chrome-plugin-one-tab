import React from 'react';

// SVG icon components (replacing emoji for Chrome Web Store compatibility)
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
const SyncIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
    <polyline points="23 4 23 10 17 10"/>
    <polyline points="1 20 1 14 7 14"/>
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
  </svg>
);
const BarChartIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
    <line x1="12" y1="20" x2="12" y2="10"/>
    <line x1="18" y1="20" x2="18" y2="4"/>
    <line x1="6" y1="20" x2="6" y2="16"/>
  </svg>
);
const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
);
const XIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
    <line x1="18" y1="6" x2="6" y2="18"/>
    <line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
);
const LightbulbIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
    <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.74V17h8v-2.26A7 7 0 0 0 12 2z"/>
  </svg>
);
const TagIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
    <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
    <line x1="7" y1="7" x2="7.01" y2="7"/>
  </svg>
);
const KeyboardIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
    <rect x="2" y="4" width="20" height="16" rx="2"/>
    <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10"/>
  </svg>
);

/**
 * Step 1: 保存 — action + CTA 模板
 * 强调"做什么动作" + 模拟按钮视觉，让用户看到一眼会点哪里。
 */
export const SaveTabsStep: React.FC = () => (
  <div className="flex flex-col items-center gap-5 p-6">
    <div className="onboarding-icon-wrapper rounded-xl shadow-md bg-primary/10 w-12 h-12 flex items-center justify-center">
      <SaveIcon />
    </div>
    <div className="text-center">
      <h2 className="text-xl font-semibold text-gray-900 dark:text-white">先把窗口存起来</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
        点击顶部&ldquo;保存会话&rdquo;，当前窗口变成一个可找回的工作会话
      </p>
    </div>

    {/* Action + CTA: 一个被点亮的按钮 + 操作要点列表 */}
    <div className="w-full max-w-md flex flex-col gap-4">
      <div className="rounded-xl bg-gradient-to-br from-primary/10 to-primary/5 border border-primary/20 px-5 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-primary text-white p-2 flex items-center justify-center">
            <SaveIcon />
          </div>
          <div>
            <div className="text-sm font-medium text-gray-900 dark:text-white">保存当前窗口</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">这一步就是你需要的全部动作</div>
          </div>
        </div>
        <span className="text-xs font-mono px-2 py-1 rounded bg-white/60 dark:bg-gray-800/60 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700">⌘ / Ctrl + S</span>
      </div>

      <ul className="space-y-2 text-sm text-gray-700 dark:text-gray-300">
        <li className="flex items-start gap-2">
          <span className="mt-0.5 text-primary"><CheckIcon /></span>
          <span>默认保存当前窗口所有未固定的标签</span>
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-0.5 text-primary"><CheckIcon /></span>
          <span>固定标签(pinned)可按设置一并保存</span>
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-0.5 text-primary"><CheckIcon /></span>
          <span>需要时给会话补一句备注或加标签</span>
        </li>
      </ul>

      <div className="text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 rounded-lg px-3 py-2 leading-relaxed">
        需要跨设备时再按需手动同步；本地保存已足够日常使用。
      </div>
    </div>
  </div>
);

/**
 * Step 2: 恢复 — 示例对比 模板
 * 一边"没保存 → 重新打开"，另一边"保存 → 一键恢复"，直白对比价值。
 */
export const RestoreStep: React.FC = () => (
  <div className="flex flex-col items-center gap-5 p-6">
    <div className="onboarding-icon-wrapper rounded-xl shadow-md bg-primary/10 w-12 h-12 flex items-center justify-center">
      <RocketIcon />
    </div>
    <div className="text-center">
      <h2 className="text-xl font-semibold text-gray-900 dark:text-white">恢复，而不是重来</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
        一次性把整个会话在新窗口打开，回到上次的工作现场
      </p>
    </div>

    {/* Example contrast: 没有 / 有 */}
    <div className="w-full max-w-md grid grid-cols-1 gap-3">
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 p-4">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-gray-400"><XIcon /></span>
          <span className="text-xs font-medium uppercase tracking-wide text-gray-500">没保存</span>
        </div>
        <div className="space-y-1.5">
          <div className="text-xs px-2 py-1 rounded bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-500 line-through">
            一个一个重新打开标签
          </div>
          <div className="text-xs px-2 py-1 rounded bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-500 line-through">
            翻历史记录找回刚才的链接
          </div>
          <div className="text-xs px-2 py-1 rounded bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-500 line-through">
            重新登录每个网站
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-primary/30 bg-primary/5 dark:bg-primary/10 p-4">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-primary"><CheckIcon /></span>
          <span className="text-xs font-medium uppercase tracking-wide text-primary">用 TabStack 恢复</span>
        </div>
        <div className="space-y-1.5">
          <div className="text-xs px-2 py-1 rounded bg-white dark:bg-gray-900 border border-primary/30 text-gray-800 dark:text-gray-200">
            一次打开会话里的全部标签
          </div>
          <div className="text-xs px-2 py-1 rounded bg-white dark:bg-gray-900 border border-primary/30 text-gray-800 dark:text-gray-200">
            pinned 标签的状态也跟着回来
          </div>
          <div className="text-xs px-2 py-1 rounded bg-white dark:bg-gray-900 border border-primary/30 text-gray-800 dark:text-gray-200">
            默认在新窗口打开，不打断当前工作
          </div>
        </div>
      </div>
    </div>
  </div>
);

/**
 * Step 3: 搜索 — 技巧提示 模板
 * 一组"上手即用"的小贴士，按编号列出，便于扫读。
 */
export const SearchStep: React.FC = () => (
  <div className="flex flex-col items-center gap-5 p-6">
    <div className="onboarding-icon-wrapper rounded-xl shadow-md bg-primary/10 w-12 h-12 flex items-center justify-center">
      <SearchIcon />
    </div>
    <div className="text-center">
      <h2 className="text-xl font-semibold text-gray-900 dark:text-white">需要时快速找回</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
        搜索会话名、备注、标签或 URL，先按会话归组，再展开标签
      </p>
    </div>

    {/* Tips list: 编号 + 图标 + 文案 */}
    <div className="w-full max-w-md space-y-2.5">
      <div className="flex items-start gap-3 rounded-lg px-3 py-2.5 bg-gray-50 dark:bg-gray-800/40">
        <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary text-white text-xs font-semibold flex items-center justify-center">1</span>
        <div className="flex-1">
          <div className="text-sm font-medium text-gray-900 dark:text-white flex items-center gap-1.5">
            <TagIcon />标签/会话名/备注都是关键字
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">模糊匹配，不必输完整词</div>
        </div>
      </div>

      <div className="flex items-start gap-3 rounded-lg px-3 py-2.5 bg-gray-50 dark:bg-gray-800/40">
        <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary text-white text-xs font-semibold flex items-center justify-center">2</span>
        <div className="flex-1">
          <div className="text-sm font-medium text-gray-900 dark:text-white flex items-center gap-1.5">
            <KeyboardIcon />快捷键 ⌘ / Ctrl + K 直接聚焦搜索
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">免去点输入框的动作</div>
        </div>
      </div>

      <div className="flex items-start gap-3 rounded-lg px-3 py-2.5 bg-gray-50 dark:bg-gray-800/40">
        <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary text-white text-xs font-semibold flex items-center justify-center">3</span>
        <div className="flex-1">
          <div className="text-sm font-medium text-gray-900 dark:text-white flex items-center gap-1.5">
            <BarChartIcon />收藏重要会话，二次定位更快
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">关键上下文打星常驻列表顶部</div>
        </div>
      </div>

      <div className="flex items-start gap-3 rounded-lg px-3 py-2.5 bg-gray-50 dark:bg-gray-800/40">
        <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary text-white text-xs font-semibold flex items-center justify-center">4</span>
        <div className="flex-1">
          <div className="text-sm font-medium text-gray-900 dark:text-white flex items-center gap-1.5">
            <SyncIcon />跨设备搜索结果以最后一次同步为准
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">本地优先，必要时再触发同步</div>
        </div>
      </div>
    </div>

    <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200/60 dark:border-amber-700/40 rounded-lg px-3 py-2 max-w-md">
      <span className="text-amber-600 dark:text-amber-400"><LightbulbIcon /></span>
      <span>提示：保存时给会话起个有意义的名字，搜索时召回率会高很多。</span>
    </div>
  </div>
);