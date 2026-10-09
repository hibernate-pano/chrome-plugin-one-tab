import { tabManager } from '@/background/TabManager';
import { migrateToV2 } from '@/utils/migrationHelper';
import { setupBackgroundSync } from '@/background/backgroundSync';
import { syncEngine, SYNC_UPLOAD_ALARM } from '@/services/syncEngine';
import { isOpenableTabUrl, isStorableTabUrl } from '@/utils/inputValidation';
import { enqueue, hasQueuedOrRunningJob } from '@/background/mutationQueue';
import { mutationService } from '@/background/mutationService';
import { ensureOpStampMigrated } from '@/background/opStampMigratedGuard';
import { runMigrations as runStorageMigrations } from '@/utils/migrationUtils';
import { LEGACY_KEYS, STORAGE_KEYS } from '@/storage-kv/keys';
import { UPLOAD_DEBOUNCE_MS } from '@/core/syncTiming';
import { logError, logInfo, logWarn } from './utils/log';
// 诊断导出前落盘性能 span 用（见 PERF_FLUSH 消息分支）。
import { perfTrace } from './utils/perfTrace';

// Chrome 扩展的 Service Worker
// 为了避免模块导入问题，早期版本内联了存储逻辑；现统一使用 utils/storage 以与前端页面共享同一数据源（IndexedDB）

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
// 这里改的是 chrome.storage.local 里的键，而权威表本身正是为「键名只在一处定义」
// 建立的 —— 手抄副本的代价是：改名时漏改一处，旧数据静默读不到（不报错）。
async function migrateStorageKeys() {
  try {
    const legacyKey = LEGACY_KEYS.LEGACY_TAB_GROUPS;
    const currentKey = STORAGE_KEYS.GROUPS;
    const { [legacyKey]: tabGroups } = await chrome.storage.local.get([legacyKey]);
    const { [currentKey]: tab_groups } = await chrome.storage.local.get([currentKey]);

    // 如果存在旧键且新键不存在或为空，则迁移
    if (Array.isArray(tabGroups) && (!Array.isArray(tab_groups) || tab_groups.length === 0)) {
      await chrome.storage.local.set({ [currentKey]: tabGroups });
      // 迁移完成后可选择清理旧键（可选）
      await chrome.storage.local.remove(legacyKey);
      logInfo(`已将旧键 ${legacyKey} 迁移为 ${currentKey}`);
    }
  } catch (error) {
    logWarn('迁移存储键失败（可忽略）:', error);
  }
}

async function runMigrations() {
  // chrome.storage.local 旧键只碰迁移自身的旧键，不碰 GROUPS —— 可留在队列外。
  await migrateStorageKeys();

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

const showNotification = async (message: string, title = 'TapStack'): Promise<void> => {
  await tabManager.showNotification({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message,
  });
};

logInfo('Service Worker: 已简化同步逻辑，只保留手动同步功能');

// 初始化右键菜单
async function setupContextMenus() {
  try {
    await chrome.contextMenus.removeAll();
  } catch (error) {
    logWarn('清理旧的右键菜单失败，可忽略:', error);
  }

  chrome.contextMenus.create({
    id: 'open-tab-manager',
    title: '打开标签管理器',
    contexts: ['action']
  });

  chrome.contextMenus.create({
    id: 'saveCurrentTab',
    // 2026-10-09 P1-1：定位不变（保存 = 剪切，产品负责人已确认保持现状），
    // 但同一动作的每个入口都必须把「会关闭」说出来 —— 否则用户按右键菜单
    // 时以为只是存个副本，标签却被关掉了。
    title: '保存当前标签并关闭',
    contexts: ['action']
  });

  chrome.contextMenus.create({
    id: 'saveOtherTabs',
    title: '保存其他标签并关闭',
    contexts: ['action']
  });
}

// 初始安装或更新时
chrome.runtime.onInstalled.addListener(async (details) => {
  logInfo('Service Worker: 扩展已安装或更新, 原因:', details.reason);

  // 记录安装/更新事件以触发用户引导
  if (details.reason === 'install') {
    await chrome.storage.local.set({
      onboarding_trigger: {
        reason: 'install',
        version: chrome.runtime.getManifest().version,
      },
    });
    logInfo('Service Worker: 已记录首次安装事件');
  } else if (details.reason === 'update') {
    await chrome.storage.local.set({
      onboarding_trigger: {
        reason: 'update',
        version: chrome.runtime.getManifest().version,
        previousVersion: details.previousVersion,
      },
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
});

// 监听扩展图标点击事件
chrome.action.onClicked.addListener(async () => {
  try {
    await showNotification('正在保存当前窗口为会话...');
    const tabs = await chrome.tabs.query({ currentWindow: true });
    await tabManager.saveAllTabs(tabs);
    await tabManager.openTabManager(true);
  } catch (error) {
    logError('处理扩展图标点击失败:', error);
    await showNotification('无法保存当前窗口，请重试。如果问题持续，请重启浏览器。');
  }
});

// 监听快捷键命令
chrome.commands.onCommand.addListener(async (command) => {
  logInfo('收到快捷键命令:', command);

  try {
    switch (command) {
      case 'save_all_tabs': {
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

      case '_execute_action':
        logInfo('快捷键打开标签管理器');
        await tabManager.openTabManager();
        break;
    }
  } catch (error) {
    logError('处理快捷键命令失败:', error);
    await showNotification('快捷键操作失败，请重试');
  }
});

// 监听右键菜单点击事件
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  logInfo('右键菜单点击:', info.menuItemId);

  try {
    if (info.menuItemId === 'open-tab-manager') {
      logInfo('点击右键菜单，打开标签管理器');
      await tabManager.openTabManager();
    } else if (info.menuItemId === 'saveCurrentTab' && tab) {
      logInfo('点击右键菜单，保存当前标签页');
      // 同快捷键：只在真保存了才报成功（失败原因由 saveCurrentTab 就地弹出）
      const saved = await tabManager.saveCurrentTab(tab);
      if (saved) {
        await showNotification('当前标签页已保存');
      }
      await tabManager.openTabManager(true);
    } else if (info.menuItemId === 'saveOtherTabs') {
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
        await showNotification('没有其他标签页需要保存');
        return;
      }

      await tabManager.saveAllTabs(otherTabs);
      await tabManager.openTabManager(true);
    }
  } catch (error) {
    logError('处理右键菜单点击失败:', error);
    // ── 顺带修 P1-8：同一动作的两个入口必须同一种诚实度 ────────────────
    // 快捷键保存失败走的是外层 catch → 「快捷键操作失败，请重试」；
    // 右键的 catch 原先只 logError，用户点完毫无反应，与「没点上」无法区分。
    // 文案不写「保存失败」：本 catch 同时兜着打开管理器与保存其他标签两个分支，
    // 对它们说「保存失败」反而是新的不准确。用与快捷键同构的泛化文案。
    await showNotification('操作失败，请重试');
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
              : 'URL scheme not allowed',
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
              error: skipped > 0 ? '本设备无法打开这些标签（本地文件/临时链接/浏览器内部页面）' : 'no valid URLs',
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
              // 但 SW 并不知道调用方有没有删掉原会话（未锁定组先删后开、已锁定组不删），
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
            sendResponse({ success: false, error: 'no valid URLs' });
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

            await tabManager.saveAllTabs(tabs);
            sendResponse({ success: true });
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
            });
            return { ok: r.success, error: r.error, payload: r };
          }
          if (data.op === 'download') {
            const r = await syncEngine.downloadAndMerge({
              forceRemote: !!data.forceRemote, syncSettings: !!data.syncSettings,
            });
            return { ok: r.success, error: r.reason, payload: r };
          }
          return { ok: false, error: `未知同步操作: ${data.op}` };
        }, { priority: 'high' })
          .then(res => sendResponse(res))
          .catch(err => sendResponse({ ok: false, error: err?.message || '同步失败' }));
        return true;
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
