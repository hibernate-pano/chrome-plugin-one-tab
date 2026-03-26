import { storage } from '@/utils/storage';

export type ProductEventName =
  | 'onboarding_completed'
  | 'onboarding_skipped'
  | 'session_saved'
  | 'session_renamed'
  | 'session_restored'
  | 'session_restored_again'
  | 'search_performed'
  | 'search_filtered'
  | 'session_favorited'
  | 'session_note_saved'
  | 'sync_upload_started'
  | 'sync_upload_completed'
  | 'sync_download_started'
  | 'sync_download_completed'
  | 'onetab_import_completed';

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
    console.error('记录产品事件失败:', error);
  }
};
