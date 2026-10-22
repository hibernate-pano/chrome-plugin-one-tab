/**
 * 保存成功的**工具栏徽标回执**（2026-10-23）。
 *
 * ── 这条路径要解决什么（主审实测确认的 P0）────────────────────────────────
 *
 * 「用快捷键保存」是本产品**频率最高**的入口，也是**唯一**一条
 * 「破坏性动作发生、但屏幕上零反馈」的路径：
 *
 *   1. `TabManager.saveAllTabs` 成功后调 `showNotification({...})`，
 *      **没有传 `kind`** ⇒ 按 `showNotification` 的分流规则按 'success' 处理
 *      ⇒ **受「显示通知提醒」开关约束**；
 *   2. 默认设置 `showNotifications: false`（`src/utils/storage.ts`）
 *      ⇒ **默认配置下这条通知根本不发**；
 *   3. 快捷键路径**明确不打开管理页**
 *      ⇒ 管理页那个「已保存 N」的内联反馈在这条路上没有。
 *
 * ⇒ 用户按 `Ctrl+Shift+S`（macOS `⌘⇧S`）保存整窗 → **标签被关掉、窗口被腾空**
 *   → 屏幕上什么都不会出现。用户此刻的问题是「我刚才那 20 个标签存到哪了？
 *   叫什么名字？」—— 而他刚经历了一次「屏幕被夺走」，主动去开扩展的动力很低。
 *
 * 这是本仓第一性原则「用户按了键没反应必须有一句话解释」的**镜像**：
 * 键按了，世界变了，一句话没有。
 *
 * ── 为什么是徽标，不是浏览器通知 ──────────────────────────────────────────
 *
 * 「显示通知提醒」默认关闭是**已拍板的产品决定**（用户偏好，不能推翻）：
 * 通知会跨应用抢注意力，而保存成功是**例行确认**而不是异常。
 * 但「破坏性动作完成了」需要一句**在场**的回执 —— 徽标正好在这两者之间：
 *
 *   · **零新权限**：`chrome.action.setBadgeText` 不需要任何 permission
 *     （官方文档：action API 只要求 manifest 里有 `"action"` 键，本仓已有；
 *     `permissions` 里**不需要**加 `action`）。加权限是**提审可见**的变化，
 *     商店页要交代 —— 这里避免掉了。
 *   · **零打扰**：它长在扩展图标上，用户不去看它就不存在；不跨应用、不抢焦点。
 *   · **不依赖任何开关**：徽标不是通知，不受 `showNotifications` 约束。
 *
 * ⇒ 所以本模块**不碰** `showNotification` 的分流规则，也**不碰**
 *   `showNotifications` 这个已拍板的默认。「默认关通知」与「保存要有回执」
 *   这两件事不矛盾：回执走的是另一条通道。
 *
 * ── 徽标与既有状态徽标会不会打架 ──────────────────────────────────────────
 *
 * 全仓 grep 过：`chrome.action.setBadgeText` **此前没有任何调用方**；
 * manifest 里也没有 `declarativeNetRequest`（那是唯一另一个能驱动徽标的
 * 机制）。管理页里那些「同步中 / 未登录」是**页内文字**，不是工具栏徽标。
 * ⇒ 不存在需要合并的既有徽标，不存在覆盖冲突。
 *
 * ── 多窗口同时保存怎么办 ────────────────────────────────────────────────
 *
 * 后一次保存覆盖前一次的徽标。**可接受**：徽标是**最新一次**保存的回执，
 * 而「最近保存的那条」正是用户此刻唯一关心的一条。徽标是全局的
 * （不带 tabId）—— 因为保存发生在某个窗口，而用户可能停在任意标签上。
 *
 * ── 截断规则（明确的，不是「随便截」）────────────────────────────────────
 *
 * Chrome 官方文档：「Any number of characters can be passed, but only about
 * four can fit in the space.」⇒ 徽标**只放得下约 4 个字符**。
 * 本模块的规则（`formatBadgeText`），**输出恒 ≤ 4 字符**：
 *
 *   | 真实个数     | 徽标    | 说明 |
 *   |-------------|---------|------|
 *   | 1 .. 999    | `7`     | 精确 |
 *   | 1000 .. 9999| `1.2k`  | 向**下**取整到百位（1234 → `1.2k`） |
 *   | 10000 .. 99999 | `12k+` | `+` 表示「至少」 |
 *   | ≥ 100000    | `99k+`  | 4 字符封顶 |
 *
 * 为什么不给 `'12k'` 再多一位：放不下就是放不下，**宁可少一位也不溢出** ——
 * 溢出时 Chrome 会自己裁掉尾部，用户看到的是 `'12'`（看起来像 12 个！）。
 * 那比显示 `'99k+'` 危险得多：它会**说谎**，而本仓的第一性原则是
 * 「不许对没发生的事报成功 / 说假数字」。
 *
 * 为什么用 `+` 而不是四舍五入：`1.2k` 读作「大约 1200」，而 `12k+` 读作
 * 「至少 12000」—— 两者的**方向**都偏保守（宁可少说），不会夸大用户存下的量。
 *
 * ── 为什么清空时机用 chrome.alarms 而不是 setTimeout ─────────────────────
 *
 * MV3 的 service worker 随时会被系统杀掉：`setTimeout` 必然丢失 ⇒
 * 徽标会**永远留在图标上**（比没有回执更糟：用户看到的是一个过期的数字，
 * 以为刚才存了 12 个标签）。
 * `chrome.alarms` 是持久的，SW 被回收后照样触发 ⇒ 徽标一定会在到期后清掉。
 *
 * ⚠️ Chrome 对 alarm 有 30 秒下限（「Chrome limits alarms to at most once
 * every 30 seconds」）。本模块的清空时长取 **60 秒**（见 `RECEIPT_TTL_MS`），
 * 远大于下限 ⇒ 不会被 clamp，行为可预期。
 *
 * ── 「用户点了扩展图标时要不要延长」——不要 ─────────────────────────────
 *
 * 点图标会**打开管理页**，而管理页里本来就有完整的「已保存 N 个标签页」内联
 * 反馈（`Header.tsx` 的 saveFeedback）⇒ 管理页就是那个「看得更久」的地方。
 * 徽标不必再延长：它只负责「在用户还没决定去不去管理页的那几秒里，
 * 给一个『刚才存了 N 个』的凭据」。
 */

// ── 常量 ────────────────────────────────────────────────────────────────

/**
 * 徽标显示多久后自动清空（毫秒）。
 *
 * 取 60s 的理由：
 *   · Chrome alarm 最小 30s ⇒ 60s 不会被 clamp，行为可预期；
 *   · 3~5s 太短 —— 用户刚松开快捷键、视线还在浏览器标签栏上，
 *     徽标就没了，等于没给；
 *   · 60s 足够用户扫一眼，也不至于让过期数字长期挂在图标上误导人。
 */
export const RECEIPT_TTL_MS = 60_000;

/** 清空徽标用的 alarm 名字（chrome.alarms 同名会覆盖 ⇒ 重存即重排）。 */
export const RECEIPT_CLEAR_ALARM = 'tapstack-save-receipt-clear';

/**
 * 徽标底色。
 *
 * 为什么固定成一个**不随主题变**的深蓝而不是跟随主题：
 *   · Chrome 官方文档里 `setBadgeBackgroundColor` **没有**「跟随浏览器明暗主题」
 *     这回事 —— 底色是我们给的，不会自动变；
 *   · 徽标文字颜色是 Chrome 自动选的（文档：「a color to be automatically
 *     chosen that will contrast with the badge's background color」），
 *     ⇒ 只要底色**足够深**，明暗两种系统主题下文字都读得清；
 *   · 选深蓝而不是红：红色在扩展语境里是「错误 / 危险」的通用信号，
 *     而这里是**成功**。成功用红会误导用户。
 *
 * 取 `#1d4ed8`（blue-700）：对白字对比度 ≈ 8.6:1 ⇒ 远超 WCAG AA 的 4.5:1。
 */
export const RECEIPT_BADGE_COLOR = '#1d4ed8';

/** 徽标能放下的最大字符数（Chrome 官方：「only about four can fit」）。 */
export const BADGE_MAX_CHARS = 4;

// ── 纯函数：徽标文案 ────────────────────────────────────────────────────

/**
 * 把「存了多少个标签」变成能放进徽标的**短文本**。
 *
 * 规则（见文件头的「截断规则」），输出**恒 ≤ {@link BADGE_MAX_CHARS} 字符**。
 *
 * 纯函数、无副作用 ⇒ 可以 node:test 直测，不碰 chrome.*。
 */
export function formatBadgeText(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '';
  const n = Math.floor(count);
  if (n < 1000) return String(n);
  if (n < 10000) {
    // 向下取整到百位（1234 → '1.2k'，1999 → '1.9k'）——
    // 宁可少说一点，也不夸大用户存下的量。
    // toFixed(1) 默认就是四舍五入，这里显式处理以免半进位（1.25 → '1.3'）。
    const truncated = Math.floor(n / 100) / 10;
    return `${truncated.toFixed(1)}k`;
  }
  if (n < 100000) return `${Math.floor(n / 1000)}k+`;
  return '99k+';
}

/**
 * 徽标**该显示什么** —— 包含「有没有值得显示」的判据。
 *
 * 为什么要这一层而不是直接调 formatBadgeText：
 * 存了 0 个标签是**不可能成功**的（`saveAllTabs` 在「一个都存不下」时
 * 直接 `return null`，根本走不到回执这一步）。所以「0」不该出现一个徽标
 * —— 出现 `'0'` 徽标会让用户以为「存了，但存了 0 个」，那是谎话。
 */
export function badgeTextForSave(savedCount: number): string {
  return formatBadgeText(savedCount);
}

// ── 纯函数：回执的生命周期（注入时钟）───────────────────────────────────

/**
 * 回执的状态机。**纯逻辑**，不碰 chrome.*。
 *
 * 为什么把它抽出来（而不是在 SW 里直接 setTimeout）：
 * MV3 的 SW 随时被回收 ⇒ 任何「等 N 秒再清空」的逻辑都必须挂在
 * 持久化机制（chrome.alarms）上；而**「什么时候到期」「到期后该做什么」
 * 这两个判断本身**是纯逻辑，可以脱离浏览器直测。
 * 仓库里的同款做法是 `src/background/syncBackoff.ts`（纯函数 + 注入时钟）。
 */
export interface SaveReceiptState {
  /** 真的存下多少个标签（原始数字，用于 tooltip 文案）。 */
  readonly savedCount: number;
  /** 会话名（tooltip 用；徽标放不下，所以不进徽标）。 */
  readonly sessionName: string;
  /** 当前徽标应显示的文本（空串 = 不显示）。 */
  readonly badgeText: string;
  /** 本次回执对应的时间戳（epoch ms）。 */
  readonly issuedAt: number;
  /** 到期时间戳（epoch ms）。 */
  readonly expiresAt: number;
}

/**
 * 记一次保存回执 ⇒ 新状态。
 *
 * @param savedCount  真的存下多少个标签
 * @param now         当前时刻（epoch ms）—— **注入**以便测试不真等
 * @param sessionName 会话名（可选；进 tooltip，答「叫什么名字」）
 */
export function issueSaveReceipt(
  savedCount: number,
  now: number,
  sessionName = ''
): SaveReceiptState {
  return {
    savedCount,
    sessionName,
    badgeText: badgeTextForSave(savedCount),
    issuedAt: now,
    expiresAt: now + RECEIPT_TTL_MS,
  };
}

/**
 * 这个回执现在**是否已到期**（到期 = 该清空了）。
 *
 * `>=` 而不是 `>`：到期那一毫秒就该清（用 `>` 会多留一毫秒，且让边界
 * 行为依赖时钟精度）。测试里 `now === expiresAt` 应当判为已到期。
 */
export function isReceiptExpired(state: SaveReceiptState, now: number): boolean {
  return now >= state.expiresAt;
}

// ── chrome.* 适配层（薄壳）──────────────────────────────────────────────

/**
 * chrome.action 的**最小依赖契约**（注入以便测试）。
 *
 * 为什么要注入而不是直接用全局 `chrome`：
 * 本仓既有纪律是「chrome 行为由薄壳负责、逻辑走纯函数」
 * （见 `syncBackoff.ts` 的 BackoffKv 注入契约）。这样「到期判定」能被
 * node:test 直测，不需要真起浏览器、也不需要真等 60 秒。
 */
export interface BadgeApi {
  setBadgeText(details: { text: string }): Promise<void> | void;
  setBadgeBackgroundColor(details: { color: string }): Promise<void> | void;
  setTitle(details: { title: string }): Promise<void> | void;
}

/**
 * chrome.alarms 的**最小依赖契约**。
 */
export interface AlarmsApi {
  create(name: string, info: { when: number }): void;
  clear(name: string): Promise<boolean> | boolean;
}

/**
 * 悬停提示文案 —— 徽标只有 4 个字符（`1.2k`），光看数字猜不出
 * 「这是刚存了几个标签」。标题是免费的、不抢注意力，正好补上这句。
 *
 * 用**原始个数**而不是徽标文本：`1.2k` 是近似值，标题要给真话。
 *
 * ⚠️ 徽标本身**答不了**「叫什么名字」（4 个字符放不下一个域名），
 *   所以会话名也放进标题 —— 用户此刻问的正是这两个问题：
 *   「我刚才那 20 个标签，存到哪了？叫什么名字？」
 *   标题把两个都答了：「存到哪」= 存成了会话（可点图标进管理页），
 *   「叫什么」= 会话名。
 */
export function receiptTooltip(savedCount: number, sessionName?: string): string {
  const base = `TapStack - 已保存 ${savedCount} 个标签页`;
  const name = (sessionName ?? '').trim();
  if (!name) return base;
  return `${base}（${name}）`;
}

/**
 * 把一次「保存成功」画成徽标，并排好清空。
 *
 * ⚠️ **绝不抛错**：回执是**锦上添花**，它失败（没有 action 权限、
 * chrome.action 不可用、alarms 建失败）绝不能把一次**已经成功的保存**
 * 变成一次报错 —— 那会让用户以为保存失败，而数据其实已经存好了。
 * 这是本仓「不许把成功做成失败」的同一条纪律（1.22.16 的反面）。
 *
 * @param badgeApi  chrome.action 的适配层
 * @param alarmsApi chrome.alarms 的适配层
 * @param state     由 {@link issueSaveReceipt} 算出的回执状态
 */
export async function paintSaveReceipt(
  badgeApi: BadgeApi,
  alarmsApi: AlarmsApi,
  state: SaveReceiptState
): Promise<void> {
  try {
    // 先排清空、再画徽标：顺序反了的话，alarms 建失败会留下一个永不清的徽标。
    // 排清空在前 ⇒ 即使画徽标失败，也只是「没画出来」，不留垃圾状态。
    alarmsApi.create(RECEIPT_CLEAR_ALARM, { when: state.expiresAt });
    await badgeApi.setBadgeText({ text: state.badgeText });
    await badgeApi.setBadgeBackgroundColor({ color: RECEIPT_BADGE_COLOR });
    await badgeApi.setTitle({ title: receiptTooltip(state.savedCount, state.sessionName) });
  } catch {
    // 静默降级：回执失败 ≠ 保存失败。见上面的说明。
  }
}

/**
 * 清掉徽标（到期时调用）。
 *
 * 标题也要还原 —— 否则图标下面的提示会一直停留在「已保存 N 个标签页」，
 * 而那件事早就过去了。还原成 manifest 里的 `default_title`（由调用方注入，
 * 本模块不硬编码产品文案）。
 */
export async function clearSaveReceipt(
  badgeApi: BadgeApi,
  alarmsApi: AlarmsApi,
  defaultTitle: string
): Promise<void> {
  try {
    await badgeApi.setBadgeText({ text: '' });
    await badgeApi.setTitle({ title: defaultTitle });
  } catch {
    // 同上：清不掉也不能抛。
  }
  try {
    await alarmsApi.clear(RECEIPT_CLEAR_ALARM);
  } catch {
    // alarm 清不掉只是下次到期时再清一次，无害。
  }
}
