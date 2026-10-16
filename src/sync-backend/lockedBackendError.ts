/**
 * 「自带存储本轮不可用」的专用错误（2026-10-16，Wave 2A）。
 *
 * ── 为什么要一个专用类，而不是继续抛普通 Error ──────────────────────────
 * 未配置 / 未解锁云盘在**用户视角里是正常状态**，不是故障。但锁定占位后端
 * 过去抛的是普通 `Error`，下游（syncEngine → backgroundSync）只能看到一句
 * 人话 message，无法把它与真实网络/服务端故障分机器识别，于是把「用户还没
 * 配置」也计入失败退避阶梯：连续 8 次后自动同步被静默停掉，而设置页仍宣称
 * 「每 N 分钟在后台自动同步一次」。
 *
 * 这个类就是那条分界线：`code === 'backend_locked'` 可被 syncEngine 翻译成
 * `locked: true` 的结果标记，backgroundSync 据此把本轮归类为 `yielded`
 * （让路）——不进退避、不清 alarm，并给用户一次性可见提醒。
 *
 * ── 为什么不用 message 文本或 `instanceof Error` 只用基类 ───────────────
 * 用文本匹配（`/未配置|未解锁/`）会在文案改动时静默失效——正是本仓库
 * `.memory/fallback-catch-must-not-equal-pre-fix-behavior.md` 那类
 * 「看起来修了、实际没修且不可区分」的失败模式。
 *
 * `isLockedBackendError` 同时认 `instanceof` 与 `code` 字段：错误对象若跨
 * realm（不同执行上下文）`instanceof` 会失败，而 `code` 是结构化标记；
 * 两者都认，等于给这条判据加了一层与 realm 无关的兜底。
 */
export class LockedBackendError extends Error {
  /** 稳定的机器码：下游按它分类，不解析 message。 */
  readonly code = 'backend_locked' as const;

  constructor(message: string) {
    super(message);
    this.name = 'LockedBackendError';
  }
}

/** 判据：这个错误是否来自锁定占位后端（未配置 / 未解锁 / 存储读失败）。 */
export function isLockedBackendError(err: unknown): boolean {
  if (err instanceof LockedBackendError) return true;
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'backend_locked'
  );
}
