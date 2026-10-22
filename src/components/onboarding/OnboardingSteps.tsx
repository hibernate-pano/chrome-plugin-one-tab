import React from 'react';

import { saveAndCloseLabel } from '@/components/layout/saveActionCopy';
import { MENU_LOGIN_LABEL } from '@/components/common/menuLabels';

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
      关闭本引导后，点击顶部的“{saveAndCloseLabel}”按钮
      <br />
      当前窗口会被收成一个工作会话，<strong>这些标签随之关闭</strong>
      {/* 2026-10-09 P1-1：定位保持「保存 = 剪切」（产品负责人已确认），
          但新用户第一次操作就该知道会发生什么 —— 「收成一个会话」没有明说
          标签会关掉，用户可能以为只是存了个副本。

          2026-10-20 审计 A-14：按钮名必须引用常量。
          原文案手写「保存会话」，而按钮的可见文字是 `saveAndCloseLabel`
          （=「保存并关闭」）—— 用户在引导里看到的名字与按钮上的名字对不上，
          会去找一个叫「保存会话」的东西。引导是 `saveAndCloseLabel` 的
          **第三个**引用点（顶栏按钮 / 空态 CTA / 引导），2026-10-19 审计 I-3
          只把前两处收敛到常量，第三处被漏在纪律之外。 */}
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
        {/* ── 2026-10-20 审计 A-3：承诺必须说清锁定的**边界** ─────────────
         * 「重要会话可锁定，避免误删」听起来像「锁了就删不掉」，
         * 而实现（修好后）是：锁定保护的是**会话内部**（不可重命名、
         * 不可逐条删标签、不参与清理重复），整组仍然可以删，只是会先
         * 明确提示「该会话已锁定」。把边界写出来，用户才知道锁定能挡住什么。 */}
        <div className="onboarding-feature-desc">重要会话可锁定，避免误删其中的标签</div>
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
        <div className="onboarding-feature-desc">不输入关键词也能筛：只看较近的，或更久之前的</div>
      </div>
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon">🌐</div>
        <div className="onboarding-feature-title">按域名过滤</div>
        <div className="onboarding-feature-desc">记得站点、不记得网址时，按域名直接找出来</div>
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
      {/* ── 2026-10-19 审计 I-6：原文与真实行为相反 ──────────────────────
       * 原文「需要时也可以从会话列表里再次打开刚刚整理过的内容」承诺了
       * 「恢复后还能再打开一次」。而未锁定会话恢复后**即被消费**（从列表
       * 消失，无回收站）—— 用户回头找不到那组东西。
       * 真实的重复使用方式是「先锁定」。 */}
      想反复使用同一组，请先锁定该会话；未锁定的会话恢复后即从列表移除
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
        <div className="onboarding-feature-title">域名命名</div>
        <div className="onboarding-feature-desc">新会话默认按域名或主机名命名（如 github.com、localhost:3000），取不到时用标签标题，再取不到才用时间戳</div>
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
      通过右上角菜单「{MENU_LOGIN_LABEL}」开启同步
      <br />
      {/* ── 2026-10-19 审计 I-4：「备份」这个词必须去掉 ────────────────
       * 云端不是备份，而是**同一份数据的镜像**：你在本机删除，云端那份
       * 也会被删（删除广播）。README 专门论证过必须弃用「保险箱」隐喻，
       * 理由正是「存进来应该安全」的预期会害用户删数据 —— 「自动备份」
       * 是同一个陷阱：用户会以为「云端有备份，删了能找回」。
       *
       * 另一个改动：原文写「保存后会自动同步到云端；新设备登录后会自动拉回云端的会话」，
       * 而自动同步自 1.23.0 起**默认关闭**（间隔也是用户自己选的），
       * 且「登录即恢复」是本轮 F-6 修好后才成立的（登录成功会主动拉一次）。
       * 现在说的是用户真正会遇到的流程。 */}
      保存后会自动同步到云端；新设备登录后会自动拉回云端的会话
      <br />
      {/* ── 2026-10-22 审计 P1-5：默认状态必须说清 ────────────────────────
       * 上面两句**都成立**（保存后会自动上传、登录后会主动拉一次），
       * 但它们让人以为「登录 = 开了自动同步」。实际上：
       *   · 上传：每次本地保存/重命名都会安排一次延迟上传 —— 与开关无关；
       *   · **定时拉取**：默认**关闭**（后台轮询 alarm 只在 syncEnabled=true
       *     时注册）⇒ 两台设备都在线时，A 存的东西**不会自动出现在 B**。
       * 用户会得出「这产品同步不可靠」的结论，而事实上只需在设置里打开开关。
       * 商店文案（CHROMEWEBSTORE.md）早就写对了，这里补上同一件事。 */}
      定时拉取默认关闭，可在设置里打开
    </p>
    <div className="onboarding-feature-grid">
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon">🔄</div>
        <div className="onboarding-feature-title">自动同步</div>
        {/* 审计 P1-5：卡片标题叫「自动同步」，描述却只讲上传 ⇒ 用户以为
            「登录 = 开了自动同步」。把上传与定时拉取分开说，与上面那句、
            与商店文案同口径。 */}
        <div className="onboarding-feature-desc">保存和重命名都会上传到云端；定时拉取可在设置里开启</div>
      </div>
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon">📤</div>
        <div className="onboarding-feature-title">导入导出</div>
        <div className="onboarding-feature-desc">支持 OneTab 文本格式与 JSON 备份</div>
      </div>
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon">🛟</div>
        <div className="onboarding-feature-title">误删保护</div>
        {/* ── 2026-10-19 审计 I-5：承诺必须收窄到真实行为 ────────────────
         * 原文「删除整个会话会先确认；单条删除直接生效」让人以为**任何**删除
         * 都会先问。实际：单条标签的 ✕ 直接删、把最后一条标签拖到别的会话
         * 会让整个会话当场消失（这两条都不经过确认）。
         *
         * 整组删除的确认还受设置里的「删除前确认」开关控制（默认开；锁定的会话
         * 始终强制确认），「删除全部会话」始终确认并显示数量。
         *
         * 锁定会话也不防「删除所有会话」—— 那个操作对所有会话一视同仁。
         * 如实说清比说得好听重要：用户据此决定要不要开「删除前确认」。 */}
        <div className="onboarding-feature-desc">删除整个会话会先确认（可在设置里关闭，删除全部会话始终确认）；单条删除、以及把最后一条标签拖到别的会话，会立即生效</div>
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
