/**
 * 同步服务包装器（v1.12.0 简化版）
 *
 * 手动同步入口。所有核心同步逻辑委托给 SmartSyncService → SyncEngine。
 */

import { smartSyncService } from './smartSyncService';
import { errorHandler } from '@/utils/errorHandler';

class SyncService {
  async initialize() {
    await smartSyncService.initialize();
  }

  async hasCloudData() {
    return smartSyncService.hasCloudData();
  }

  async hasLocalData() {
    return smartSyncService.hasLocalData();
  }

  async uploadToCloud(background = false, _overwriteCloud = false) {
    return smartSyncService.uploadToCloud(background);
  }

  async downloadFromCloud(background = false, overwriteLocal = false) {
    return smartSyncService.downloadFromCloud(background, overwriteLocal);
  }

  async downloadAndRefresh(overwriteLocal = false) {
    try {
      return await smartSyncService.downloadFromCloud(false, overwriteLocal);
    } catch (error) {
      errorHandler.handle(error as Error, {
        showToast: false,
        logToConsole: true,
        severity: 'medium',
        fallbackMessage: '下载数据失败',
      });
      return { success: false, error: error instanceof Error ? error.message : '下载失败' };
    }
  }
}

export const syncService = new SyncService();
