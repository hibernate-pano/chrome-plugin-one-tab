import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { updateGroupNameAndSync, toggleGroupLockAndSync, deleteGroup, deleteBroadcastWarn, deleteTabAndSync, moveTabAndSync } from '@/store/slices/tabSlice';
import { DraggableTab } from '@/components/dnd/DraggableTab';
import { TabGroup as TabGroupType, Tab } from '@/types/tab';
import { useToast } from '@/contexts/ToastContext';
import { useEnhancedToast } from '@/utils/toastHelper';
import { OpenGuard, OpenAllGuard } from '@/utils/openGuard';
import { isOpenableTabUrl } from '@/utils/inputValidation';
import { useNearViewport } from '@/hooks/useNearViewport';
import { resolveRowWindow } from './lazyTabRows';
import { trackProductEvent } from '@/utils/productEvents';
import { logError } from '../../utils/log';

interface TabGroupProps {
  group: TabGroupType;
}

// 图标组件
const EditIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
  </svg>
);

const LockIcon = ({ locked }: { locked: boolean }) => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    {locked ? (
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
    ) : (
      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 10.5V6.75a4.5 4.5 0 119 0v3.75M3.75 21.75h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
    )}
  </svg>
);

const DeleteIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
  </svg>
);

const OpenAllIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
  </svg>
);

const OpenAllInPlaceIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5M21 3v5.25M21 3h-5.25M21 3l-7.5 7.5" />
  </svg>
);

export const TabGroup: React.FC<TabGroupProps> = React.memo(({ group }) => {
  const dispatch = useAppDispatch();
  const confirmBeforeDelete = useAppSelector(state => state.settings.confirmBeforeDelete);
  const { showConfirm, showToast } = useToast();
  const { showDeleteError, showRestoreError } = useEnhancedToast();

  const [isEditing, setIsEditing] = useState(false);
  const [newName, setNewName] = useState(group.name);
  const [isCollapsed, setIsCollapsed] = useState(false);
  // 复活去重守卫（逻辑见 @/utils/openGuard，可单测）：单 tab 按 tabId 冷却去重，
  // 整组恢复按 group.id 加同类在途锁。组件卸载即丢弃，无需额外清理。
  const openGuardRef = useRef<OpenGuard | null>(null);
  const openAllGuardRef = useRef<OpenAllGuard | null>(null);
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
    const trimmed = newName.trim();
    // 名字没变就不写：既避免 Enter + blur 双触发时发两次 rename（第二次会拿到
    // 自己的乐观值当快照），也避免无意义的 version bump。
    if (trimmed !== '' && trimmed !== group.name) {
      void dispatch(updateGroupNameAndSync({ groupId: group.id, name: trimmed }))
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
    }
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
          showDeleteError(`删除会话失败: ${error.message || '未知错误'}`);
        });
    };

    if (!confirmBeforeDelete) {
      runDelete();
      return;
    }

    showConfirm({
      title: `删除「${group.name}」？`,
      message: `将永久删除该会话内的 ${group.tabs.length} 个标签记录，删除后无法恢复。确认继续吗？`,
      type: 'danger',
      confirmText: '删除',
      cancelText: '取消',
      onConfirm: runDelete,
      onCancel: () => { }
    });
  }, [confirmBeforeDelete, dispatch, group.id, group.name, group.tabs.length, showConfirm, showDeleteError]);

  const handleToggleLock = useCallback(() => {
    void dispatch(toggleGroupLockAndSync(group.id))
      .then(action => {
        if (toggleGroupLockAndSync.rejected.match(action)) {
          logError('切换锁定失败，已恢复原状态:', action.error);
          showToast('切换锁定失败，锁定状态已恢复', 'error');
        }
      })
      .catch(error => logError('切换锁定失败:', error));
  }, [dispatch, group.id, showToast]);

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
          showDeleteError(`恢复会话后清理原会话失败: ${error.message || '未知错误'}`);
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
          showDeleteError(`${r?.error || '恢复会话失败'}。原会话仍保留在列表中。`);
          return;
        }
        consumeSession();
        if (typeof r.skippedUnopenable === 'number' && r.skippedUnopenable > 0) {
          const keptNote = group.isLocked ? '它们仍保留在会话中。' : '这几个地址不再保存在列表中。';
          showDeleteError(
            `已恢复 ${tabsPayload.length - r.skippedUnopenable} 个标签；` +
              `另有 ${r.skippedUnopenable} 个在当前设备无法打开（本地文件、临时链接或` +
              `浏览器内部页面）。${keptNote}`
          );
        }
      }
    );
  }, [dispatch, group, showDeleteError, showRestoreError]);

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
      }).catch(error => {
        logError('打开标签失败:', error);
        showRestoreError(`打开失败：${error?.message || '未知错误'}`);
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
          showRestoreError(r.error || '打开失败，已保留在会话中');
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
          })
          .catch(error => {
            logError('打开后从会话移除失败:', error);
            showDeleteError(`标签已打开，但从会话移除失败: ${error.message || '未知错误'}`);
          });
      }
    );
  }, [dispatch, group, showRestoreError, showDeleteError]);

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
      })
      .catch(error => {
        logError('移动标签失败:', error);
        showDeleteError(`移动标签失败: ${error.message || '未知错误'}`);
      });
  }, [dispatch, showDeleteError]);

  const handleDeleteTab = useCallback((tabId: string) => {
    // 按钮在锁定组里已不渲染（见 DraggableTab 的 locked），这里是兵底：
    // 任何绕过 UI 的调用同样不许逐条删 —— 与整组删除按钮「锁定时不渲染」同口径。
    if (group.isLocked) {
      showDeleteError('会话已锁定，解锁后才能删除其中的标签');
      return;
    }
    dispatch(deleteTabAndSync({ groupId: group.id, tabId }))
      .unwrap()
      .then(payload => {
        const warn = deleteBroadcastWarn(payload);
        if (warn) showDeleteError(warn);
      })
      .catch(error => {
        showDeleteError(`更新会话失败: ${error.message || '未知错误'}`);
      });
  }, [dispatch, group.id, group.isLocked, showDeleteError]);

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
          <button
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="btn-icon theme-btn-hover p-1 -ml-1 micro-interaction-button"
            aria-label={isCollapsed ? '展开会话' : '折叠会话'}
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
              <h3
                id={`tab-group-title-${group.id}`}
                className="tab-group-title truncate cursor-pointer tab-group-title-hover transition-colors flat-interaction min-w-0"
                onClick={() => !group.isLocked && setIsEditing(true)}
                title={group.isLocked ? '会话已锁定，先解锁才能重命名' : '点击编辑会话名称'}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    if (!group.isLocked) setIsEditing(true);
                  }
                }}
              >
                {group.name}
              </h3>
            </div>
          )}

          {/* 数量徽章 */}
          <span 
            className="tab-group-count flex-shrink-0"
            aria-label={`包含 ${group.tabs.length} 个标签页`}
          >
            {group.tabs.length}
          </span>

          {/* 锁定图标 */}
          {group.isLocked && (
            <span 
              className="tab-group-lock-icon flex-shrink-0" 
              title="会话已锁定"
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

        {/* 操作按钮：恢复常驻，其余 hover 显。
            恢复是核心“找回”动作，零学习成本；触屏无 hover 窄屏常驻；
            键盘 focus-within 同样显形，避免对不可见控件盲操作。 */}
        <div className="flex items-center gap-0.5 sm:gap-1 opacity-100 transition-all duration-200 ease-out flex-shrink-0">
          {/* 恢复全部（新窗口） */}
          <button
            onClick={handleOpenAllTabs}
            className="btn-icon theme-btn-hover p-1.5 tab-group-action-accent micro-interaction-button"
            title="在新窗口恢复整个会话"
            aria-label={`在新窗口恢复整个会话，共 ${group.tabs.length} 个标签页`}
          >
            <OpenAllIcon />
          </button>

          {/* 在当前窗口打开 */}
          <button
            onClick={handleOpenAllTabsInCurrentWindow}
            className="btn-icon theme-btn-hover p-1.5 micro-interaction-button"
            title="在当前窗口打开整个会话"
            aria-label={`在当前窗口打开整个会话，共 ${group.tabs.length} 个标签页`}
          >
            <OpenAllInPlaceIcon />
          </button>

          {/* 编辑 */}
          {!group.isLocked && (
            <button
              onClick={() => setIsEditing(true)}
              className="btn-icon theme-btn-hover p-1.5 micro-interaction-button"
              title="重命名会话"
              aria-label="重命名会话"
            >
              <EditIcon />
            </button>
          )}

          {/* 锁定/解锁 */}
          <button
            onClick={handleToggleLock}
            className={`btn-icon p-1.5 micro-interaction-button ${group.isLocked ? 'tab-group-lock-icon' : ''}`}
            title={group.isLocked ? '解锁会话' : '锁定会话'}
            aria-label={group.isLocked ? '解锁会话' : '锁定会话'}
          >
            <LockIcon locked={group.isLocked} />
          </button>

          {/* 删除 */}
          {!group.isLocked && (
            <button
              onClick={handleDelete}
              className="btn-icon p-1.5 tab-group-action-danger micro-interaction-button"
              title="删除会话"
              aria-label="删除会话"
            >
              <DeleteIcon />
            </button>
          )}
        </div>
      </div>

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
                    moveTab={handleMoveTab}
                    handleOpenTab={handleOpenTab}
                    handleDeleteTab={handleDeleteTab}
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
