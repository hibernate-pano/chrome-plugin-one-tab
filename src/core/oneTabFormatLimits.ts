/**
 * OneTab 格式**承载不了**什么，以及这件事必须被**披露**给用户
 * （2026-10-22 审计 DS-43-2）。
 *
 * ── 缺陷原形 ──────────────────────────────────────────────────────────────
 *
 * OneTab 的行格式是 `URL | 标题`，**社区标准如此**。它只承载两样东西：
 * 网址与标题。会话级的东西（锁定状态、会话名）与标签级的东西
 * （网站图标、固定标签）**格式里没有位置** ⇒ 往返一次就没了。
 *
 * 后果不是「少了个图标」这种 cosmetic 问题，而是**锁的保护失效**：
 *
 *   1. 用户把一个**锁定**会话导出成 OneTab（拿去别的浏览器用）；
 *   2. 在另一台机器导入 ⇒ 该会话变成**未锁定**；
 *   3. 用户点「快速恢复」⇒ 标签开了，会话**从列表消失**
 *      （未锁定会话恢复即消费 —— 1.24.1 定案的语义，本轮不动）；
 *   4. **不可逆**（v1.22.0 起无回收站；这条路径没有撤销，
 *      因为锁定会话从不被消费 ⇒ 也从来没有过消费 ⇒ 也就没有撤销按钮）。
 *
 * 而 `CHROMEWEBSTORE.md` 承诺的是「**锁定的会话恢复后仍保留**，可以反复使用」。
 * 往返之后，这个承诺对导出的那一份**不成立**。
 *
 * ── 为什么不能靠「让格式承载它」来修 ──────────────────────────────────────
 *
 * 往 OneTab 行里塞锁定态 = **协议级改动**：
 *   · 我们的导出文件在 OneTab 里打开会多出看不懂的行；
 *   · 别人的 OneTab 文件在我们这儿会被误读。
 * ⇒ 本轮**不碰协议**。能做的只有**披露**：让用户在导出/导入的那一刻
 * 就知道「这个格式带不过去什么」，而不是恢复之后才发现会话没了。
 *
 * JSON 备份路径**没有这个问题**（`isLocked` 原样落在备份里）⇒
 * 披露只挂在 OneTab 这条路上。给 JSON 路径也说同样的话 = 谎话
 * （JSON 用户会以为自己的备份也丢锁定态）。
 *
 * ── 为什么「字段清单」是**数据**而不是文案里的字面量 ──────────────────────
 *
 * 清单（`ONETAB_LOST_FIELDS`）是这份文件存在的全部理由：
 * 提示文案由它**生成** ⇒ 文案与清单不可能各说各话；
 * 守卫再拿它与**真实的往返结果**对账（真实往返仍会丢这个字段吗？）
 * ⇒ 清单也不可能与格式实现漂移。
 *
 * 也就是说：改一次措辞不会让任何东西变红，但**把一个字段从清单里删掉**
 * （于是提示里也不说了）或**让格式开始承载它**（于是提示变成了谎话），
 * 守卫都会变红。
 *
 * ── 为什么提示从**格式模块**里发出，而不是从 UI ──────────────────────────
 *
 * OneTab 的导入/导出**只有一个**入口：
 *   · 导入：`storage.importFromOneTabFormat` → `parseOneTabFormat`；
 *   · 导出：`storage.exportToOneTabFormat` → `formatToOneTabFormat`。
 * 这两个函数是**格式的唯一实现** ⇒ 「这个格式带不过去什么」这句话
 * 应当从**知道这件事的那一处**说出来，而不是在调用方各写一遍
 * （两处各写一遍 = 迟早漂移；本仓已为「同一把尺子」付过多次学费）。
 *
 * ⚠️ 本文件因此**不是纯函数模块**：两个 announce* 函数有副作用
 * （发提示）。这是刻意的 —— 提示必须与**这一次真实的导入/导出**绑定，
 * 而不是一个"预先读一次"的静态说明。
 */
import { errorHandler } from '../utils/errorHandler';
import { logInfo } from '../utils/log';

/**
 * OneTab 格式承载不了、往返一次就会丢失的字段。
 *
 * 口径：**往返后原值不再保留**（不是"变成空"，是"那份信息没了"）。
 * 逐条理由：
 *
 * · `isLocked` —— **唯一有牙齿的一条**。锁定是「恢复后这个会话还在不在」
 *   的唯一开关；丢了它，一次恢复就把会话消费掉，且不可撤销。
 * · `name` —— 会话名由内容重新派生（主导域名，取不到时是「导入的会话 N」），
 *   用户自己起的名字**不会**跟过去。
 * · `favicon` —— 网站图标不在这份格式里，导入后由界面按需重取。
 * · `pinned` —— 「这是浏览器固定标签」这个标记不在这份格式里，
 *   导入后一律当作普通标签。
 *
 * ⚠️ **时间戳不在清单里**：导入时会被重新生成为「导入时刻」，
 * 那是**有意义的替代**（时间戳表达的是"什么时候存的"，跨设备没有同一答案），
 * 不是「信息丢了」。把重新生成算成丢失，会让提示变成噪音。
 */
export const ONETAB_LOST_FIELDS = ['isLocked', 'name', 'favicon', 'pinned'] as const;

/** 清单里每个字段的用户可读名字（提示文案用）。 */
export type OneTabLostField = (typeof ONETAB_LOST_FIELDS)[number];

export const ONETAB_LOST_FIELD_LABELS: Record<OneTabLostField, string> = {
  isLocked: '锁定状态',
  name: '会话名',
  favicon: '网站图标',
  pinned: '固定标签',
};

/** 把字段清单拼成一句中文（「锁定状态、会话名、网站图标、固定标签」）。 */
const lostFieldsText = (): string =>
  ONETAB_LOST_FIELDS.map(field => ONETAB_LOST_FIELD_LABELS[field]).join('、');

/**
 * 导入 OneTab 之后的提示文案。
 *
 * 事实与措辞的分工（**别把这两件事混成一句**）：
 *   · 「格式带不过去什么」是**格式的事实**（由清单生成）；
 *   · 「所以导入的会话都是未锁定的、恢复后会被移除」是**后果**，
 *     而这条后果是本产品里唯一真正会**丢数据**的那条 ⇒ 必须说清，
 *     并给出可执行的下一步（手动锁定）。
 */
export const oneTabImportNoticeText = (): string =>
  `OneTab 格式不保存${lostFieldsText()}；` +
  '导入的会话都是未锁定的，恢复后会被移除，需要反复使用请导入后手动锁定。';

/**
 * 导出 OneTab 之前的提示文案。
 *
 * 这一句必须在**导出那一刻**说 —— 因为「重新导入会丢」这件事，
 * 只有在用户把文件拿去另一台机器的时候才会真正咬人。
 * 出口必须给：**要完整保留就用 JSON 备份**。
 */
export const oneTabExportNoticeText = (): string =>
  `OneTab 格式不保存${lostFieldsText()}；` +
  '导出后重新导入会丢失这些，需要完整保留请用 JSON 备份。';

/**
 * 把提示发出去。
 *
 * 【为什么走 errorHandler】这是本仓**唯一的非组件提示通道**
 * （ToastContext 在挂载时向它注册回调）。发出点不在组件里
 * （在格式模块里，与 UI 无关）⇒ 没有 useToast 可用。
 * errorHandler 的回调只接受 error/warning 两种级别 ⇒ 本条固定为
 * warning：它不是故障，但**必须让用户看见**（不说 = 用户以为锁跟着走了）。
 *
 * 【为什么 logToConsole:false】errorHandler 的 console 输出格式是
 * 「[MEDIUM] UNKNOWN_ERROR: …」—— 那是一副**故障**的样子，
 * 而这里根本不是故障。日志另走 logInfo（那是本仓的日志收口点）。
 */
const announce = (text: string, tag: string): void => {
  logInfo(`[oneTabFormatLimits] ${tag}：${text}`);
  errorHandler.handle(text, { severity: 'medium', logToConsole: false });
};

/** 导入 OneTab 之后：告诉用户这个格式带不过去锁定态。 */
export const announceOneTabImportLimits = (): void => {
  announce(oneTabImportNoticeText(), '导入提示');
};

/** 导出 OneTab 之前：告诉用户这个文件带不过去锁定态。 */
export const announceOneTabExportLimits = (): void => {
  announce(oneTabExportNoticeText(), '导出提示');
};
