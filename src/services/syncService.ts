import { smartSyncService } from './smartSyncService';
import { errorHandler } from '@/utils/errorHandler';

/**
 * 同步服务包装器 - 仅支持手动同步
 * 已移除所有自动同步功能
 */
class SyncService {
  // 初始化同步服务 - 简化版
  async initialize() {
    console.log('同步服务初始化：仅支持手动同步');
    // 初始化智能同步服务（仅加载最后同步时间）
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
