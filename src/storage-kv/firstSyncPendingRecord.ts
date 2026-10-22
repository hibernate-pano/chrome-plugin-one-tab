/**
 * 归属待决位的**取值形状**（2026-10-20）：按「目标库」寻址。
 *
 * ── 为什么不是全局单值 ────────────────────────────────────────────────────
 * 待决位的语义是「**这些会话归谁还没定**」，而「归谁」**依赖于目标库**：
 * 换云盘（地址 / 账号 / 目录任一变化）= 另一个库 = **另一个决定**。
 * 全局单值让「换云盘」与「同库重设密码」在判据上完全一样
 * （两者都是「本机配过自带存储」）⇒ 换云盘时本机的历史会话被**静默整批**
 * 推上新云盘，而用户从没被问过「这些会话归新云盘吗」。
 *
 * 口径与同步水位线一致：`baseUrl | username | rootPath` 三者任一变化都
 * 意味着「另一个库」（见 `webdav/adapter.ts` 的 `watermarkKey` 注释）。
 *
 * ── 形状 ──────────────────────────────────────────────────────────────────
 * 一个键（`webdav_first_sync_pending`），值是「作用域 → 是否待决」的记录：
 *
 *     { '["https://dav.example/","me","TapStack"]': true,   // 这个库待决
 *       '__legacy_pending__': true }                          // 旧格式迁移槽位
 *
 * 为什么不按作用域**各写一个键**：`storage.clear()`（「清除本地数据」）
 * 的键清单由 `Object.values(STORAGE_KEYS)` 派生，动态键派生不出来
 * ⇒ 动态键会变成清不掉的孤儿待决位（而它会把同步永久降级成增量）。
 * 单键 + 记录形状 ⇒ 键仍然受 `STORAGE_KEYS` 管。
 *
 * ── 旧格式的迁移语义（必须明确）──────────────────────────────────────────
 * 老用户磁盘上是**全局布尔值**。它被读成：
 *   · `true` ⇒ 落进 `LEGACY_PENDING_SLOT` ⇒ 任何**没有显式记录**的库
 *     都算待决（保守方向：多挡一次、少传一次；「多传」不可回滚 ——
 *     见 `core/syncDecision.ts` 的 fail-closed 论证）；
 *   · `false` ⇒ 没有待决 ⇒ 不挡。
 * **显式记录优先于旧格式槽位**：归属决策做完后写入的显式 `false` 必须能
 * 压住旧的 `true`（否则用户刚做完三选一又被重新拦住 —— 那正是本次要
 * 消灭的误拦的另一面）。
 *
 * 本模块的**判据部分是纯函数**，不碰 DOM、不碰存储 —— 所以判据能被直接做行为断言。
 *
 * ⚠️ 例外：文件末尾的 `resolveCurrentLibraryScope()` 是 IO（它要去读磁盘上的配置），
 * 它经由**加载器注册表**取后端模块（页面动态 / SW 静态），见那里的说明。
 */

import { loadLibraryIdentity } from '@/sync-backend/webdav/libraryIdentityRuntime';

/**
 * 「没有目标库」的作用域名。
 *
 * 它是**真实的一态**（本机还没配过自带存储），不是一个占位符：
 * 待决位按库寻址后，「还没配过」也必须有一个确定的落点，
 * 否则「配之前」与「配之后」会写进同一处、互相覆盖。
 * 真实库的作用域键是 JSON 数组（以 `[` 开头），与它不可能撞上。
 */
export const NO_LIBRARY_SCOPE = 'no-library';

/**
 * 记录里保留旧格式布尔值的那一个槽位。
 *
 * 真实库的作用域键是 JSON 数组字符串（以 `[` 开头），
 * 所以这个保留名与任何真实作用域都不可能撞上。
 */
export const LEGACY_PENDING_SLOT = '__legacy_pending__';

/** 存的值是不是一个「作用域 → 是否待决」的普通对象。 */
function isPlainRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

/**
 * 待决位记录 → 某个作用域是否待决（纯函数，fail-closed 方向）。
 *
 * 判据顺序（**显式记录优先于旧格式**）：
 *   1. 该作用域有显式记录 ⇒ 用它（`true` 待决 / `false` 已决）；
 *   2. 没有显式记录 ⇒ 回退旧格式槽位（老用户迁移过来的那个全局布尔值）；
 *   3. 旧格式槽位也是「已完成」⇒ 不待决。
 *
 * `scope === null` 或 `NO_LIBRARY_SCOPE` = **不知道是哪个库** ⇒ 保守方向：
 * 只要有**任何一个**作用域待决，就算待决（宁可少传，不可多传）。
 *
 * 为什么要这一档（真实场景）：「保存配置」这个动作会**先**置位、**后**落盘
 * 配置。若配置还没落盘，读方算出来的作用域就是「还没有目标库」——
 * 而那一刻标志**已经**置上了（置位必须排在最前面，见 WebDavSettings 的
 * handleSave）。若这一档按「no-library 这一格是 false」来读，标志就**读不到**
 * ⇒ 置位形同虚设 ⇒ 刚切到自带存储的那次自动上传仍是无抑制全量
 * （round 30 真机抓到的那个缺陷）。保守方向同时覆盖了它。
 */
export function resolveFirstSyncPending(raw: unknown, scope: string | null): boolean {
  // 旧格式的全局布尔值（老用户磁盘上的形状）—— 尚未被规范化时也读得出来。
  if (raw === true) return true;
  if (raw === false || raw === null || raw === undefined) return false;
  if (!isPlainRecord(raw)) return false;

  if (scope === null || scope === NO_LIBRARY_SCOPE) {
    // 不知道是哪个库 ⇒ 只要有任何一个待决就算待决。
    return Object.values(raw).some(v => v === true);
  }
  const own = raw[scope];
  if (own === true) return true;
  if (own === false) return false;
  // 没有显式记录 ⇒ 旧格式槽位说了算（老用户迁移）。
  return raw[LEGACY_PENDING_SLOT] === true;
}

/**
 * 把盘上的值规范化成「作用域 → 布尔」记录（纯函数）。
 *
 * 旧格式的 `true` 落进 `LEGACY_PENDING_SLOT`（保住它的保守语义：
 * 任何没有显式记录过的库都算待决）；旧格式的 `false` 落成空记录。
 * 已经是记录形状的（原样保留，只留布尔成员）⇒ 幂等。
 */
export function toPendingRecord(raw: unknown): Record<string, boolean> {
  if (raw === true) return { [LEGACY_PENDING_SLOT]: true };
  if (!isPlainRecord(raw)) return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === true || v === false) out[k] = v;
  }
  return out;
}

/**
 * 「本机当前指向的库」的作用域键 —— **异步**版本（要读磁盘上的配置）。
 *
 * ⚠️ 为什么身份计算本身必须是**纯函数**（`libraryScopeKey`，
 * 见 `sync-backend/webdav/libraryIdentity.ts`）：调用点有两类 ——
 *   · 存储层（读写待决位）：那里已经能 `await`；
 *   · **UI 渲染期**（面板要显示「为什么被拦住了」）：那里不能 `await`。
 * 所以身份计算必须是**纯函数**，两处都调它。
 *
 * 它读的是**磁盘上已保存的配置**（`webdav_sync_config_v1`），不是表单里
 * 正在编辑的内容 —— 待决位的读取方（后台的 syncEngine）也在读磁盘，
 * 两边必须用同一份真值。拿表单值去比会得出「同一个库」的假结论
 * （表单被改成新地址时，表单 ≠ 磁盘 ⇒ 恰恰是**不同**的库）。
 *
 * ⚠️ 依赖方向：本模块在 `storage-kv`（键与值的形状层），而配置在
 * `sync-backend/webdav/config.ts`（后端层）—— 后端层依赖键层，反过来会成环。
 * 所以这里**经由加载器注册表**取后端模块：只有真的需要解析作用域时才会加载，
 * 而 `storage-kv` 的其余部分（键表、驱动）不依赖它。
 *
 * ⚠️ 2026-10-23 审计 P0-1：**不能直接 `await import()`** ——
 * service worker 里 `import()` 被 Chrome 禁止（HTML 规范），
 * 那一行在 SW realm 里必然抛 ⇒ 作用域恒为「没有目标库」
 * ⇒ 待决位的判据整个换成保守分支 ⇒ SW 永远以为归属决策没做完
 * ⇒ 历史会话被永久挡在用户自己的云盘之外，而回包还报「成功」。
 * ⇒ 改成「同一份模块、两种取法」的注册表：页面动态加载，SW 由入口静态注册
 * （见 `sync-backend/webdav/libraryIdentityRuntime.ts`）。
 */
export async function resolveCurrentLibraryScope(): Promise<string> {
  try {
    return await resolveCurrentLibraryScopeStrict();
  } catch {
    // 读不到配置 ⇒ 「没有目标库」。
    //
    // ⚠️ 这个兜底是**保守方向**（fail-closed）：算不出库 ⇒ 落进
    // 「只要有一格待决就算待决」⇒ 自动上传被抑制 ⇒ 会话留在本机等用户决定。
    // 反过来（读不到就当「没有待决」）会让历史会话在用户没表态时被整批推上云盘，
    // 而那正是 2026-10-18 P1#4 明令禁止的「多传」，不可回滚。
    return NO_LIBRARY_SCOPE;
  }
}

/**
 * 同上，但**不吞异常**（2026-10-23 审计 P0-1 的真机验证用）。
 *
 * ── 为什么需要「不吞」的版本 ──────────────────────────────────────────────
 * `resolveCurrentLibraryScope` 把「算不出库」和「**没配过库**」都变成同一个值
 * （`NO_LIBRARY_SCOPE`）⇒ 从外面**看不出**「SW 到底算没算出来」。
 * 而这正是 P0-1 的核心问题：**单测里算得出（Node 的 import() 合法），
 * 真 Chrome 的 SW 里算不出** ⇒ 只有真机能分辨。
 * ⇒ 诊断通道用这个版本：算得出就返回真值，算不出就**报错**。
 *
 * ⚠️ 判据上仍然是 fail-closed：真正决定「能不能上传」的是
 * `resolveCurrentLibraryScope`（它兜底成 no-library ⇒ 保守方向）。
 * 这里只是把「兜底之前的事实」暴露给诊断用。
 */
export async function resolveCurrentLibraryScopeStrict(): Promise<string> {
  const { currentLibraryScope } = await loadLibraryIdentity();
  return await currentLibraryScope();
}
