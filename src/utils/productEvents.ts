import { storage } from '@/utils/storage';
import { logError } from './log';

export type ProductEventName =
  | 'onboarding_completed'
  | 'onboarding_skipped'
  | 'session_saved'
  | 'session_renamed'
  | 'session_restored'
  | 'session_restored_again'
  | 'search_performed'
  | 'search_filtered'
  | 'sync_upload_started'
  | 'sync_upload_completed'
  | 'sync_download_started'
  | 'sync_download_completed'
  | 'onetab_import_completed';

// 2026-10-11 移除 `session_favorited` / `session_note_saved`（收藏与备注功能已于 1.22.13 下线）。
// 它们此前是**死事件名**：没有任何 trackProductEvent 调用点能产生它们，却仍留在诊断的封闭词表里，
// 于是「历史存量里若有这两个名字的事件」会被统计成「用户用了收藏」——
// 诊断文件是流向公开 issue 的，编出来的数据比没有数据更坏。
// 移除后它们按「词表外」处理：丢弃并计入 droppedUnknownNameCount（显式记账，不静默）。

export const trackProductEvent = async (
  name: ProductEventName,
  payload: Record<string, unknown> = {}
) => {
  try {
    await storage.appendProductEvent({
      name,
      payload,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    logError('记录产品事件失败:', error);
  }
};
