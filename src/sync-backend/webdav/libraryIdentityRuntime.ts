/**
 * 「本机当前指向哪个云端库」的**加载器注册表**（2026-10-23 审计 P0-1）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * 「本机当前在哪个库」这件事，**页面**与 **service worker** 都要算
 * （待决位按库寻址 ⇒ 两边必须得出同一个答案，否则两边的判断会打架）。
 *
 * 但 **service worker 里 `import()` 被 Chrome 禁止**
 * （HTML 规范：ServiceWorkerGlobalScope 上不允许 import()；
 * 真机报错：`TypeError: import() is disallowed on ServiceWorkerGlobalScope
 * by the HTML specification`）⇒ SW 侧**算不出**这个库。
 *
 * 后果不是「读不到就少传一点」，而是**判据整个换了**：
 * 算不出库 ⇒ 落进「不知道是哪个库 ⇒ 只要有一格待决就算待决」的保守分支
 * ⇒ SW 永远以为归属决策没做完 ⇒ 自动上传被永久降级成「只传本次改动过的那几个」
 * ⇒ **历史会话再也传不上用户自己的云盘，而回包还报「成功」**。
 *
 * ⇒ 同一份模块有**两种取法**：
 *   · 页面（弹窗 / 设置页）：`await import('./libraryIdentity')`
 *     —— 首屏不下载，真的要算作用域时才下；
 *   · Service Worker：**静态** import —— SW 入口（src/service-worker.ts）
 *     自己 import 进来，然后注册到这里。
 *
 * 本模块就是那个注册表。**全仓只此一处**取库身份模块
 * （不许再有第二种写法 —— 两种写法必然漂移成「一半页面、一半 SW」，
 * 而那正是本缺陷的形状）。
 *
 * ⚠️ **SW 入口必须注册**：否则 SW 里会走到默认的动态加载 ⇒
 * Chrome 直接抛「import() is disallowed」。这里提前抛一条说人话的错。
 *
 * ── 为什么这个注册表**不成环** ──────────────────────────────────────────
 * `libraryIdentity.ts` 要用 `NO_LIBRARY_SCOPE` ⇒ 它静态依赖
 * `storage-kv/firstSyncPendingRecord.ts`；而后者的作用域解析要回到本注册表。
 * 若本模块**运行时**import `libraryIdentity`，那就是一个真环。
 * ⇒ 本模块对 `libraryIdentity` 只有**类型位置**的引用
 * （`typeof import('./libraryIdentity')` ⇒ 编译后消失，不产生静态依赖），
 * 运行时的那条边是 `await import(...)` ⇒ 环被断开。
 */

import { isServiceWorkerRealm } from '@/core/runtimeRealm';

/** 库身份模块的形状（类型位置 ⇒ 编译后消失，不产生静态依赖）。 */
export type LibraryIdentityModule = typeof import('./libraryIdentity');

/** 加载库身份模块的方式：返回一个库身份模块。 */
export type LibraryIdentityLoader = () => Promise<LibraryIdentityModule>;

let registeredLoader: LibraryIdentityLoader | null = null;

/**
 * 注册库身份加载器（**Service Worker 入口专用**）。
 *
 * 页面侧不要调用：页面走默认的动态加载即可。
 */
export function setLibraryIdentityLoader(loader: LibraryIdentityLoader): void {
  registeredLoader = loader;
}

/**
 * 拿到库身份模块。
 *
 * 页面：默认路径是动态 import（首屏不下载）。
 * SW：必须由入口注册静态加载器；没注册就**明确报错**，
 * 而不是让 Chrome 抛一句「import() is disallowed」。
 */
export async function loadLibraryIdentity(): Promise<LibraryIdentityModule> {
  if (registeredLoader) return registeredLoader();
  if (isServiceWorkerRealm()) {
    throw new Error(
      'Service Worker 里必须注册静态的「库身份」加载器' +
        '（由 src/service-worker.ts 在启动时注册）—— ' +
        'service worker 不允许 import()，动态加载在 SW 里必然失败。'
    );
  }
  return await import('./libraryIdentity');
}
