/**
 * S4 单写者收口：本模块仅为纯决策函数转发（行为零变化）。
 *
 * S1 重构：纯决策函数（decideDownloadPrecheck / decideCloudTombstoneWrite /
 * hasRemoteChanges / getGroupsToSync / validateMergeResult）已搬迁至
 * @/core/syncDecision，此处 re-export 转发。
 *
 * S4 收口：已废弃的 version+时间戳 LWW 合并（mergeTabGroups/mergeGroup/mergeTabs）
 * 已搬迁至 `@/utils/syncUtils.legacy` 并与生产隔离——本模块不再 export 它们，
 * 任何 `import { mergeTabGroups } from '@/utils/syncUtils'` 将在编译期直接失败，
 * 从机制上杜绝接回生产路径。生产合并语义唯一真相：`@/utils/opStampMerge` 的
 * mergeOpStamped（唯一入口 syncEngine.downloadAndMerge）。
 */
export * from '@/core/syncDecision';
