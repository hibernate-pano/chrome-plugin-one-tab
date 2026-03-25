import React from 'react';

export const WelcomeStep: React.FC<{ version: string }> = ({ version }) => (
  <div className="onboarding-content">
    <div className="onboarding-icon-wrapper">
      <span>🧭</span>
    </div>
    <h2 className="onboarding-title">欢迎使用 TabVault Pro</h2>
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
        <div className="onboarding-feature-desc">按会话、备注或标签找回</div>
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
    <h2 className="onboarding-title">先保存一个会话</h2>
    <p className="onboarding-description">
      点击顶部的“保存会话”按钮
      <br />
      当前窗口会被收成一个可找回的工作会话
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
        <div className="onboarding-feature-icon">✍️</div>
        <div className="onboarding-feature-title">备注与收藏</div>
        <div className="onboarding-feature-desc">给重要会话补一句上下文说明</div>
      </div>
    </div>
  </div>
);

export const SearchStep: React.FC = () => (
  <div className="onboarding-content">
    <div className="onboarding-icon-wrapper">
      <span>🔍</span>
    </div>
    <h2 className="onboarding-title">需要时快速找回</h2>
    <p className="onboarding-description">
      搜索会话名、备注、标签标题或 URL
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
        <div className="onboarding-feature-desc">快速收敛到最近保存或更久之前</div>
      </div>
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon">⭐</div>
        <div className="onboarding-feature-title">收藏重要会话</div>
        <div className="onboarding-feature-desc">关键上下文更容易二次定位</div>
      </div>
    </div>
  </div>
);

export const RestoreStep: React.FC = () => (
  <div className="onboarding-content">
    <div className="onboarding-icon-wrapper">
      <span>🚀</span>
    </div>
    <h2 className="onboarding-title">恢复时继续，而不是重来</h2>
    <p className="onboarding-description">
      恢复整个会话时，会默认在新窗口中打开
      <br />
      你还能在“最近恢复”里再次回到刚刚的工作现场
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
        <div className="onboarding-feature-title">最近恢复</div>
        <div className="onboarding-feature-desc">知道你上次从哪里恢复过这个会话</div>
      </div>
    </div>
  </div>
);

export const ReadyStep: React.FC = () => (
  <div className="onboarding-content text-center">
    <div className="onboarding-icon-wrapper">
      <span className="onboarding-confetti">✅</span>
    </div>
    <h2 className="onboarding-title">核心闭环已经齐了</h2>
    <p className="onboarding-description">
      现在开始保存、搜索、恢复你的工作会话
      <br />
      需要跨设备时，再按需手动同步
    </p>
  </div>
);
