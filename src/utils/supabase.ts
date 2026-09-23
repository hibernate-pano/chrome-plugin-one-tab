/**
 * S3 重构：实现已拆分至 ./supabase/*（client/probe/readback/auth/upload/download/ports/sync），
 * 本文件仅作 re-export 门面（沿用 S1/S2 范式），调用方 import 路径保持不变，行为零变化。
 */
export { supabase, isSupabaseConfigured, getDeviceId } from './supabase/client';
export { supportsCloudTombstone, supportsOpStamp, fetchTabGroupsDigest } from './supabase/probe';
export type { TabGroupDigest } from './supabase/probe';
export {
  compareUploadReadback,
  compareTombstoneReadback,
  compareHardDeleteReadback,
} from './supabase/readback';
export type { UploadReadbackExpect, UploadReadbackRow } from './supabase/readback';
export { auth } from './supabase/auth';
export { sync } from './supabase/sync';
export type { SupabaseSyncPort, SupabaseAuthPort, SupabasePort } from './supabase/ports';
