/**
 * 同步节奏常量（单一事实来源，2026-10-09 架构 P2-4）。
 *
 * ── 为什么需要这个模块 ──────────────────────────────────────────────────
 * 「上传防抖 3000ms」原先散在 5 处各自手抄：
 *   · src/services/syncEngine.ts      `scheduleUpload(delayMs = 3000)`
 *   · src/background/TabManager.ts    `scheduleUpload(3000)` ×2
 *   · src/background/mutationHandlers.ts  `NORMAL_MS = 3000`
 *   · src/service-worker.ts           `… : 3000`（消息 fallback）
 * 调整上传节奏时漏改任意一处，就会出现「同一批变更在不同入口走不同延迟」——
 * 不报错、只是行为分叉，且分叉点随调用路径变化，极难排查。
 *
 * ── 为什么放在 core/ 而不是 syncEngine.ts ───────────────────────────────
 * `mutationHandlers.ts` 是**纯模块**（deps 注入、不 import syncEngine —— 见
 * opStampMigratedGuard.ts 里记录的循环依赖约束），所以它不能从 syncEngine
 * 取常量。放在 core/ 下双方都能引，且 core 是纯逻辑层、无 chrome 依赖。
 *
 * ── 与「30s 协议超时」「35s 上传保护窗口」不是一回事 ─────────────────────
 * 刻意不合并：那三个是同一条链路上的不同语义（防抖窗口 / 请求上界 / 下载保护），
 * 数值接近纯属巧合。把它们并成一个常量会让「单独调整某一个」变成不可能。
 */

/**
 * 普通变更（重命名 / 锁定 / 移动 / 保存）的上传防抖窗口。
 *
 * 语义：用户操作后等这么久再上传，把连续操作（拖拽、连点）合并成一次请求。
 * 取值权衡：太短则频繁上传（egress + 撞网关），太长则跨设备可见性变差。
 */
export const UPLOAD_DEBOUNCE_MS = 3000;

/**
 * 删除 / 新建类操作的上传窗口（更短）。
 *
 * 为什么比普通变更短：删除意图要靠云端 `is_deleted` 行广播给其它设备，
 * 且用户刚做完「删除」这个明确动作后期待立刻生效；拖太久会让对端继续看到
 * 已删内容。1500ms 仍足以让连续删除合并成一批。
 */
export const DELETE_PRIORITY_UPLOAD_MS = 1500;
