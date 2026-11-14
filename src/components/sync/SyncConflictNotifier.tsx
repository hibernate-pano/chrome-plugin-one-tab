import React, { useEffect, useRef } from 'react';
import { useToast } from '@/contexts/ToastContext';
import { storage } from '@/utils/storage';
import { logWarn } from '@/utils/log';
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
 * P0-1 冲突可见化：popup 挂载时把后台记下的「并发覆盖」提示展示一次。
 *
 * 为什么挂在 AppContainer（ToastProvider 内）而不是某个业务页：冲突是全局
 * 事实，与用户当前在哪个标签页无关；只要用户打开 popup 就该看到。
 *
 * 生命周期纪律：**只展示一次**（读→展示→清除）。用 ref 防 StrictMode 的
 * 双调用重复弹；清除失败也吞掉（下次再弹一次不致命，重复提示好过不提示…但
 * 这里选择吞错，避免弹错本身变成新故障）。
 */
export const SyncConflictNotifier: React.FC = () => {
  const { showToast } = useToast();
  const shownRef = useRef(false);

  useEffect(() => {
    if (shownRef.current) return;
    shownRef.current = true;
    (async () => {
      try {
        const notice = await storage.getPendingConflictNotice();
        if (!notice) return;
        showToast(buildConflictMessage(notice), 'warning', 8000);
        await storage.clearPendingConflictNotice();
      } catch (e) {
        logWarn('[SyncConflictNotifier] 读取/清除冲突提示失败:', e);
      }
    })();
  }, [showToast]);

  return null;
};
