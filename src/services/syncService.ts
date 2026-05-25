import { smartSyncService } from './smartSyncService';
import { errorHandler } from '@/utils/errorHandler';

/**
 * 同步服务包装器
 * 手动同步入口 + 自动同步由 Redux middleware 驱动
 */
class SyncService {
  async initialize() {
    await smartSyncService.initialize();
  }

  // 检查云端是否有数据
  async hasCloudData() {
    return smartSyncService.hasCloudData();
  }

  // 检查本地是否有数据
  async hasLocalData() {
    return smartSyncService.hasLocalData();
  }

  // 手动上传数据到云端
  async uploadToCloud(background = false, overwriteCloud = true) {
    return smartSyncService.uploadToCloud(background, overwriteCloud);
  }

  // 手动从云端下载数据
  async downloadFromCloud(background = false, overwriteLocal = false) {
    return smartSyncService.downloadFromCloud(background, overwriteLocal);
  }

  // 下载数据（使用智能同步服务）
  async downloadAndRefresh(overwriteLocal = false) {
    try {
      const result = await smartSyncService.downloadFromCloud(false, overwriteLocal);
      return result;
    } catch (error) {
      // 使用 errorHandler 统一处理错误
      errorHandler.handle(error as Error, {
        showToast: false, // 不显示 toast，由调用方决定
        logToConsole: true,
        severity: 'medium',
        fallbackMessage: '下载数据失败'
      });
      
      return { success: false, error: error instanceof Error ? error.message : '下载失败' };
    }
  }
}

export const syncService = new SyncService();
