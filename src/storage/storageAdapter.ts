/**
 * S2 重构：实现已搬迁至 @/storage-kv/storageAdapter（键常量见 @/storage-kv/keys，
 * 环境探测见 @/storage-kv/env，与 supabase session 层同源），本文件仅作
 * re-export 转发（行为零变化）。调用方 import 路径保持不变。
 */
export * from '@/storage-kv/storageAdapter';
