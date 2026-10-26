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
 * run 段内部可计时的 IO 阶段。
 *
 * 只列**真的被测**的阶段；纯计算段（apply）不在这里——它由聚合时相减推出
 * （见文件头）。把推导值也塞进这张表会让人误以为它被直接测过。
 */
export const SPAN_STEPS = [
  'journal',
  'read',
  'write',
  'noteDeleted',
  // 撤回删除广播意图（撤销「恢复即消费」，2026-10-22 审计 P0-4）
  'retractDeleted',
  'scheduleUpload',
] as const;

export type SpanStep = (typeof SPAN_STEPS)[number];
