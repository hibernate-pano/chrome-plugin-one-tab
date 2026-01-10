/**
 * 服务层统一导出
 * 提供对所有服务的集中访问
 */

// 存储服务
export { storageService } from './storageService';
export type { StorageService } from './storageService';

// 标签服务
export { tabService } from './tabService';
export type { TabService } from './tabService';

// 已有的同步服务
export { syncService } from './syncService';
export { smartSyncService } from './smartSyncService';
