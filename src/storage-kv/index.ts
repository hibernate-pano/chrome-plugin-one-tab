/**
 * 共享 storage-kv 包入口（S2 重构：src/storage-kv 过渡形态）。
 *
 * 收敛 KV 抽象（storageAdapter + drivers + types）与键常量（keys）及
 * 字符串共享存储（stringStore + env，supabase session 层同源），
 * MV3/SW 安全、无新增依赖。
 * 各原位置文件保留 re-export 转发，调用方 import 路径零变化。
 * 后续可整体提升为 packages/storage-kv 独立包（需 pnpm workspace + 别名配置）。
 */
export * from '@/storage-kv/types';
export * from '@/storage-kv/keys';
export * from '@/storage-kv/env';
export * from '@/storage-kv/stringStore';
export * from '@/storage-kv/indexedDbClient';
export * from '@/storage-kv/localStorageFallback';
export * from '@/storage-kv/storageAdapter';
