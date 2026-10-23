/**
 * 「哪一个云端库」的身份 + 归属待决位的**按库寻址**（2026-10-20）。
 *
 * ── 缺陷形状 ──────────────────────────────────────────────────────────────
 * 归属待决标志（`FIRST_SYNC_PENDING`）原先是**全局单值**，判据是
 * 「本机此前有没有配过自带存储」（`WebDavSettings` 的 `wasConfigured`）。
 * 于是「**换云盘**」与「**同一个云盘重设密码**」在判据上**完全一样**
 * （两者都是 `wasConfigured === true`）—— 而它们的**后果完全不同**：
 * 重设密码还是同一个库，换云盘是**另一个库**。
 *
 * 结果：换到云盘 B 时，本机的历史会话被**全量推上 B**
 * （适配器见远端为空 ⇒ `firstSync = true` ⇒ 全量），
 * 而用户从来没有被问过「这些会话归 B 吗」。
 * 那正是 2026-10-18 P1#4 明令禁止的「多传」，不可回滚。
 *
 * ── 修法 ──────────────────────────────────────────────────────────────────
 * 待决位的语义是「**这些会话归这个库吗**」—— 而「这个库」会变。
 * 所以待决位改成**按库寻址**（一个键，值是 `{库身份: 是否待决}` 的记录），
 * 口径与同步水位线一致：`baseUrl | username | rootPath` 三者任一变化
 * 都意味着「另一个库」（见 `webdav/adapter.ts` 的 `watermarkKey` 注释）。
 *
 * 判据因此变成：
 *   · 从没配过 ⇒ 首次配置 ⇒ 置位（2026-10-18 真机实测出来的那条，别动）；
 *   · 配过、库的身份**变了**（换云盘）⇒ 置位（新库 = 新的归属决定）；
 *   · 配过、库的身份**没变**（重设密码 / 改加密口令）⇒ **不**置位
 *     （拦了会让同步莫名停摆且零提示 —— 那是老用户重设密码的既有行为）。
 *
 * ── 为什么记录里留一个「旧格式」槽位 ──────────────────────────────────────
 * 老用户磁盘上是**全局单值**（`true` / `false`）。它必须被**迁移**，
 * 而迁移的语义要明确：
 *   · 旧值 `true` ⇒ 「有一个库的归属决定还没做」⇒ 保守方向：
 *     **任何没有显式记录过的库都算待决**（多挡一次、少传一次；
 *     「多传」不可回滚 —— 见 `syncDecision.ts` 的 fail-closed 论证）。
 *   · 旧值 `false` ⇒ 没有待决 ⇒ 不挡。
 * 显式记录（`true` / `false`）**优先于**旧格式槽位 ——
 * 归属决策做完后写入的显式 `false` 必须能压住旧的 `true`
 * （否则用户刚做完三选一又被重新拦住，那正是本次要消灭的误拦）。
 */
import { loadWebDavConfig, DEFAULT_ROOT } from './config';
import { NO_LIBRARY_SCOPE } from '@/storage-kv/firstSyncPendingRecord';

export {
  NO_LIBRARY_SCOPE,
  LEGACY_PENDING_SLOT,
  resolveFirstSyncPending,
  toPendingRecord,
} from '@/storage-kv/firstSyncPendingRecord';

/** 指向一个云端库的最小信息（与 `StoredWebDavConfig` 的三个字段同构）。 */
export interface LibraryRef {
  baseUrl: string;
  username: string;
  rootPath: string;
}

/**
 * 宽松版地址规范化：能规范化就规范化，不能就原样（trim）。
 *
 * 为什么不用 `normalizeBaseUrl` 直接抛：它对「http://非本机」「带内嵌凭据」
 * 这类地址会抛错，而身份计算是**判据**的一部分 —— 判据在用户填错地址时
 * 崩掉，比「地址没规范化到位」严重得多（前者是同步停摆，后者只是多比一次）。
 */
function normalizeBaseUrlLoose(raw: string): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    let pathname = url.pathname || '/';
    if (!pathname.endsWith('/')) pathname += '/';
    return `${url.protocol}//${url.host}${pathname}`;
  } catch {
    return trimmed;
  }
}

/** 目录规范化：去前后斜杠（与 `adapter.ts` 的 `normalizeRoot` 同口径）。 */
function normalizeRootLoose(raw: string): string {
  return String(raw ?? '').trim().replace(/^\/+|\/+$/g, '');
}

/**
 * 库的标识串。
 *
 * 用 `JSON.stringify([...])` 而不是 `a|b|c`：账号与路径里都可能含 `|`
 * （自建服务器的用户名几乎不受限制），直接拼会歧义
 * （`baseUrl="a|b", user="c"` 与 `baseUrl="a", user="b|c"` 会撞成同一个），
 * 而「撞成同一个」的后果是**一个库的归属决定被另一个库继承** ⇒ 多传。
 */
export function libraryIdentityOf(ref: LibraryRef): string {
  const root = normalizeRootLoose(ref?.rootPath ?? '');
  return JSON.stringify([
    normalizeBaseUrlLoose(ref?.baseUrl ?? ''),
    String(ref?.username ?? '').trim(),
    // 空目录 = 默认目录（与 `saveWebDavConfig` 落盘、`loadWebDavConfig` 读回
    // 的默认一致）—— 否则「表单里空着」与「磁盘上写着 TapStack」会被当成
    // 两个库 ⇒ 用户只是重填了一次密码就被重新拦住。
    root || DEFAULT_ROOT,
  ]);
}

/** 某个库的作用域键（存待决位时用它寻址）。 */
export function libraryScopeKey(ref: LibraryRef | null): string {
  return ref ? libraryIdentityOf(ref) : NO_LIBRARY_SCOPE;
}

/**
 * 两个引用是否指向**同一个**库。
 *
 * `null`（没配过）与任何引用都不同 —— 「没配过」不是「某个库」，
 * 它是「还没有目标」，第一次配置时必须当成新库。
 */
export function sameLibrary(a: LibraryRef | null, b: LibraryRef | null): boolean {
  if (!a || !b) return false;
  return libraryIdentityOf(a) === libraryIdentityOf(b);
}

/**
 * 本机**当前**指向的库（读已落盘的配置）。
 *
 * ⚠️ 读的是**磁盘上的配置**，不是表单里正在编辑的内容：
 * 待决位的读取方（后台的 syncEngine）也在读磁盘，两边必须用同一份真值。
 * 拿表单值去比会得出「同一个库」的假结论（表单被改成新地址时，
 * 表单 ≠ 磁盘 ⇒ 恰恰是**不同**的库）。
 *
 * 读不到（没配过 / 读失败）⇒ `null`（= 没有目标库）。
 *
 * ⚠️ 2026-10-23（第 51 轮）：**不再导出** —— 全仓只有本文件内的
 * `currentLibraryScope()` 用它（外面的读取方要的是**作用域键**，不是那个
 * 引用对象）。留着一个没人用的导出 = 留一条「可以直接拿引用当身份」的路，
 * 而引用里含用户名/路径 ⇒ 那条路不该开。
 */
async function currentLibraryRef(): Promise<LibraryRef | null> {
  try {
    const cfg = await loadWebDavConfig();
    if (!cfg) return null;
    return { baseUrl: cfg.baseUrl, username: cfg.username, rootPath: cfg.rootPath };
  } catch {
    return null;
  }
}

/**
 * 本机当前指向的库的作用域键（读磁盘上的已保存配置）。
 *
 * 读不到 ⇒ `NO_LIBRARY_SCOPE`（= 没有目标库）。
 */
export async function currentLibraryScope(): Promise<string> {
  return libraryScopeKey(await currentLibraryRef());
}
