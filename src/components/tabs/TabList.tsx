import React, { useEffect, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { loadGroups } from '@/store/slices/tabSlice';
import { invalidateGroupsCache, onGroupsChanged } from '@/utils/storage';
import { DraggableTabGroup } from '@/components/dnd/DraggableTabGroup';
import { SearchResultList } from '@/components/search/SearchResultList';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PersonalizedWelcome } from '@/components/common/PersonalizedWelcome';
import { toListErrorCopy } from './listErrorCopy';
import { getContextOrigin } from '@/core/contextOrigin';
import { logError } from '../../utils/log';

interface TabListProps {
  searchQuery: string;
}

export const TabList: React.FC<TabListProps> = ({ searchQuery }) => {
  const dispatch = useAppDispatch();
  const { groups, isLoading, error, errorSource } = useAppSelector(state => state.tabs);
  const { layoutMode } = useAppSelector(state => state.settings);
  // ── 2026-10-09 P1-4：空态主 CTA 不得 fire-and-forget ──────────────────
  // 这是**新用户第一屏**的主 CTA。原先 query 后直接 sendMessage、不 await、
  // 不看回包、无 loading、无禁点 —— SW 挂了或保存失败时界面零变化，
  // 用户只能猜「没点上」还是「坏了」。同一操作在 Header.tsx 已于 1.22.13 修好
  // （await + 转圈 + inline 成功/失败），唯独空态这条漏了。
  // 复用同一模式：在途禁点、回包决定成败、失败出声。
  const [isSavingFromEmpty, setIsSavingFromEmpty] = useState(false);
  const [emptySaveFeedback, setEmptySaveFeedback] = useState<
    { kind: 'success' | 'error'; text: string } | null
  >(null);

  // 成功是轻提示：3 秒后自动退场（不打扰）。
  // **失败不自动消失** —— 否则用户可能没看到，就永远不知道刚才那次没成功
  // （「失败要出声」要求它留在原地，直到下次点击或状态变化）。
  useEffect(() => {
    if (emptySaveFeedback?.kind !== 'success') return;
    const timer = setTimeout(() => setEmptySaveFeedback(null), 3000);
    return () => clearTimeout(timer);
  }, [emptySaveFeedback]);

  const handleSaveFromEmpty = async () => {
    if (isSavingFromEmpty) return;
    setIsSavingFromEmpty(true);
    setEmptySaveFeedback(null);
    try {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const windowId = tabs[0]?.windowId;
      const response = (await chrome.runtime.sendMessage({
        type: 'SAVE_ALL_TABS',
        data: { windowId },
      })) as { success?: boolean; error?: string } | undefined;
      // sendMessage 对 {success:false} 是 resolve 不是 reject —— 不查回包
      // 就是「保存失败了却什么都不说」，与本仓修掉的谎报成功同一类。
      if (response?.success) {
        setEmptySaveFeedback({ kind: 'success', text: '已保存' });
      } else {
        setEmptySaveFeedback({ kind: 'error', text: response?.error || '保存失败，请重试' });
      }
    } catch (saveError) {
      // sendMessage 在 SW 被回收 / 扩展重载时可能整体 reject
      logError('空态保存当前窗口失败:', saveError);
      setEmptySaveFeedback({ kind: 'error', text: '保存失败，请重试' });
    } finally {
      setIsSavingFromEmpty(false);
    }
  };

  useEffect(() => {
    const initializeData = async () => {
      try {
        // ── 2026-10-09 专家团体检 P0：迁移必须委托给 SW 单写者队列 ──
        //
        // 修复前这里直接 await runMigrations() —— 它内部三件（favicon 清洗、
        // 无墓碑清理、最近恢复历史）都是「全量读 → 改 → 写 groups」，在 **popup
        // realm** 执行，与 SW 的 mutation / sync:download 零互斥：
        // mutationQueue 的 pending/running 是模块级变量，popup 与 SW 各持一份
        // 队列实例，在 popup 里调 enqueue 也串行不了 SW 的写入。
        //
        // 结果是：t0 本页读快照 → t1 SW 刚保存的会话落盘 → t2 本页用 t0 整表
        // 写回 → 刚保存的会话当场消失（本地与云端一起丢，且 v1.22.0 无回收站）。
        //
        // 改走 RUN_MIGRATIONS 消息后，迁移与其它写在**同一条 SW 队列**内串行，
        // 与 importGroups 走 sendMutation 是同一条先例。失败仍如实抛错，
        // 由下面的 catch 落日志并照常 loadGroups（应用不能因迁移失败而打不开）。
        const res = (await chrome.runtime.sendMessage({ type: 'RUN_MIGRATIONS' })) as
          | { success?: boolean; error?: string }
          | undefined;
        // sendMessage 在 SW 回 {success:false} 时是**resolve 不是 reject** ——
        // 不检查回包就是「失败被静默通过」，与本仓修掉的谎报成功同一类。
        // 迁移失败不阻断加载（下面照常 loadGroups，应用必须能打开），
        // 但必须留下日志：否则「迁移没跑」与「迁移成功」在日志里完全同形。
        if (res && res.success === false) {
          throw new Error(res.error || 'SW 侧迁移失败');
        }
        dispatch(loadGroups());
      } catch (migrationError) {
        logError('初始化数据失败:', migrationError);
        dispatch(loadGroups());
      }
    };

    initializeData();

    // 刷新统一走这个 150ms 防抖出口：把「拖拽中连续 hover 触发的多次写盘回声」、
    // SW 的 REFRESH_TAB_LIST 合并成一次读取，避免同一帧内反复重载。
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleReload = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        dispatch(loadGroups());
      }, 150);
    };

    const messageListener = (message: { type?: string }) => {
      if (message.type === 'REFRESH_TAB_LIST') {
        invalidateGroupsCache();
        scheduleReload();
        // 只对**确实要处理**的消息返回 true。返回 true = 告诉 Chrome「我会稍后
        // 调 sendResponse」，于是发送方（SW 的 groupsChangedBus 广播）的 Promise
        // 会一直挂到本页面销毁为止——而本监听器从不调用 sendResponse。对无关消息
        // 也返回 true 会白白吊着对方的响应通道（1.22.11 修正）。
        return true;
      }
      return false;
    };

    chrome.runtime.onMessage.addListener(messageListener);

    const unsubscribe = onGroupsChanged(originId => {
      // 自己写出的回声：Redux 已是乐观更新后的新值，重载只会把列表打回存储态，
      // 拖拽时表现为整页刷新。缓存失效照旧（见 onGroupsChanged），其它上下文
      //（另一个窗口 / SW 后台写入 / 云端合并）的变更照常重载。
      if (originId === getContextOrigin()) return;
      scheduleReload();
    });

    return () => {
      chrome.runtime.onMessage.removeListener(messageListener);
      if (debounceTimer) clearTimeout(debounceTimer);
      unsubscribe();
    };
  }, [dispatch]);

  // 原始异常（PostgREST / message-port / chrome.storage 内部文本）只进日志，
  // 界面上给的是可行动文案——见 listErrorCopy。必须排在所有提前 return 之前，
  // 否则就是「条件 Hook」，渲染分支一变 hook 数量就变。
  //
  // state.error 是共享字段：loadGroups.rejected 与列表内写操作（删除/更新会话）的
  // rejected 都写它。不看 errorSource 一律打「加载会话列表失败」时，一次 removeTab
  // 30s 超时会被误报成加载失败（线上日志实锤），排障的人会往读路径上查——按来源分开。
  useEffect(() => {
    if (!error) return;
    if (errorSource === 'load') {
      logError('加载会话列表失败:', error);
    } else if (errorSource === 'action') {
      logError('列表内操作失败（非加载，如删除/更新会话）:', error);
    } else {
      logError('会话列表状态错误（来源未标注）:', error);
    }
  }, [error, errorSource]);

  const errorCopy = toListErrorCopy(error);

  // 只有「冷启动还没有任何数据」才整页 loading。
  // 后台刷新（onGroupsChanged / REFRESH_TAB_LIST）也会把 isLoading 置真，
  // 若照旧整页替换，拖拽/同步每次落盘都会闪一次全屏 spinner——即用户看到的
  // 「整个标签管理器页面都刷新了」。有数据时让刷新静默进行。
  if (isLoading && groups.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  // 同理：已有数据时后台刷新失败不该把列表整页换成错误页，日志照旧（见上 error effect）。
  if (error && groups.length === 0) {
    return (
      <EmptyState
        tone="warning"
        title={errorCopy.title}
        description={errorCopy.description}
        action={
          <button
            type="button"
            onClick={() => {
              dispatch(loadGroups());
            }}
            className="rounded-2xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            重新加载
          </button>
        }
        className="min-h-[16rem] flex flex-col justify-center"
      />
    );
  }

  const sortedGroups = [...groups].sort((left, right) => {
    return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  });

  const filteredGroups = sortedGroups;
  const totalTabCount = filteredGroups.reduce((count, group) => count + group.tabs.length, 0);

  if (filteredGroups.length === 0 && !searchQuery) {
    return (
      <div className="space-y-4">
        <PersonalizedWelcome tabCount={totalTabCount} className="flat-card p-6" />
        <div className="flat-card p-6">
          <EmptyState
            tone="default"
            title="先保存一个工作会话"
            // 指代修正：空态自己就有这个按钮，原文案却指「右上角」，
            // 用户会不确定该点哪个。（保存是否会关闭标签属 P1-1 定位决策，
            // 那条待负责人拍板，此处只修指代，不改承诺。）
            // 2026-10-09 P1-1：定位不变（保存 = 剪切），但新用户第一屏的 CTA
            // 必须在动手前把「标签会被关闭」说出来 —— 不能等它关了才发现。
            description="点击下方按钮，把当前窗口保存成可稍后找回的工作会话；当前标签随后会被关闭。"
            action={
              <div className="flex flex-col items-center gap-2">
                <button
                  type="button"
                  onClick={handleSaveFromEmpty}
                  disabled={isSavingFromEmpty}
                  className="px-6 py-2 text-sm font-medium flat-button-primary flat-interaction disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isSavingFromEmpty ? '保存中…' : '保存当前窗口'}
                </button>
                {/* 成功 3 秒后消失（见上方 useEffect）；失败常驻到下次操作 */}
                {emptySaveFeedback && (
                  <p
                    role={emptySaveFeedback.kind === 'error' ? 'alert' : 'status'}
                    className={
                      emptySaveFeedback.kind === 'error'
                        ? 'text-sm text-red-600 dark:text-red-400'
                        : 'text-sm text-green-700 dark:text-green-400'
                    }
                  >
                    {emptySaveFeedback.text}
                  </p>
                )}
              </div>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 micro-interaction-container">
      {/* ── 2026-10-09 P1-9：已有数据时的后台刷新失败必须出声 ─────────────
       * 下面的错误页只覆盖 `error && groups.length === 0`（冷启动无数据）。
       * 而**列表里已经有数据**时再发生一次 loadGroups 失败，原先完全没有任何
       * 可见出口 —— 界面继续显示旧列表，只有 console 里一行日志。用户不知道
       * 「自己正在看的是上次的数据」，更不知道刚才刷新失败了。
       *
       * 为什么不改成整页错误页：那正是上面注释论证过、必须避免的行为
       * （后台刷新会闪掉整个页面，拖拽/同步每次落盘都全屏跳一次）。
       * 所以保留列表 + 补一条**非阻塞**提示 —— 减法减的是常驻界面，
       * 不是减掉失败反馈。
       *
       * 为什么必须判 errorSource === 'load'：error 是共享字段，列表内写操作
       *（删除/更新会话）的 rejected 也写它。不分开判的话，一次 removeTab
       * 30s 超时会被误报成「加载失败」，排障的人会往读路径上查（线上日志实锤）。
       */}
      {error && errorSource === 'load' && groups.length > 0 && (
        <div
          role="alert"
          className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm dark:border-amber-700 dark:bg-amber-950/40"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-amber-900 dark:text-amber-200">
              <strong className="font-medium">{errorCopy.title}</strong>
              <span className="ml-1.5 text-amber-800 dark:text-amber-300">
                当前显示的是上次读到的会话。
              </span>
            </span>
            <button
              type="button"
              onClick={() => dispatch(loadGroups())}
              className="rounded-lg border border-amber-400 px-3 py-1 text-xs font-medium text-amber-900 transition hover:bg-amber-100 dark:border-amber-700 dark:text-amber-100 dark:hover:bg-amber-900/60"
            >
              重新加载
            </button>
          </div>
          <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
            {errorCopy.description}
          </p>
        </div>
      )}

      {searchQuery ? (
        <SearchResultList searchQuery={searchQuery} />
      ) : layoutMode === 'double' ? (
        <div className="grid grid-cols-1 sm:grid-cols-1 md:grid-cols-2 gap-2 sm:gap-3 md:gap-4">
          {(() => {
            // 按次序左右对分：前半进左栏、后半进右栏，读序与单栏一致。
            // 历史实现用奇偶交替（index % 2），导致阅读顺序错乱（1,3,5… 后 2,4,6…），
            // 且总数为奇数时左栏恒好多出一个——用户观感就是「左边多一个、右边不匀」。
            // 奇数时把多出的一项放左栏：左栏是读序起点，视觉与语义都更自然。
            const mid = Math.ceil(filteredGroups.length / 2);
            const columns = [filteredGroups.slice(0, mid), filteredGroups.slice(mid)];
            return columns.map((column, columnIndex) => (
              <div key={columnIndex} className="space-y-2 transition-all duration-300 ease-out">
                {column.map(group => (
                  <DraggableTabGroup key={group.id} group={group} />
                ))}
              </div>
            ));
          })()}
        </div>
      ) : (
        <div className="space-y-2 transition-all duration-300 ease-out">
          {filteredGroups.map(group => (
            <DraggableTabGroup key={group.id} group={group} />
          ))}
        </div>
      )}
    </div>
  );
};

export default TabList;
