import { smartSyncService } from './smartSyncService';
import { errorHandler } from '@/utils/errorHandler';

// 旧版同步服务，保留以维护向后兼容性
// 新功能请使用 smartSyncService
class SyncService {
  // 初始化同步服务 - 使用新的智能同步服务
  async initialize() {
    console.log('同步服务初始化：使用智能同步服务');
    // 初始化智能同步服务
    await smartSyncService.initialize({
      autoSync: true,
      syncInterval: 1 * 60 * 1000, // 1分钟（测试用）
      syncOnStartup: true,
      syncOnChange: true,
      conflictStrategy: 'newest'
    });
  }

  // 检查云端是否有数据
  async hasCloudData() {
    return smartSyncService.hasCloudData();
  }

  // 检查本地是否有数据
  async hasLocalData() {
    return smartSyncService.hasLocalData();
  }

  // 后台同步数据
  async backgroundSync() {
    return smartSyncService.syncAll(true);
  }

  // 上传数据到云端（覆盖模式）
  async uploadToCloud(background = false, overwriteCloud = true) {
    return smartSyncService.uploadToCloud(background, overwriteCloud);
  }

  // 从云端下载数据
  async downloadFromCloud(background = false, overwriteLocal = false) {
    return smartSyncService.downloadFromCloud(background, overwriteLocal);
  }

  // 同步所有数据
  async syncAll(background = true) {
    return smartSyncService.syncAll(background);
  }

  // 从云端同步数据
  async syncFromCloud(background = true) {
    return this.downloadFromCloud(background);
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
