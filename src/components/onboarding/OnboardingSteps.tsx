import React from 'react';

import { saveAndCloseLabel } from '@/components/layout/saveActionCopy';
import { MENU_LOGIN_LABEL } from '@/components/common/menuLabels';
// 审计 H-4：「拉回」= **合并**（不覆盖）这件事，空态那侧已经说对了。
// 同一个语义不许两处实现 ⇒ 这里复用同一个常量，不另造一句中文。
// （`emptyStateActions.ts` 不 import 任何东西 ⇒ 引入它不会带来循环依赖。）
import { EMPTY_STATE_ACTION_HINT } from '@/components/tabs/emptyStateActions';
// 审计 WC-6：锁定**不阻止**删除整个会话，「删除所有会话」照样会删掉锁定会话。
// 锁定卡片与删除卡片说的是同一件事 ⇒ 一个出处、两处引用（措辞抄 README/商店页）。
import { LOCK_DELETE_BOUNDARY } from '@/components/onboarding/onboardingCopy';

/**
 * 引导各步内容。
 *
 * 每个步骤标题都带 tabIndex={-1}：不是给键盘用户新增一个 Tab 落点（-1 本就不进 Tab 序列），
 * 而是给 OnboardingGuide 在切步时提供聚焦目标——读屏会播报新标题，
 * 键盘用户的焦点也不会停留在上一步已经卸载的按钮上。
 *
 * ── 2026-10-23 审计 V-12：emoji 是**装饰**，不进朗读队列 ──────────────────
 *
 * 21 个 emoji 渲染点原先**没有一个**带 `aria-hidden` ⇒ `<span>🧭</span>`
 * 是一个有内容的文本节点 ⇒ 读屏会把它当文字念出来（「指南针」/「compass
 * emoji」），18 个 emoji 逐个念。它们旁边紧挨着说明文字，念出来只是噪音。
 *
 * 现在每个 emoji 容器都标 `aria-hidden="true"` —— 视觉保留，朗读队列清空。
 * （emoji 的视觉风格本身是审美问题，本轮不动；见审计报告 §3 的「撤回的判断」。）
 */
export const WelcomeStep: React.FC<{ version: string }> = ({ version }) => (
  <div className="onboarding-content">
    <div className="onboarding-icon-wrapper" aria-hidden="true">
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
        <div className="onboarding-feature-icon" aria-hidden="true">💾</div>
        <div className="onboarding-feature-title">保存</div>
        <div className="onboarding-feature-desc">先把工作现场收起来</div>
      </div>
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon" aria-hidden="true">🔍</div>
        <div className="onboarding-feature-title">搜索</div>
        <div className="onboarding-feature-desc">按会话名或标签找回</div>
      </div>
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon" aria-hidden="true">🚀</div>
        <div className="onboarding-feature-title">恢复</div>
        <div className="onboarding-feature-desc">默认在当前窗口里继续工作</div>
      </div>
    </div>
  </div>
);

export const SaveTabsStep: React.FC = () => (
  <div className="onboarding-content">
    <div className="onboarding-icon-wrapper" aria-hidden="true">
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
      {/* ── 2026-10-23 审计 H-12：说清「这些标签」的**例外** ───────────────
          「这些标签随之关闭」对绝大多数标签为真，但有三类标签**既不保存、
          也不关闭**（它们留在原处）：
            ① **固定标签页**（`collectPinnedTabs` 默认 false ⇒ 被丢弃，
               而关闭用的是同一份过滤结果 ⇒ 也被留下）；
            ② **浏览器内部页面**（chrome:// / edge:// / about:// /
               chrome-extension://）—— 存下来也开不出来，直接丢弃；
            ③ **危险 schema**（javascript: / data: / vbscript:）—— 同样丢弃。
          ②③ 用户几乎无感（他自己不会钉一个 chrome:// 页），
          ① 却非常常见（pin 一个工作台是日常）⇒ 引导里点名**固定标签页**这一类，
          说清它「会留在原处」。真实例外清单由 `filters.isValidTab` 与
          `TabManager.saveAllTabs` 决定（守卫从那两处现场读，不钉中文）。 */}
      （浏览器里钉住的固定标签页除外，它们会留在原处）
    </p>
    <div className="onboarding-feature-grid">
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon" aria-hidden="true">🪟</div>
        <div className="onboarding-feature-title">保存当前窗口</div>
        <div className="onboarding-feature-desc">把此刻的工作上下文完整留住</div>
      </div>
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon" aria-hidden="true">📌</div>
        {/* ── 2026-10-23 审计 H-2 / H-11 ──────────────────────────────────
         * H-11：标题混用英文 `Pinned`，而产品其它地方一律叫「固定标签页」
         *        （设置页「保存时收集固定标签页」、筛选器「固定标签」、
         *        保存提示「另有 N 个固定标签页未保存」）。引导是新用户看的
         *        第一眼 ⇒ 用户记住「Pinned」去设置页找「固定标签页」对不上号。
         * H-2 ：原文「固定标签页可保留，也可一并保存」把一个**默认关闭、
         *        且藏在设置页**的开关说成「随你」。真实默认见
         *        `storage.ts` 的 `DEFAULT_SETTINGS.collectPinnedTabs`（false）。
         *        ⇒ 说清默认状态 + 开关在哪儿。 */}
        <div className="onboarding-feature-title">固定标签页</div>
        <div className="onboarding-feature-desc">
          默认不保存浏览器里钉住的标签页，它们会留在原处；想一并存进会话，可在设置里打开「保存时收集固定标签页」
        </div>
      </div>
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon" aria-hidden="true">🔒</div>
        <div className="onboarding-feature-title">锁定保护</div>
        {/* ── 2026-10-20 审计 A-3：承诺必须说清锁定的**边界** ─────────────
         * 「重要会话可锁定，避免误删」听起来像「锁了就删不掉」，
         * 而实现（修好后）是：锁定保护的是**会话内部**（不可重命名、
         * 不可逐条删标签、不参与清理重复），整组仍然可以删，只是会先
         * 明确提示「该会话已锁定」。把边界写出来，用户才知道锁定能挡住什么。
         *
         * ── 2026-10-23 审计 H-8：补上锁定**最要紧**的那半句 ──────────────
         * 锁定真正改变的是「**恢复后这个会话还在不在**」——
         * 未锁定的会话恢复后即被消费（从列表移除），锁定的才留得住、
         * 可以反复用。这是第 4 步教的那条核心规则的**唯一例外**，
         * 引导里却一个字没提 ⇒ 用户读了第 4 步「想反复使用请先锁定」，
         * 却不知道锁定到底改变了什么、按钮在哪。 */}
        <div className="onboarding-feature-desc">
          重要会话可锁定：恢复后仍留在列表里，可反复使用；也不会被「清理重复标签」清理，不能重命名或逐条删除。{LOCK_DELETE_BOUNDARY}
        </div>
      </div>
    </div>
  </div>
);

export const SearchStep: React.FC = () => (
  <div className="onboarding-content">
    <div className="onboarding-icon-wrapper" aria-hidden="true">
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
        <div className="onboarding-feature-icon" aria-hidden="true">🗂️</div>
        <div className="onboarding-feature-title">先找会话</div>
        <div className="onboarding-feature-desc">同一批相关标签会一起出现</div>
      </div>
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon" aria-hidden="true">⏱️</div>
        <div className="onboarding-feature-title">按时间过滤</div>
        <div className="onboarding-feature-desc">不输入关键词也能筛：只看较近的，或更久之前的</div>
      </div>
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon" aria-hidden="true">🌐</div>
        <div className="onboarding-feature-title">按域名过滤</div>
        <div className="onboarding-feature-desc">记得站点、不记得网址时，按域名直接找出来</div>
      </div>
      {/* ── 2026-10-23 审计 H-13：教「会话排序」─────────────────────────────
          第 42 轮刚做了会话排序（`core/sessionSort.ts` 的四档：最近保存 /
          最近活动 / 名称 / 会话大小（标签数）），控件在筛选区里。
          引导是**新功能的唯一介绍位** —— 不教，用户一屏 20 个会话分不清
          哪个是刚存的，会以为「TapStack 就是按保存时间排死的」。
          排序的判据口径以 `SESSION_SORT_OPTIONS` 为准（守卫从那里现场读
          选项标签，不钉中文措辞）。 */}
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon" aria-hidden="true">↕️</div>
        <div className="onboarding-feature-title">排序</div>
        <div className="onboarding-feature-desc">
          会话多的时候，筛选区里可以按最近保存、最近活动、名称或会话大小（标签数）排序
        </div>
      </div>
    </div>
  </div>
);

export const RestoreStep: React.FC = () => (
  <div className="onboarding-content">
    <div className="onboarding-icon-wrapper" aria-hidden="true">
      <span>🚀</span>
    </div>
    <h2 tabIndex={-1} className="onboarding-title">恢复时继续，而不是重来</h2>
    <p className="onboarding-description">
      恢复整个会话时，默认用「在当前窗口打开整个会话」直接加到当前窗口
      <br />
      {/* ── 2026-10-19 审计 I-6：原文与真实行为相反 ──────────────────────
       * 原文「需要时也可以从会话列表里再次打开刚刚整理过的内容」承诺了
       * 「恢复后还能再打开一次」。而未锁定会话恢复后**即被消费**（从列表
       * 消失，无回收站）—— 用户回头找不到那组东西。
       * 真实的重复使用方式是「先锁定」。 */}
      想反复使用同一组，请先锁定该会话；未锁定的会话恢复后即从列表移除
      {/* ── 2026-10-25：主操作换人 ⇒ 这半句必须跟着换 ────────────────────
          产品负责人 2026-10-25：「我主要使用『从当前窗口打开所有标签页』」
          ⇒ 卡头那颗**主按钮**（第一位 + accent 墨色）现在是
          「在当前窗口打开整个会话」，「在新窗口恢复整个会话」退成次要的
          （宽屏第二颗 / 窄屏收进「更多」）。
          ⇒ 引导里「默认在新窗口中打开」这句**已经变成假话**，改成
          「默认直接加到当前窗口」，并把另一个入口按真实文案点名。
          守卫从 `TabGroup.tsx` 的两个 aria-label 现场读，不钉中文措辞。 */}
      <br />
      也可以选「在新窗口恢复整个会话」，另开一扇窗继续
    </p>
    <div className="onboarding-feature-grid">
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon" aria-hidden="true">🪄</div>
        <div className="onboarding-feature-title">当前窗口恢复</div>
        <div className="onboarding-feature-desc">
          直接加到当前窗口接着做；也可以选「在新窗口恢复整个会话」另开一扇窗
        </div>
      </div>
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon" aria-hidden="true">📍</div>
        {/* ── 2026-10-23 审计 H-11：英文 `pinned` → 中文「固定标签页」 ─────
            产品其它地方一律叫「固定标签页」（设置页 / 筛选器 / 保存提示）。
            标题改中文后，原描述「固定标签页状态会跟着一起回来」与标题重复
            ⇒ 描述一并改，说清**为什么**它会跟着回来（保存时记住了固定状态）。 */}
        <div className="onboarding-feature-title">保留固定标签页</div>
        <div className="onboarding-feature-desc">
          保存时记住了哪些标签是固定的，恢复后它们仍是固定的
        </div>
      </div>
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon" aria-hidden="true">🕘</div>
        {/* ── 2026-10-25 产品定案：默认名从「替用户猜」改成「保存时刻」──────
            旧文案说「默认按域名命名，取不到时用标签标题，再取不到才用时间戳」——
            那条链每一级都在**猜**：猜域名会猜错（跨站时是「一半对」的名字），
            猜标题会钉一个一次性的名字（同一工作现场第二次保存标题变了 ⇒
            名字就变了 ⇒ 找回时对不上）。
            ⇒ 现在默认就是保存时刻（不会说谎），**没有例外**。
            站点身份没丢：每个标签的域名在标签行右侧本来就写着。 */}
        <div className="onboarding-feature-title">自动命名</div>
        <div className="onboarding-feature-desc">新会话默认用保存时间命名（如 2026-10-25 14:30），点一下标题就能改成你习惯的名字</div>
      </div>
    </div>
  </div>
);

export const SyncStep: React.FC = () => (
  <div className="onboarding-content">
    <div className="onboarding-icon-wrapper" aria-hidden="true">
      <span>☁️</span>
    </div>
    <h2 tabIndex={-1} className="onboarding-title">换台设备也能找回</h2>
    <p className="onboarding-description">
      {/* ── 2026-10-23 审计 H-9：顶栏那两颗「上传 / 下载」才是**常驻**的同步入口 ──
          引导此前只教「⋯ 菜单 → 去登录」，而聚光灯第 5 步恰好锚在
          `[aria-label="菜单"]` ⇒ 高亮的正是**更绕**的那条路。
          真实存在的是顶栏的两颗按钮（`aria-label` = 「上传本地会话到云端」/
          「从云端下载会话到本地」，可见文字「上传」「下载」，窄屏收成图标）。
          两者都**不需要先开菜单** ⇒ 一并告诉用户。
          守卫从 `SyncButton.tsx` 的 aria-label 现场读，不钉中文措辞。 */}
      通过右上角菜单「{MENU_LOGIN_LABEL}」开启同步；顶栏的「上传」「下载」按钮可以手动同步
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
       * 现在说的是用户真正会遇到的流程。
       *
       * ── 2026-10-23 审计 H-3 / H-4 ──────────────────────────────────────
       * H-3：「自动同步」是**设置页那个默认关着的开关**的名字
       *      （OptionsPage 的「自动同步」开关 / `syncEnabled`，默认 false）。
       *      引导里写「会自动同步」会让用户以为「登录 = 开了自动同步」。
       *      ⇒ 下面这半句保持「保存后会自动同步到云端」**不动** ——
       *        审计 §4 自己判定这半句**为真**（「自动同步到云端」在中文里
       *        读成**单向** A→B），而且
       *        `tests/guards/autoSyncDisclosure.test.ts` 明确钉着它
       *        （「上传确实每次保存都会发生 —— 这句不是谎报」）。
       *        把「自动」去掉反而是把一条**真的**披露改成含糊的说法。
       *      真缺陷在**拉回**那半句：「登录后会自动拉回」读起来像**持续**拉取，
       *      而登录只触发**一次** ⇒ 「会自动」去掉。
       * H-4：拉回是**合并**，不是覆盖 —— 空态那侧早就说对了
       *      （`emptyStateActions.ts` 的 download 提示：「把云端会话拉回本机
       *      并合并，不会清掉本地内容」）。同一个动作、两处说法 ⇒
       *      这里**逐字复用**那一句（同一个常量 ⇒ 以后不可能漂移）。
       *      （登录后的自动拉取与空态那按钮走的是同一条命令、同一个
       *      `forceRemote: false` 合并模式 ⇒ 两处说的是同一件事。） */}
      保存后会自动同步到云端；新设备登录后，{EMPTY_STATE_ACTION_HINT.download}
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
        <div className="onboarding-feature-icon" aria-hidden="true">🔄</div>
        {/* 审计 P1-5：卡片标题叫「自动同步」，描述却只讲上传 ⇒ 用户以为
            「登录 = 开了自动同步」。
            ── 2026-10-23 审计 H-3：更要紧的是**标题本身** ——「自动同步」
            正是设置页那个**默认关着**的开关的名字，标题先被眼睛捕获，
            用户读完标题形成的预期要到描述后半句才被推翻。
            ⇒ 标题改成中性说法，把「默认关闭」直接写进描述。 */}
        <div className="onboarding-feature-title">云端同步</div>
        <div className="onboarding-feature-desc">
          保存和重命名都会自动上传到云端；定时拉取默认关闭，可在设置里开启
        </div>
      </div>
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon" aria-hidden="true">📤</div>
        <div className="onboarding-feature-title">导入导出</div>
        {/* ── 2026-10-23 审计 H-14：OneTab 文本格式**本身不带会话名** ──────
            社区标准如此（`URL | 标题`，空行分组）⇒ 名字一定会丢。
            而**两档导入的命名规则不同**（别混成一句）：
              · **JSON 备份**（本扩展自己导出的）⇒ 会话名**原样保留**；
              · **OneTab 文本** ⇒ 按这批标签里出现最多的域名命名，
                取不到域名才回落到「导入的会话 N」。
            守卫从 `oneTabFormatParser.ts` 的 `deriveImportedGroupName` 现场读
            命名口径，不钉中文措辞。 */}
        <div className="onboarding-feature-desc">
          支持 OneTab 文本格式与 JSON 备份；JSON 备份保留原会话名，OneTab 文本本身不带会话名，导入时按域名命名
        </div>
      </div>
      <div className="onboarding-feature-card">
        <div className="onboarding-feature-icon" aria-hidden="true">🛟</div>
        <div className="onboarding-feature-title">误删保护</div>
        {/* ── 2026-10-19 审计 I-5：承诺必须收窄到真实行为 ────────────────
         * 原文「删除整个会话会先确认；单条删除直接生效」让人以为**任何**删除
         * 都会先问。实际：单条标签的 ✕ 在**会让整个会话消失时**是要先确认的
         * （默认设置下删最后一条就会弹），而把最后一条标签拖到别的会话
         * 是**直接生效、不多问一句**（拖拽即剪切）。
         *
         * ⚠️ 2026-10-23 审计 WC-9：这两条路径**行为相反**，不能写成同一条 ——
         * 原文「单条删除、以及把最后一条标签拖到别的会话，会立即生效」
         * 把它们并列了，于是「删最后一条会先确认」这个例外无处安放。
         * ⇒ 拆成两句，各说各的（与 README / 商店页同一口径）。
         *
         * 整组删除的确认还受设置里的「删除前确认」开关控制（默认开；锁定的会话
         * 始终强制确认），「删除所有会话」始终确认并显示数量。
         *
         * ── 2026-10-23 审计 WC-6：锁定**不阻止**删除整个会话 ────────────
         * 锁定会话也不防「删除所有会话」—— 那个操作对所有会话一视同仁。
         * 删整个锁定的会话是可以的，只是会先提示「该会话已锁定」且一定要确认。
         * 如实说清比说得好听重要：用户据此决定要不要开「删除前确认」。 */}
        <div className="onboarding-feature-desc">删除整个会话会先确认（可在设置里关闭，删除所有会话始终确认）；{LOCK_DELETE_BOUNDARY}；单条删除会立即生效——但如果这一删会让整个会话消失，就会先确认；把最后一条标签拖到别的会话，也会立即生效（那个被搬空的会话随之消失）</div>
      </div>
    </div>
  </div>
);

export const ReadyStep: React.FC = () => (
  <div className="onboarding-content text-center">
    <div className="onboarding-icon-wrapper" aria-hidden="true">
      <span className="onboarding-confetti" aria-hidden="true">✅</span>
    </div>
    <h2 tabIndex={-1} className="onboarding-title">核心闭环已经齐了</h2>
    <p className="onboarding-description">
      现在开始保存、搜索、恢复你的工作会话
      <br />
      需要跨设备时，再按需手动同步
    </p>
  </div>
);
