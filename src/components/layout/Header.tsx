import React, { useState, useTransition, useRef, useLayoutEffect, useCallback } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import {
  toggleLayoutMode,
  dispatchSaveSettings,
  updateSettings,
} from '@/store/slices/settingsSlice';
import { cleanDuplicateTabs, deleteBroadcastWarn, deleteTabAndSync } from '@/store/slices/tabSlice';
import { HeaderDropdown } from './HeaderDropdown';
import { buildRandomPickPool, pickRandomCandidate } from './randomPickPool';
import { mutationErrorMessage } from '@/components/tabs/mutationErrorCopy';
import { toServiceWorkerErrorCopy } from '@/utils/serviceWorkerErrorCopy';
import type { SearchFilters } from '@/utils/search';
import { AuthTab } from '@/components/auth/AuthModal';
import { useToast } from '@/contexts/ToastContext';
import { useEnhancedToast } from '@/utils/toastHelper';
import { TabCounter } from './TabCounter';
import SyncButton from '@/components/sync/SyncButton';
import { SimpleThemeToggle } from './SimpleThemeToggle';
import { LayoutMode } from '@/types/tab';
import { useDebouncedSearch } from '@/hooks/useDebouncedSearch';
import { Tooltip } from '@/components/common/Tooltip';
import { TapStackLogo } from '@/components/common/TapStackIcon';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { cleanDuplicatesConfirmMessage, cleanDuplicatesResultMessage } from './cleanDuplicatesMessage';
import { saveAndCloseDescription, saveAndCloseLabel, saveAndCloseShortLabel } from './saveActionCopy';
import { isBrandContentClipped } from './brandLayout';
import { onImportRequest } from './importRequest';
import {
  saveAllSuccessMessage,
  saveAllSuccessShortMessage,
} from '@/domain/tabGroup/saveFeedbackCopy';
import { planCleanDuplicates } from '@/core/mutationOps';
import { decideFeedback } from '@/core/feedbackPolicy';
import { storage } from '@/utils/storage';
import { logError } from '../../utils/log';

// 骰子抽签池的默认筛选（没传时用同一份常量，不每次渲染生成新对象）。
const EMPTY_FILTERS: SearchFilters = {};

interface HeaderProps {
  onSearch: (query: string) => void;
  /**
   * 重放用户引导（2026-10-20 审计 B-2）。
   *
   * 引导是一次性的：跳过后回不去，而用户跳过的常见理由是「现在没空」。
   * 菜单里给了「使用引导」一个入口，重放的是**同一套** OnboardingGuide
   * （不复制一份内容），走完照常记完成状态。
   */
  onReplayOnboarding?: () => void;
  /**
   * 打开登录 / 注册弹窗（2026-10-22 审计 L-11）。
   *
   * 弹窗原本寄生在 Header 里（`<AuthModal>` 在 header 末尾），
   * 于是**只有顶栏这一个地方能开它**。而空态（一个会话都没有）
   * 需要给「登录 TapStack 云端」一个出口 ——
   * 换设备的老用户打开扩展看到的是一片空白，
   * 他最该做的那一步（登录 → 自动拉回云端会话）当时无处可点。
   *
   * 所以把弹窗**提升到 MainApp**：Header 与空态共用同一个实例，
   * 不会出现两个 portal、两个焦点陷阱。
   */
  onOpenAuth: (tab: AuthTab) => void;
  /**
   * 清空筛选条件（2026-10-22 审计 P1-8）。
   *
   * 品牌盒那一下的承诺是「回到默认视图」——而「默认视图」= 无搜索词 **且**
   * 无筛选条件。修复前它只清搜索词：用户只靠筛选（没输过关键词）时点它，
   * setSearchValue('') 写回本来就是 '' 的值 ⇒ React bail out ⇒ 零变化，
   * 按钮看起来像坏了。
   *
   * 筛选状态住在应用层（MainApp 持有，见 useSearchFilters），
   * 所以顶栏能直接把它一起清掉。
   */
  onResetFilters?: () => void;
  /**
   * 骰子（随机打开一个标签）的抽签依据（2026-10-30）。
   *
   * 骰子按钮在顶栏，但「随机打开**下面**的其中一个」的承诺是所见即所得：
   * 抽签池必须等于列表页此刻渲染的那一批（搜索词 + 生效筛选）。
   * 搜索词与筛选状态住在 MainApp（`useSearchFilters` + deferred 搜索词），
   * 所以由它下发，顶栏不另起一份。
   */
  searchQuery?: string;
  effectiveFilters?: SearchFilters;
  hasActiveFilters?: boolean;
}

// 图标组件
const LoadingIcon = () => (
  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
  </svg>
);

const CloseIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
  </svg>
);

// ── 2026-10-24：顶栏回到 v1.25.1 的样子 ────────────────────────────────
//
// 产品负责人定案：「界面与交互回到 v1.25.1 的样子」。
// v1.25.1 的顶栏是**四颗图标按钮**（布局 / 清理 / 主题 / ⋯），
// 1.26.0（审计 U-20）把前两颗收进了 ⋯ 菜单，顶栏因此少了两颗按钮、
// 搜索框变宽 —— 那是**长相**（按钮的排布），不是功能。
// ⇒ 这两颗按钮**回到顶栏**（sm 以上显示），功能一条不少：
//   · 布局切换：点一下还是同一份 dispatch（handleToggleLayout 未变）；
//   · 清理重复：还是同一个破坏性确认流程（handleCleanDuplicateTabs 未变）。
// 菜单里的同名入口**保留**（窄屏补偿，见 HeaderDropdown.tsx）。
//
// ⚠️ 布局切换 / 清理重复**都不许从顶栏消失**——它们是 v1.25.1 顶栏的一部分。
// 守卫见 tests/guards/headerActionBudget.test.ts（判据已改成 v1.25.1 的口径）。
//
// 2026-10-30 增补：产品负责人在这一组里加了第三颗 —— 骰子（随机打开一个标签）。
// 顶栏因此由四颗变成五颗；上面两条不变式（**任何宽度都摸得到**）对骰子同样成立。

// 单栏：一个整框（换掉旧的三横线——和菜单图标撞形）
const LayoutSingleIcon = () => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <rect x="3.75" y="5.25" width="16.5" height="13.5" rx="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// 双栏：整框 + 中缝
const LayoutDoubleIcon = () => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <rect x="3.75" y="5.25" width="16.5" height="13.5" rx="1.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M12 5.25v13.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const CleanIcon = () => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
  </svg>
);

// 骰子：随机打开一条（2026-10-30）。点阵画法 —— 五点在框内，
// 与农夫山泉式的「随机」直觉一致，也与顶栏其它图标同为描边风格。
const DiceIcon = () => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <rect x="3.75" y="3.75" width="16.5" height="16.5" rx="3" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="8.25" cy="8.25" r="1" fill="currentColor" stroke="none" />
    <circle cx="15.75" cy="8.25" r="1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="8.25" cy="15.75" r="1" fill="currentColor" stroke="none" />
    <circle cx="15.75" cy="15.75" r="1" fill="currentColor" stroke="none" />
  </svg>
);

const MenuIcon = () => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 12.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 18.75a.75.75 0 110-1.5.75.75 0 010 1.5z" />
  </svg>
);

const SaveIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
  </svg>
);

export const Header: React.FC<HeaderProps> = ({
  onSearch,
  onReplayOnboarding,
  onOpenAuth,
  onResetFilters,
  searchQuery = '',
  effectiveFilters = EMPTY_FILTERS,
  hasActiveFilters = false,
}) => {
  const dispatch = useAppDispatch();
  const { showConfirm, showAlert, showToast } = useToast();
  const { showRestoreError, showDeleteError } = useEnhancedToast();
  const settings = useAppSelector(state => state.settings);
  const groups = useAppSelector(state => state.tabs.groups);
  // 清理重复标签的进行中标志：只用来禁点 + 转圈，不阻塞界面。
  const [isCleaningDuplicates, setIsCleaningDuplicates] = React.useState(false);
  // 骰子的在途标志：同一时间只抽一次（连点会开出多个浏览器标签，
  // 而 SW 的 OPEN_TAB 不做去重）。
  const [isRandomPickBusy, setIsRandomPickBusy] = React.useState(false);

  const { searchValue, debouncedValue, handleSearchChange, clearSearch, isSearching } = useDebouncedSearch();
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const [isSearchTransitionPending, startSearchTransition] = useTransition();

  const handleCleanDuplicateTabs = async () => {
    if (isCleaningDuplicates) return;
    // ── 2026-10-19：确认前算真实波及范围 ─────────────────────────────────
    // 五个破坏性动作里，只有清理重复标签此前是「不告诉你会删掉多少」就让你点确认。
    // 而 1.22.0 起删除即物理清除、无回收站 —— 同意的那一刻看不到范围。
    //
    // 计数用 planCleanDuplicates（纯函数）：SW 执行时用的是**同一份**判据
    // （mutationHandlers → applyCleanDuplicates → planCleanDuplicates），
    // 所以这里的数字就是真实会发生的，不是估算。
    //
    // 输入取 storage 真值而不是 Redux：Redux 可能落后于磁盘（外部写入 /
    // 尚未回环），而确认框报错数字比不报更糟。
    //
    // ── 2026-10-22 审计 DS-7：读失败必须**中止**，不能退回快照 ──────────────
    // 修复前读失败会退回 Redux 快照，于是确认框里的数字与**实际删除量**
    // 可能对不上（执行侧读的是真值）。更糟的变体：读失败**且**快照为空 ⇒
    // 「本次预计清除 0 个」⇒ 连确认框都不弹，只说一句「无需清理」——
    // 用户以为无事发生，而真值里其实有 12 个重复标签页。
    //
    // 破坏性路径上的读路径必须 fail-closed：读不到真值就不动手。
    let localGroups: typeof groups;
    try {
      localGroups = await storage.getGroupsForWrite();
    } catch (error) {
      logError('[Header] 清理前读取真实会话失败，已取消清理:', error);
      showToast('暂时读不到真实会话，已取消清理，请稍后重试', 'error');
      return;
    }
    const plan = planCleanDuplicates(localGroups);

    // 没东西可清时不该摆一道「确认清理」的破坏性弹窗：让用户点一次「确认清理」
    // 才告诉他其实什么都没删，与「点了没反应」同类。直接说清即可。
    if (plan.removedTabsCount === 0 && plan.removedGroupsCount === 0) {
      showToast(cleanDuplicatesConfirmMessage(0, 0), 'info', 4000);
      return;
    }

    showConfirm({
      title: '确认清理重复标签和空会话',
      message: cleanDuplicatesConfirmMessage(plan.removedTabsCount, plan.removedGroupsCount),
      // ── 2026-10-19 审计 V-5：这个动作是不可撤销的删除，确认按钮必须是 danger ──
      // 确认文案里已经明写「此操作无法撤销」，而按钮却是 warning 琥珀色
      // （bg-amber-700）—— 与「删除所有会话」的 rose 红不是同一套语言。
      // 用户会把琥珀读成「提醒一下」而不是「要真删」。
      // 破坏性动作的按钮语言必须与它的后果一致：不可撤销 ⇒ danger。
      type: 'danger',
      confirmText: '确认清理',
      cancelText: '取消',
      // 不要在确认弹窗里等清理跑完：大批量去重 + 成百上千条删除广播登记会有可见
      // 耗时，挂着弹窗转圈就是用户说的「卡住」。确认即关窗，清理在后台进行，
      // 完成时列表由 Redux 自然更新并报出清理结果；失败再弹提示。
      onConfirm: () => {
        void (async () => {
          setIsCleaningDuplicates(true);
          // ── 2026-10-22 审计 U-20 之后的接线：进行中必须看得见 ──────────
          // 入口搬进 ⋯ 菜单后，确认弹窗一关，界面上就**没有任何东西**
          // 表示「清理正在跑」——大批量去重 + 上千条删除广播登记有可见耗时，
          // 用户会以为点了没反应。结果提示要等它跑完才出现。
          // 一条「正在清理…」把这段空窗填上。
          showToast('正在清理重复标签和空会话…', 'info', 2000);
          try {
            const result = await dispatch(cleanDuplicateTabs()).unwrap();
            // 清理是有成效的操作，但**结果不是界面能说出来的** ——
            // 列表只是变短了，「清了几个重复标签、几个空会话」界面永远表达不了；
            // 而且这是**破坏性**操作，确认框里写的是「预计」，实到多少要实说。
            //
            // 计数取自 SW 回传的权威计划，而不是本地乐观算出的那份：popup 的
            // state.groups 可能陈旧，本地计数会与实际落盘结果不符（见 tabSlice
            // 的 cleanDuplicateTabs 注释）。列表更新在 pending 阶段就已经发生了。
            //
            // 「说不说」由判据层裁决（decideFeedback），不在这里拍脑袋。
            const cleanResult = cleanDuplicatesResultMessage(
              result.value.plan.removedTabsCount,
              result.value.plan.removedGroupsCount,
            );
            const fb = decideFeedback({
              visibility: 'self-evident',
              hiddenFact: cleanResult,
            });
            if (fb.level !== 'silent') {
              showToast(cleanResult, 'info', 4000);
            }
            // 清理会物理移除整组（空会话）。本地已删干净，但若云端删除广播
            // 登记失败，这些会话会在其它设备上复活——必须如实告知，不能让
            // 「清理成功」那句结果提示盖过去。
            const warn = deleteBroadcastWarn(result);
            if (warn) {
              showAlert({
                title: '清理未完全同步',
                message: warn,
                type: 'warning',
                onClose: () => { },
              });
            }
          } catch (error) {
            logError('清理重复标签失败:', error);
            showAlert({
              title: '清理失败',
              message: '清理重复标签失败，请重试',
              type: 'error',
              onClose: () => { },
            });
          } finally {
            setIsCleaningDuplicates(false);
          }
        })();
      },
      onCancel: () => { },
    });
  };

  // ── 2026-10-30：骰子 = 随机打开下面列表里的一条 ──────────────────────
  //
  // 抽签池与列表页走同一条管线（`AdvancedSearch` / `buildBrowseResults` +
  // `applySearchFilters`，见 ./randomPickPool 的文件头）—— 抽到的恒是
  // 用户此刻**看得见**的那一批里的，且池子已剔掉本设备打不开的地址
  // 与锁定会话（抽中它们只会「点了没反应」或「开了但记录还在」）。
  //
  // ⚠️ 池子**在点击时才算**，不放在 useMemo 里。搜索是全仓最重的计算
  //    （2026-10-23 真机实测：8000 标签搜宽泛词 1250ms），而本组件每敲一个
  //    字符都会重渲染 —— 挂个 memo 等于让**每一次搜索**都多跑一遍全文检索，
  //    哪怕用户一次都没点过骰子。点击时算一次，代价只落在真的用它的人身上。
  //
  // 打开与消费走与「点开一行」**完全相同**的路径：
  //   · 发 OPEN_TAB（SW 侧用 isOpenableTabUrl 把门，见 openUrlGateConsistency）；
  //   · **回包 success:true 才删**（与 TabGroup / SearchResultList 同一道成功门：
  //     SW 拒开是 sendResponse({success:false}) ⇒ promise **resolve**，
  //     不看回包就会「开了没看到页面，记录也没了」）；
  //   · 成功**静默**（标签已经开在浏览器里，这行从列表消失 ⇒ 界面自明）。
  const handleRandomPick = () => {
    if (isRandomPickBusy) return;
    const pool = buildRandomPickPool(groups, {
      query: searchQuery,
      filters: effectiveFilters,
      hasActiveFilters,
    });
    const pick = pickRandomCandidate(pool);
    if (!pick) {
      // 空池必须出声：按了键没反应 = 「界面坏了」。
      // 说清是**池子空了**而不是「随机失败」——后者会让用户一直点。
      showToast(
        searchQuery.trim() || hasActiveFilters
          ? '当前搜索结果里没有可随机打开的标签页'
          : '没有可随机打开的标签页',
        'info',
        3000
      );
      return;
    }
    setIsRandomPickBusy(true);
    chrome.runtime.sendMessage(
      { type: 'OPEN_TAB', data: { url: pick.tab.url, pinned: !!pick.tab.pinned } },
      (res: unknown) => {
        setIsRandomPickBusy(false);
        const r = res as { success?: boolean; error?: string } | undefined;
        if (!r || r.success !== true) {
          // 与点开单独一行同口径：拒开不删，那条记录还在会话里。
          showRestoreError(toServiceWorkerErrorCopy(r?.error, '打开失败，已保留在会话中'));
          return;
        }
        dispatch(deleteTabAndSync({ groupId: pick.group.id, tabId: pick.tab.id }))
          .unwrap()
          .then(payload => {
            const warn = deleteBroadcastWarn(payload);
            if (warn) showDeleteError(warn);
          })
          .catch(error => {
            logError('随机打开后从会话移除失败:', error);
            showDeleteError(mutationErrorMessage('标签页已打开，但从会话移除', error));
          });
      }
    );
  };

  // async：末尾要 await 保存结果并出声（React 对事件处理器返回 Promise 无要求）
  const handleToggleLayout = async () => {
    dispatch(toggleLayoutMode());

    let nextLayoutMode: LayoutMode;
    switch (settings.layoutMode) {
      case 'single':
        nextLayoutMode = 'double';
        break;
      case 'double':
        nextLayoutMode = 'single';
        break;
      default:
        nextLayoutMode = 'single';
    }

    // 先更新 Redux state
    dispatch(updateSettings({
      layoutMode: nextLayoutMode,
    }));
    
    // 然后保存到存储；失败必须出声（否则开关保持新状态、刷新后回退，全程无声）
    const saveError = await dispatchSaveSettings(dispatch);
    if (saveError) showToast(saveError, 'error');
  };

  const handleSaveAllTabs = async () => {
    // 2026-10-07 专家团体检 P1-3：原先只 sendMessage 不 await、不处理回包，
    // 于是整个保存主流程在页内零反馈 —— 用户点了之后眼前一空（当前窗口标签被
    // 全部关掉、另开一个标签页），无法判断是保存了、崩了、还是页面跳转了。
    // 唯一的反馈是一条系统通知，而通知在部分系统上会被专注助手吞掉。
    //
    // 项目自己的原则是「用户按了键没反应必须有一句话解释」，这条正是它的反例。
    // 现在：await 回包 + 按钮 inline 反馈 + 失败时明确出声。
    if (isSaving) return;
    setIsSaving(true);
    setSaveFeedback(null);
    try {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const windowId = tabs[0]?.windowId;
      const response = (await chrome.runtime.sendMessage({
        type: 'SAVE_ALL_TABS',
        data: { windowId },
      })) as
        | { success?: boolean; error?: string; savedCount?: number; droppedPinnedCount?: number }
        | undefined;
      if (response?.success) {
        // ── 2026-10-20 审计 A-4：成功文案要说出「没保存什么」─────────────
        // 固定标签页开关关闭时，那些标签既没保存也没关闭，只剩它们还在原地。
        // 按钮反馈是用户此刻唯一盯着的地方，不说 = 用户以为全存了。
        const summary = {
          savedCount: response.savedCount ?? 0,
          droppedPinnedCount: response.droppedPinnedCount ?? 0,
        };
        setSaveFeedback({
          kind: 'success',
          text: saveAllSuccessShortMessage(summary),
          shortText: saveAllSuccessShortMessage(summary),
          fullText: saveAllSuccessMessage(summary),
        });
      } else {
        const message = response?.error || '保存失败，请重试';
        setSaveFeedback({
          kind: 'error',
          text: message,
        });
        // ── 2026-10-22 审计 P1-4：失败必须**在每个宽度下**看得见 ──────────
        // 错误文案原先只渲染在 `hidden sm:inline` 的 span 里 ⇒ 窄屏上
        // 「保存失败」四个字**整个被 CSS 藏了**：按钮文案不变、没有 toast、
        // 页面里搜不到失败字样 ⇒ 用户看到的是「点了完全没反应」。
        // 这违反契约 ①「用户按了键没反应必须有一句话解释」，而且是在
        // **最需要解释**的时候（保存失败）。
        // ⇒ 失败一律走 toast：它不受断点影响，读屏也会播报。
        showToast(message, 'error', 4000);
      }
    } catch (error) {
      // sendMessage 在 SW 被回收 / 扩展重载时可能整体 reject
      logError('保存会话失败:', error);
      setSaveFeedback({ kind: 'error', text: '保存失败，请重试' });
      showToast('保存失败，请重试', 'error', 4000);
    } finally {
      setIsSaving(false);
    }
  };

  const getContainerWidthClass = () => {
    // 统一使用相同宽度，单栏和双栏布局保持一致
    return 'layout-double-width';
  };

  React.useEffect(() => {
    startSearchTransition(() => {
      onSearch(debouncedValue);
    });
  }, [debouncedValue, onSearch]);

  const isSearchBusy = isSearching || isSearchTransitionPending;

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleSearchChange(e.target.value);
  };

  const handleClearSearch = () => {
    clearSearch();
  };

  const handleResetToDefaultView = () => {
    clearSearch();
    // 「回到默认视图」= 无搜索词 **且** 无筛选条件（2026-10-22 审计 P1-8）。
    onResetFilters?.();
  };

  const [showDropdown, setShowDropdown] = useState(false);

  // 保存按钮的 in-flight 与结果反馈（2026-10-07 P1-3）。
  // 保存是本页唯一会「摧毁用户当前工作现场」的动作（关掉整个窗口的标签），
  // 必须让用户看得见结果 —— 哪怕标签已经关掉了。
  // 成功轻提示 3s 自动退场，失败常驻到下次操作（与 TabList 空态 CTA 同口径）。
  const [isSaving, setIsSaving] = useState(false);
  // 成功反馈有长短两版（2026-10-20 审计 A-4）：
  //   · shortText —— 按钮里显示（宽度有限）
  //   · fullText  —— 悬停/读屏看到的完整说明（说清「什么没保存」）
  const [saveFeedback, setSaveFeedback] = useState<{
    kind: 'success' | 'error';
    text: string;
    shortText?: string;
    fullText?: string;
  } | null>(null);
  // 账号弹窗是应用级关注点：portal 到 body，由 MainApp 持有
  // （2026-10-22 审计 L-11：提升到 MainApp，好让空态也能开它）。
  // 不随菜单开关而卸载（菜单点完就关，弹窗独立存活）。
  const [pendingImport, setPendingImport] = useState(false);

  // 「打开导入」的请求总线（2026-10-22 审计 L-11）：
  // 空态的「导入数据」按钮把意图送到这里，由 Header 打开下拉菜单并展开
  // 导入子菜单 —— 真正的导入实现在 HeaderDropdown 里（一份，不复制）。
  React.useEffect(() => {
    return onImportRequest(() => {
      setPendingImport(true);
      setShowDropdown(true);
    });
  }, []);

  const handleOpenAuth = (tab: AuthTab) => {
    setShowDropdown(false);
    onOpenAuth(tab);
  };

  // 下拉菜单挂载后会把「展开哪个子菜单」这件事消费掉（initialSubmenu 只在挂载时读一次）。
  // 消费完就要把待办清掉，否则**下次打开菜单**还会自动展开导入子菜单 ——
  // 用户明明只是想看看菜单，却每次都被甩进导入区。
  const handleInitialSubmenuConsumed = useCallback(() => {
    setPendingImport(false);
  }, []);

  // 成功是轻提示：3 秒后自动退场；失败常驻到下次保存（与空态 CTA 同口径）
  React.useEffect(() => {
    if (saveFeedback?.kind !== 'success') return;
    const timer = setTimeout(() => setSaveFeedback(null), 3000);
    return () => clearTimeout(timer);
  }, [saveFeedback]);

  // ── 2026-10-20 几何修复：品牌名要么完整可见，要么完全消失 ──────────────
  //
  // CSS 侧的降级阈值（`@media (max-width: 420px)`）只能覆盖**量过的宽度**：
  // 滚动条 gutter 的宽度因平台而异（macOS 8px / Windows 15–17px），
  // 字体缩放、系统字号也会改品牌名的宽度。凡是「差一点点放不下」的宽度，
  // 都会退化成「TapSta」—— 用户看到半个词，**没有任何提示**。
  //
  // 所以再加一道运行期兜底：直接量「品牌名的右边界」有没有越过
  // 「品牌盒的右边界」。越过了就把名字整体隐藏（visibility: hidden，
  // 不占位也不参与命中测试）⇒ 只剩图标，绝不出现半个字。
  //
  // 用 useLayoutEffect：判定必须在绘制前完成，否则会闪一帧「TapSta」。
  const brandRef = useRef<HTMLButtonElement>(null);
  const [brandNameClipped, setBrandNameClipped] = useState(false);

  useLayoutEffect(() => {
    const el = brandRef.current;
    if (!el) return;
    const check = () => {
      const name = el.querySelector<HTMLElement>('.app-header-brand-name');
      if (!name) {
        setBrandNameClipped(false);
        return;
      }
      // CSS 已经降级成「只留图标」时，名字没有盒子，运行期不用再管。
      if (getComputedStyle(name).display === 'none') {
        setBrandNameClipped(false);
        return;
      }
      setBrandNameClipped(
        isBrandContentClipped(
          name.getBoundingClientRect().right,
          el.getBoundingClientRect().right
        )
      );
    };
    check();
    // 品牌盒的宽度一变（窗口缩放、滚动条出现、操作区变宽）就要重量一次。
    const observer = new ResizeObserver(check);
    observer.observe(el);
    const grid = el.closest('.app-header-grid');
    if (grid) observer.observe(grid);
    return () => observer.disconnect();
  }, []);

  return (
    <header className="header">
      <div className={`w-full py-2.5 sm:py-3 px-3 sm:px-6 ${getContainerWidthClass()}`}>
        <div className="app-header-grid">
          {/* Logo 区域 */}
          <button
            ref={brandRef}
            onClick={handleResetToDefaultView}
            className="app-header-brand flex items-center gap-2 sm:gap-3 group flat-interaction min-w-0"
            title="回到默认视图"
            aria-label="回到默认视图"
          >
            <span className="flex-shrink-0">
              <TapStackLogo
                size="sm"
                showIcon={true}
                // 被裁掉时整体隐藏（不是省略号、不是半个字）—— 判据见 brandLayout.ts
                nameClassName={`app-header-brand-name${brandNameClipped ? ' invisible' : ''}`}
              />
            </span>
            <div className="app-header-brand-meta hidden sm:block">
              <TabCounter />
            </div>
          </button>

          {/* 搜索框：图标位常驻占位，spinner 原位替换，避免输入中 pl-3→pl-10 整行跳动 */}
          {/* data-tooltip-avoid：顶栏提示条不得压住搜索框 ——
              两行顶栏（≤1024px）里搜索框就在操作区下一行，提示条向下弹
              必然压上去（实测 400px 下盖住 34.4%、700px 下 17.5%）。
              标上这个属性，提示条会自动下移避让。 */}
          <div className="app-header-search" data-tooltip-avoid>
            <div className="relative" role="search">
              <div className="absolute left-3 top-1/2 -translate-y-1/2 search-icon" aria-hidden="true">
                {isSearchBusy ? <LoadingIcon /> : (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                )}
              </div>
              {/* ── 2026-10-23 审计 H-7：placeholder / aria-label 必须提「URL」──
                  引导第 3 步教的是「搜索会话名、标签标题或 URL」，能力也确实
                  存在（`utils/search.ts` 的 `searchUrls` 默认 true，匹配
                  `tab.url`）。但**界面上唯一在输入前可见的说明**是这个
                  placeholder —— 它原先只写「会话或标签」⇒ 用户没有任何线索
                  知道网址也能搜，只能用自己记得的关键词试。
                  （空态那句「支持搜索…或 URL」要**搜空之后**才出现，
                  而他得先知道能搜 URL，才可能搜空。）
                  ⇒ placeholder 与 aria-label 一起改：placeholder 是**视觉**提示
                  （短，带省略号），aria-label 是**读屏**提示（完整、无省略号）。
                  ⚠️ 改了 aria-label 就必须同步改引导里的聚光灯选择器
                  （`OnboardingGuide.tsx` 两处）—— 否则第 2 步的聚光灯会
                  匹配不到任何元素、静默失去高亮（与 42 轮 P0-1 同类缺陷）。 */}
              <input
                ref={searchInputRef}
                type="text"
                placeholder="搜索会话 / 标签 / URL..."
                className="input search-input theme-focus w-full py-2 pl-10 text-sm"
                onChange={handleSearch}
                value={searchValue}
                aria-label="搜索会话名、标签标题或 URL"
                role="searchbox"
                autoComplete="off"
                aria-busy={isSearchBusy}
              />
              {searchValue && (
                <button
                  onClick={handleClearSearch}
                  className="absolute right-3 top-1/2 -translate-y-1/2 search-clear-btn flat-interaction transition-colors"
                  title="清空搜索"
                  aria-label="清空搜索"
                >
                  <CloseIcon />
                </button>
              )}
            </div>
          </div>

          {/* 操作按钮组 */}
          <nav className="app-header-actions" aria-label="会话操作">
            {/* ── 2026-10-24：这两颗按钮回到顶栏（v1.25.1 的排布）─────────────
                1.26.0（审计 U-20）把它们收进 ⋯ 菜单，顶栏因此少了两颗按钮、
                搜索框变宽。那是**长相**（按钮排布），不是功能 ⇒ 随 v1.25.1 一起退回去。

                两颗都是**重复入口**，不是独有能力：
                  · 布局切换 —— 同一份 dispatch（handleToggleLayout），菜单里也有；
                  · 清理重复 —— 同一个破坏性确认流程（handleCleanDuplicateTabs），菜单里也有。
                ⇒ 退的只是「顶栏上少这两颗」这个长相，功能一条没少。

                窄屏（<640px）藏起来：390px 实测顶栏塞不下这么多按钮，
                搜索框会被压成 0 宽（global.css 的 F-1 注释）。
                窄屏时这两个入口由 ⋯ 菜单提供（见 HeaderDropdown.tsx 的 sm:hidden 补偿区）。 */}
            <div className="hidden sm:block">
              <Tooltip
                content={settings.layoutMode === 'single' ? '切换双栏布局' : '切换单栏布局'}
                position="bottom"
              >
                <button
                  onClick={handleToggleLayout}
                  className="btn-icon flat-interaction"
                  aria-label={settings.layoutMode === 'single' ? '切换为双栏布局' : '切换为单栏布局'}
                >
                  {settings.layoutMode === 'single' ? <LayoutSingleIcon /> : <LayoutDoubleIcon />}
                </button>
              </Tooltip>
            </div>

            <div className="hidden sm:block">
              {/* ── 2026-10-30：骰子（随机打开一个标签）─────────────────────
                  产品负责人要求放在「布局切换 / 清理重复」这一组里。
                  窄屏由 ⋯ 菜单提供同名入口（见 HeaderDropdown.tsx 的
                  `sm:hidden` 补偿区）—— 与旁边两颗同一纪律：任何宽度都摸得到。 */}
              <Tooltip content="随机打开一个标签" position="bottom">
                <button
                  onClick={handleRandomPick}
                  disabled={isRandomPickBusy}
                  className="btn-icon flat-interaction"
                  aria-label="随机打开一个标签页"
                  aria-busy={isRandomPickBusy}
                >
                  {isRandomPickBusy ? <LoadingIcon /> : <DiceIcon />}
                </button>
              </Tooltip>
            </div>

            <div className="hidden sm:block">
              <Tooltip content="清理重复标签" position="bottom">
                <button
                  onClick={handleCleanDuplicateTabs}
                  disabled={isCleaningDuplicates}
                  className="btn-icon flat-interaction"
                  aria-label="清理重复标签页"
                  aria-busy={isCleaningDuplicates}
                >
                  {isCleaningDuplicates ? <LoadingIcon /> : <CleanIcon />}
                </button>
              </Tooltip>
            </div>

            {/* 主题切换 */}
            <SimpleThemeToggle />

            {/* 同步按钮 */}
            <SyncButton />

            {/* 保存按钮。
                **可见文字本身就带「关闭」**（2026-10-19 审计 I-3）：原先可见文字
                只有「保存会话」，「并关闭这些标签页」只写在 hover 300ms 才出现的
                tooltip 和 aria-label 里 —— 鼠标快速点击、触屏、窄屏用户全程
                看不到，而点下去当前窗口就被清空了。
                现在可见文案 = saveAndCloseLabel（与空态 CTA 逐字同源，
                见 components/layout/saveActionCopy.ts），文案与行为不可能漂移。

                ── 2026-10-19 审计 I-1：空态时降为次级按钮 ──────────────────
                新用户第一屏上，顶栏「保存并关闭标签」与空态卡里的主 CTA
                做的是**同一件事**（同一个 SAVE_ALL_TABS + 关闭标签），却是两个
                同色主按钮 —— 用户要在两个蓝色按钮之间猜哪一个是真的。
                空态时顶栏这一颗降为次级样式（.btn-secondary），让空态卡的
                CTA 成为**唯一**的主操作；有会话之后（空态卡不渲染）顶栏恢复
                主按钮样式。

                ── 2026-10-24：回到 v1.25.1 的层级 ────────────────────────────
                1.26.0（审计 L-5）把条件改成了「**任何时候**都是次级」——
                理由是「管理页此时是一列会话，用户在做的是『找回』，
                页面上最响的那颗按钮却是个会把当前窗口清空的动作」。
                那是**视觉层级**（按钮长什么样），不是功能 ⇒ 随 v1.25.1 一起退。

                退回去之后 I-1 的原始意图**仍然成立**：空态（groups.length === 0）
                时它是次级按钮，空态卡那颗 CTA 是页面上唯一的主操作。
                有会话之后它恢复主按钮样式 —— 这正是 v1.25.1 的样子。
                守卫：tests/guards/audit20261019Ui.test.ts（判据已改成 v1.25.1 口径）。 */}
            <Tooltip content={saveAndCloseDescription} position="bottom">
              <button
                onClick={handleSaveAllTabs}
                disabled={isSaving}
                className={`btn ${groups.length === 0 ? 'btn-secondary' : 'btn-primary'} flat-interaction whitespace-nowrap shrink-0 px-3 sm:px-4 disabled:opacity-60 disabled:cursor-not-allowed`}
                aria-label={saveAndCloseDescription}
                aria-busy={isSaving}
                // 成功后的完整说明放在 title 上：窄屏按钮装不下长句，
                // 但「另有 N 个固定标签未保存」这个事实必须可查（悬停即可见）。
                title={saveFeedback?.kind === 'success' ? saveFeedback.fullText : undefined}
              >
                {isSaving ? <LoadingSpinner size="sm" className="text-current" /> : <SaveIcon />}
                <span className="hidden sm:inline whitespace-nowrap">
                  {isSaving
                    ? '保存中…'
                    : saveFeedback?.kind === 'error'
                      ? saveFeedback.text
                      : saveFeedback?.kind === 'success'
                        ? saveFeedback.text
                        : saveAndCloseLabel}
                </span>
                <span className="sm:hidden" aria-hidden="true">
                  {isSaving
                    ? '保存中'
                    : saveFeedback?.kind === 'error'
                      ? '保存失败'
                      : saveFeedback?.kind === 'success'
                        ? saveFeedback.shortText
                        : saveAndCloseShortLabel}
                </span>
              </button>
            </Tooltip>

            {/* 更多菜单。aria-expanded/haspopup 是菜单按钮的最低契约：
                读屏要能播报「已折叠/已展开，菜单按钮」，
                引导第 5 步的聚光灯也锚在这个 aria-label 上。
                2026-10-18 round 38：data-menu-trigger 给菜单的「外部点击关闭」
                一个可跳过本按钮的判据 —— 同一个 click 里 onClick 先开菜单、
                事件继续冒泡到 document，不跳过就会把刚打开的菜单立刻关掉。 */}
            <div className="relative">
              <button
                onClick={() => setShowDropdown(!showDropdown)}
                className="btn-icon flat-interaction"
                aria-label="菜单"
                aria-haspopup="menu"
                aria-expanded={showDropdown}
                data-menu-trigger
              >
                <MenuIcon />
              </button>
              {showDropdown && (
                <HeaderDropdown
                  onClose={() => setShowDropdown(false)}
                  onOpenAuth={handleOpenAuth}
                  onToggleLayout={() => {
                    void handleToggleLayout();
                  }}
                  onRequestCleanDuplicates={() => {
                    handleCleanDuplicateTabs();
                  }}
                  // 清理进行中：入口搬进菜单后，「禁点 + 进行中」跟着搬过去
                  // （审计 U-20 之后的接线；否则同一动作能跑两遍）。
                  isCleaningDuplicates={isCleaningDuplicates}
                  onRequestRandomPick={() => {
                    handleRandomPick();
                  }}
                  isRandomPickBusy={isRandomPickBusy}
                  onReplayOnboarding={onReplayOnboarding}
                  // ── 2026-10-22 审计 L-11：空态的「导入数据」把导入子菜单直接展开 ──
                  initialSubmenu={pendingImport ? 'import' : null}
                  onInitialSubmenuConsumed={handleInitialSubmenuConsumed}
                />
              )}
            </div>
          </nav>
        </div>
      </div>
    </header>
  );
};

export default Header;
