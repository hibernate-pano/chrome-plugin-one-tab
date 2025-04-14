import { store } from '@/store';
import { syncTabsToCloud, syncTabsFromCloud } from '@/store/slices/tabSlice';
import { syncSettingsToCloud, syncSettingsFromCloud } from '@/store/slices/settingsSlice';
import { getCurrentUser } from '@/store/slices/authSlice';

class SyncService {
  // 初始化同步服务 - 已禁用自动同步
  async initialize() {
    console.log('同步服务初始化：已禁用自动同步功能，仅保留手动同步');
    // 不再自动同步，保证本地操作优先，避免卡顿
  }

  // 后台同步数据
  async backgroundSync() {
    return this.syncAll(true);
  }

  // 上传数据到云端（覆盖模式）
  async uploadToCloud(background = false, overwriteCloud = true) {
    const { auth } = store.getState();

    if (!auth.isAuthenticated) {
      console.warn('用户未登录，无法上传数据到云端');
      return;
    }

    try {
      console.log(`开始${background ? '后台' : ''}上传数据到云端${overwriteCloud ? '（覆盖模式）' : '（合并模式）'}...`);

      // 上传标签组数据
      console.log('正在上传标签组数据...');
      await store.dispatch(syncTabsToCloud({ background, overwriteCloud }));

      // 上传设置数据
      console.log('正在上传设置数据...');
      await store.dispatch(syncSettingsToCloud());

      console.log(`数据上传完成！${overwriteCloud ? '云端数据已被本地数据覆盖' : '本地数据已与云端数据合并'}`);
    } catch (error) {
      console.error('数据上传失败:', error);
      // 尝试重新获取用户信息，可能是会话过期
      try {
        await store.dispatch(getCurrentUser());
      } catch (e) {
        console.error('重新获取用户信息失败:', e);
      }
    }
  }

  // 从云端下载数据
  async downloadFromCloud(background = false, overwriteLocal = false) {
    const { auth } = store.getState();

    if (!auth.isAuthenticated) {
      console.warn('用户未登录，无法从云端下载数据');
      return;
    }

    try {
      console.log(`开始${background ? '后台' : ''}从云端下载数据${overwriteLocal ? '（覆盖模式）' : '（合并模式）'}...`);

      // 从云端同步设置
      console.log('正在从云端下载设置...');
      await store.dispatch(syncSettingsFromCloud());

      // 从云端同步标签组
      console.log('正在从云端下载标签组...');
      await store.dispatch(syncTabsFromCloud({ background, forceRemoteStrategy: overwriteLocal }));

      console.log(`从云端下载数据完成！${overwriteLocal ? '本地数据已被云端数据覆盖' : '云端数据已与本地数据合并'}`);
    } catch (error) {
      console.error('从云端下载数据失败:', error);
      // 尝试重新获取用户信息，可能是会话过期
      try {
        await store.dispatch(getCurrentUser());
      } catch (e) {
        console.error('重新获取用户信息失败:', e);
      }
    }
  }

  // 同步所有数据
  async syncAll(background = true) {
    const { auth } = store.getState();

    if (!auth.isAuthenticated) {
      console.warn('用户未登录，无法同步数据');
      return;
    }

    try {
      console.log(`开始${background ? '后台' : ''}同步数据...`);

      // 修改同步策略：以云端数据为准，同时智能合并本地数据
      // 1. 先将本地删除操作同步到云端，确保删除操作不会被覆盖
      // 2. 然后从云端同步数据，以云端数据为准
      // 3. 使用智能合并算法合并数据，去除重复项

      // 使用云端优先策略，使云端数据优先

      // 先将本地数据同步到云端
      console.log('正在将本地数据同步到云端...');
      await store.dispatch(syncTabsToCloud({ background }));
      await store.dispatch(syncSettingsToCloud());

      // 然后从云端同步设置
      console.log('正在从云端同步设置...');
      await store.dispatch(syncSettingsFromCloud());

      // 使用云端优先策略从云端同步标签组
      console.log('正在从云端同步标签组，以云端数据为准...');
      // 不再尝试修改 Redux 状态，而是在调用时传递参数
      await store.dispatch(syncTabsFromCloud({ background, forceRemoteStrategy: true }));

      console.log('数据同步完成！云端数据已成功同步并与本地数据智能合并去重');
    } catch (error) {
      console.error('数据同步失败:', error);
      // 尝试重新获取用户信息，可能是会话过期
      try {
        await store.dispatch(getCurrentUser());
      } catch (e) {
        console.error('重新获取用户信息失败:', e);
      }
    }
  }

  // 从云端同步数据
  async syncFromCloud(background = true) {
    return this.downloadFromCloud(background);
  }

  // 下载数据并刷新页面
  async downloadAndRefresh(overwriteLocal = false) {
    const { auth } = store.getState();

    if (!auth.isAuthenticated) {
      console.warn('用户未登录，无法从云端下载数据');
      return;
    }

    try {
      console.log(`开始下载数据${overwriteLocal ? '（覆盖模式）' : '（合并模式）'}...`);

      // 从云端同步设置
      console.log('正在下载设置...');
      await store.dispatch(syncSettingsFromCloud());

      // 从云端同步标签组，使用 background: false 显示进度条
      console.log('正在下载标签组...');
      await store.dispatch(syncTabsFromCloud({ background: false, forceRemoteStrategy: overwriteLocal }));

      console.log(`下载数据完成！即将刷新页面...`);

      // 等待短暂后刷新页面
      setTimeout(() => {
        window.location.reload();
      }, 500);

    } catch (error) {
      console.error('下载数据失败:', error);
      // 尝试重新获取用户信息，可能是会话过期
      try {
        await store.dispatch(getCurrentUser());
      } catch (e) {
        console.error('重新获取用户信息失败:', e);
      }
    }
  }
}

export const syncService = new SyncService();
