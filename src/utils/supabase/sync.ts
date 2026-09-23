/**
 * S3 拆分 · sync：`sync` 门面对象组装（upload/download/probe 委托）。
 * 方法名与调用语义与拆分前完全一致；调用方 import 路径不变。
 */
import { fetchTabGroupsDigest } from './probe';
import { uploadSync } from './upload';
import { downloadSync } from './download';
import type { SupabaseSyncPort } from './ports';

export const sync: SupabaseSyncPort = {
  ...uploadSync,
  ...downloadSync,
  // 轻量探活（指纹列，无大字段）：供 SyncEngine 全量下载前做变更判断
  async fetchTabGroupsDigest() {
    return fetchTabGroupsDigest();
  },
};
