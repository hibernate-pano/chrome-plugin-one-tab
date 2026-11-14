/**
 * span 名封闭词表（2026-10-23 从 perfTrace.ts 拆出）。
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────────────────
 * 这两张表是**纯常量**（编译期字面量），而 `perfTrace.ts` 本身是**会写
 * IndexedDB 的运行时**（性能观测的采集与落盘）。
 *
 * 拆分之前有一根静态依赖把两者绑在一起：
 *   `src/utils/diagnostics.ts`（弹窗首屏要加载，因为顶栏菜单要能导出诊断）
 *     → `src/utils/perfTrace.ts`（首屏**用不到**的性能追踪）
 * 于是「导出诊断」这个低频功能把整套 span 采集拖进了弹窗首屏。
 *
 * 拆开之后：诊断面板用到的**词表**留在首屏（几 KB 常量），
 * 真正的 perfTrace 实例改成**动态 import**（见 diagnostics.ts 的 readDiagnosticsSources）。
 *
 * ⚠️ `perfTrace.ts` 仍然 re-export 这两个常量 —— 外部 import 路径不变
 * （`import { PERF_SPAN_NAMES } from '@/utils/perfTrace'` 继续可用），
 * 但那样 import 的人会把 perfTrace 拖回来，所以**首屏路径一律从本文件取**。
 */

/**
 * span 名封闭词表。
 *
 * 与 diagnostics 的事件名白名单同一个理由：这些字符串会进入诊断文件（用户可能贴到
 * 公开 issue）。全部来自代码常量（MutationOp['op'] / 队列任务名），不含任何来自
 * 存储或用户输入的内容。词表外的名字一律拒记——宁可少一条观测，也不能让
 * 「某个动态字符串」成为流向公开文件的通道。
 */
export const PERF_SPAN_NAMES = [
  // 语义命令（与 MutationOp['op'] 同集）
  'saveGroup',
  'removeTab',
  'deleteGroup',
  'deleteGroups',
  'deleteAllGroups',
  'importGroups',
  'renameGroup',
  'toggleGroupLock',
  'updateGroupFields',
  'moveTab',
  'cleanDuplicates',
  // 队列任务名（非 mutation）
  'sync:upload',
  'sync:download',
  'opStampMigration',
  'saveAllTabs',
  'saveCurrentTab',
] as const;

/**
 * run 段内部可计时的阶段。
 *
 * 只列**真的被测**的阶段。mutation 命令的纯计算段仍不在这里——它由聚合时
 * 相减推出（见文件头）。
 *
 * ── 2026-11-14：加入同步轮次的阶段名 ────────────────────────────────────
 * 起因：「从云端刷新有点慢」无法归因——队列层已有 `sync:download.wait` /
 * `.run`（wait=排队，run=整轮），但 run 里既有网络也有计算，占比未知。
 * 这六个阶段**由 syncEngine 显式计时**（边界之间记在下一段，见
 * `createSyncPhaseMarker`），因此它们是直接测量值，不是推导值：
 *   · gate     鉴权/后端解析/前置门禁（含「先上传再下载」那一次上传）
 *   · precheck 下载前置判据（last_upload_time / pending_upload 的本地读）
 *   · probe    指纹探活 + 差量计算（探活是网络往返，差量是纯计算）
 *   · remote   后端往返（下载 / upsert / 墓碑广播）
 *   · merge    合并 + 冲突判定（纯计算；紧随其后的合并验证为毫秒级，计入下一段）
 *   · ledger   P0-1 基线（sync_stamp_ledger）的读写
 *
 * ⚠️ 对这些 span，`applyTotalMs = run - Σsteps` 的含义变成「未被上述阶段
 * 覆盖的残余时间」，不再是「纯计算段」——两者都如实反映事实，只是读法不同。
 */
export const SPAN_STEPS = [
  'journal',
  'read',
  'write',
  'noteDeleted',
  // 撤回删除广播意图（撤销「恢复即消费」，2026-10-22 审计 P0-4）
  'retractDeleted',
  'scheduleUpload',
  // 同步轮次（sync:download / sync:upload）的阶段，见上方说明
  'gate',
  'precheck',
  'probe',
  'remote',
  'merge',
  'ledger',
] as const;

export type SpanStep = (typeof SPAN_STEPS)[number];
