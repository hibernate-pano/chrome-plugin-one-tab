import React, { useEffect, useRef } from 'react';
import { useToast } from '@/contexts/ToastContext';
import { storage } from '@/utils/storage';
import { logWarn } from '@/utils/log';
import type { ToastType } from '@/components/common/Toast';
import type { PendingConflictNotice } from '@/core/mergeConflictDetect';

/**
 * 把待展示的冲突提示压成一句用户能看懂的话（导出供单测）。
 *
 * 措辞只陈述**事实**：「N 个会话同时被两台设备修改、整组覆盖后共丢 M 个标签」。
 * 不写「你的数据很危险」这类夸大，也不写「冲突已合并」这类会让人以为
 * 两边内容都在的假话（组级 LWW 只保留一侧）。
 */
export function buildConflictMessage(n: PendingConflictNotice): string {
  const names = n.groups
    .slice(0, 3)
    .map(g => `「${g.name}」`)
    .join('、');
  const more = n.groups.length > 3 ? ' 等' : '';
  const tail = names ? `：${names}${more}` : '';
  return (
    `同步冲突：${n.totalGroups} 个会话在两台设备上同时被修改，` +
    `整组覆盖后共 ${n.totalLostTabs} 个标签未能保留${tail}`
  );
}

/**
 * P0-1 冲突可见化：把后台记下的「并发覆盖」提示展示一次（读→展示→清除）。
 *
 * 两个触发时机：
 * ① popup 挂载时 —— 覆盖「后台同步时 popup 没开」的主场景；
 * ② 订阅 conflictNoticeChanged 总线 —— 覆盖「同步完成时 popup 正开着」的场景
 *   （手动点同步等结果）：后台落盘成功即广播，这里收到后重读并展示，
 *   不用等用户下次打开 popup。总线只说「可能有新提示」，内容自己重读
 *   —— 读不到（已被消费/已被清）就安静返回，天然幂等。
 *
 * 为什么挂在 AppContainer（ToastProvider 内）而不是某个业务页：冲突是全局
 * 事实，与用户当前在哪个标签页无关；只要 popup 开着就该看到。
 *
 * 生命周期纪律：每条提示**只展示一次**。shownRef 只防挂载路径在 StrictMode
 * 下的双调用（订阅路径靠「读不到就 return」幂等，不需要 ref）；清除失败也
 * 吞掉（下次再弹一次不致命，重复提示好过不提示…但这里选择吞错，避免弹错
 * 本身变成新故障）。
 */
async function consumePendingNotice(
  showToast: (message: string, type?: ToastType, duration?: number) => number
): Promise<void> {
  try {
    const notice = await storage.getPendingConflictNotice();
    if (!notice) return;
    showToast(buildConflictMessage(notice), 'warning', 8000);
    await storage.clearPendingConflictNotice();
  } catch (e) {
    logWarn('[SyncConflictNotifier]', e);
  }
}

export const SyncConflictNotifier: React.FC = () => {
  const { showToast } = useToast();
  const shownRef = useRef(false);

  useEffect(() => {
    if (!shownRef.current) {
      shownRef.current = true;
      void consumePendingNotice(showToast);
    }
    // popup 开着时后台落盘的新提示也要展示（总线广播）。
    // 总线走动态 import：它同时被 SW 引用 ⇒ 静态 import 会让 Rollup 把它切成
    // 两个入口的公共块并进 popup 的 modulepreload 清单，首屏 +3.1KB。
    // 订阅晚一个 chunk 加载（几十 ms，弹窗渲染之后）⇒ 对「同步刚完成」的
    // 场景仍然即时；广播是尽力而为的提示，晚到只是晚展示一次，不丢事实。
    let unsubscribed = false;
    let unsubscribe: (() => void) | null = null;
    void import('@/storage-kv/conflictNoticeBus')
      .then(({ subscribeConflictNoticeChanged }) => {
        if (unsubscribed) return;
        unsubscribe = subscribeConflictNoticeChanged(() => {
          void consumePendingNotice(showToast);
        });
      })
      .catch(e => logWarn('[SyncConflictNotifier]', e));
    return () => {
      unsubscribed = true;
      unsubscribe?.();
    };
  }, [showToast]);

  return null;
};