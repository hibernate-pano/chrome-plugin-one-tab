/**
 * 「我现在跑在哪儿」的判据（2026-10-23）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * MV3 的 **module service worker 里 `import()` 被 Chrome 禁止**
 * （HTML 规范：ServiceWorkerGlobalScope 上不允许 import()）——
 * 真机报错是 `TypeError: import() is disallowed on ServiceWorkerGlobalScope
 * by the HTML specification`。
 *
 * 于是「重依赖按需加载」这件事在两个上下文里必须**分两种取法**：
 *   · 页面（弹窗 / 设置页）：`await import(...)` —— 首屏不下载，用到才下；
 *   · Service Worker：**静态** import —— 入口自己 import 进来再注册。
 *
 * 本模块只回答一个问题：**当前是不是 service worker**，
 * 让「本该由 SW 静态注册、却被走到了默认动态路径」的地方
 * **说人话地报错**，而不是让浏览器抛一句看不懂的规范条款。
 */

/**
 * 当前是不是跑在 service worker 里。
 *
 * 判据用两个条件而不是一个：
 *   · `ServiceWorkerGlobalScope` 存在 ⇒ 是 worker；
 *   · `document` 不存在 ⇒ 不是页面。
 * 两个都成立才是 service worker —— 普通 Web Worker（`document` 同样不存在）
 * **允许** `import()`，不能被误伤。
 */
export function isServiceWorkerRealm(): boolean {
  const g = globalThis as unknown as { ServiceWorkerGlobalScope?: unknown };
  return typeof g.ServiceWorkerGlobalScope !== 'undefined' && typeof document === 'undefined';
}
