/**
 * S3 重构：实现已拆分至 ./supabase/*（client/probe/readback/auth/upload/download/ports/sync），
 * 本文件仅作 re-export 门面，调用方 import 路径保持不变，行为零变化。
 *
 * ⚠️ 文件名为什么叫 supabaseFacade 而不是 supabase：
 * 仓库里同时存在 `src/utils/supabase/`（目录，真实实现拆分）与本文件（门面）。
 * 两者同名时，`import ... from '@/utils/supabase'` 能解析到谁，取决于解析器
 * 先试「文件+扩展名」还是「目录/index」——TypeScript 与 Vite 当前都先试文件，
 * 所以今天指向本文件；但只要有人往 src/utils/supabase/ 里放一个 index.ts
 * （仓库别处已在用 barrel 风格：src/storage-kv/、src/domain/tabGroup/），
 * 这条解析顺序就成了隐式约定，任何解析顺序不同的工具（打包器、测试 loader、
 * IDE 跳转、未来的 monorepo 工具链）都可能把 8 个模块的 import 悄悄指到别处。
 * 改名后「门面」与「实现目录」在名字上就再也撞不上了，隐患从「靠解析顺序」
 * 变成「靠类型检查」（路径写错直接编译失败）。
 * 真实实现在 ./supabase/*，门面只是把它们重新汇一处给扩展侧调用方。
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
