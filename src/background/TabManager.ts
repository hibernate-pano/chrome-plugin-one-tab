import { storage } from '@/utils/storage';
import { UPLOAD_DEBOUNCE_MS } from '@/core/syncTiming';
import { createTabGroupFromChromeTabs, filterValidTabs, isInternalUrl } from '@/domain/tabGroup';
import { cacheManager } from '@/utils/performance';
import { trackProductEvent } from '@/utils/productEvents';
import { syncEngine } from '@/services/syncEngine';
import { sanitizeTabUrl, isOpenableTabUrl } from '@/utils/inputValidation';
import { enqueue } from './mutationQueue';
import { createSeqRegistry } from '@/utils/seqRegistry';
import { getDeviceId } from '@/utils/deviceUtils';
import { saveAllSuccessMessage, type SaveAllSummary } from '@/domain/tabGroup/saveFeedbackCopy';
import { MANAGER_PAGE_PATH } from '@/core/managerPage';
import { kvGet, kvSet } from '@/storage/storageAdapter';
import type { OpStamp } from '@/core/opStamp';
import { logError, logInfo, logWarn } from '../utils/log';

// 保存路径也走同一套印记（与 mutationService 的 registry 各持一实例，但无 memo、
// 同一持久化 key + Lamport 推导，因此互相一致）。无印记的组在合并中等价于
// EMPTY_STAMP（全序最小值）：一旦它被云端带上印记的副本碰上，本地标签列表会整体输掉。
const seqRegistry = createSeqRegistry({
  kvGet,
  kvSet,
  getGroups: () => storage.getGroups(),
});

/** 新实体的印记：本设备下一个 Lamport 序号 */
async function stampForNewEntity(): Promise<OpStamp> {
  return { d: await getDeviceId(), s: await seqRegistry.nextSeq() };
}

/**
 * 统一的标签页管理器
 * 负责处理所有与标签页相关的操作，避免代码重复
 */
export class TabManager {
  private static instance: TabManager;

  private constructor() { }

  static getInstance(): TabManager {
    if (!TabManager.instance) {
      TabManager.instance = new TabManager();
    }
    return TabManager.instance;
  }

  /**
   * 获取扩展页面URL
   *
   * 路径来自 `@/core/managerPage` 的单源常量 —— 此前这里是手抄的字符串，
   * 而设置页的「回到 TapStack」出口也要同一个路径。各自手抄早晚会漂，
   * 而漂了之后的症状是「先白屏再跳转」，极难查。
   */
  private getExtensionUrl(): string {
    return chrome.runtime.getURL(MANAGER_PAGE_PATH);
  }

  /**
   * 检查是否已有标签管理页面打开
   */
  private async getExistingTabManagerTabs(): Promise<chrome.tabs.Tab[]> {
    const extensionUrl = this.getExtensionUrl();
    return await chrome.tabs.query({ url: extensionUrl + '*' });
  }

  /**
   * 打开或激活标签管理器页面
   * @param shouldRefresh 是否刷新已存在的页面
   */
  async openTabManager(shouldRefresh: boolean = false): Promise<void> {
    const existingTabs = await this.getExistingTabManagerTabs();

    if (existingTabs.length > 0) {
      const tab = existingTabs[0];
      if (tab.id) {
        await chrome.tabs.update(tab.id, { active: true });
        if (shouldRefresh) {
          await chrome.tabs.reload(tab.id);
        }
      }
    } else {
      await chrome.tabs.create({ url: this.getExtensionUrl() });
    }
  }

  /**
   * 保存所有标签页
   *
   * @returns 成功时返回保存摘要（保存了多少、丢了多少固定标签），
   *          失败时返回 null。
   *
   * ── 2026-10-18：不许对没发生的事报成功 ───────────────────────────────
   * 本函数在「清洗后一个标签都不剩」（整窗都是内部页 / 危险 schema，或固定标签页
   * 开关关闭导致全被过滤）时弹一条通知然后 `return` —— 而调用方原先**不看返回值**，
   * `SAVE_ALL_TABS` 照样回 `success:true`，popup 的保存按钮就地显示「已保存」。
   * 用户看到「已保存」，实际列表里没有新会话（与 1.22.16 修掉的 saveCurrentTab
   * 是同一类缺陷：预检失败仍报成功）。
   *
   * ── 2026-10-20 审计 A-4：返回摘要而不只是 boolean ────────────────────
   * 「保存成功」不是全部事实：默认配置下固定标签页**既没保存也没关闭**，
   * 而通知只报成功的那一半。调用方（popup 按钮反馈）需要知道丢了多少，
   * 才能说出「已保存 12 个，另有 3 个固定标签未保存」。
   * 返回 boolean 时这些信息只能留在 SW 内部 —— popup 看不到，
   * 而 popup 的按钮反馈恰恰是用户盯着的那块屏幕。
   */
  async saveAllTabs(inputTabs?: chrome.tabs.Tab[]): Promise<SaveAllSummary | null> {
    try {
      let tabs = inputTabs ?? [];

      if (!inputTabs) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            tabs = await chrome.tabs.query({ currentWindow: true });
            break;
          } catch (error) {
            logWarn(`查询标签页失败，重试 ${attempt + 1}/3`, error);
            if (attempt === 2) {
              throw error;
            }
            await new Promise(resolve => setTimeout(resolve, 200));
          }
        }
      }

      const cache = cacheManager.getCache('storage');
      cache.delete('settings');
      // 本地保存路径：读失败降级为默认值即可（collectPinnedTabs 只是本地行为开关）。
      // 不能让一次瞬时存储错误把「保存全部标签」整条打死——那是为了一个只影响云端的
      // 隐患赔上本地保存功能，不成比例。见 storage.getSettingsForLocalUse 的分流理由。
      const settings = await storage.getSettingsForLocalUse();
      const collectPinnedTabs = settings.collectPinnedTabs ?? false;

      // ── 2026-10-20 审计 A-4：被丢弃的固定标签从不被提起 ────────────────
      // 默认配置下 collectPinnedTabs=false ⇒ 用户 pin 在窗口里的标签
      // **既不会被保存、也不会被关闭**，它们就那么留在原处。
      // 而成功通知只写「已将 N 个标签页保存为新会话」—— 用户 pin 了 3 个
      // 工作台，收到「已保存 12 个」，那 3 个去哪了？它们通常正是最重要的
      // 页面，而用户无从得知。这是「声明 ≠ 行为」的直接违反。
      //
      // 丢弃数必须**同时**出现在：① 系统通知；② 回给 popup 的结果里
      // （popup 的按钮反馈是用户真正盯着的那块屏幕）。
      const droppedPinnedCount = collectPinnedTabs
        ? 0
        : tabs.filter(tab => tab.pinned === true).length;

      const tabGroup = createTabGroupFromChromeTabs(tabs, {
        includePinned: collectPinnedTabs,
      });

      // URL 清洗（2026-10-05 起语义明确为「能不能存」）：拒绝 javascript:/
      // data:/vbscript: 这类危险 schema。注意 **file: / blob: 现在会通过**——
      // 它们能存进数据库（保存时用户确实打得开），只是在别的设备上未必打得开，
      // 那种情况由读取侧的 unopenable 标记 + 打开时的兜底提示处理。
      // 失败计数用日志告知，不污染 storage，也不打断保存流程。
      const sanitizedTabs: typeof tabGroup.tabs = [];
      let droppedTabs = 0;
      for (const t of tabGroup.tabs) {
        const url = sanitizeTabUrl(t.url);
        if (url) sanitizedTabs.push({ ...t, url });
        else droppedTabs++;
      }
      if (droppedTabs > 0) {
        logWarn(`[TabManager] 保存时丢弃 ${droppedTabs} 个危险 URL 标签`);
      }
      const safeGroup = { ...tabGroup, tabs: sanitizedTabs };

      if (safeGroup.tabs.length === 0) {
        await this.showNotification({
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: 'TapStack',
          message: '当前窗口里没有可保存的标签页',
          // **失败**（一个标签都没存下），不是「操作的一部分」：必须 'error'，
          // 否则默认关闭的「显示通知提醒」会把它整条吞掉 —— 用户按了快捷键、
          // 标签没保存、标签没关、屏幕上什么都不动，只能猜「没点上还是坏了」。
          // 同文件其余失败通知（内部页面/固定页开关/危险 URL）都是 'error'。
          kind: 'error',
        });
        // 一个标签都没存下 ⇒ 不是成功。调用方据此不得报「已保存」。
        return null;
      }

      // 单写者：读-改-写必须整体在队列内（只把读放进队列、写在队列外 =
      // 与其他 job 交错读改写，会丢刚写入的会话）。写走直写：SW 可随时被挂起，
      // 防抖窗口期内的保存会丢失；且 SW 内 mutation 已是直写，混用会互相覆盖。
      await enqueue('saveAllTabs', async () => {
        const existingGroups = await storage.getGroupsForWrite();
        const stamped: typeof safeGroup = { ...safeGroup, lastOp: await stampForNewEntity() };
        await storage.setGroupsImmediate(
          [stamped, ...existingGroups].sort(
            (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          )
        );
      }, { priority: 'high' });

      // ponytail: 自动上传承诺接入点。SW 保存路径完全绕过 Redux（直接 setGroups），
      // autoSyncMiddleware 永远监听不到 saveGroup.fulfilled——这里补上 scheduleUpload
      // 让"保存后自动同步云端"实际生效（未登录时 syncEngine 安全跳过）。
      // 第二个参数＝本次改动过的会话 id：WebDAV 归属待决期只允许上传这些，
      // 否则「保存一个标签页」会把全部历史会话推上用户的云盘（P1#4 第二半）。
      syncEngine.scheduleUpload(UPLOAD_DEBOUNCE_MS, [safeGroup.id]);

      await this.showNotification({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'TapStack',
        message: saveAllSuccessMessage({
          savedCount: safeGroup.tabs.length,
          droppedPinnedCount,
        })
      });

      await trackProductEvent('session_saved', {
        sessionId: safeGroup.id,
        sessionName: safeGroup.name,
        tabCount: safeGroup.tabs.length,
        pinnedCount: safeGroup.tabs.filter(tab => tab.pinned).length,
      });

      this.notifyTabManagerRefresh();

      const tabsToClose = filterValidTabs(tabs, {
        includePinned: collectPinnedTabs,
      });
      const tabIdsToClose = tabsToClose
        .map(tab => tab.id)
        .filter((id): id is number => id !== undefined);

      if (tabIdsToClose.length > 0) {
        try {
          await chrome.tabs.create({ url: 'chrome://newtab' });
          await chrome.tabs.remove(tabIdsToClose);
        } catch (error) {
          logWarn('关闭标签页时出错:', error);
        }
      }

      // 走到这里 = 会话已落盘（关标签失败只影响便利性，不影响保存本身）。
      return {
        savedCount: safeGroup.tabs.length,
        droppedPinnedCount,
      };

    } catch (error) {
      logError('保存标签页失败:', error);

      // 显示错误通知
      await this.showNotification({
        type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: 'TapStack - 保存失败',
          message: '保存标签页时发生错误，请重试',
          kind: 'error',
        });

      throw error;
    }
  }

  /**
   * 保存当前标签页
   *
   * @returns 是否**真的保存了**。
   *
   * ── 2026-10-09 专家团体检 P0：不许对没发生的事报成功 ──────────────────
   * 本函数有 3 条预检早退（内部页 / 固定页开关关闭 / URL 清洗后为空），
   * 每条都自己弹了失败通知然后 `return` —— 而调用方原先**不看返回值**，
   * 无条件再弹一条「当前标签页已保存」。用户于是连收两条互相矛盾的通知：
   *   ① 「无法保存此页面」  ② 「当前标签页已保存」
   * 这正是「预检失败但仍继续执行并报成功」。
   *
   * 现在返回 boolean：只有走到 `chrome.tabs.remove` 之后才算 true。
   * 调用方（快捷键 / 右键菜单）据此决定要不要发成功通知。
   * 失败通知仍由本函数在**判定失败的那一刻**发（原因更具体），
   * 调用方不得再补发一条泛化的成功文案。
   */
  async saveCurrentTab(tab: chrome.tabs.Tab): Promise<boolean> {
    logInfo('保存当前标签页:', tab.url);

    // 内部 URL 判定收敛到 domain/tabGroup/filters.isInternalUrl（唯一真相源）。
    // 原先这里内联了一份残缺列表（只认 chrome:// 与 chrome-extension://，
    // 漏了 edge:// 与 about:），与同文件上方 filterValidTabs 用的完整列表给出
    // 不同答案。改成引用后**可观测行为不变**——下方 createTabGroupFromChromeTabs
    // 内部先走 filterValidTabs → isValidTab → isInternalUrl，那两类页面在那里
    // 已经被丢弃。消除的是「同一判断两处不同答案」的隐患（下次往 filters 里加
    // 协议时旧代码会静默漏掉这条路径），不是修一个正在漏的数据 bug。
    // 注意这与后面的 sanitizeTabUrl 是两道正交的串联门：先按前缀滤掉自己的
    // 页面，再按协议滤掉危险地址。about: 是唯一被两表同时点名的协议
    // （这里拒、sanitizeTabUrl 放行），必须靠这道门挡住。
    if (!tab.url || isInternalUrl(tab.url)) {
      // 2026-10-07 P2（静默失败清单 #6）：原先直接 return，用户按了 Alt+S
      // 什么都没发生、连通知都没有 —— 与「按了键没反应」无法区分。
      await this.showNotification({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: '无法保存此页面',
        message: '浏览器内部页面（设置、扩展商店等）无法保存为会话',
        kind: 'error',
      });
      return false;
    }

    try {
      // 同 saveAllTabs：本地保存路径，读失败降级而非抛错
      const settings = await storage.getSettingsForLocalUse();
      const collectPinnedTabs = settings.collectPinnedTabs ?? false;

      if (!collectPinnedTabs && tab.pinned) {
        // 2026-10-07 P2（静默失败清单 #7）：原先静默 return，用户会以为
        // 快捷键坏了。固定标签页默认不保存是产品决定，但必须说出来。
        await this.showNotification({
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: '未保存固定标签页',
          message: '设置中未开启「保存固定标签页」，如需保存请在设置里开启',
          kind: 'error',
        });
        return false;
      }

      const tabGroup = createTabGroupFromChromeTabs([tab], {
        includePinned: collectPinnedTabs,
      });

      // URL 清洗（saveAllTabs 同语义，单标签版本）
      const sanitizedTabs: typeof tabGroup.tabs = [];
      for (const t of tabGroup.tabs) {
        const url = sanitizeTabUrl(t.url);
        if (url) sanitizedTabs.push({ ...t, url });
      }
      const safeGroup = { ...tabGroup, tabs: sanitizedTabs };

      if (safeGroup.tabs.length === 0) {
        // 2026-10-07 P2（静默失败清单 #8）：URL 清洗后全部被丢弃时，
        // 至少要告诉用户为什么没保存成。
        await this.showNotification({
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: '无法保存此页面',
          message: '此页面的地址无法安全保存（本地文件或危险协议）',
          kind: 'error',
        });
        return false;
      }

      // 单写者 + 盖印记：与 saveAllTabs 同一语义（原先连 enqueue 都没有，属丢更新路径）。
      // 写走直写，理由同 saveAllTabs（SW 挂起丢保存 + 与 mutation 直写混用覆盖）。
      await enqueue('saveCurrentTab', async () => {
        const existingGroups = await storage.getGroupsForWrite();
        const stamped: typeof safeGroup = { ...safeGroup, lastOp: await stampForNewEntity() };
        await storage.setGroupsImmediate([stamped, ...existingGroups]);
      }, { priority: 'high' });

      // ponytail: 关闭单标签时也会触发数据变更（保存到当前会话）——同样需自动上传。
      syncEngine.scheduleUpload(UPLOAD_DEBOUNCE_MS, [safeGroup.id]);

      await trackProductEvent('session_saved', {
        sessionId: safeGroup.id,
        sessionName: safeGroup.name,
        tabCount: safeGroup.tabs.length,
        pinnedCount: safeGroup.tabs.filter(item => item.pinned).length,
      });

      this.notifyTabManagerRefresh();

      if (tab.id) {
        await chrome.tabs.remove(tab.id);
      }
      return true;

    } catch (error) {
      logError('保存当前标签页失败:', error);
      throw error;
    }
  }

  /**
   * 打开单个标签页，保留标签管理器页面
   *
   * 2026-10-05：这里原本直接 `chrome.tabs.create({ url })`，而调用方
   * （popup 的 handleOpenTab）已在上游用 isOpenableTabUrl 判过；这里再加一道
   * 是为了**兜住所有其它调用路径**（恢复整窗、键盘快捷键、消息入口）。
   * 打不开时给用户一条明确通知，而不是静默失败或抛一个看不懂的错。
   */
  async openTab(url: string): Promise<void> {
    if (!isOpenableTabUrl(url)) {
      // 2026-10-05：日志只打 origin（见 faviconUtils 的同类说明）——
      // logWarn 直通生产 console，用户贴控制台截图就等于公开访问过的站点。
      // 通知文案里也只展示 origin：路径/查询串对「为什么打不开」这个判断没有增量，
      // 却可能带着 /internal/hr/salary 这样的路径。
      let origin = '(无法解析)';
      try {
        const u = new URL(url);
        origin = `${u.protocol}//${u.host}`;
      } catch {
        /* 保持占位 */
      }
      logWarn('[TabManager] 拒绝打开本设备无法导航的地址:', origin);
      await this.showNotification({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: '无法打开此标签',
        message: `「${origin}」是本机文件、临时链接或浏览器内部页面，无法在此设备上重新打开。该标签已保留在会话中。`,
        kind: 'error',
      });
      return;
    }
    try {
      const existingTabs = await this.getExistingTabManagerTabs();
      const tabManagerId = existingTabs.length > 0 ? existingTabs[0].id : null;

      await chrome.tabs.create({ url, active: false });

      if (tabManagerId) {
        await chrome.tabs.update(tabManagerId, { active: true });
      }

    } catch (error) {
      logError('打开标签页失败:', error);
      throw error;
    }
  }

  /**
   * 打开多个标签页，保留标签管理器页面
   */
  async openTabsInNewWindow(tabs: Array<{ url: string; pinned?: boolean }>): Promise<void> {
    try {
      if (tabs.length === 0) {
        return;
      }

      const [firstTab, ...remainingTabs] = tabs;
      const createdWindow = await chrome.windows.create({ url: firstTab.url, focused: true });
      const targetWindowId = createdWindow.id;
      const createdFirstTabId = createdWindow.tabs?.[0]?.id;

      if (!targetWindowId) {
        throw new Error('无法创建会话恢复窗口');
      }

      if (firstTab.pinned && createdFirstTabId) {
        await chrome.tabs.update(createdFirstTabId, { pinned: true });
      }

      await Promise.all(
        remainingTabs.map(tab =>
          chrome.tabs.create({
            windowId: targetWindowId,
            url: tab.url,
            active: false,
            pinned: tab.pinned,
          })
        )
      );

    } catch (error) {
      logError('在新窗口恢复会话失败:', error);
      throw error;
    }
  }

  /**
   * 在当前窗口打开多个标签页（保留已打开的标签，不新建窗口）
   */
  async openTabsInCurrentWindow(tabs: Array<{ url: string; pinned?: boolean }>): Promise<void> {
    try {
      if (tabs.length === 0) {
        return;
      }

      // 固定在当前窗口的最后一个标签页之后打开，避免打断当前浏览上下文
      const [currentTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const index = currentTab ? currentTab.index + 1 : undefined;

      const [firstTab, ...remainingTabs] = tabs;
      // 第一个标签激活，其余后台打开
      await chrome.tabs.create({ url: firstTab.url, active: true, pinned: !!firstTab.pinned, index });

      await Promise.all(
        remainingTabs.map(tab =>
          chrome.tabs.create({ url: tab.url, active: false, pinned: !!tab.pinned })
        )
      );
    } catch (error) {
      logError('在当前窗口恢复会话失败:', error);
      throw error;
    }
  }

  /**
   * 通知标签管理器页面刷新数据
   */
  private notifyTabManagerRefresh(): void {
    chrome.runtime.sendMessage({
      type: 'REFRESH_TAB_LIST',
      data: { timestamp: Date.now() }
    }).catch(() => {});
  }

  /**
   * 显示通知。
   *
   * ── 2026-10-17 接上「显示通知提醒」开关（此前是空接线）───────────────
   * 体检发现：全仓 7 处引用 `showNotifications` **零处读取**，15 个通知点
   * 无一检查设置 ⇒ 选项页把开关关掉，用户照样弹通知。这是一个**关于用户
   * 隐私的假陈述**，且是 2026-10-12 体检的 P1、连续三轮评审都没拦住。
   *
   * ── 为什么按 kind 分流，而不是一刀切读设置 ───────────────────────────
   * 这里有个必须守住的不变式：**失败通知不能被开关关掉**。2026-10-07 那一轮
   * 修的正是「静默失败清单」：原先 Alt+S 按了没反应、内部页面不保存、
   * URL 被清洗掉，全都直接 return，用户无从分辨「按了没反应」和「坏了」。
   * 若在这里统一按设置拦掉，等于把刚修好的静默失败重新装回去 ——
   * 「关掉通知」不该变成「操作失败但用户不知道」。
   *
   * 因此语义分三类：
   *   · kind: 'success' —— 例行确认（「已保存 N 个标签页」）。默认关，符合
   *     DEFAULT_SETTINGS.showNotifications = false，也符合多数人不要弹窗的偏好。
   *   · kind: 'info'    —— 用户**主动操作后**的即时反馈，但**不是失败**的那种。
   *     同样受设置控制。
   *   · kind: 'error'   —— 失败与异常。**永远发**，不受设置影响。
   *
   * ⚠️ 这一行原先把「快捷键失败、页面无法保存」举成 'info' 的例子，与本节开头
   * 「失败通知不能被开关关掉」直接冲突，于是「一个标签都没存下」（2026-10-18
   * round 24）与「没有其他标签页需要保存」两条真失败被默认关闭的开关静默吞掉，
   * 而设置页写着「失败提示不受此开关影响，始终会通知」。
   * 判据只有一条：**用户要求的动作没发生 ⇒ 'error'**。
   *
   * ⚠️ 未标注 kind 的调用点默认按 'success' 处理（即受设置控制）。
   * 这是刻意选的方向：新加的通知默认不该打扰用户；要「无论设置都发」必须
   * 显式写 kind: 'error'，让这个选择可见、可评审。
   */
  async showNotification(options: {
    type: 'basic';
    iconUrl: string;
    title: string;
    message: string;
    /**
     * 通知性质。决定是否受「显示通知提醒」开关约束：
     * 'success' / 'info' 受控；'error' 永远发（失败不能静默）。
     */
    kind?: 'success' | 'info' | 'error';
  }): Promise<void> {
    if (options.kind !== 'error') {
      try {
        const settings = await storage.getSettings();
        if (settings.showNotifications !== true) return;
      } catch (error) {
        // 读不到设置时**按开启处理**（发通知）：读失败不是用户的意图，
        // 而通知发不出去的后果远小于「本该告诉用户的失败没告诉」。
        // 与 storage.getSettings 自身的 fail-closed 方向相反且刻意：
        // 那条保护的是「别用默认值覆盖真实云端设置」，这里保护的是「别漏报失败」。
        logWarn('[TabManager] 读取通知设置失败，按开启处理:', error);
      }
    }
    try {
      await chrome.notifications.create({
        type: options.type,
        iconUrl: options.iconUrl,
        title: options.title,
        message: options.message
      });
    } catch (error) {
      logError('显示通知失败:', error);
    }
  }
}

// 导出单例实例
export const tabManager = TabManager.getInstance();
