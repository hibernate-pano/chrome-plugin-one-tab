import { tabManager } from '@/background/TabManager';
import { migrateToV2 } from '@/utils/migrationHelper';
import {
  AUTO_SYNC_DISABLED_REASON,
  readAutoSyncConfig,
  setupBackgroundSync,
} from '@/background/backgroundSync';
import { syncEngine, SYNC_UPLOAD_ALARM } from '@/services/syncEngine';
import { isOpenableTabUrl, isStorableTabUrl } from '@/utils/inputValidation';
import { enqueue, hasQueuedOrRunningJob } from '@/background/mutationQueue';
import { mutationService } from '@/background/mutationService';
import { ensureOpStampMigrated } from '@/background/opStampMigratedGuard';
import { clearSaveReceipt, RECEIPT_CLEAR_ALARM } from '@/background/saveReceipt';
import { runMigrations as runStorageMigrations } from '@/utils/migrationUtils';
import { UPLOAD_DEBOUNCE_MS } from '@/core/syncTiming';
import { recordOnboardingTrigger } from '@/utils/onboardingStorage';
import { logError, logInfo, logWarn } from './utils/log';
// 诊断导出前落盘性能 span 用（见 PERF_FLUSH 消息分支）。
import { perfTrace } from './utils/perfTrace';
import { invalidateActiveSyncBackend, primeSyncBackend } from '@/sync-backend';
// ── 2026-10-23（首屏瘦身 + SW 可运行）────────────────────────────────────
//
// 【为什么 SW 入口要静态 import 这些】弹窗首屏瘦身 ⇒ Supabase SDK 与
// WebDAV 传输栈在**页面侧**改成按需加载（首屏不下载）。
// 但 **service worker 里 `import()` 被 Chrome 禁止**
// （HTML 规范：ServiceWorkerGlobalScope 上不允许 import()），
// 而 SW 侧同样需要它们（核登录态、上传下载）⇒
// **SW 入口静态 import 进来，再注册给那两个加载器**。
//
// 页面侧不注册 ⇒ 页面走默认的动态加载（首屏照旧不下载）。
// 两边的**实现是同一份模块**（不是两份代码），所以行为不会漂移。
import { setSupabaseFacadeLoader } from '@/utils/supabaseRuntime';
import * as supabaseFacade from '@/utils/supabaseFacade';
import { setWebDavTransportLoader } from '@/sync-backend/webdavRuntime';
import { WebDavClient } from '@/sync-backend/webdav/client';
import { WebDavBackendAdapter } from '@/sync-backend/webdav/adapter';
import { hasHostPermission } from '@/sync-backend/webdav/permission';
// ── 2026-10-23 审计 P0-1：「本机当前在哪个库」也要在 SW 里算得出来 ──────
//
// 待决位是**按库寻址**的（storage-kv/firstSyncPendingRecord.ts）⇒ 页面与 SW
// 必须得出同一个答案。而「算出库」要读后端层的库身份模块 ⇒ 那条边过去是
// `await import(...)` ⇒ **SW 里 import() 被 Chrome 禁止** ⇒ SW 恒为
// 「没有目标库」⇒ 落进保守分支 ⇒ SW 永远以为归属决策没做完 ⇒
// 历史会话被永久挡在用户自己的云盘之外，而回包还报「成功」。
//
// ⇒ 与上面两个注册表同一个形状：SW 入口静态 import 进来，再注册给它。
// 页面侧不注册 ⇒ 页面仍然是「用到才下载」，首屏照旧不碰云端栈。
import { setLibraryIdentityLoader } from '@/sync-backend/webdav/libraryIdentityRuntime';
import * as libraryIdentity from '@/sync-backend/webdav/libraryIdentity';
// 诊断通道用：SW 侧算出来的库作用域（不吞异常 ⇒ 算不出就是报错）。
import { resolveCurrentLibraryScopeStrict } from '@/storage-kv/firstSyncPendingRecord';
import {
  CONTEXT_MENU_IDS,
  CONTEXT_TYPES,
  resolveContextTypes,
  toChromeContextType,
} from '@/background/contextMenuPolicy';
// ── 2026-10-22（402）：「云端项目被限制」的机器判据要穿过 SW 这一层 ────────
// SW 的 SYNC 分支是 popup 与引擎之间的**唯一**接缝；标记在这一层被吞掉 ⇒
// 界面拿不到它 ⇒ 又退回「请重试」（而重试对被封禁的服务端无用）。
import { isBackendUnavailableError } from '@/core/backendUnavailable';
import { backendUnavailableCopy } from '@/components/sync/backendUnavailableCopy';

// Chrome 扩展的 Service Worker
// 为了避免模块导入问题，早期版本内联了存储逻辑；现统一使用 utils/storage 以与前端页面共享同一数据源（IndexedDB）

// ⚠️ **注册必须在任何同步/认证动作之前** ─────────────────────────────────
//
// SW 里的 `import()` 是非法的 ⇒ 重依赖只能静态带进来。
// 这里把「静态拿到的模块」注册成两个加载器的实现：
//   · Supabase 门面（SDK + 读写实现）
//   · WebDAV 传输栈（client + adapter + 权限）
// 页面侧不注册 ⇒ 页面仍然是「用到才下载」，首屏照旧不碰云端栈。
setSupabaseFacadeLoader(async () => supabaseFacade);
setWebDavTransportLoader(async () => ({
  WebDavClient,
  WebDavBackendAdapter,
  hasHostPermission,
}));
// 「本机当前在哪个库」：同一份模块，SW 静态取、页面动态取（见上面的 P0-1 说明）。
setLibraryIdentityLoader(async () => libraryIdentity);

// Service Worker启动日志
logInfo('=== TapStack Service Worker 启动 ===');
logInfo('版本:', chrome.runtime.getManifest().version);
logInfo('启动时间:', new Date().toISOString());
logInfo('Chrome APIs 可用性检查:');
logInfo('- chrome.tabs:', !!chrome.tabs);
logInfo('- chrome.runtime:', !!chrome.runtime);
logInfo('- chrome.action:', !!chrome.action);
logInfo('- chrome.storage:', !!chrome.storage);
logInfo('=====================================');

// 迁移旧的存储键到新的统一键名
// 2026-10-09 架构 P2-2：键名改引用权威表，不再手抄。
// tabGroups 是历史键名（归在 LEGACY_KEYS），tab_groups 是现行键（STORAGE_KEYS）。
//
// ── 2026-10-20 审计 A-15：这一步已被删除，理由是它**写错了地方** ──────────
//
// 修复前这里做的是：把 chrome.storage.local 里的 `tabGroups` **再写一份**到
// chrome.storage.local 的 `tab_groups`（改名），再删掉旧键。
//
// 三个问题，一个比一个严重：
//
// ① **方向是反的**。会话数据最终的归宿是 IndexedDB（见 storage-kv/）。
//    chrome.storage.local 是**迁移的源**，不是目的地。往源里写一份改名后的
//    副本，等于「先把行李搬到中转站，再从中转站搬到目的地」—— 中转站有 10MB
//    配额限制，而目的地（IndexedDB）压根不受限。
//
// ② **它是唯一会撞 10MB 配额的一步**。重度用户的 `tab_groups` 可能有
//    几十上百个会话，序列化后逼近或超过配额 ⇒ `chrome.storage.local.set` 抛错。
//    而整条迁移的 catch 是 `logWarn` 后「可忽略」⇒ **用户看不到自己的会话**，
//    却没有任何报错。今天它靠 `unlimitedStorage` 权限兜着；一旦移除该权限，
//    这条「看起来无害」的写就变成老用户升级路上的真雷。
//
// ③ **它与真正的迁移重复，而且覆盖不全**。`MIGRATION_SCAN_KEYS` 已经包含
//    `tab_groups` 与历史键 `tabGroups`（见 storage-kv/keys.ts），
//    `migrateFromChromeStorage` 会把两者都搬进 IndexedDB。改名这件事在
//    **KV 层**做才对 —— 而且必须做，否则历史键的值会被搬进 IndexedDB 的
//    `tabGroups` 键（一个没人读的键），用户依旧看不到会话。
//
// 处置：删掉这里的 chrome.storage 写入，改名交给 KV 层
// （`MIGRATION_KEY_RENAMES` + `planMigrationWrites`，见 src/storage-kv/keys.ts
// 与 storageAdapter.ts）。迁移失败时 KV 层**显式失败**（读抛错 / 写整条失败），
// 不再静默降级成「用户一个会话都没有」。
//
// 保留一个「旧键清理」也不合适：`migrateFromChromeStorage` 成功后已经
// `chrome.storage.local.remove(keys)`（keys 含两个键名）。

async function runMigrations() {
  // ── 2026-10-20 审计 A-15：原先这里的 `await migrateStorageKeys()` 已删除 ──
  //
  // 它会把会话数据**写回 chrome.storage.local**（改名），那是唯一会撞 10MB
  // 配额的一步，而它的 catch 是静默吞掉 ⇒ 用户看不到自己的会话。
  // 改名已下沉到 KV 层（storage-kv/keys.ts 的 MIGRATION_KEY_RENAMES +
  // storageAdapter.ts 的 planMigrationWrites），那里失败会**显式失败**。
  //
  // 注意：`migrateFromChromeStorage` 由 `ensureInitialized()` 触发，而
  // `ensureInitialized()` 由任意一次 kvGet 触发 —— 也就是说 chrome.storage
  // → IndexedDB 的迁移**本来就不依赖** runMigrations。这里删掉调用不会
  // 少搬任何数据。

  // ── 2026-10-09 专家团体检 P0：以下三件都是「全量读 → 改 → 写 groups」──
  //
  // runMigrations 由 onInstalled / onStartup 调用，此刻处在队列**外**。原先
  // migrateToV2() 是**裸调用**，而紧挨它下方 10 行的注释就写着「此刻处在队列外，
  // 必须入队」—— 规则在同一个函数里已知，只是没套到它身上。与正在跑的
  // sync:download / mutation 交错时，迁移会拿 t0 快照覆盖 t1 刚写入的会话：
  // 被覆盖的一方已经报成功给用户了，而 v1.22.0 起无回收站，用户找不回来。
  // 下一轮 upload 读的是被抹掉后的状态 ⇒ 本地与云端一起丢。
  //
  // 三件合并成一个 job（同一个单写者任务内串行），不要拆成三次入队：
  // 中途插一个 mutation 会让「迁移中途的半成品」暴露给用户可见的列表。
  try {
    await enqueue('storageMigrations', async () => {
      await migrateToV2();
      // 阶段二·§7：存量实体补操作印记。必须在任何同步/写入之前跑完——
      // 没有印记的本地实体会被合并当成全序最小值，在首次与云端合并时静默输给云端。
      //
      // true = 此刻已在 storageMigrations 这个 job 内，就地串行（再入队会死锁）。
      await ensureOpStampMigrated(true);
      // popup 侧的三件迁移（favicon 清洗 / 无墓碑清理 / 最近恢复历史）
      // 原先由 TabList 在自己的 realm 直写 —— 见 RUN_MIGRATIONS 分支的说明。
      await runStorageMigrations();
    });
  } catch (error) {
    logError('[Migration] 数据迁移失败:', error);
  }
}

/**
 * SW 侧的通知出口。
 *
 * ── 2026-10-17 接上「显示通知提醒」开关 ─────────────────────────────────
 * 本函数原先无脑转发，于是 service-worker.ts 里 8 个通知点全部不受设置约束
 * （选项页关掉开关照样弹）。kind 透传给 tabManager.showNotification，由那一层
 * 统一裁决：'success' / 'info' 受开关控制，'error' 永远发。
 *
 * 未传 kind 时默认 'success'（受控制）—— 新增通知默认不该打扰用户。
 */
const showNotification = async (
  message: string,
  title = 'TapStack',
  kind: 'success' | 'info' | 'error' = 'success'
): Promise<void> => {
  await tabManager.showNotification({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message,
    kind,
  });
};

logInfo('Service Worker: 已简化同步逻辑，只保留手动同步功能');

// 初始化右键菜单
//
// ── 2026-10-20 审计 A-12：菜单要在「网页上右键」也出现 ───────────────────
// 修复前三个菜单项的 contexts 全是 ['action'] ⇒ **只在扩展图标上右键才出现**。
// 而用户最自然的位置是**在网页标签页上右键**（OneTab 等竞品就是在那儿做的），
// 商店文案写的也是「不打开管理界面，也能保存当前标签页」——
// 那句话在修复前是假的：在网页上右键，TapStack 什么也没有。
//
// 两条入口的语义不同：
//   · action 上下文（右键图标）—— 「当前标签」= 当前窗口的活动标签
//   · page 上下文（右键网页）—— 「当前标签」= **用户右键的那一个**
//     （Chrome 传进来的 tab 就是它）。用活动标签会是错的：
//     用户右键的是 B 页，系统却存了 A 页 —— 而且存完会把 A 页关掉。
//
// ⚠️ 标题与 id 的对应关系（Chrome 的硬约束）：
//   `contextMenus.create` 的**一个**调用只有**一个** title，共享给它的
//   全部 contexts。想要「在图标上叫 A、在网页上叫 B」，必须**拆成两个
//   create 调用、两个 id**。所以下面 `saveCurrentTab`（网页）与
//   `saveCurrentTabFromIcon`（图标）是**两项**，指向同一个业务动作。
//
//   拆开还有一个必要理由：**文案必须各自说清破坏性**。
//   「保存其他标签并关闭」会关掉当前窗口除一个之外的**全部**标签 ——
//   这种量级的破坏，放在随手右键就能触达的位置太危险，所以它只在
//   action 上下文（用户明确右键了扩展图标）出现。
//
// ⚠️ 上下文覆盖（2026-10-20，需求「contexts 扩到 ['action','page','tab']」）：
//   `tab` 上下文 = 右键**标签栏上的标签页标题**（不是网页内容区）。
//   它与 `page` 是两个不同的右键位置，但语义相同 —— 都是「用户右键了某个
//   标签页，要存的就是这个标签页」。
//   Chrome 在这两种上下文里传给 onClicked 的 `tab` **都是被右键的那一个**，
//   所以它们共用 `saveCurrentTab` 这一个菜单项（同一 title、同一动作）。
//
// ⚠️⚠️ `'tab'` 的两个坑（都不能靠「类型对了」蒙过去）：
//   ① **类型滞后**：`@types/chrome@0.0.262` 的 `ContextType` 里还没有 'tab'，
//      而 Chrome **运行时是支持的** —— Chrome 自己的参数校验错误把合法词表
//      原样列了出来：
//
//        Error at property 'contexts': Error at index 0: Value must be one of
//        action, all, audio, browser_action, editable, frame, image, launcher,
//        link, page, page_action, selection, tab, video.
//
//      也就是说 `'tab'` 在运行时的词表里，只是**类型定义滞后**。
//      所以这里必须做一次**精确**的类型断言，不是 `as any`：
//      断言 `as chrome.contextMenus.ContextType[]` 会把未知字面量也一起
//      放行，掩盖真正的拼写错误；而 `as unknown as ContextType[]`
//      等于放弃检查。下面的做法是：先用 `CONTEXT_TYPES` 常量表把值
//      钉死在一个地方（拼错会编译不过），再断言到 Chrome 的类型。
//
//   ② **老浏览器不认识**：实测 `'tab'` 在 Chrome 44~146 的 schema 里没有，
//      150 起才有（Chrome 150 之前传 'tab' 会抛参数错误 ——
//      「Value must be one of ...」里没有 tab）。
//      本扩展的 `minimum_chrome_version` 是 120 ⇒ 老浏览器上必须裁掉它。
//
//      【为什么用特性探测、而不是版本号判断】版本号判断依赖「我核实过的
//      那个数字」，而那个数字会随 Chrome 演进过时（实测表格见
//      `contextMenuPolicy.ts` 的注释）。特性探测依赖的是**浏览器自己的
//      答案**：试着注册一次，抛异常就是不支持 —— 不会过期，
//      也不会因为我漏了一个中间版本而错。
//
//      【顺带纠正一个说法】老浏览器上 create 失败**只影响那一项**，
//      不会让其他菜单项也注册不上（实测：['page'] → ['page','definitely_not_a_context']
//      → ['action'] 三项连着注册，中间那项抛错，前后两项照常注册成功）。
//      即便如此，裁剪仍然值得做 —— 少一次必然失败的调用，语义也更干净。
//
// ── 探测机制 ────────────────────────────────────────────────────────────
/**
 * 探测当前浏览器**是否接受 `'tab'` 上下文**（特性探测，不是版本号判断）。
 *
 * 做法：拿一个**探测用的 id** 试着注册带 'tab' 的菜单项：
 *   · 注册成功 ⇒ 这个浏览器认识 'tab' ⇒ 真菜单可以用它 ⇒ 立刻删掉探测项。
 *   · 抛异常   ⇒ 不认识（Chrome 150 之前的版本）⇒ 真菜单里去掉 'tab'。
 *
 * 【为什么用「探测项」而不是「直接注册真菜单项再看成不成功」】
 * 后者的问题是：真菜单项的 id 一旦注册成功又失败，重试会撞 id 冲突，
 * 而且「失败」与「被浏览器删了」分不清。独立的探测项没有这些歧义。
 *
 * 【为什么值得多这一次调用】`'tab'` 是用户最想「收起来」的位置
 * （正在浏览时右键标签栏上的标签标题）。而按版本号判断要依赖
 * 「我核实过的那个数字」—— 那个数字会随 Chrome 演进过时
 * （实测：44~146 没有，150 起有）。特性探测依赖浏览器自己的答案，
 * 不会过期。
 *
 * 【探测失败会怎样】probe 用的 id 是 `__tabstack_probe_tab_context__`，
 * 失败时不会有任何残留（注册失败 = 没注册上）。成功时立刻 remove 掉。
 */
function supportsTabContext(): boolean {
  const PROBE_ID = '__tabstack_probe_tab_context__';
  try {
    chrome.contextMenus.create({
      id: PROBE_ID,
      title: 'probe',
      contexts: [toChromeContextType(CONTEXT_TYPES.tab)],
    });
    chrome.contextMenus.remove(PROBE_ID);
    return true;
  } catch (error) {
    logInfo('当前浏览器不支持 tab 上下文，右键菜单只挂在 page 上下文上');
    void error;
    return false;
  }
}

async function setupContextMenus() {
  try {
    await chrome.contextMenus.removeAll();
  } catch (error) {
    logWarn('清理旧的右键菜单失败，可忽略:', error);
  }

  // ① 打开标签管理器 —— 只在扩展图标上有意义（action 上下文）
  chrome.contextMenus.create({
    id: CONTEXT_MENU_IDS.openTabManager,
    title: '打开标签管理器',
    contexts: [CONTEXT_TYPES.action]
  });

  // ②a 在网页上 / 标签页标题上右键：保存**此标签页**并关闭
  //    标题用「此标签页」而不是「当前标签」—— 在网页上下文里，
  //    「当前」有歧义（是活动标签？还是我右键的这个？）。
  //    「此」明确指向用户刚刚右键的那一个。
  //
  //    contexts 含 'tab'：右键**标签栏上的标签标题**也要能存 ——
  //    那是用户最想「收起来」的位置（正在浏览时右键标签标题）。
  //
  //    ⚠️ 断言说明：`@types/chrome@0.0.262` 的 `ContextType` 枚举缺 'tab'，
  //    但 Chrome 运行时支持（见上面 Chrome 自己的参数校验词表）。
  //    这里是**精确**断言（不是 `as any`）：上下文名由 `CONTEXT_TYPES`
  //    常量表钉死，拼错会编译不过。
  chrome.contextMenus.create({
    id: CONTEXT_MENU_IDS.saveCurrentTab,
    // 2026-10-09 P1-1：定位不变（保存 = 剪切，产品负责人已确认保持现状），
    // 但同一动作的每个入口都必须把「会关闭」说出来 —— 否则用户按右键菜单
    // 时以为只是存个副本，标签却被关掉了。
    title: '保存此标签页并关闭',
    contexts: resolveContextTypes(
      [CONTEXT_TYPES.page, CONTEXT_TYPES.tab],
      supportsTabContext()
    ).map(toChromeContextType)
  });

  // ②b 在扩展图标上右键：保存**当前标签页**并关闭（= 活动标签）
  chrome.contextMenus.create({
    id: CONTEXT_MENU_IDS.saveCurrentTabFromIcon,
    title: '保存当前标签页并关闭',
    contexts: ['action']
  });

  // ③ 保存其他标签并关闭 —— 只在扩展图标上有意义（action 上下文）：
  //    在网页上右键时「其他标签」的参照点是模糊的，且这个动作会关掉
  //    当前窗口除一个之外的**全部**标签 —— 在网页上随手右键就触发它太危险。
  //
  //    【enabled 为什么不是「按当前标签数现算」】Chrome **没有**
  //    `contextMenus.onShown`（那是 Firefox `browser.menus` 的事件；
  //    Chrome 只有 `onClicked`）。想在菜单弹出前置灰，就得自己跟踪
  //    标签数的变化并在变化时 `update({enabled})` —— 那要求监听
  //    tabs.onActivated/onCreated/onRemoved 三类事件，任何一个漏掉
  //    都会留下「置灰状态与真实标签数不一致」的菜单项
  //    （用户看到灰着的选项却其实能存，或反过来）。
  //    两种错误的代价不对称：状态错了比多一句提示更糟。
  //
  //    所以这里**保留该项可点**，把「没有其他标签」这件事在**点击后**
  //    明确说出来（见 onClicked 分支的提示）—— 用户点了立刻知道发生了什么，
  //    不会「点了没反应」。这条动作的破坏性由「只在 action 上下文出现」
  //    来控制（用户必须明确右键扩展图标才够得到它），不靠置灰。
  chrome.contextMenus.create({
    id: CONTEXT_MENU_IDS.saveOtherTabs,
    title: '保存其他标签并关闭',
    contexts: ['action']
  });
}

// 初始安装或更新时
chrome.runtime.onInstalled.addListener(async (details) => {
  logInfo('Service Worker: 扩展已安装或更新, 原因:', details.reason);

  // 记录安装/更新事件以触发用户引导
  //
  // ── 2026-10-20 审计 B-1：这里必须**合并**而不是覆写 ──────────────────────
  // 原先两条分支各自 `chrome.storage.local.set({ onboarding_trigger: … })`，
  // 每次安装/更新都无条件覆写。后果是一条真实的丢引导路径：
  //   装 1.25.0 → 没打开过管理页 → 商店自动升级到 1.25.1
  //   ⇒ update 触发把 install 触发抹掉
  //   ⇒ 判据走 update 分支，patch 变化不算新功能 ⇒ **不展示引导**
  //   ⇒ 这个用户永远看不到首次引导。
  // 「用户还没看过引导」比「版本变没变」更要紧 ⇒ install 触发必须压过 update。
  // 合并规则见 utils/onboardingStorage.ts 的 recordOnboardingTrigger。
  if (details.reason === 'install') {
    await recordOnboardingTrigger({
      reason: 'install',
      version: chrome.runtime.getManifest().version,
    });
    logInfo('Service Worker: 已记录首次安装事件');
  } else if (details.reason === 'update') {
    await recordOnboardingTrigger({
      reason: 'update',
      version: chrome.runtime.getManifest().version,
      previousVersion: details.previousVersion,
    });
    logInfo('Service Worker: 已记录版本更新事件, 旧版本:', details.previousVersion);
  }

  // 迁移旧的存储键 + 数据版本
  await runMigrations();

  // 创建右键菜单
  await setupContextMenus();

  // 注册后台同步 alarm（每 60s 拉取云端变更）
  setupBackgroundSync();
});

// 浏览器启动时
chrome.runtime.onStartup.addListener(async () => {
  logInfo('Service Worker: 浏览器已启动');
  // 尝试进行一次迁移，确保老用户数据可见
  await runMigrations();

  // 确保右键菜单存在
  await setupContextMenus();

  // 注册后台同步 alarm（程序启动后恢复轮询）
  setupBackgroundSync();
});

// Service Worker 激活时也初始化一次，防止遗漏
setupContextMenus().catch(error => {
  logError('初始化右键菜单失败:', error);
});

// ── 2026-10-13（WebDAV 阶段 2）：SW 启动即预解析同步后端 ──────────────
// 为什么必须在模块顶层做：SW 每次被唤醒都是全新执行上下文，
// 后端解析结果不跨唤醒存活。而 `getActiveSyncBackend()` 必须保持**同步**
// （20 处调用方都在同步链路里，见 sync-backend/index.ts 的论证），
// 所以解析只能提前 await 好，同步调用方直接取结果。
//
// 不 await 的后果不是报错，而是 `getActiveSyncBackend()` 走 fail-safe 分支
// 返回 Supabase 并告警 —— 于是「配了 WebDAV 却一直同步到 Supabase」。
primeSyncBackend().then(outcome => {
  if (outcome.resolvedId !== outcome.requestedId) {
    // 回落必须出声：静默把用户切回旧后端 = 他的新配置无声失效。
    logWarn(
      `[ServiceWorker] 同步后端回落：期望 ${outcome.requestedId}，实际 ${outcome.resolvedId}` +
        (outcome.fallbackReason ? ` —— ${outcome.fallbackReason}` : '')
    );
  }
});

// 后台同步 alarm（SW 被唤醒时重新注册，防遗漏）
setupBackgroundSync();

// ponytail: 上传报警听器。syncEngine.scheduleUpload() 改用 chrome.alarms
// （setTimeout 在 MV3 SW idle 被杀后丢），这里负责接收 alarm 事件并触发上传。
// 重要：与 popup SYNC 'upload' 走同一个队列名 'sync:upload'，确保所有数据
// 写动作（包括 alarm 驱动的延迟上传）都通过 mutationQueue 串行化，避免与
// 实时上传产生竞态导致本地状态被云端旧数据覆盖。
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_UPLOAD_ALARM) {
    enqueue('sync:upload', () => syncEngine.runScheduledUpload()).catch(err => {
      logError('[ServiceWorker] alarm 驱动的上传入队失败:', err);
    });
  }
  // ── 2026-10-23：保存徽标回执的到期清空 ─────────────────────────────────
  //
  // 为什么必须是 alarm 而不是 setTimeout：MV3 的 SW 随时被系统回收，
  // setTimeout 必然丢失 ⇒ 徽标会**永远留在图标上**，变成一个过期的假数字
  // （「已保存 12」挂在图标上，而那件事早就过去了 —— 比没有回执更糟）。
  // chrome.alarms 是持久的，SW 被回收后照样触发 ⇒ 徽标一定清得掉。
  if (alarm.name === RECEIPT_CLEAR_ALARM) {
    void clearSaveReceipt(
      {
        setBadgeText: (details) => chrome.action.setBadgeText(details),
        setBadgeBackgroundColor: (details) => chrome.action.setBadgeBackgroundColor(details),
        setTitle: (details) => chrome.action.setTitle(details),
      },
      {
        create: (name, info) => chrome.alarms.create(name, info),
        clear: (name) => chrome.alarms.clear(name),
      },
      // 还原成 manifest 的 default_title —— 硬编码在这里会与 manifest 漂移。
      chrome.runtime.getManifest().action?.default_title ?? 'TapStack'
    );
  }
});

// 监听扩展图标点击事件
//
// ── 2026-10-22 审计 P0-1：点图标**不再**保存并关闭当前窗口 ──────────────
//
// 原来的行为：showNotification('正在保存当前窗口为会话…') → saveAllTabs(tabs)
// → 关掉这些标签 → 打开管理器。全程**零确认**。
//
// 而用户点工具栏图标的心智模型是「打开这个扩展看看」——和所有其它扩展一样，
// 不是「把我这一窗标签销毁掉」。于是产品的第一句话就不可逆：装完第一次点图标，
// 12 个标签消失。而「我想看看上周存的会话」和「我要把这一窗收起来」是**两个
// 意图**，共用一个手势 ⇒ 破坏性的那一个总会被误触。
//
// 这条已被独立标记两次：`docs/audit-2026-10-20-round1.md:342`（P0，未修）、
// `docs/audit-2026-10-22-product-director.md`（P0-1，2026-10-22 复核仍成立）。
//
// 现在：点图标 = **只打开会话管理器**，不动当前窗口任何一个标签。
// 「保存并关闭」仍然是产品的核心动作，但改由**明确的意图**触发：
//   · 管理页顶栏的「保存并关闭」按钮（按钮上有字，用户看得见自己在干什么）；
//   · 右键扩展图标 →「保存其他标签并关闭」/「保存当前标签页并关闭」；
//   · 快捷键 Ctrl+Shift+S（macOS ⌘⇧S）保存整窗并关闭 —— 键位与语义都没变。
//
// 这不是把功能删掉，是把**不可逆的破坏**从「随手一点」挪到「明确的一步」。
chrome.action.onClicked.addListener(async () => {
  try {
    // 不传 shouldRefresh：管理器开着时刷新它会丢滚动位置，
    // 而它的数据本来就靠 storage 变更事件保持新鲜。
    await tabManager.openTabManager();
  } catch (error) {
    logError('打开标签管理器失败:', error);
    await showNotification('无法打开会话管理器，请重试。如果问题持续，请重启浏览器。', 'TapStack', 'error');
  }
});

// 监听快捷键命令
//
// 这里**没有** `_execute_action` 分支：Chrome 对 action 命令不派发
// commands.onCommand，按下 Ctrl+Shift+S 等同于点击扩展图标，走的是上面
// chrome.action.onClicked（保存整窗并关闭，随后打开管理器）。曾经写在这里的
// 那条分支是死代码，而它的文案（「打开标签管理器」）与真实行为相反。
chrome.commands.onCommand.addListener(async (command) => {
  logInfo('收到快捷键命令:', command);

  try {
    switch (command) {
      // Alt+Shift+S 是 Ctrl+Shift+S 的等价备用键位（两个 command id，
      // 同一个动作）。以前 Ctrl+Shift+S 挂在 `_execute_action` 上 ——
      // 那条命令走的是「点图标」，也就是**保存整窗并关闭**；现在图标改成
      // 只打开管理器，所以 Ctrl+Shift+S 必须挂到一个真的保存命令上，
      // 否则「Ctrl+Shift+S 保存整窗并关闭」这句话就成了假话。
      //
      // 两条 case 故意相邻且中间不夹注释：空 case 的 fall-through 是 eslint
      // no-fallthrough 认可的写法，但**中间夹注释**会让它判成漏写 break。
      case 'save_all_tabs':
      case 'save_all_tabs_alt': {
        logInfo('快捷键保存所有标签页');
        const allTabs = await chrome.tabs.query({ currentWindow: true });
        await tabManager.saveAllTabs(allTabs);
        break;
      }

      case 'save_current_tab': {
        logInfo('快捷键保存当前标签页');
        const [activeTab] = await chrome.tabs.query({
          active: true,
          currentWindow: true
        });
        if (activeTab) {
          // ── 2026-10-09 P0：只在真保存了才报成功 ──────────────────────
          // saveCurrentTab 有 3 条预检早退（内部页 / 固定页开关 / URL 清洗后为空），
          // 每条都自己弹了具体失败通知。原先这里**不看结果**、无条件再弹
          // 「当前标签页已保存」，用户连收两条互相矛盾的通知。
          const saved = await tabManager.saveCurrentTab(activeTab);
          if (saved) {
            await showNotification('当前标签页已保存');
          }
        } else {
          logWarn('未找到活跃标签页');
        }
        break;
      }
    }
  } catch (error) {
    logError('处理快捷键命令失败:', error);
    await showNotification('快捷键操作失败，请重试', 'TapStack', 'error');
  }
});

// 监听右键菜单点击事件
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  logInfo('右键菜单点击:', info.menuItemId);

  try {
    if (info.menuItemId === CONTEXT_MENU_IDS.openTabManager) {
      logInfo('点击右键菜单，打开标签管理器');
      await tabManager.openTabManager();
    } else if (
      (info.menuItemId === CONTEXT_MENU_IDS.saveCurrentTab ||
        info.menuItemId === CONTEXT_MENU_IDS.saveCurrentTabFromIcon) &&
      tab
    ) {
      // ── 2026-10-20 审计 A-12：要存的是「用户右键的那一个」────────────
      // 在网页上右键时，Chrome 传进来的 tab 就是被右键的那个标签。
      // 拿「当前活动标签」会是错的：用户右键 B 页，系统却存了 A 页 ——
      // 而且存完会把 A 页关掉。这是不可逆的错操作。
      //
      // 两个 id 指向同一动作：`saveCurrentTab`（网页/标签标题上下文，标题
      // 「保存此标签页」）与 `saveCurrentTabFromIcon`（扩展图标上下文，标题
      // 「保存当前标签页」）。拆成两个是因为 Chrome 的 create 只有**一个**
      // title，共享给所有 contexts。
      const fromPageContext = info.menuItemId === CONTEXT_MENU_IDS.saveCurrentTab;
      logInfo(
        '点击右键菜单，保存当前标签页',
        fromPageContext ? '（网页/标签标题右键上下文）' : '（扩展图标上下文）'
      );

      // 同快捷键：只在真保存了才报成功（失败原因由 saveCurrentTab 就地弹出）
      const saved = await tabManager.saveCurrentTab(tab);
      if (saved) {
        await showNotification('当前标签页已保存');
      }
      // ── 右键保存后**不**打开管理页 ──────────────────────────────────
      // 修复前这里无条件 `openTabManager(true)`，与商店文案「不打开管理界面，
      // 也能保存当前标签页」正面相反 —— 而且快捷键路径不打开、图标点击
      // 路径打开、菜单路径打开，三条入口三种行为。
      //
      // 【为什么现在**所有**右键保存路径都不打开】需求写的是「右键保存后不要
      // 强制打开管理页 —— 快捷键路径就不打开，入口之间应一致」。
      // 快捷键路径（save_all_tabs / save_current_tab）不打开管理页，
      // 所以右键保存路径也不打开：**保存本身就是目的**，
      // 用户要的是「标签收起来了」，不是「再看一眼列表」。
      // 用户想看列表时，右键菜单里本来就有一项「打开标签管理器」。
      //
      // （扩展图标右键保存时「刷新一下列表」曾经是合理的 —— 但那条路径
      //  与快捷键路径同样是一次「保存」，入口之间必须一致。
      //  真要刷新，用户点「打开标签管理器」即可。）
    } else if (info.menuItemId === CONTEXT_MENU_IDS.saveOtherTabs) {
      logInfo('点击右键菜单，保存除当前标签以外的所有标签');
      // 获取当前窗口的所有标签页和当前活动的标签页
      const [allTabs, activeTabs] = await Promise.all([
        chrome.tabs.query({ currentWindow: true }),
        chrome.tabs.query({ active: true, currentWindow: true })
      ]);

      // 获取当前活动的标签页ID
      const activeTabId = activeTabs.length > 0 ? activeTabs[0].id : null;

      // 过滤掉当前活动的标签页
      const otherTabs = activeTabId
        ? allTabs.filter(t => t.id !== activeTabId)
        : allTabs;

      if (otherTabs.length === 0) {
        // 失败（用户点了「保存其他标签」，结果一个都没保存）⇒ 必须 'error'：
        // 这条通知不能被默认关闭的「显示通知提醒」吞掉，否则点了毫无反应。
        // （Chrome 没有 contextMenus.onShown，所以无法在菜单弹出前置灰
        //  这一项 —— 见 setupContextMenus 里的说明。用户点了至少得到
        //  一句实话，而不是「点了没反应」。）
        await showNotification('没有其他标签页需要保存', 'TapStack', 'error');
        return;
      }

      await tabManager.saveAllTabs(otherTabs);
      // 同上：右键保存不强制打开管理页（与快捷键路径一致）。
    }
  } catch (error) {
    logError('处理右键菜单点击失败:', error);
    // ── 顺带修 P1-8：同一动作的两个入口必须同一种诚实度 ────────────────
    // 快捷键保存失败走的是外层 catch → 「快捷键操作失败，请重试」；
    // 右键的 catch 原先只 logError，用户点完毫无反应，与「没点上」无法区分。
    // 文案不写「保存失败」：本 catch 同时兜着打开管理器与保存其他标签两个分支，
    // 对它们说「保存失败」反而是新的不准确。用与快捷键同构的泛化文案。
    await showNotification('操作失败，请重试', 'TapStack', 'error');
  }
});

// 简化的消息处理
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  logInfo('Service Worker 收到消息:', message.type);

  // 基本验证
  if (!message || !message.type) {
    sendResponse({ success: false, error: '无效消息' });
    return false;
  }

  try {
    switch (message.type) {
      case 'OPEN_TAB': {
        const data = message.data || {};
        const rawUrl: string | undefined = data.url || data.tab?.url;
        const pinned: boolean | undefined = data.pinned ?? data.tab?.pinned;
        // ── 2026-10-05：用 isOpenableTabUrl（能不能**打开**），不是 sanitizeTabUrl ──
        // URL 来源不可信（云端同步 / 导入 / 跨设备），但这两道门答的不是同一件事：
        // sanitizeTabUrl 放行 file:/blob:（它们存得下、只是本设备打不开），
        // 而这里要把 URL 交给 chrome.tabs.create —— 打不开就该在这里拒，
        // 而不是丢给 Chrome 弹一个错误页（扩展无 file:// 访问权限时必然如此）。
        const singleUrl = rawUrl && isOpenableTabUrl(rawUrl) ? String(rawUrl).trim() : null;

        if (singleUrl) {
          chrome.tabs.create({ url: singleUrl, active: false, pinned })
            .then(() => sendResponse({ success: true }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          return true;
        }
        // 拒开时明确告知调用方（避免 UI 显示"已打开"但其实静默丢弃）
        if (rawUrl) {
          sendResponse({
            success: false,
            error: isStorableTabUrl(rawUrl)
              ? '此标签在当前设备无法打开（本地文件/临时链接/浏览器内部页面），已保留在会话中'
              // 2026-10-19 审计 F-7：回**稳定 reason 码**而不是英文原文。
              // 原文会被 UI 原样弹给全中文界面的用户（"URL scheme not allowed"），
              // 用户无从行动。reason 码 → 中文的映射见 utils/serviceWorkerErrorCopy.ts。
              : 'url_scheme_not_allowed',
          });
          return false;
        }
        break;
      }

      case 'OPEN_TABS': {
        const data = message.data || {};

        if (Array.isArray(data.tabs)) {
          // ── 2026-10-05：这里必须用 isOpenableTabUrl，不是 sanitizeTabUrl ──
          // sanitizeTabUrl 的语义是「能不能**存**」（放行 file:/blob:/view-source:，
          // 见 utils/inputValidation.ts 的三道门说明），而这里是「能不能**打开**」。
          // 修复前两处都用 sanitizeTabUrl，于是恢复一个含 file:// 的会话时：
          //   file:///… 通过过滤 → chrome.tabs.create({url:'file:///…'})
          // 而 Chrome 扩展在无 "Allow access to file URLs" 权限时会拒绝或打开
          // 一个错误页，用户看到的是「恢复出来的会话里有几个标签是坏的」，
          // 却查不出原因。单个 openTab 已有兜底（弹通知），批量路径当时没有。
          const safeTabs: Array<{ url: string; pinned?: boolean }> = [];
          let skipped = 0;
          for (const t of data.tabs as Array<{ url?: string; pinned?: boolean }>) {
            if (isOpenableTabUrl(t.url)) {
              safeTabs.push({ url: String(t.url).trim(), pinned: t.pinned });
            } else if (typeof t.url === 'string' && t.url.trim()) {
              skipped++;
            }
          }
          if (safeTabs.length === 0) {
            sendResponse({
              success: false,
              error: skipped > 0 ? '本设备无法打开这些标签（本地文件/临时链接/浏览器内部页面）' : 'no_valid_urls',
            });
            return false;
          }
          const opener = data.inCurrentWindow
            ? tabManager.openTabsInCurrentWindow(safeTabs)
            : tabManager.openTabsInNewWindow(safeTabs);
          opener
            .then(() => {
              // 跳过数 > 0 时**必须告知调用方**：UI 不能显示「已打开 N 个」而实际
              // 少开了几个（与 docs 记录过的「对没发生的事报成功」同一类问题）。
              //
              // 2026-10-09：日志**不判断会话状态**。原日志写「它们仍保留在会话中」——
              // 但 SW 并不知道调用方有没有删掉原会话（先开后删，失败时调用方不删），
              // 这句话对其中一半是假的。SW 只报它确知的事实（跳过几个），
              // 「会话还在不在」由真正知道的 UI 层说（见 TabGroup 的分流文案）。
              if (skipped > 0) {
                logWarn(
                  `[SW] OPEN_TABS：${skipped} 个标签在本设备无法打开（本地文件/临时链接/` +
                    '浏览器内部页面），已跳过未打开。'
                );
              }
              sendResponse({
                success: true,
                ...(skipped > 0 ? { skippedUnopenable: skipped } : {}),
              });
            })
            .catch(error => sendResponse({ success: false, error: error.message }));
          return true;
        }

        if (Array.isArray(data.urls)) {
          const safeTabs = (data.urls as unknown[])
            .map(u => (isOpenableTabUrl(u) ? { url: String(u).trim() } : null))
            .filter((t): t is { url: string } => t !== null);
          if (safeTabs.length === 0) {
            sendResponse({ success: false, error: 'no_valid_urls' });
            return false;
          }
          const opener = data.inCurrentWindow
            ? tabManager.openTabsInCurrentWindow(safeTabs)
            : tabManager.openTabsInNewWindow(safeTabs);
          opener
            .then(() => sendResponse({ success: true }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          return true;
        }
        break;
      }

      case 'SAVE_ALL_TABS':
        // 允许前端通过消息触发保存
        (async () => {
          try {
            // 优先使用前端传来的 windowId，其次用 sender 信息，最后回退到 currentWindow
            const windowId = message.data?.windowId ?? sender.tab?.windowId;
            const tabs = windowId
              ? await chrome.tabs.query({ windowId })
              : await chrome.tabs.query({ currentWindow: true });

            logInfo('[Service Worker] SAVE_ALL_TABS 查询到标签页:', tabs.length);

            // ── 2026-10-18：只在真的保存了才回 success ───────────────────
            // saveAllTabs 在「清洗后一个标签都不剩」时弹通知并返回 null
            // （整窗都是内部页 / 危险 schema，或固定标签页开关关闭把它们全滤掉）。
            // 原先这里不看结果、无条件回 success:true ⇒ popup 的保存按钮显示
            // 「已保存」，而列表里根本没有新会话 —— 与 1.22.16 修掉的
            // saveCurrentTab 是同一类「预检失败仍报成功」。
            //
            // ── 2026-10-20 审计 A-4：把摘要一起带回去 ────────────────────
            // 「保存成功」不是全部事实：默认配置下固定标签页既没保存也没关闭。
            // 摘要（savedCount / droppedPinnedCount）必须回到 popup ——
            // 按钮反馈是用户真正盯着的那块屏幕，只在 SW 里弹通知不够。
            const summary = await tabManager.saveAllTabs(tabs);
            if (!summary) {
              // 文案与 TabManager 就地弹的通知同口径（那条说原因，这条进按钮）。
              sendResponse({ success: false, error: '没有可保存的标签页' });
              return;
            }
            sendResponse({
              success: true,
              savedCount: summary.savedCount,
              droppedPinnedCount: summary.droppedPinnedCount,
            });
          } catch (e: any) {
            logError('[Service Worker] SAVE_ALL_TABS 失败:', e);
            sendResponse({ success: false, error: e?.message || '保存失败' });
          }
        })();
        return true; // 异步响应

      case 'REFRESH_TAB_LIST':
        sendResponse({ success: true });
        return false;

      // ── 2026-10-09 专家团体检 P0：popup 侧迁移委托给 SW 的单写者队列 ──
      //
      // 修复前：TabList 在自己的 realm 直接 await runMigrations()（内部三件全量
      // 读-改-写 groups），与 SW 的 mutation / sync:download **零互斥** ——
      // 因为 mutationQueue 的 pending/running 是模块级变量，popup 与 SW 是两个
      // JS realm，各持一份实例，就算在 popup 里调 enqueue 也保护不了 SW 的写入。
      //
      // 时序即丢数据：t0 popup 迁移读快照 → t1 SW 的 mutation 写入刚保存的会话
      // → t2 popup 用 t0 快照整表写回 → 刚保存的会话当场消失，而它已报「已保存」。
      //
      // 【为什么不能只靠 getGroupsForWrite()】那解决的是**本 realm 的缓存陈旧**，
      // 不是跨 realm 互斥。importGroups 当初就是用同一条 sendMutation 路径解决
      // 同类竞态的（见 storage.mergeImportedGroups 注释），这里复用同一条先例。
      //
      // 【为什么 enqueue 而不是就地执行】本分支跑在消息处理上下文（仍是 SW 进程，
      // 但不在队列内），就地执行会与正在跑的 job 交错。入队后 SW 内一切数据写
      // （语义命令 / 上传 / 下载合并 / 迁移）严格串行。
      case 'RUN_MIGRATIONS': {
        enqueue('storageMigrations', () => runStorageMigrations())
          .then(() => sendResponse({ success: true }))
          .catch(err => sendResponse({ success: false, error: err?.message || '迁移失败' }));
        return true; // 异步响应
      }

      // 诊断导出前请求 SW 落盘性能 span（见 @/utils/perfTrace）。
      //
      // 【为什么不入 mutationQueue】入队就会排在正在执行的慢任务后面，而我们要看的
      // 恰恰是那次慢操作的计时——等它排队，现场已经过期。这里只写 PERF_SPANS 这一个
      // 与业务数据无关的键，不参与「读-改-写」，绕过队列是安全的。
      //
      // 【为什么必须显式请求】span 记在 SW 进程，落盘有节流窗口；诊断导出跑在 UI 进程，
      // 读不到 SW 的内存缓冲。不主动 flush 就会丢掉最近几秒——通常正是复现的那几秒。
      case 'PERF_FLUSH': {
        void perfTrace().flush()
          .then(() => sendResponse({ success: true }))
          .catch(() => sendResponse({ success: true }));
        return true; // 异步响应
      }

      // 诊断：SW 侧算出来的「本机当前指向哪个库」。
      //
      // ── 为什么需要这个通道（2026-10-23 审计 P0-1）─────────────────────────
      // 「本机在哪个库」这件事，页面与 SW 都必须算得出同一个答案
      // （待决位是**按库寻址**的）。而 SW 里 `import()` 被 Chrome 禁止
      // ⇒ 过去 SW **算不出** ⇒ 落进保守分支 ⇒ 历史会话永远传不上用户自己的
      // 云盘，而回包还报「成功」。
      //
      // 这个缺陷在单测里看不出来（Node 的 `import()` 合法）⇒ **只有真机能验**。
      // 而真机要验的正是「SW 算出来的是不是那个库」——
      // 于是需要一条只读的诊断通道，把 SW 侧算出来的作用域原样报出来
      // （用 `…Strict` 版本：不吞异常 ⇒ 算不出就是**报错**，而不是
      // 悄悄兜底成 no-library 让人误以为「算出来了，只是没配库」）。
      //
      // ⚠️ 它是**只读**的：不写任何键、不碰任何数据。
      case 'LIBRARY_SCOPE': {
        void resolveCurrentLibraryScopeStrict()
          .then(scope => sendResponse({ ok: true, scope }))
          .catch(err =>
            sendResponse({ ok: false, error: err?.message || '算不出库作用域' })
          );
        return true; // 异步响应
      }

      case 'MUTATE': {
        const cmd = message.data;
        if (!cmd || typeof cmd.op !== 'string') {
          sendResponse({ ok: false, error: '无效命令' });
          return false;
        }
        // originId 由发起上下文提供，一路带到落盘广播，供发起方过滤自己的回声。
        const originId = typeof message.originId === 'string' ? message.originId : undefined;
        // high 车道：用户直接点的操作，不排在后台整库上传后面等（见 mutationQueue 注释）
        enqueue(cmd.op, () => mutationService.handle(cmd, originId), { priority: 'high' })
          .then(res => sendResponse(res))
          .catch(err => sendResponse({ ok: false, error: err?.message || '命令执行失败' }));
        return true; // 异步响应
      }

      case 'SYNC': {
        const data = message.data || {};
        if (data.op === 'scheduleUpload') {
          syncEngine.scheduleUpload(typeof data.delayMs === 'number' ? data.delayMs : UPLOAD_DEBOUNCE_MS);
          sendResponse({ ok: true });
          return false;
        }
        // ── 2026-10-11（1.23.0）：菜单开关/档位变化后重建 alarm ──────────
        // popup 与 SW 是两个执行上下文：popup 只写设置（Redux + 落盘），
        // alarm 的启停/周期统一由 SW 侧 setupBackgroundSync 重建 —— 单点。
        // SW 重启（onStartup/模块顶层）本来就会调 setup 读最新设置，所以这条
        // 消息即使丢失（如 SW 正忙），下次启动也会收敛到正确状态，不存在
        // 「开关改了但 alarm 没跟上」的永久分叉。
        if (data.op === 'resyncAlarm') {
          // ── 2026-10-14：顺带刷新本上下文的**后端解析缓存** ────────────────
          // 为什么必须加这一步（真机 E2E 抓到的，不是推演）：
          //   · 后端解析结果是模块级缓存（sync-backend/index.ts 的 activeBackend），
          //     SW 启动时在模块顶层解析一次就固定了。
          //   · 设置页保存后调的是**它自己上下文**的 primeSyncBackend ——
          //     popup/options/SW 是三个独立 JS 世界，页面刷新了 SW 那份没动。
          //   · 于是用户配好 WebDAV、不重启浏览器，SW 仍按旧后端同步；
          //     ensureBackendPrimed() 见缓存非空就直接返回，永远不自愈。
          // 表现是「我明明切换了设置却没生效」，极难自查。
          //
          // 放在 resyncAlarm 里而不是新增命令：它的语义本就是
          //「设置变了，SW 侧重新读一遍」，alarm 与后端缓存是同一件事。
          // 代价只有一次 settings 读 + 一次配置读。
          //
          // ⚠️ 必须用 promise 链而不是把 listener 改成 async：
          // 本 listener 是同步函数，Chrome 靠它同步 return true 保活 sendResponse 通道
          // （全文件统一用这个模式）。在同步函数里写 await 会让响应通道在
          // 第一个 await 处就关闭，调用方拿到「消息端口已关闭」。
          invalidateActiveSyncBackend();
          try {
            setupBackgroundSync();
            sendResponse({ ok: true });
          } catch (err) {
            logWarn('[SW] 重建后台同步 alarm 失败:', err);
            sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
          }
          // 后端重解析失败**不**影响 alarm 已重建的结果（那是两件事），
          // 只告警：下次 SW 启动会重新解析。
          void primeSyncBackend()
            .then(outcome => {
              if (outcome.resolvedId !== outcome.requestedId) {
                logWarn(
                  `[SW] 同步后端回落：期望 ${outcome.requestedId}，实际 ${outcome.resolvedId}` +
                    (outcome.lockedReason ? ` —— ${outcome.lockedReason}` : '')
                );
              }
            })
            .catch(err => logWarn('[SW] 重解析同步后端失败（下次启动自愈）:', err));
          return false;
        }
        // ── 2026-10-11（1.23.0）：自动下载受总开关门禁 ───────────────────
        // popup 打开时的 AutoSync 带 auto:true（显式意图的证据），用户手点的
        // 下载/上传不带 —— 门禁只看 auto 位，不看调用方是谁。以后新增自动触发
        // 方只要带上 auto:true 就自动被管住，不用每个调用点各写一次。
        // 判据复用 readAutoSyncConfig（与 alarm 循环同一单点）。
        // 读失败 → 跳过本轮（省流量方向；瞬时错误下次打开重试）+ 告警，不抛。
        // 【为什么是 promise 链而不是 await】本 listener 是同步函数（Chrome 要求
        // 同步返回 true 保活异步 sendResponse 通道，全文件统一用这个模式）。
        // 门禁先行、放行后走下面同一条入队路径 —— 不复制第二份 enqueue。
        if (data.op === 'download' && data.auto === true) {
          void readAutoSyncConfig().then(
            cfg => {
              if (!cfg.enabled) {
                logInfo('[SW] 自动同步已关闭，跳过本次自动下载（用户可点「同步」手动获取）');
                sendResponse({ ok: false, error: AUTO_SYNC_DISABLED_REASON });
                return;
              }
              runSyncOp();
            },
            err => {
              logWarn('[SW] 读不到自动同步配置，跳过本次自动下载:', err);
              sendResponse({ ok: false, error: AUTO_SYNC_DISABLED_REASON });
            }
          );
          return true; // 异步响应（sendResponse 在上面的链里调）
        }
        // 【为什么把下面整段包进 runSyncOp 而不是复制一份 enqueue】门禁放行后
        // 必须走**同一条**入队路径（含在途去重门禁 + high 车道 + 结果包装），
        // 复制第二份 enqueue 等于两份「下载到底怎么入队」的真相，改一条漏一条。
        // 三道门顺序：总开关（否决性，最便宜）→ 在途去重（并发保护）→ 入队执行。
        const runSyncOp = (): boolean => {
        // 自动下载去重闸门（1.22.12）。【为什么不能靠 downloadAndMerge 里的
        // isSyncing 守卫】那是任务**执行时**才跑的检查，而队列把并发串行化了：
        // 轮到第二个下载时前一个必然已结束、isSyncing=false —— 守卫永远为假，
        // 重复下载一个接一个全量串跑（每轮一轮整库解密 + normalizeTabsData 告警），
        // AutoSync 还要为排队付满 30s 协议超时（线上日志的「操作超时：download」）。
        // 去重必须发生在入队之前，用队列的在途状态当判据（见 hasQueuedOrRunningJob）。
        // 只拦 auto（popup 打开自动触发）：用户手点的下载/上传是显式意图，照常排队执行。
        if (data.op === 'download' && data.auto === true && hasQueuedOrRunningJob('sync:')) {
          // already_syncing 是既有 reason：AuthProvider 对它静默（line 73 的白名单），
          // 用户手点的下载不带 auto、永远不会收到闸门的这个 reason。
          // false = 这次没有真的执行下载。
          sendResponse({ ok: false, error: 'already_syncing' });
          return false;
        }
        // 手动上传/下载也是用户点的（popup 里的按钮）→ high 车道，与语义命令同等待遇。
        enqueue(`sync:${data.op}`, async () => {
          // 统一包装为 MutationResult：ok=业务成败，error=原因码（already_syncing 等），
          // payload=完整原始结果（MergeResult/UploadResult，popup 按需取字段）
          if (data.op === 'upload') {
            const r = await syncEngine.upload({
              forcePending: true,
              overwriteCloud: !!data.overwriteCloud,
              syncSettings: data.syncSettings !== false,
              // 2026-10-18 P1#4：只有设置页三选一会传 true，其余调用方
              // （含 scheduleUpload 与这里的默认路径）都算「用户尚未确认归属」。
              explicitFirstSync: data.explicitFirstSync === true,
            });
            // ── 2026-10-20 D-3：这里是把「本轮没全传上去」翻译给用户的地方 ──
            //
            // 引擎的 `success` 说的是「这一轮没有硬失败」（墓碑广播、TTL 清理、
            // 设置上传都真的完成了），它**不是**「全部会话都同步了」。
            // 而「全部同步了」才是用户按下按钮时期待的那件事 ——
            // 所以**这一层**（唯一面向用户的一层）必须把两件事分开：
            // 有会话没传上去 ⇒ ok=false + 如实的原因 ⇒ popup 弹错误提示。
            //
            // 为什么不在引擎里把 success 直接置 false：引擎的 success 被
            // backgroundSync 与 downloadAndMerge 消费 —— 它们据此决定
            // 「要不要继续下载」。若「部分没传上去」被当成「整体失败」，
            // 下载会被永久挡住（上传永远补不齐 ⇒ 每轮都失败 ⇒ 每轮都跳过下载），
            // 用户连**别的**会话都同步不了。那是把一个小洞捅成一个大洞。
            //
            // 为什么 UI 不需要改（本次任务不许动 src/components/**）：
            // popup 现有的失败分支会把 error 交给 resolveSyncFailureCopy，
            // 而它对「含中文的句子」是原样透出的 —— 于是
            // 「N 个会话尚未同步到云端（已保留待传队列，下一轮会自动重试）」
            // 会原样弹给用户，不需要在组件里新增字段。
            //
            // ── 2026-10-20 D-10：还有第三种「没同步完」——「无法确认」 ──────
            // 「有没有东西没传上去」（skippedGroups>0）与「能不能证明东西都
            // 传上去了」是**两件事**。登记失败过的那一轮，登记集合可能与上行
            // 集合**完全对得上**（skippedGroups=0），而「没漏」**无从证明**
            // （漏登记的改动压根没记下 id）。
            //
            // 旧判据只看 skippedGroups ⇒ 这种情况回包 ok=true ⇒ popup 弹
            // 「上传成功」—— 那是在撒谎。现在多一个判据 cannotConfirmAllSynced：
            // 它为 true ⇒ 同样 ok=false ⇒ 弹的是引擎给的人话（说明为什么卡住、
            // 怎么恢复），不是「同步成功」。
            const partial = typeof r.skippedGroups === 'number' && r.skippedGroups > 0;
            const cannotConfirm = r.cannotConfirmAllSynced === true;
            return {
              ok: r.success && !partial && !cannotConfirm,
              error: r.error,
              payload: r,
              // ── 2026-10-22（402）：把「服务端不可用」的机器标记带出 SW ────
              // 这一层是 popup 与 SW 的**唯一**接缝。标记不在这透出 ⇒
              // 界面只能拿到一句人话/英文 ⇒ resolveSyncFailureCopy 选不对措辞
              // ⇒ 用户又看到「请重试」（而重试无用）。
              ...(r.backendUnavailable ? { backendUnavailable: true } : {}),
            };
          }
          if (data.op === 'download') {
            const r = await syncEngine.downloadAndMerge({
              forceRemote: !!data.forceRemote, syncSettings: !!data.syncSettings,
            });
            // ── 2026-10-20 D-6：如实回传「云端有 N 组这轮读不出来」────────────
            //
            // `payload: r` 就是**整份 MergeResult**，其中含引擎如实上报的
            // `skippedRemoteGroups`（数量 + id 清单）。界面据此区分「合并」与
            // 「覆盖」两种事实并出文案（见 components/sync/syncPreviewView.tsx
            // 的 skippedRemoteGroupsNotice）。
            //
            // ⚠️ **ok 仍然是 true**：这一轮没有硬失败，重试也不会变好（云端那行
            // 还是读不出来）。说成失败 ⇒ 界面弹「下载失败，请重试」⇒ 用户一直
            // 点重试 ⇒ 那是**误导性失败**，比谎报成功更糟。
            //
            // ⚠️ **不许在这里把 payload 削掉**：那会让「云端读不出来」这件事
            // 重新退回「只写进日志」的状态（界面报成功，用户只看到列表变短）。
            //
            // ── 2026-10-22（402）：同样带出「服务端不可用」的机器标记 ────────
            // 与上传分支同形：标记必须穿过 SW 这一层，否则界面选不对措辞。
            return {
              ok: r.success,
              error: r.reason,
              payload: r,
              ...(r.backendUnavailable ? { backendUnavailable: true } : {}),
            };
          }
          return { ok: false, error: `未知同步操作: ${data.op}` };
        }, { priority: 'high' })
          .then(res => sendResponse(res))
          // ── 2026-10-22（402）：异常路径**不许**把机器标记吞掉 ──────────────
          // 这一层是 popup 与 SW 的接缝，而它是**通用** catch：任何异常都
          // 落成 `{ ok:false, error: err?.message }`。而「服务端项目被限制」
          // 的机器标记（code / http_status）就在异常对象上 —— 不显式带出，
          // 界面就只剩一句英文原文 ⇒ 「请重试」（错方向）。
          //
          // 什么时候会走到这里：账号闸门（ensureAuthenticated）在引擎里
          // **就地**处理了「服务端不可用」，但队列里**别的**任务
          // （含未来新增的调用点）抛出的同类异常仍会落到这里。
          // 所以这一层也要认。
          .catch(err => {
            const unavailable = isBackendUnavailableError(err);
            sendResponse({
              ok: false,
              error: unavailable ? backendUnavailableCopy(data.op === 'download' ? 'download' : 'upload') : err?.message || '同步失败',
              ...(unavailable ? { backendUnavailable: true } : {}),
            });
          });
        return true;
        };
        return runSyncOp();
      }

      default:
        sendResponse({ success: false, error: '未知消息类型' });
        return false;
    }
  } catch (error) {
    logError('处理消息失败:', error);
    sendResponse({ success: false, error: '处理消息失败' });
    return false;
  }
});
