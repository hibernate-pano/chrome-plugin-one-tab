import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { SafeFavicon } from '@/components/common/SafeFavicon';
import { Tooltip } from '@/components/common/Tooltip';
import { pickDominantTab } from '@/domain/tabGroup/pickDominantTab';
import { updateGroupNameAndSync, toggleGroupLockAndSync, deleteGroup, deleteBroadcastWarn, deleteTabAndSync, moveTabAndSync } from '@/store/slices/tabSlice';
import { DraggableTab } from '@/components/dnd/DraggableTab';
import { TabGroup as TabGroupType, Tab } from '@/types/tab';
import { useToast } from '@/contexts/ToastContext';
import { useEnhancedToast } from '@/utils/toastHelper';
import { OpenGuard, OpenAllGuard } from '@/utils/openGuard';
import { isOpenableTabUrl } from '@/utils/inputValidation';
import { shouldAutoDeleteAfterTabRemoval, onlyActiveTabId } from '@/core/tabGroupUtils';
import { useNearViewport } from '@/hooks/useNearViewport';
import { resolveRowWindow } from './lazyTabRows';
import { trackProductEvent } from '@/utils/productEvents';
import {
  collectFocusableMenuItemIndices,
  resolveMenuNavigation,
} from '@/utils/menuKeyboard';
import { resolveRenameDecision } from '@/domain/tabGroup/renameDecision';
import { registerFocusReturn } from '@/utils/focusReturn';
import { focusTabOrderSibling } from '@/utils/focusOrder';
import { logError } from '../../utils/log';
import { toServiceWorkerErrorCopy } from '@/utils/serviceWorkerErrorCopy';
import { mutationErrorMessage } from '@/components/tabs/mutationErrorCopy';
import {
  openSingleTabSuccessMessage,
  restoreGroupSuccessMessage,
  restoreOutcomeSentence,
} from '@/components/tabs/restoreFeedbackCopy';
import { useConsumeUndo } from '@/components/tabs/useConsumeUndo';
import {
  deleteGroupConfirmMessage,
  deleteGroupConfirmTitle,
  deleteGroupEntryLabel,
  deleteGroupRequiresConfirm,
  lockedTabDeleteMessage,
} from '@/components/tabs/lockedDeleteCopy';
import { lockToggleMessage } from '@/components/tabs/lockFeedbackCopy';
import { moveEmptiesSessionMessage } from '@/components/tabs/moveFeedbackCopy';

interface TabGroupProps {
  group: TabGroupType;
}

// 图标组件
const EditIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
  </svg>
);

/**
 * 锁图标 —— **画的是当前状态**，不是点了会发生什么。
 *
 * 【这是产品负责人的决定，不采纳「永远画闭锁」的建议】
 * 闭锁＝已锁、开锁＝未锁，这是 Material / Lucide / SF Symbols 一致的约定，
 * 用户扫一屏卡片时正是靠**形状**判断「哪个被锁了」。若改成永远画闭锁，
 * 就把「形状＝状态」这条用户已经建立的读法反过来 —— 锁定与未锁定在
 * 一屏里反而分不出来了。
 *
 * 因此这里补的是真正的缺口（而不是改图标语义）：
 *   · 锁定态有 accent 色的**徽章 + 闭锁图形**，未锁定态只有中性描边；
 *   · tooltip 同时说明「现在是什么状态」与「点了会发生什么」。
 */
const LockIcon = ({ locked }: { locked: boolean }) => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    {locked ? (
      /* 闭锁：锁梁端正地扣在锁体上（锁体 x 4.5–16.5，锁梁 x 7.5–16.5）。 */
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
    ) : (
      /* 开锁：锁梁整个甩到锁体右侧并探出边界（锁梁 x 13.5–22.5，锁体 x 1.5–16.5）
         ⇒ 与闭锁的形态差异一眼可见，不靠颜色。 */
      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 10.5V6.75a4.5 4.5 0 119 0v3.75M3.75 21.75h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
    )}
  </svg>
);

const DeleteIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
  </svg>
);

/**
 * 「在新窗口恢复整个会话」—— 窗口框 + **穿出框外**的箭头。
 *
 * 【为什么是这个形状（U-10）】两个「打开」按钮并排出现在每一张卡上，
 * 是全产品最高频的两个动作。原先两者共用同一个圆角矩形框，只差箭头朝向
 * ⇒ 16px 下 90% 的像素一样，肉眼读不出哪个是「开新窗口」。
 *
 * 现在两者**基础形状就不同**：
 *   · 本图标 = 框的右上角**开了缺口**，箭头从缺口探出去伸到框外
 *     （业界通用的「另开一个窗口」符号 open_in_new）⇒ 轮廓是「带尾巴的框」；
 *   · 另一个 = 一个**闭合的框**，箭头**完全落在框内** ⇒ 轮廓是「一个干净的框」。
 *
 * 于是即使把颜色全部抹掉（灰度打印、强制高对比），两者的**轮廓**仍然不同：
 * 一个有伸出边界的东西，一个所有笔画都在框里。
 */
const OpenAllIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
  </svg>
);

/**
 * 「在当前窗口打开」—— **闭合的**窗口框 + 完全落在框内的横向箭头。
 *
 * 箭头不越界 ⇒ 一眼可读成「内容进到这个框里」＝ 就地打开；
 * 而上一个图标有笔画伸到框外 ⇒ 读成「离开这个框」＝ 另开一个窗口。
 * 两者遮住颜色后仍可区分（见 OpenAllIcon 的注释）。
 */
const OpenAllInPlaceIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 6h8.25A2.25 2.25 0 0 1 15.75 8.25v10.5A2.25 2.25 0 0 1 13.5 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6Z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M6.5 13.5h6.5M10.5 11l2.5 2.5-2.5 2.5" />
  </svg>
);

/**
 * 锁定 / 解锁按钮的提示语（2026-10-22 审计 U-11）。
 *
 * 必须**同时说明当前状态和点了会发生什么**：
 * 原文案只有「锁定会话」三个字 —— 用户既不知道这个会话现在是不是锁着，
 * 也不知道锁定会带来哪些后果（会被清理吗？还能改名吗？恢复后还在吗？）。
 *
 * 两句的措辞与 lockFeedbackCopy（锁定后的 toast）保持一致，
 * 免得「点之前说的」与「点之后说的」对不上。
 */
const LOCK_TOOLTIP = {
  locked: '会话已锁定 · 点此解锁（解锁后恢复即从列表移除）',
  unlocked:
    // ── 2026-10-23 审计 H-8：补上锁定最要紧的那半句 ──────────────────────
    // 锁定真正改变的是「**恢复后这个会话还在不在**」——
    // 未锁定的会话恢复后即被消费（从列表移除），锁定的才留得住、可反复用。
    // 这半句原先只在**锁定之后**的 toast 里说（lockFeedbackCopy），
    // 而「点之前」该说的 tooltip 里一个字没提 ⇒ 用户在按钮上得不到
    // 「锁定到底改变了什么」的答案。
    // 措辞与 lockFeedbackCopy 的锁定后提示对齐（同一件事，同一口径）。
    '会话未锁定 · 点此锁定（恢复后仍留在列表里，可反复使用；不会被「清理重复标签」清理，也不能重命名或逐条删除）',
} as const;

export const TabGroup: React.FC<TabGroupProps> = React.memo(({ group }) => {
  const dispatch = useAppDispatch();
  const confirmBeforeDelete = useAppSelector(state => state.settings.confirmBeforeDelete);
  // ── 2026-10-20 审计 A-9：showTabCount 从「死设置」变成**真被读**的开关 ──
  // 修复前这个设置只有默认值与上云映射，UI 从不读它 —— 标签数量永远显示。
  // 现在设置页有开关（OptionsPage「外观」小节），这里真的按它决定画不画徽章。
  const showTabCount = useAppSelector(state => state.settings.showTabCount);
  // ── 2026-10-22 审计 U-15：卡片的视觉身份 ────────────────────────────────
  // 此前 SafeFavicon 只出现在**标签行**，卡片级一处都没有 ⇒ 行的辨识度
  // 比卡还高，层级倒挂（一屏十张卡长得一模一样）。
  //
  // 成本为零：会话里已经存着每个标签的 favicon（来自浏览器自己的
  // chrome.tabs.Tab.favIconUrl，src/domain/tabGroup/factory.ts 落盘），
  // 这里只是把它读出来 —— 不新增权限、不新增网络请求、不引第三方服务。
  //
  // 取哪个标签：与「默认会话名」同一把尺子（域名占多数的那个），
  // 否则卡片图标与会话名会来自不同站点，自相矛盾。判据见
  // @/domain/tabGroup/pickDominantTab（纯函数，四条契约有单测）。
  //
  // ⚠️ 受设置页的「显示网站图标」开关控制（2026-10-22 收口）。
  // 那个开关叫「显示网站图标」，用户关掉它的意思就是「我不想看到网站图标」——
  // 卡片头这枚也是网站图标 ⇒ 它必须一起消失，否则开关就是半拉子的
  // （关掉了还剩一处，那一处就成了「偷偷显示」）。
  const showFavicons = useAppSelector(state => state.settings.showFavicons);
  const dominantTab = useMemo(() => pickDominantTab(group.tabs), [group.tabs]);
  const { showConfirm, showToast } = useToast();
  const { showDeleteError, showRestoreError, showRestoreSuccessMessage } = useEnhancedToast();
  // ── 2026-10-22 审计 P0-4：「恢复即消费」要可撤销 ────────────────────────
  // 恢复动作会把这条会话**删掉**（无回收站）—— 本产品最高频的两个动作，
  // 却都是不可逆的删除。撤销凭据挂在成功提示上：用户点开一个标签之后，
  // 那条记录还找得回来。
  const { showConsumeToast } = useConsumeUndo();

  const [isEditing, setIsEditing] = useState(false);
  const [newName, setNewName] = useState(group.name);
  const [isCollapsed, setIsCollapsed] = useState(false);
  // 复活去重守卫（逻辑见 @/utils/openGuard，可单测）：单 tab 按 tabId 冷却去重，
  // 整组恢复按 group.id 加同类在途锁。组件卸载即丢弃，无需额外清理。
  const openGuardRef = useRef<OpenGuard | null>(null);
  const openAllGuardRef = useRef<OpenAllGuard | null>(null);
  // 窄屏「更多」菜单（2026-10-19 审计 P0-2 / P2-9）
  const moreMenuRef = useRef<HTMLDetailsElement | null>(null);
  const moreMenuButtonRef = useRef<HTMLDivElement | null>(null);
  // portal 出去的面板本身（方向键导航与 Tab 接管都要用它的 ref）。
  const moreMenuPanelRef = useRef<HTMLDivElement | null>(null);
  // 宽屏卡头的删除按钮（确认框关闭后的稳定还焦落点）。
  const cardActionRef = useRef<HTMLButtonElement | null>(null);
  // 菜单面板的固定定位坐标（相对视口）。
  const [moreMenuPos, setMoreMenuPos] = useState<{ top: number; left: number } | null>(null);
  if (openGuardRef.current === null) openGuardRef.current = new OpenGuard();
  if (openAllGuardRef.current === null) openAllGuardRef.current = new OpenAllGuard();

  // 标签行懒渲染（v1.22.9）：把「同一时刻存在于 DOM 的标签行数」从「数据总量」解耦。
  //
  // 观测挂在**卡片根节点**上，不是折叠容器上：折叠时容器高度为 0，若观测它，
  // IO 会把折叠的卡判成「不可见」——对结果没影响（折叠态本来就不渲染行），
  // 但一旦展开，判定依据会变成「展开前的位置」，语义混乱。挂在卡片上则始终
  // 反映「这张卡在视口的什么位置」，展开后立刻按真实位置判定。
  const [cardRef, isNearViewport] = useNearViewport<HTMLDivElement>();
  const { renderRows, placeholderHeight } = resolveRowWindow(group.tabs.length, isNearViewport);

  // ── DS-43-16：删掉**唯一那条**活跃标签 ⇒ 整个会话卡会消失 ──────────────────
  // 「删除会话前确认」开关关闭时零确认 ⇒ ✕ 的提示是用户唯一的预警，
  // 必须说清「整张卡会一起消失」。
  //
  // 一次扫完全组回答所有行（见 `onlyActiveTabId` 的注释）：
  // 逐行调 `shouldAutoDeleteAfterTabRemoval` 是 O(n²)，
  // 而拖拽过程中每 100ms 就重渲一次。
  const soleActiveTabId = useMemo(() => onlyActiveTabId(group), [group]);

  // 只在“不处于编辑态”时把外部值同步进草稿。
  // 失败回滚会让 group.name 短暂变回旧值（那正是我们要的），
  // 但如果这里无条件回写，用户正在输入框里的草稿会被回滚值抹掉——保存失败后
  // 恰恰是最需要保留草稿让人重试的时刻。
  useEffect(() => {
    if (!isEditing) setNewName(group.name);
  }, [group.name, isEditing]);

  const handleNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setNewName(e.target.value);
  }, []);

  /**
   * P1-5：四条乐观写路径（重命名/锁定/收藏/备注）的失败出口。
   * thunk 用 rejectWithValue 把写入前快照带回来，slice 的 rejected reducer 已据此
   * 把 Redux 回滚到与 storage 一致的值；这里只负责「告诉用户刚才那下没生效」并
   * 把编辑态/草稿留在原处（可立即重试），否则用户以为已经改成功了。
   * 之前这四条 dispatch 全部没有失败处理，写失败静默、UI 与 storage 永久分叉。
   */
  const handleNameSubmit = useCallback(() => {
    // ── 2026-10-20 键盘可达性：三种提交都要能**退出编辑态** ──────────────
    // 修复前守卫是 `if (trimmed !== '' && trimmed !== group.name)` 且**无 else**：
    // 名字没改、或被清空时，整个函数什么都不做，而 `setIsEditing(false)`
    // 只写在异步成功回调里 ⇒ 输入框**卡在编辑态出不来**
    // （实测：按 Enter 后 stillEditing=true；清空后按 Enter：stillEditing=true、
    // value="" ⇒ 用户只能按 Esc）。
    // 决策抽到 @/domain/tabGroup/renameDecision（纯函数，可单测）。
    const decision = resolveRenameDecision(newName, group.name);

    if (decision.kind === 'unchanged') {
      // 名字没变：不写盘（避免 Enter + blur 双触发时发两次 rename，
      // 第二次会拿到自己的乐观值当快照；也避免无意义的 version bump），
      // 但**必须退出编辑态**。
      setIsEditing(false);
      return;
    }

    if (decision.kind === 'empty') {
      // 清空：回滚到原名并退出编辑态（理由见 renameDecision.ts 的文件头）。
      // 必须出声：静默回滚 = 「我明明改了却没反应」。
      setNewName(group.name);
      setIsEditing(false);
      showToast('会话名称不能为空，已保留原名称', 'warning');
      return;
    }

    void dispatch(updateGroupNameAndSync({ groupId: group.id, name: decision.name }))
      .then(action => {
        if (updateGroupNameAndSync.rejected.match(action)) {
          logError('重命名失败，已恢复原名称:', action.error);
          showToast('重命名失败，会话名称已恢复', 'error');
          // 保持编辑态：草稿还在输入框里，用户可以直接重试
          setIsEditing(true);
          return;
        }
        setIsEditing(false);
      })
      .catch(error => logError('重命名失败:', error));
  }, [dispatch, group.id, group.name, newName, showToast]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleNameSubmit();
    } else if (e.key === 'Escape') {
      setNewName(group.name);
      setIsEditing(false);
    }
  }, [handleNameSubmit, group.name]);

  const handleDelete = useCallback(() => {
    const runDelete = () => {
      dispatch(deleteGroup(group.id))
        .unwrap()
        .then(payload => {
          // 本地删除已生效，但云端删除广播登记可能失败 ⇒ 对端会复活这一组。
          // 这种情况**不是** ok:false（本地确实删了），必须单独 surface，
          // 否则用户看到「删除成功」就不会再检查，而实际结果是「删了又回来」。
          const warn = deleteBroadcastWarn(payload);
          if (warn) showDeleteError(warn);
        })
        .catch(error => {
          // 2026-10-19 审计 F-8：原始异常只进日志，界面只说可行动的话。
          showDeleteError(mutationErrorMessage('删除会话', error));
        });
    };

    // ── 2026-10-20 审计 A-3：锁定会话的删除**必须**确认 ──────────────────
    // 锁定是用户显式表达的「这个重要，别弄丢」。删它属于**越权动作**：
    // 若跟着「删除会话前确认」开关一起关掉，用户点一下就把自己保护过
    // 的东西永久删了（无回收站）—— 那等于把「锁定」变回一句谎话。
    // 未锁定会话仍听开关（日常删除不加噪音）。
    const copyInput = {
      name: group.name,
      tabCount: group.tabs.length,
      isLocked: group.isLocked,
    };
    if (!deleteGroupRequiresConfirm({ isLocked: group.isLocked, confirmBeforeDelete })) {
      runDelete();
      return;
    }

    // ── 2026-10-20 焦点管理：登记「确认框关闭后焦点去哪」 ──────────────
    // 确认框由 ToastContext 全局渲染，打开时 activeElement 是触发它的
    // 那个按钮（窄屏是「更多」菜单里的「删除会话」，宽屏是卡头那颗删除按钮）；
    // 那个按钮随后随菜单/卡片被卸载 ⇒ 旧实现拒绝还焦 ⇒ **焦点掉到 body**
    // （实测四条路径全部复现：卡片菜单 Esc / 点取消、顶栏菜单点取消）。
    //
    // 登记**稳定的落点**：窄屏用卡片的 summary（「⋯」按钮），
    // 宽屏用卡头的删除按钮本身。两者都不会随确认框关闭而消失。
    registerFocusReturn(
      moreMenuButtonRef.current ?? cardActionRef.current
    );

    showConfirm({
      // 锁定会话的标题与正文都点明「已锁定」—— 用户要删的正是那个
      // 被自己保护过的东西，不说清楚就只是一次普通删除。
      title: deleteGroupConfirmTitle(copyInput),
      message: deleteGroupConfirmMessage(copyInput),
      type: 'danger',
      confirmText: '删除',
      cancelText: '取消',
      onConfirm: runDelete,
      onCancel: () => { }
    });
  }, [confirmBeforeDelete, dispatch, group.id, group.isLocked, group.name, group.tabs.length, showConfirm, showDeleteError]);

  const handleToggleLock = useCallback(() => {
    void dispatch(toggleGroupLockAndSync(group.id))
      .then(action => {
        if (toggleGroupLockAndSync.rejected.match(action)) {
          logError('切换锁定失败，已恢复原状态:', action.error);
          showToast('切换锁定失败，锁定状态已恢复', 'error');
          return;
        }
        // ── 2026-10-22 审计 L-9：锁定改变的是「恢复后还在不在」这条规则 ──
        // 恢复时消费会话是本产品最容易被误解的一条规则，而锁定是**唯一**
        // 能改变它的开关 —— 切换时不出声，用户只能在恢复之后才发现
        // 「这次怎么没被消费」，那时已经晚了。
        // 文案必须说出**后果**，而不只是「已锁定」这三个字。
        showToast(lockToggleMessage(!group.isLocked), 'success', 4000);
      })
      .catch(error => logError('切换锁定失败:', error));
  }, [dispatch, group.id, group.isLocked, showToast]);

  const openAllTabs = useCallback((inCurrentWindow: boolean) => {
    const allGuard = openAllGuardRef.current as OpenAllGuard;
    // 同类在途锁：恢复流程（删本地组 + SW 开窗口）结束前，同组重复点击直接忽略，
    // 防一次恢复开出两个浏览器窗口。
    //
    // ── 2026-10-09 P1-3：命中锁不能一声不吭 ──────────────────────────────
    // 原先是裸 `return`：用户重复点击，既没有按钮禁用、也没有 toast，
    // 只能自己猜「没点上」还是「坏了」。同一组件里**单标签**的冷却分支早就
    // 用 showRestoreError 出声了（见下方 openTab），整组这条同类分支漏了。
    // 「按了键没反应必须有一句话解释」是项目第一性原则，静默 return 直接违反。
    if (!allGuard.tryAcquire(group.id)) {
      showRestoreError('正在恢复该会话，请稍候…');
      return;
    }
    const releaseAll = () => allGuard.release(group.id);
    // 兜底：dispatch 悬挂时不永久锁死该组的恢复入口
    const safetyTimer = setTimeout(releaseAll, 10000);
    const releaseAllOnce = () => {
      clearTimeout(safetyTimer);
      releaseAll();
    };

    const tabsPayload = group.tabs.map(tab => ({
      url: tab.url,
      pinned: !!tab.pinned,
    }));

    void trackProductEvent('session_restored', {
      sessionId: group.id,
      sessionName: group.name,
      source: inCurrentWindow ? 'list-current-window' : 'list',
      tabCount: group.tabs.length,
    });

    // ── 先开后删（与单标签 handleOpenTab 同口径）─────────────────────────
    // 原顺序是先 dispatch(deleteGroup) 再发 OPEN_TABS：SW 拒开（全部不可打开 /
    // 无 URL）、建窗抛错、或页面已关闭导致无回包时，会话早已被物理删除且无回收站
    // —— 标签没开出来，记录也没了。现在只有 SW 明确回 success:true 才消费原会话。
    const consumeSession = () => {
      if (group.isLocked) {
        // 锁定组恢复后保留，可反复用；无 dispatch 可挂 finally，此处即解锁
        releaseAllOnce();
        return;
      }
      // ponytail: 去掉 fake dispatch — autoSyncMiddleware 会通过真实 thunk 的
      // fulfilled action 触发 scheduleUpload，无需骗一次
      dispatch(deleteGroup(group.id))
        .unwrap()
        .then(payload => {
          // 恢复 = 整组物理移除，广播登记失败同样要 surface：本地卡片没了，
          // 云端行还活着，对端下次合并会把它复活。用户以为恢复成功就不会再查。
          const warn = deleteBroadcastWarn(payload);
          if (warn) showDeleteError(warn);
        })
        .catch(error => {
          logError('恢复会话后删除原会话失败:', error);
          showDeleteError(mutationErrorMessage('恢复会话后清理原会话', error));
        })
        .finally(releaseAllOnce);
    };

    chrome.runtime.sendMessage(
      { type: 'OPEN_TABS', data: { tabs: tabsPayload, inCurrentWindow } },
      // 2026-10-05：处理回包。过去是 fire-and-forget，于是 SW 跳过的标签
      //（本地文件 / 临时链接 / 浏览器内部页面 —— 见 service-worker 的
      // isOpenableTabUrl 过滤）用户完全不知情，看起来就是「恢复出来的会话
      // 里有几个标签是坏的」。
      //
      // 未锁定 → 打开成功后会话已移除，打不开的地址不再保存在列表中
      // 已锁定 → 会话还在，打不开的那几个仍留在里面
      (res: unknown) => {
        const r = res as { success?: boolean; skippedUnopenable?: number; error?: string } | undefined;
        // 没有 success:true 就没有证据证明标签打开了：记录原样保留，可重试。
        if (!r || r.success !== true) {
          releaseAllOnce();
          // 2026-10-19 审计 F-7：SW 的 error 可能是一句中文，也可能是机器码
          // （如 no_valid_urls）。统一走 toServiceWorkerErrorCopy 翻译，
          // 别把英文原文弹给全中文界面的用户。
          showDeleteError(
            `${toServiceWorkerErrorCopy(r?.error, '恢复会话失败')}。原会话仍保留在列表中。`
          );
          return;
        }
        consumeSession();
        if (typeof r.skippedUnopenable === 'number' && r.skippedUnopenable > 0) {
          const keptNote = group.isLocked ? '它们仍保留在会话中。' : '这几个地址不再保存在列表中。';
          // ── 2026-10-22 审计 P0-4：部分成功**也是一次消费** ──────────────
          // consumeSession() 已经在上面跑过了 ⇒ 未锁定时整条会话已被移除。
          // 那是不可逆的删除，所以这条提示上同样要挂「撤销」——
          // 否则用户手里就有一条**没有退路**的消费。
          showConsumeToast(
            `已恢复 ${tabsPayload.length - r.skippedUnopenable} 个标签；` +
              `另有 ${r.skippedUnopenable} 个在当前设备无法打开（本地文件、临时链接或` +
              `浏览器内部页面）。${keptNote}`,
            group.isLocked ? undefined : { group },
            { type: 'error' },
          );
          return;
        }
        // ── 2026-10-20 审计 A-1：成功必须出声 ─────────────────────────────
        // 修复前这里**什么都不说**：窗口开了、会话卡从列表消失、屏幕上零反馈。
        // 「我的卡片怎么没了？」是用户看到卡片凭空消失时的第一反应，
        // 而它其实是成功。搜索页同一动作早就有 showRestoreSuccess，
        // 只有列表页（**主界面**）没有 —— 同一产品两个界面两种反馈。
        //
        // 文案抽到 restoreFeedbackCopy.ts：列表页与搜索页共用一份措辞，
        // 改一处就不会漂移成两个说法。
        //
        // ── 2026-10-22 审计 P0-4：这条提示上挂「撤销」 ────────────────────
        // 未锁定 ⇒ 整条会话已被移除（不可逆，无回收站）⇒ 必须给退路。
        // 锁定 ⇒ 会话仍在列表里，从未被消费 ⇒ 挂撤销就是骗人（按钮按了
        // 什么也不会发生）。
        showConsumeToast(
          restoreGroupSuccessMessage(tabsPayload.length, group.isLocked),
          group.isLocked ? undefined : { group },
        );
      }
    );
  }, [dispatch, group, showConsumeToast, showDeleteError, showRestoreError, showRestoreSuccessMessage]);

  const handleOpenAllTabs = useCallback(() => openAllTabs(false), [openAllTabs]);
  const handleOpenAllTabsInCurrentWindow = useCallback(() => openAllTabs(true), [openAllTabs]);

  const handleOpenTab = useCallback((tab: Tab) => {
    // ── popup 侧前置拦截：本设备打不开的地址（file:/blob:/内部页面）──────
    // 这条**必须排在去重守卫与锁定分支之前**，它拒的是「一次从未发生的打开」：
    //  · 排在锁定分支之后：锁定组会把 OPEN_TAB 发给 SW，而锁定分支只看 promise 的
    //    reject（.catch），SW 的 success:false 回包被丢掉 ⇒ 点了完全没反应；
    //  · 排在守卫之后：第一次点击先占住冷却档位，紧接着的第二次点击文案变成
    //    「刚刚已打开这个标签，正在冷却中」——可它从来没被打开过（文案撒谎）。
    // 拒开一次确定性失败的动作不该消耗任何去重额度，所以两支守卫都在它下面。
    // 文案与 SW 的拒开口径一致：已保留在会话中。
    if (!isOpenableTabUrl(tab.url)) {
      showRestoreError('此标签在当前设备无法打开，已保留在会话中');
      return;
    }
    // 在途+冷却去重：mutation 回包前的重复点击直接忽略；回包后冷却期内同样忽略，
    // 防止“复活项”被二次点开导致同一 URL 打开多个浏览器标签。
    // 锁定组不删本地项、恢复立即可见，只需防双击（见 openCooldownMs）；
    // 失败必须 release，否则该 tab 会被记住一整个冷却窗口、点重试无反应。
    const guard = openGuardRef.current as OpenGuard;
    // 【冷却命中必须出声】tryAcquire 失败就静默 return 等于「点了没反应」——
    // 项目原则是「按了键没反应必须有一句话解释」，否则「无感」变成「无声」。
    if (!guard.tryAcquire(tab.id, group.isLocked)) {
      showRestoreError('刚刚已打开这个标签，正在冷却中，请稍候再试');
      return;
    }
    const releaseOnFailure = () => guard.release(tab.id);
    // ── 点开即消费（2026-10-14，用户决策反转 1.22.13 的两步语义） ──────────
    // 顺序：先开后删，SW 回包 success 才删 —— 比 1.22.12 原版多一道成功门。
    // 原版是无条件删（SW 拒开也照删：开了没看到页面，记录也没了，两头空）。
    // 锁定组从不消费（与整组恢复语义一致：锁定会话恢复后保留、可反复用）。
    if (group.isLocked) {
      chrome.runtime.sendMessage({
        type: 'OPEN_TAB',
        data: { url: tab.url, pinned: !!tab.pinned }
      })
        .then((res: unknown) => {
          // ── 2026-10-22 审计 P1-6：成功门（锁定分支原来会谎报成功）──────
          // SW 拒开是 sendResponse({success:false}) ⇒ promise **resolve**
          // 而不是 reject ⇒ 原来的 .then(() => 报成功) 在拒开时照样跑 ⇒
          // 界面播「已打开该标签页」，实际一个标签都没开。
          // 判据与下面未锁定分支同一把尺子：没有 success:true 就没有证据。
          const r = res as { success?: boolean; error?: string } | undefined;
          if (!r || r.success !== true) {
            // 失败必须释放冷却档位：否则这条标签被记住一整个冷却窗口，
            // 用户点重试没反应（与未锁定分支同口径）。
            releaseOnFailure();
            showRestoreError(toServiceWorkerErrorCopy(r?.error, '打开失败，标签仍保留在会话中'));
            return;
          }
          // ── 2026-10-20 审计 A-2：成功必须出声 ─────────────────────────
          // 锁定组不消费记录，但**行也还在** —— 屏幕上同样什么都不动。
          // 「点了没反应」与「已打开」用户分不出来。
          showRestoreSuccessMessage(openSingleTabSuccessMessage(true));
        })
        .catch(error => {
        logError('打开标签失败:', error);
        // 消息本身失败（SW 没起来 / 没有接收方）⇒ 同样释放冷却档位。
        releaseOnFailure();
        showRestoreError(mutationErrorMessage('打开标签', error));
      });
      return;
    }
    chrome.runtime.sendMessage(
      {
        type: 'OPEN_TAB',
        data: { url: tab.url, pinned: !!tab.pinned }
      },
      (res: unknown) => {
        const r = res as { success?: boolean; error?: string } | undefined;
        if (r && r.success === false) {
          // SW 明确拒开：开了没看到页面，记录保留（用户批复：拒开不删）。
          releaseOnFailure();
          showRestoreError(toServiceWorkerErrorCopy(r.error, '打开失败，已保留在会话中'));
          return;
        }
        // SW 无回包（无 URL 的 break 分支）同样不删：没证据证明打开了。
        if (!r || r.success !== true) {
          releaseOnFailure();
          showRestoreError('打开失败，已保留在会话中');
          return;
        }
        dispatch(deleteTabAndSync({ groupId: group.id, tabId: tab.id }))
          .unwrap()
          .then(payload => {
            const warn = deleteBroadcastWarn(payload);
            if (warn) showDeleteError(warn);
            // ── 2026-10-20 审计 A-2：点开即消费 = 一次不可撤销的删除 ──
            // 这是本产品**最高频**的动作，却是零反馈的：标签行消失、
            // 页面打开、屏幕上什么都不动。用户无法区分「已打开」与「被删了」。
            // 成功门已过（SW 回包 success:true），所以这里可以放心报成功。
            //
            // ── 2026-10-22 审计 P0-4：这条提示上挂「撤销」 ────────────────
            // 点开标签 = 消费掉那条记录（不可逆，无回收站）⇒ 必须给退路。
            // 凭据里带 consumedIndex：撤销时标签要插回**原来的位置**，
            // 而不是追加到末尾（那是用户自己排的顺序，撤销不该偷偷改它）。
            showConsumeToast(openSingleTabSuccessMessage(false), {
              group,
              consumedTabId: tab.id,
              consumedIndex: group.tabs.findIndex(t => t.id === tab.id),
            });
          })
          .catch(error => {
            logError('打开后从会话移除失败:', error);
            showDeleteError(mutationErrorMessage('标签已打开，但从会话移除', error));
          });
      }
    );
  }, [dispatch, group, showConsumeToast, showRestoreError, showDeleteError, showRestoreSuccessMessage]);

  const handleMoveTab = useCallback((sourceGroupId: string, sourceIndex: number, targetGroupId: string, targetIndex: number) => {
    dispatch(moveTabAndSync({
      sourceGroupId,
      sourceIndex,
      targetGroupId,
      targetIndex
    }))
      .unwrap()
      .then(payload => {
        // 跨组拖拽搬空源组 = 整组物理移除，广播登记失败同样要 surface。
        const warn = deleteBroadcastWarn(payload);
        if (warn) showDeleteError(warn);
        // ── 2026-10-23 审计 DS-43-11：搬空了一个会话，必须出声 ──────────
        // 之前这里是**零反馈**：那张会话卡静默消失，用户全程不知道
        // 自己拖走的是这个会话的最后一条标签。
        //
        // 交互本身**不动**（产品钦定「直接生效，不多问」，
        // 见 tests/dragLastTabRefused.test.ts）—— 补的只是**说出来**。
        //
        // 注意说这句话的是**目标会话**那个组件（drop 落在目标行上，
        // 目标行的 moveTab 回调属于目标组）⇒ 源会话的名字由 thunk 带回
        // （见 tabSlice.ts 的 moveTabAndSync）。
        const moved = payload?.value;
        if (moved?.removedGroupId) {
          showRestoreSuccessMessage(
            moveEmptiesSessionMessage({
              sourceName: moved.sourceGroupName,
              targetName: group.name,
            })
          );
        }
      })
      .catch(error => {
        logError('移动标签失败:', error);
        showDeleteError(mutationErrorMessage('移动标签', error));
      });
  }, [dispatch, group, showDeleteError, showRestoreSuccessMessage]);

  const handleDeleteTab = useCallback((tabId: string) => {
    // 按钮在锁定组里已不渲染（见 DraggableTab 的 locked），这里是兵底：
    // 任何绕过 UI 的调用同样不许逐条删 —— 与整组删除按钮「锁定时不渲染」同口径。
    if (group.isLocked) {
      showDeleteError(lockedTabDeleteMessage());
      return;
    }

    const runDelete = () => {
      dispatch(deleteTabAndSync({ groupId: group.id, tabId }))
        .unwrap()
        .then(payload => {
          const warn = deleteBroadcastWarn(payload);
          if (warn) showDeleteError(warn);
        })
        .catch(error => {
          showDeleteError(mutationErrorMessage('更新会话', error));
        });
    };

    // 删掉最后一条活跃标签 = 整组物理移除（判据复用 applyRemoveTab 的同一份语义）。
    // 后果与「删除整个会话」等价，而删除整个会话本来就有确认开关 ⇒ 同口径走确认；
    // 其余逐条删除保持即时（✕ 已带「无法恢复」提示，给日常单删加确认只会变噪音）。
    if (!confirmBeforeDelete || !shouldAutoDeleteAfterTabRemoval(group, tabId)) {
      runDelete();
      return;
    }

    showConfirm({
      title: `删除「${group.name}」？`,
      // 2026-10-23 审计 H-10：「标签记录」统一成「标签页」
      // （⚠️ 同一句话在 SearchResultList.tsx 也有，那一处不在本轮分工内）。
      message: '这是该会话的最后一条标签页，删除后整个会话会从列表消失，无法恢复。确认继续吗？',
      type: 'danger',
      confirmText: '删除',
      cancelText: '取消',
      onConfirm: runDelete,
      onCancel: () => { }
    });
  }, [confirmBeforeDelete, dispatch, group, showConfirm, showDeleteError]);

  /**
   * 锁定会话里的标签被尝试拖走（2026-10-19 审计 F-3）。
   *
   * 锁定承诺「组内不发生删除」，而拖到别的会话 = 从本组移除，拖走最后一条
   * = 整组物理移除。所以锁定组的标签不可拖（DraggableTab 的 draggable={!locked}）。
   *
   * 这里只负责**出声**：拦下却不出声，用户会以为是自己没拖动成功。
   * 放在 TabGroup（而不是 DraggableTab）是因为这一层才知道「锁定」这件事
   * 对用户的意义 —— 组件行只知道 locked 布尔值。
   */
  /**
   * 菜单面板的固定定位坐标（相对视口）。
   *
   * 面板用 position: fixed + portal 渲染到 body（见下方 createPortal）。
   * 坐标按 summary 按钮的视口位置算，并做**视口内收边**：
   * 窄屏时按钮靠右，面板宽 176px，若不收边会横向溢出视口。
   */
  const computeMoreMenuPosition = useCallback((): { top: number; left: number } | null => {
    const btn = moreMenuButtonRef.current;
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    const PANEL_W = 176;
    const MARGIN = 8;
    const left = Math.max(MARGIN, Math.min(r.right - PANEL_W, window.innerWidth - PANEL_W - MARGIN));
    // 优先向下；下方不够就向上。
    const estimatedH = 160;
    const top = r.bottom + 4 + estimatedH <= window.innerHeight
      ? r.bottom + 4
      : Math.max(MARGIN, r.top - 4 - estimatedH);
    return { top, left };
  }, []);

  /**
   * 窄屏「更多」菜单的开合（2026-10-19 审计 P0-2 / P2-9）。
   *
   * 原生 <details> 的两个缺口：
   *   · 点菜单项后**不自动收起** —— 「重命名会话」点完，菜单还浮在输入框上面；
   *   · **外部点击不关闭、Esc 不关闭** —— 键盘用户没有任何方式收起它。
   *
   * 这里补上：菜单项被点 → 收起；点菜单外 → 收起；Esc → 收起。
   */
  const handleMoreMenuToggle = useCallback((e: React.MouseEvent) => {
    // summary 的默认行为是切换 open —— 我们的处理只管「何时关」，
    // 不干预展开本身。
    e.preventDefault();
    const el = moreMenuRef.current;
    if (!el) return;
    const nextOpen = !el.open;
    el.open = nextOpen;
    if (!nextOpen) {
      setMoreMenuPos(null);
      return;
    }
    setMoreMenuPos(computeMoreMenuPosition());
  }, []);

  const closeMoreMenu = useCallback(() => {
    const el = moreMenuRef.current;
    if (el?.open) el.open = false;
    setMoreMenuPos(null);
  }, []);

  /**
   * 菜单面板里的可聚焦项（纯 DOM 查询，语义过滤在 @/utils/menuKeyboard）。
   */
  const getMoreMenuItems = useCallback((): HTMLElement[] => {
    const panel = moreMenuPanelRef.current;
    if (!panel) return [];
    return Array.from(panel.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  }, []);

  /**
   * summary 上的键盘处理：把焦点**直接送进**菜单。
   *
   * ── 为什么必须显式接管 Tab ─────────────────────────────────────────────
   * 面板 portal 到 `document.body` 末尾 ⇒ DOM 序在所有卡片之后 ⇒
   * 从 summary 按 Tab 要穿过整个列表才进得去（实测 4 标签会话 16 次 Tab、
   * 15 标签会话 37 次 Tab）。这不是「Tab 序不理想」，是**功能不可达**：
   * 窄屏（<640px）下「重命名 / 锁定 / 删除会话」只存在于这个菜单里
   * （那三颗宽屏按钮都是 `hidden sm:inline-flex`）⇒ 菜单键盘不可达
   * = 这三个功能在窄屏**完全无法使用**。
   *
   * 为什么不把面板搬回卡内（那样 Tab 序自然就对了）：
   * 实测那样会**破坏菜单** —— 外层 wrapper 带 `content-visibility: auto`
   * （paint containment）会把超出 wrapper 盒的面板**裁掉**（命中测试落在
   * 背后的标签行上），而会话卡又带永久 `transform`（fadeInUp 的 to 帧
   * translateY(0) + forwards）⇒ 卡成了 `position: fixed` 的包含块，
   * 视口定位全错。portal 是唯一可靠解（见下方 createPortal 的注释）。
   *
   * 所以：**portal 保留，Tab 序用焦点管理修**。
   *   · 菜单关着时按 ↓ / Enter / Tab → 打开菜单并把焦点送进第一项；
   *   · 菜单开着时按 Tab → 在菜单项之间循环（不逃到页面其它地方）；
   *   · 菜单开着时按 Esc → 关菜单并把焦点还给 summary。
   */
  const handleMoreMenuTriggerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const el = moreMenuRef.current;
      if (!el) return;

      // 菜单**已经打开**时，summary 上的 ↓ / Enter / Space / Tab
      // 都应当进入菜单第一项。
      if (el.open) {
        if (
          e.key === 'ArrowDown' ||
          e.key === 'Enter' ||
          e.key === ' ' ||
          e.key === 'Tab'
        ) {
          const items = getMoreMenuItems();
          if (items.length === 0) return;
          e.preventDefault();
          items[0].focus();
        }
        return;
      }

      // 菜单关着时：↓ / Enter / Space / Tab 打开并进入第一项。
      //
      // Tab 必须在其中：面板 portal 到 body 末尾 ⇒ DOM 序在所有卡片之后 ⇒
      // 不接管的话，从 summary 按 Tab 要穿过整个列表才进得去
      // （实测 4 标签会话 16 次 Tab、15 标签会话 37 次 Tab）——
      // 而窄屏下「重命名 / 锁定 / 删除会话」**只**存在于这个菜单里。
      const opens = ['ArrowDown', 'Enter', ' ', 'Tab'].includes(e.key);
      if (!opens) return;

      e.preventDefault();
      el.open = true;
      // 坐标要在 open 之后算（面板尺寸依赖 open 状态）。
      setMoreMenuPos(computeMoreMenuPosition());
      // 等 React 把 portal 面板挂上来再聚焦。
      requestAnimationFrame(() => {
        const items = getMoreMenuItems();
        if (items.length > 0) items[0].focus();
      });
    },
    [getMoreMenuItems]
  );

  // 外部点击 / Esc 关闭（挂在 document 上，只在菜单打开时监听）。
  useEffect(() => {
    const el = moreMenuRef.current;
    if (!el) return;
    const onDocClick = (e: MouseEvent) => {
      if (!el.open) return;
      const target = e.target as Node | null;
      if (target && !el.contains(target)) closeMoreMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && el.open) {
        e.stopPropagation();
        closeMoreMenu();
        // 焦点还给 summary（菜单的触发点）。
        //
        // 为什么必须在这里统一做：面板自己的 keydown 处理器只在**焦点在面板里**
        // 时才触发；而焦点可能在 summary 上（↓ 打开后未进菜单、或 Tab 前的瞬间）。
        // 只在面板里还焦 ⇒ 两条路径不一致。
        moreMenuButtonRef.current?.focus();
      }
    };
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [closeMoreMenu]);

  /**
   * 菜单面板的键盘模型（2026-10-20 键盘可达性修复）。
   *
   * 修复前：这个面板声明了 `role="menu"`，子项却是普通 button ——
   * AX 树读作「菜单」但子项没有 menuitem 语义；方向键完全无反应
   * （实测 8 次 ArrowDown 焦点纹丝不动）。
   *
   * 为什么原先方向键不工作：HeaderDropdown 的方向键处理器只作用于**它自己**
   * 容器内的 `[role="menuitem"]`，而卡片菜单的子项不在那个容器里 ⇒ 没有任何
   * 处理器接管这里的事件。
   *
   * 现在补齐 APG 的菜单键盘约定：
   *   ↑/↓ 在菜单项之间移动（只选**可聚焦**的项）
   *   Home/End 跳到首/末项
   *   Enter/Space 触发当前项（button 的原生行为，这里不拦截）
   *   Tab 在菜单项之间循环（不逃到页面别处 —— 面板在 body 末尾，
   *     不接管的话 Tab 会一路跑到页面最后）
   *   Esc 关菜单并把焦点还给 summary
   */
  useEffect(() => {
    const panel = moreMenuPanelRef.current;
    if (!panel) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const items = getMoreMenuItems();
      if (items.length === 0) return;

      const active = document.activeElement as HTMLElement | null;
      const currentIndex = active ? items.indexOf(active) : -1;

      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeMoreMenu();
        // 焦点还给 summary（菜单的触发点），否则焦点会掉到 body。
        moreMenuButtonRef.current?.focus();
        return;
      }

      if (event.key === 'Tab') {
        const focusable = items.filter(item => item.tabIndex >= 0);
        if (focusable.length === 0) return;
        const pos = active ? focusable.indexOf(active) : -1;
        const atLast = pos === focusable.length - 1;

        // Tab 到**最后一项** ⇒ 关菜单并把焦点送到 summary 在页面里的下一个
        // 可聚焦元素（与 APG「Tab 关菜单、焦点前进」一致）。
        // 不这么做的话，Tab 会在菜单里无限循环 —— 用户**出不去**了。
        if (!event.shiftKey && atLast) {
          event.preventDefault();
          const trigger = moreMenuButtonRef.current;
          closeMoreMenu();
          if (trigger && !focusTabOrderSibling(trigger, 1)) {
            // 页面后面没有可聚焦元素了 ⇒ 焦点退回 trigger（至少不丢到 body）。
            trigger.focus();
          }
          return;
        }

        // 其余情况：Tab 在菜单项之间循环，不逃到页面别处。
        event.preventDefault();
        const next = event.shiftKey
          ? (pos <= 0 ? focusable.length - 1 : pos - 1)
          : (pos === -1 ? 0 : pos + 1);
        focusable[next].focus();
        return;
      }

      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;

      // 只让**可聚焦**的项参与导航（role="menuitem" 但 tabIndex=-1 的必须排除）。
      const focusableIndices = collectFocusableMenuItemIndices(panel);
      if (focusableIndices.length === 0) return;

      const decision = resolveMenuNavigation(
        focusableIndices,
        currentIndex,
        event.key as 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'
      );
      if (decision.kind === 'none') return;
      event.preventDefault();
      items[decision.index].focus();
    };

    panel.addEventListener('keydown', handleKeyDown);
    return () => {
      panel.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeMoreMenu, getMoreMenuItems, moreMenuPos]);

  const handleLockedDragBlocked = useCallback(() => {
    showRestoreError('会话已锁定，解锁后才能移动其中的标签');
  }, [showRestoreError]);

  /**
   * 「拖走最后一条标签会整组删掉这个会话」——**不拦**（2026-10-19 回退）。
   *
   * 这条规则一直是产品的核心：会话是活的容器，搬走最后一条标签就意味着这个容器
   * 已经没有内容，随之消失。数据层从来没改过（`mutationOps.moveTab` 里「源组被搬空
   * ⇒ 整组物理移除」一直都在）。
   *
   * round 29（commit 4837492）曾在 UI 层架一道拦截：判据是
   * `confirmBeforeDelete && shouldAutoDeleteAfterTabRemoval`，然后拒绝这次拖拽并提示
   * 「请改用右侧删除按钮」。问题不在于那条判据算错了——它算得对——而在于它**拦掉了
   * 产品最核心的一条交互**：拖拽是连续手势，被拒绝之后用户要做的是「换个入口重做一遍
   * 同一个移动」。用了很多年的行为被一轮评审收走、且此后几轮都没被翻回来。
   *
   * 产品负责人 2026-10-19 明确要求恢复：**直接删除，不加确认**。
   * 因此这里不再传 `onDragBlocked`，恢复 round 29 之前的行为。
   *
   * `onDragBlocked` 这个可选 prop 本身保留在 DraggableTab 上（不删机制），
   * 将来若要临时加回某种「拖拽前的保护」，接上这个 prop 即可，不必再改一次组件。
   *
   * 锁定会话仍不走这条路：锁定组的标签渲染层不提供删除/拖出
   * （DraggableTab 的 `draggable={!locked}` + 拖拽入口的锁定闸，见
   * handleLockedDragBlocked；2026-10-19 审计 F-3 之前这里是**只挡住了删除、
   * 没挡住拖出**，与本段注释相反），
   * 数据层 `shouldAutoDeleteAfterTabRemoval` 也对锁定组豁免 —— 这两条与本次回退无关，
   * 一直是「锁定 = 组内不发生删除」的产品语义。
   */

  // 格式化时间
  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) return '今天';
    if (days === 1) return '昨天';
    if (days < 7) return `${days} 天前`;
    if (days < 30) return `${Math.floor(days / 7)} 周前`;
    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  };

  return (
    <div
      ref={cardRef}
      className="tab-group-card animate-in group/card micro-interaction-card"
      role="region"
      aria-labelledby={`tab-group-title-${group.id}`}
    >
      {/* 标签组头部 */}
      <div className="tab-group-header gap-2">
        <div className="flex items-center gap-2 sm:gap-3 flex-1 min-w-0">
          {/* 折叠按钮 */}
          <Tooltip content={isCollapsed ? '展开这个会话的标签页' : '收起这个会话的标签页'}>
            <button
              onClick={() => setIsCollapsed(!isCollapsed)}
              className="btn-icon theme-btn-hover -ml-1 micro-interaction-button"
              // ── 2026-10-20 可访问名：带上会话名 ──────────────────────────
              // 原先所有卡的折叠按钮都叫「折叠会话」：3 张卡 ⇒
              // ["折叠会话", "折叠会话", "折叠会话"] ⇒ 读屏用户按按钮列表
              // 时完全分不出是哪张卡（同一行的 summary 就带了会话名）。
              // 现在是「折叠会话：{会话名}」。
              aria-label={isCollapsed ? `展开会话：${group.name}` : `折叠会话：${group.name}`}
              aria-expanded={!isCollapsed}
            >
              <svg
                className={`w-4 h-4 transition-transform duration-300 ease-out ${isCollapsed ? '-rotate-90' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </Tooltip>

          {/* ── 2026-10-22 审计 U-15：卡片的视觉身份 ────────────────────────
              favicon 取「域名占多数」的那个标签（pickDominantTab），
              与会话名同一把尺子 ⇒ 图标与名字不会自相矛盾。

              缺 favicon 时**整块不渲染**（不留灰方块占位）——
              占位方块会让人以为「这里本该有个图标但没加载出来」，
              而事实是「这个会话确实没有图标」。

              装饰性图片 ⇒ alt=""（不参与读屏朗读；站点的名字由标题承担）。 */}
          {showFavicons && dominantTab?.favicon && (
            <SafeFavicon
              src={dominantTab.favicon}
              alt=""
              className="w-4 h-4 shrink-0 rounded"
            />
          )}

          {/* 标题 */}
          {isEditing ? (
            <input
              type="text"
              value={newName}
              onChange={handleNameChange}
              onBlur={handleNameSubmit}
              onKeyDown={handleKeyDown}
              className="input py-1 px-2 text-sm font-medium flex-1"
              autoFocus
              aria-label="编辑会话名称"
            />
          ) : (
            <div className="min-w-0 flex items-center gap-2">
              {/* ── 2026-10-22 审计 L-8：标题承担「点击重命名」，语义要跟上 ──
                  原先这是一个 `tabIndex={0}` + onClick 的 <h3>，**没有任何角色**：
                  读屏把它念成「三级标题 React 19 升级 PR」，用户既不知道它可交互，
                  也不知道按 Enter 会发生什么。

                  修法（不加 aria-label，这是有意的）：
                  · 加 `role="button"` ⇒ 读屏会说「…，按钮」。
                  · **不加 aria-label** ⇒ 按钮的可访问名仍由文本内容给出，
                    于是卡片 region 的 `aria-labelledby`（指向这个 h3）
                    算出来的名字**不变**（仍是「React 19 升级 PR」）。
                    若加了 aria-label，region 的名字会变成
                    「重命名会话：React 19 升级 PR」—— 卡片在读屏的导航列表里
                    就会以「一个动作」而不是「一个会话」出现，更糟。
                  · 动作说明走 `aria-describedby`（读屏会补一句），
                    不污染 region 的名字。
                  · 锁定态：标题**不可交互** ⇒ 不给 role、不进 Tab 序、
                    去掉 pointer 光标与 hover 变色。
                    原先锁定会话的标题仍带 cursor-pointer 与 hover 高亮，
                    点了却什么都不发生（`!group.isLocked`）——
                    看起来可点、实际不可点，是最坏的一种组合。 */}
              {/* ── 2026-10-22 审计 U-18：原生 title= 换成仓里的 <Tooltip> ──
                  原生 title：≈1s 延迟、样式不可控、**触屏永远不出现** ——
                  而卡片头恰恰是新手最需要提示的地方（它同时也是「点标题改名」
                  这个隐藏交互的唯一线索）。
                  用套里的 Tooltip：300ms、跟随主题、触屏可点出来。

                  ⚠️ 包装层要带 min-w-0：它是 flex item，不给 min-w-0 就不会
                  收缩 ⇒ 长会话名会把整张卡撑破（标题的 truncate 会失效）。 */}
              <Tooltip
                content={group.isLocked ? '会话已锁定，先解锁才能重命名' : '点击编辑会话名称'}
                className="min-w-0"
              >
                <h3
                  id={`tab-group-title-${group.id}`}
                  className={`tab-group-title truncate transition-colors flat-interaction min-w-0 ${
                    group.isLocked
                      ? ''
                      : 'cursor-pointer tab-group-title-hover'
                  }`}
                  onClick={() => !group.isLocked && setIsEditing(true)}
                  {...(group.isLocked
                    ? {}
                    : {
                        role: 'button',
                        tabIndex: 0,
                        'aria-describedby': `tab-group-title-hint-${group.id}`,
                        onKeyDown: (e: React.KeyboardEvent) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setIsEditing(true);
                          }
                        },
                      })}
                >
                  {group.name}
                </h3>
              </Tooltip>
              {!group.isLocked && (
                <span id={`tab-group-title-hint-${group.id}`} className="sr-only">
                  激活后可重命名此会话
                </span>
              )}
            </div>
          )}

          {/* 数量徽章（showTabCount 关掉时不渲染） */}
          {showTabCount && (
            <span
              className="tab-group-count flex-shrink-0"
              aria-label={`包含 ${group.tabs.length} 个标签页`}
            >
              {/* ── 2026-10-23 审计 H-10：徽章不能是**裸数字** ────────────────
               * 原先这里只渲染 `{group.tabs.length}` ⇒ 视觉上就是一个「2」，
               * 而顶栏同时挂着「1 会话」和「2 个标签页」两个数字 ⇒
               * 用户扫卡片时会把卡头的「2」本能地读成「会话数」
               * （它长在会话卡上呀），而它其实是**标签数**。
               * 读屏用户反而知道（aria-label 说了「包含 N 个标签页」）。
               *
               * ⇒ 补上**视觉单位**，与顶栏 / 保存提示同一口径（「N 个标签页」）。
               *   不用原生 `title` 兜底：上一轮 U-18 刚把原生 title 换成仓里的
               *   <Tooltip>（原生 title ≈1s 延迟、触屏根本不出现）。
               *   既然单位已经**看得见**了，悬停提示就不必再补一句。 */}
              {group.tabs.length} 个标签页
            </span>
          )}

          {/* ── 2026-10-22 审计 U-11：锁定态必须**看得见** ──────────────────
              图标继续表示**当前状态**（闭锁＝已锁）—— 这是 Material / Lucide /
              SF Symbols 的通用约定，用户扫一屏卡片时正是靠形状判断「哪个被锁了」。
              审计建议的「永远画闭锁」被产品负责人否决：它会把「形状＝状态」
              这条用户已经建立的读法反过来。

              所以补的是真正的缺口 —— 让锁定态**在视觉上可区分**：
                · 一个 accent 淡染底的徽章（accent 色，不是中性灰）；
                · 闭锁图形（与未锁定时的开锁图形形态完全不同）；
                · 未锁定时这个位置**什么都没有**。
              一屏卡片里，哪些被锁了，一眼扫得出来。

              配色用工具类直接给（accent-wash 底 + accent-text 墨）：
              `tab-group-lock-icon` 那个 class 读的是 --color-warning（琥珀），
              且 3 套主题各自覆写它 —— 与「accent 强调」的口径对不上，
              这里就不复用它（搜索页仍在用，不受影响）。 */}
          {group.isLocked && (
            <span
              className="tab-group-lock-badge flex-shrink-0 inline-flex items-center justify-center rounded p-0.5 bg-[var(--color-accent-wash)] text-[var(--color-accent-text)]"
              aria-label="会话已锁定"
            >
              <LockIcon locked={true} />
            </span>
          )}

          {/* 时间 */}
          <span className="tab-group-time hidden sm:block flex-shrink-0">
            {formatTime(group.createdAt)}
          </span>
        </div>

        {/* 操作按钮。
            ── 2026-10-19 审计 V-3：窄屏降级 ──────────────────────────────
            修复前这里是 6 颗 36px 的图标按钮（折叠 + 恢复×2 + 重命名 + 锁定 +
            删除），在 400px 宽的窗口里占掉 216px / 366px 的卡宽，
            标题被压到只剩 74px（截断到 5 个汉字），而两个「打开」图标在
            16px 下几乎同形（用户分不清「新窗口恢复」与「当前窗口打开」）。

            窄屏（<640px）只留两颗最常用的：**恢复整个会话** 与 **更多**
            （一个 ⋯ 菜单承载重命名 / 锁定 / 删除）。恢复是零学习成本的
            核心「找回」动作，必须常驻；其余是低频操作，收进菜单是
            桌面端软件的标准做法。

            宽屏（≥640px）保持 5 颗全平铺 —— 桌面上横向空间充足，
            平铺的「一眼看全」比菜单更好。 */}
        {/* ── 2026-10-19 审计 P0-2：操作区必须能浮到标签列表之上 ──────────
         *
         * 卡内 DOM 顺序是「卡头（含操作区）→ 标签列表」，而标签列表**在后面**。
         * 两者都非定位元素时，后者画在上层；于是「更多」菜单（absolute 定位）
         * 虽然 z-30，仍被紧随其后的标签行盖住 —— 实测窄屏下「删除会话」
         * 那一行 elementFromPoint 命中的是背后的标签行，**完全点不到**。
         *
         * 给操作区 `relative z-30`：它成为卡内的定位上下文，菜单从中溢出
         * 到卡片之外，且层级高于标签列表。
         */}
        <div className="relative z-30 flex items-center gap-0.5 sm:gap-1 opacity-100 transition-all duration-200 ease-out flex-shrink-0">
          {/* 恢复全部（新窗口）—— 核心动作，窄屏也常驻。

              ── 2026-10-22 审计 U-10（两枚「打开」图标 16px 下近乎同形）──
              硬要求：**形状上**要能分，遮住颜色也能分。
                · 本图标 = 框 + **穿出框外**的箭头（另开一个窗口）；
                · 另一个 = **闭合的**框 + 框**内**的箭头（就地打开）。
              两者的轮廓因此根本不同：一个有笔画伸到框外，一个所有笔画都在框里。

              另加一层「填充」区分：这是**主操作**（整个产品的「找回」入口），
              所以用 accent 实底 + 反色图标（.theme-cta）；另一个保持描边。
              ⇒ 形状 + 填充两重编码，16px 下绝不含糊。

              ── 2026-10-22 审计 U-18（两套 tooltip 节奏）────────────────
              原生 `title=` 换成仓里的 <Tooltip>（300ms、样式可控、
              **触屏也能出现** —— 原生 title 在触屏上永远不出现，
              而卡片头恰恰是新手最需要提示的地方）。
              aria-label 原本保持不变（读屏文案不动）——
              WC-1 起它**也带后果**（读屏用户看不到 tooltip，见下）。

              ── 2026-10-23 审计 WC-1（后果说明必须按锁定态分流）──────────
              tooltip 与 aria-label 都**带上后果**，而且后果的措辞取自
              共享模块（restoreOutcomeSentence）——
              那儿按锁定态分两种说法，与成功提示用**同一个短语**。
              修复前这两处**不看 isLocked**（锁定会话的按钮也写着「会被移除」），
              而锁定恰恰是本产品**唯一**能让恢复后不被消费的开关
              （consumeSession 里 `if (group.isLocked) return;`），
              它的说明书不该劝退用户。

              aria-label 也带后果：读屏用户**看不到** tooltip。 */}
          <Tooltip
            content={`在新窗口恢复整个会话（${restoreOutcomeSentence(group.isLocked)}）`}
          >
            <button
              onClick={handleOpenAllTabs}
              className="btn-icon theme-cta micro-interaction-button"
              aria-label={`在新窗口恢复整个会话，共 ${group.tabs.length} 个标签页（${restoreOutcomeSentence(group.isLocked)}）`}
            >
              <OpenAllIcon />
            </button>
          </Tooltip>

          {/* 在当前窗口打开 —— 宽屏常驻，窄屏收进「更多」。
              Tooltip 的包装层负责窄屏隐藏（`hidden sm:inline-flex`）——
              包装层 display:none 时按钮与提示条一起消失，不会在窄屏
              留下一个 0 宽的 flex 项（那会让操作区多出一道空隙）。 */}
          <Tooltip
            content={`在当前窗口打开整个会话（标签会加到当前窗口；${restoreOutcomeSentence(group.isLocked)}）`}
            className="hidden sm:inline-flex"
          >
            <button
              onClick={handleOpenAllTabsInCurrentWindow}
              className="btn-icon theme-btn-hover micro-interaction-button"
              aria-label={`在当前窗口打开整个会话，共 ${group.tabs.length} 个标签页（${restoreOutcomeSentence(group.isLocked)}）`}
            >
              <OpenAllInPlaceIcon />
            </button>
          </Tooltip>

          {/* 编辑 —— 宽屏常驻，窄屏收进「更多」。
              锁定时这个按钮**不渲染**（锁定承诺「防误删」，
              重命名会改掉用户自己标记过的名字）⇒ 提示层也不渲染，
              免得留下一个 0 宽的 flex 项。 */}
          {!group.isLocked && (
            <Tooltip content="重命名这个会话" className="hidden sm:inline-flex">
              <button
                onClick={() => setIsEditing(true)}
                className="btn-icon theme-btn-hover micro-interaction-button"
                aria-label="重命名会话"
              >
                <EditIcon />
              </button>
            </Tooltip>
          )}

          {/* 锁定/解锁 —— 宽屏常驻，窄屏收进「更多」。
              ── 2026-10-22 审计 U-11：tooltip 必须**同时说明当前状态和
              点了会发生什么**。原文案只有「锁定会话」三个字，
              用户不知道锁定意味着什么（恢复后还在？会被清理？）。
              锁定态另有 accent 徽章 + 闭锁图形（形状差异），
              这里 tooltip 补的是「后果」那一半。 */}
          <Tooltip
            content={group.isLocked ? LOCK_TOOLTIP.locked : LOCK_TOOLTIP.unlocked}
            className="hidden sm:inline-flex"
          >
            <button
              onClick={handleToggleLock}
              className={`btn-icon micro-interaction-button ${group.isLocked ? 'tab-group-lock-icon' : ''}`}
              aria-label={group.isLocked ? '解锁会话' : '锁定会话'}
            >
              <LockIcon locked={group.isLocked} />
            </button>
          </Tooltip>

          {/* 删除 —— 宽屏常驻，窄屏收进「更多」。
              ── 2026-10-20 审计 A-3：锁定会话**也**保留这个入口 ──────────────
              修复前这里被 `{!group.isLocked && (…)}` 包住 ⇒ 锁定后整张卡
              没有任何删除入口，用户必须先解锁才能删。于是「锁定」的实际
              语义变成了「不可删除」—— 而用户锁定的动机恰恰是「这个重要，
              别弄丢」。锁定保护的是**会话内部**（不可重命名 / 不可逐条删 /
              不可拖走 / 不参与清理重复），不是「这张卡不许消失」。
              删除锁定会话仍是**允许**的，只是要走更重的确认
              （见 handleDelete 与 lockedDeleteCopy）。 */}
          <Tooltip
            content={`${deleteGroupEntryLabel(group.isLocked)}（删除后无法恢复）`}
            className="hidden sm:inline-flex"
          >
            <button
              ref={cardActionRef}
              onClick={handleDelete}
              className="btn-icon tab-group-action-danger micro-interaction-button"
              aria-label={deleteGroupEntryLabel(group.isLocked)}
            >
              <DeleteIcon />
            </button>
          </Tooltip>

          {/* 窄屏「更多」菜单：承载上面收起来的那几项。
              用原生 <details> 而不是自造弹层 —— 它自带键盘可达性
              （Enter 展开、Esc 关闭、Tab 可进），不引入新的焦点管理负担。 */}
          <details className="sm:hidden relative" ref={moreMenuRef}>
            <summary
              ref={moreMenuButtonRef as never}
              className="btn-icon theme-btn-hover micro-interaction-button list-none cursor-pointer"
              aria-label={`${group.name} 的更多操作`}
              aria-haspopup="menu"
              aria-expanded={moreMenuPos !== null}
              onClick={handleMoreMenuToggle}
              // Tab 从 summary 直接进菜单的第一项 —— 见下方「Tab 序」注释。
              onKeyDown={handleMoreMenuTriggerKeyDown}
            >
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 12.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 18.75a.75.75 0 110-1.5.75.75 0 010 1.5z" />
              </svg>
            </summary>
          </details>
        </div>
      </div>

      {/* 窄屏「更多」菜单面板（2026-10-19 审计 P0-2）：portal 到 body ──────
       *
       * 为什么必须 portal：会话卡的 `animate-in` 动画带 `transform`
       * （fadeInUp 的 to 帧是 translateY(0)，`forwards` 让它永久保留），
       * 于是**每张卡都是一个 stacking context**。面板若是卡的子元素，
       * 它的 z-index 只在卡内有效 —— 无论 z-30 还是 z-40，都压不过
       * 后面那张卡（实测窄屏下「删除会话」那一行 elementFromPoint 命中的是
       * 背后的标签行，完全点不到）。
       *
       * portal 到 body + position: fixed 让它脱离所有卡的层叠上下文，
       * 由 z-index 直接与页面内容比较 —— 这才是真正可靠的解法。
       */}
      {moreMenuPos &&
        createPortal(
          <div
            ref={moreMenuPanelRef}
            role="menu"
            aria-label={`${group.name} 的更多操作`}
            style={{
              position: 'fixed',
              top: moreMenuPos.top,
              left: moreMenuPos.left,
              zIndex: 9999,
            }}
            className="w-44 rounded-lg border theme-border-default theme-bg-elevated theme-shadow-panel py-1"
            onClick={e => e.stopPropagation()}
          >
            <button
              role="menuitem"
              onClick={() => {
                closeMoreMenu();
                handleOpenAllTabsInCurrentWindow();
              }}
              className="w-full px-3 py-2 text-left text-sm theme-text-secondary transition-colors hover:theme-btn-hover"
            >
              在当前窗口打开
            </button>
            {!group.isLocked && (
              <button
                role="menuitem"
                onClick={() => {
                  closeMoreMenu();
                  setIsEditing(true);
                }}
                className="w-full px-3 py-2 text-left text-sm theme-text-secondary transition-colors hover:theme-btn-hover"
              >
                重命名会话
              </button>
            )}
            <button
              role="menuitem"
              onClick={() => {
                closeMoreMenu();
                handleToggleLock();
              }}
              className="w-full px-3 py-2 text-left text-sm theme-text-secondary transition-colors hover:theme-btn-hover"
            >
              {group.isLocked ? '解锁会话' : '锁定会话'}
            </button>
            {/* 删除 —— 锁定会话**也**给入口（2026-10-20 审计 A-3）。
                与宽屏那颗按钮同一口径：锁定 ≠ 不可删除，锁定只是让这次
                删除要走更重的确认。窄屏用户不该因为屏幕窄就被剥夺
                「删掉它」的能力，只能靠「先解锁再删」绕路。 */}
            <button
              role="menuitem"
              onClick={() => {
                closeMoreMenu();
                handleDelete();
              }}
              className="w-full px-3 py-2 text-left text-sm theme-text-danger transition-colors hover:theme-btn-hover"
            >
              {deleteGroupEntryLabel(group.isLocked)}
            </button>
          </div>,
          document.body
        )}

      {/* 标签列表。
          折叠态必须**不渲染**可交互子元素，而不是靠 CSS/aria 藏起来：
          `max-h-0 opacity-0` 只改视觉，`aria-hidden` 只改读屏曝光，两者都不影响 Tab 序列。
          1.22.0 起删除即物理移除（无回收站、无撤销），一旦 Tab 进看不见的折叠组、
          误按 Enter 就是静默真删。React 18 尚无原生 inert 属性，条件渲染是唯一可靠手段。

          ── 2026-10-05 折叠动画改用 grid-rows，不再有高度上限 ──
          旧实现是 max-height 在 0 与 2000px 之间切换。但 2000px 是个**硬编码魔数**：
          行距 44px（lazyTabRows.TAB_ROW_STRIDE_PX）⇒ 2000/44 ≈ 45.5 行，
          超过 45 个标签的会话展开后**尾部被裁掉且无法滚动到**
          （本组件内没有任何 overflow-y-auto），对一个「一次收纳整窗标签」的
          产品这是常见路径。lazyTabRows 的占位高度算的是「行数 × 44」精确值，
          却被这同一个父级裁掉，两边承诺自相矛盾。

          grid 方案：grid-template-rows 0fr → 1fr 由浏览器在两态间插值，
          不需要任何具体像素上限（内容多高就展开到多高），折叠动画仍然保留。
          （注：这里刻意不写出旧类名的完整字面量——Tailwind 的 content 扫描
          会把注释里的类名也提取成规则，白白进产物。） */}
      <div
        className={`grid transition-all duration-300 ease-out ${
          isCollapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'
        }`}
        aria-hidden={isCollapsed}
      >
        {!isCollapsed && (
          /* grid 0fr→1fr 过渡要求直接子元素有 min-height:0 与 overflow:hidden，
             否则内容会把轨道撑开、折叠失效（这层是动画必需，不是多余包装） */
          <div className="min-h-0 overflow-hidden">
            <div
              className="tab-group-tabs-container"
              role="list"
              aria-label="会话内的标签页，可用上下方向键调整顺序"
            >
              {renderRows ? (
                group.tabs.map((tab, index) => (
                  <DraggableTab
                    key={tab.id}
                    tab={tab}
                    groupId={group.id}
                    index={index}
                    itemCount={group.tabs.length}
                    locked={group.isLocked}
                    removesWholeSession={soleActiveTabId !== null && soleActiveTabId === tab.id}
                    moveTab={handleMoveTab}
                    handleOpenTab={handleOpenTab}
                    handleDeleteTab={handleDeleteTab}
                    onLockedDragBlocked={handleLockedDragBlocked}
                  />
                ))
              ) : (
                /* 远离视口：用等高占位撑住文档高度，不把上千个行节点放进 DOM。
                   高度是**精确值**（行数 × 实测行高），不是估算，因此总高与全量渲染
                   逐像素一致，滚动位置不会漂移（见 lazyTabRows.resolveRowWindow 单测）。
                   role="presentation" 是必需的：否则读屏会在 role="list" 里念到一个
                   没有 listitem 角色的空节点。 */
                <div
                  role="presentation"
                  data-lazy-placeholder="true"
                  style={{ height: placeholderHeight }}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  const basicPropsEqual =
    prevProps.group.id === nextProps.group.id &&
    prevProps.group.name === nextProps.group.name &&
    prevProps.group.isLocked === nextProps.group.isLocked &&
    prevProps.group.tabs.length === nextProps.group.tabs.length &&
    prevProps.group.updatedAt === nextProps.group.updatedAt &&
    prevProps.group.createdAt === nextProps.group.createdAt;

  if (!basicPropsEqual) return false;

  if (prevProps.group.tabs.length === nextProps.group.tabs.length) {
    for (let i = 0; i < prevProps.group.tabs.length; i++) {
      const prevTab = prevProps.group.tabs[i];
      const nextTab = nextProps.group.tabs[i];

      if (
        prevTab.id !== nextTab.id ||
        prevTab.title !== nextTab.title ||
        prevTab.url !== nextTab.url ||
        prevTab.favicon !== nextTab.favicon
      ) {
        return false;
      }
    }
  }

  return true;
});
