import React from 'react';

/**
 * 引导各步内容。
 *
 * 每个步骤标题都带 tabIndex={-1}：不是给键盘用户新增一个 Tab 落点（-1 本就不进 Tab 序列），
 * 而是给 OnboardingGuide 在切步时提供聚焦目标——读屏会播报新标题，
 * 键盘用户的焦点也不会停留在上一步已经卸载的按钮上。
 */
export const WelcomeStep: React.FC<{ version: string }> = ({ version }) => (
  <div className="onboarding-content">
    <div className="onboarding-icon-wrapper">
      <span>🧭</span>
    </div>
    <h2 tabIndex={-1} className="onboarding-title">欢迎使用 TapStack</h2>
    <div className="flex justify-center">
      <span className="onboarding-version-badge">v{version}</span>
    </div>
    <p className="onboarding-description">
      把当前窗口保存成可找回、可恢复的工作会话
      <br />
      让中断后的继续工作变得更快、更稳
    </p>
    <div className="onboarding-feature-grid">
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon">💾</div>
        <div className="onboarding-feature-title">保存</div>
        <div className="onboarding-feature-desc">先把工作现场收起来</div>
      </div>
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon">🔍</div>
        <div className="onboarding-feature-title">搜索</div>
        <div className="onboarding-feature-desc">按会话名或标签找回</div>
      </div>
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon">🚀</div>
        <div className="onboarding-feature-title">恢复</div>
        <div className="onboarding-feature-desc">默认在新窗口里继续工作</div>
      </div>
    </div>
  </div>
);

export const SaveTabsStep: React.FC = () => (
  <div className="onboarding-content">
    <div className="onboarding-icon-wrapper">
      <span>💾</span>
    </div>
    <h2 tabIndex={-1} className="onboarding-title">先保存一个会话</h2>
    <p className="onboarding-description">
      {/* ── 2026-10-09 P1-2：文案不得让用户做一件当前做不到的事 ───────────
       * 引导遮罩 `.onboarding-overlay` 是 position:fixed; inset:0 覆盖整个视口，
       * 且**没有点击处理器**——此时点高亮区域只会点到遮罩，什么都不会发生。
       * 原文案却写「点击顶部的“保存会话”按钮」，聚光灯还把它标成可操作目标，
       * 用户照做得到的是「点了没反应」，以为按钮坏了。
       *
       * 改文案而不是改交互：让聚光灯目标在引导期间可点击需要重新设计
       * 「读」与「试」的边界（当前聚光灯是阅读态），属产品决策。
       * 文案只承诺**此刻真能做的事**，是无争议的诚实性修复。 */}
      关闭本引导后，点击顶部的“保存会话”按钮
      <br />
      当前窗口会被收成一个工作会话，<strong>这些标签随之关闭</strong>
      {/* 2026-10-09 P1-1：定位保持「保存 = 剪切」（产品负责人已确认），
          但新用户第一次操作就该知道会发生什么 —— 「收成一个会话」没有明说
          标签会关掉，用户可能以为只是存了个副本。 */}
    </p>
    <div className="onboarding-feature-grid">
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon">🪟</div>
        <div className="onboarding-feature-title">保存当前窗口</div>
        <div className="onboarding-feature-desc">把此刻的工作上下文完整留住</div>
      </div>
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon">📌</div>
        <div className="onboarding-feature-title">Pinned 可选</div>
        <div className="onboarding-feature-desc">固定标签页可保留，也可一并保存</div>
      </div>
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon">🔒</div>
        <div className="onboarding-feature-title">锁定保护</div>
        <div className="onboarding-feature-desc">重要会话可锁定，避免误删</div>
      </div>
    </div>
  </div>
);

export const SearchStep: React.FC = () => (
  <div className="onboarding-content">
    <div className="onboarding-icon-wrapper">
      <span>🔍</span>
    </div>
    <h2 tabIndex={-1} className="onboarding-title">需要时快速找回</h2>
    <p className="onboarding-description">
      搜索会话名、标签标题或 URL
      <br />
      结果会先按会话归组，再展开具体标签
    </p>
    <div className="onboarding-feature-grid">
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon">🗂️</div>
        <div className="onboarding-feature-title">先找会话</div>
        <div className="onboarding-feature-desc">同一批相关标签会一起出现</div>
      </div>
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon">⏱️</div>
        <div className="onboarding-feature-title">按时间过滤</div>
        <div className="onboarding-feature-desc">快速收敛到较新的会话或更久之前</div>
      </div>
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon">🌐</div>
        <div className="onboarding-feature-title">按域名过滤</div>
        <div className="onboarding-feature-desc">同一站点的标签更容易聚到一起</div>
      </div>
    </div>
  </div>
);

export const RestoreStep: React.FC = () => (
  <div className="onboarding-content">
    <div className="onboarding-icon-wrapper">
      <span>🚀</span>
    </div>
    <h2 tabIndex={-1} className="onboarding-title">恢复时继续，而不是重来</h2>
    <p className="onboarding-description">
      恢复整个会话时，会默认在新窗口中打开
      <br />
      需要时也可以从会话列表里再次打开刚刚整理过的内容
    </p>
    <div className="onboarding-feature-grid">
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon">🪄</div>
        <div className="onboarding-feature-title">新窗口恢复</div>
        <div className="onboarding-feature-desc">尽量不打断你当前正在做的事</div>
      </div>
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon">📍</div>
        <div className="onboarding-feature-title">保留 pinned</div>
        <div className="onboarding-feature-desc">固定标签页状态会跟着一起回来</div>
      </div>
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon">🕘</div>
        <div className="onboarding-feature-title">时间戳命名</div>
        <div className="onboarding-feature-desc">新会话默认按保存时间命名，回看更直接</div>
      </div>
    </div>
  </div>
);

export const SyncStep: React.FC = () => (
  <div className="onboarding-content">
    <div className="onboarding-icon-wrapper">
      <span>☁️</span>
    </div>
    <h2 tabIndex={-1} className="onboarding-title">换台设备也能找回</h2>
    <p className="onboarding-description">
      通过右上角菜单「登录 / 注册」开启同步
      <br />
      保存后会自动备份到云端，新设备登录即恢复
    </p>
    <div className="onboarding-feature-grid">
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon">🔄</div>
        <div className="onboarding-feature-title">自动同步</div>
        <div className="onboarding-feature-desc">保存和重命名都会自动备份</div>
      </div>
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon">📤</div>
        <div className="onboarding-feature-title">导入导出</div>
        <div className="onboarding-feature-desc">支持 OneTab 文本格式与 JSON 备份</div>
      </div>
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon">🛟</div>
        <div className="onboarding-feature-title">误删保护</div>
        <div className="onboarding-feature-desc">删除前二次确认，防手滑清空工作现场</div>
      </div>
    </div>
  </div>
);

export const ReadyStep: React.FC = () => (
  <div className="onboarding-content text-center">
    <div className="onboarding-icon-wrapper">
      <span className="onboarding-confetti">✅</span>
    </div>
    <h2 tabIndex={-1} className="onboarding-title">核心闭环已经齐了</h2>
    <p className="onboarding-description">
      现在开始保存、搜索、恢复你的工作会话
      <br />
      需要跨设备时，再按需手动同步
    </p>
  </div>
);
