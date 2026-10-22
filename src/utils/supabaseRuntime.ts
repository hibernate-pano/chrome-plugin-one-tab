/**
 * Supabase 门面的**加载器注册表**（2026-10-23）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * 「弹窗首屏不下载 Supabase SDK」⇒ 门面必须**按需加载**。
 * 但 **service worker 里 `import()` 被 Chrome 禁止**
 * （见 core/runtimeRealm.ts 的说明），而 SW 侧同样需要门面
 * （核登录态、上传下载都走它）。
 *
 * ⇒ 同一份门面有**两种取法**：
 *   · 页面（弹窗 / 设置页）：`await import('@/utils/supabaseFacade')`
 *     —— 首屏不下载，真的要用时才下；
 *   · Service Worker：**静态** import —— SW 入口（src/service-worker.ts）
 *     自己 import 进来，然后注册到这里。
 *
 * 本模块就是那个注册表。**全仓只此一处**取门面
 * （不许再有第二种写法 —— 两种写法必然漂移成「一半页面、一半 SW」）。
 *
 * ⚠️ **SW 入口必须注册**：否则 SW 里会走到默认的动态加载 ⇒
 * Chrome 直接抛「import() is disallowed」。这里提前抛一条说人话的错。
 */

import { isServiceWorkerRealm } from '@/core/runtimeRealm';

/** 门面模块的形状（类型位置 ⇒ 编译后消失，不产生静态依赖）。 */
export type SupabaseFacadeModule = typeof import('@/utils/supabaseFacade');

/** 加载门面的方式：返回一个门面模块。 */
export type SupabaseFacadeLoader = () => Promise<SupabaseFacadeModule>;

let registeredLoader: SupabaseFacadeLoader | null = null;

/**
 * 注册门面加载器（**Service Worker 入口专用**）。
 *
 * 页面侧不要调用：页面走默认的动态加载即可。
 */
export function setSupabaseFacadeLoader(loader: SupabaseFacadeLoader): void {
  registeredLoader = loader;
}

/**
 * 拿到门面模块。
 *
 * 页面：默认路径是动态 import（首屏不下载）。
 * SW：必须由入口注册静态加载器；没注册就**明确报错**，
 * 而不是让 Chrome 抛一句「import() is disallowed」。
 */
export async function loadSupabaseFacade(): Promise<SupabaseFacadeModule> {
  if (registeredLoader) return registeredLoader();
  if (isServiceWorkerRealm()) {
    throw new Error(
      'Service Worker 里必须注册静态的 Supabase 门面加载器' +
        '（由 src/service-worker.ts 在启动时注册）—— ' +
        'service worker 不允许 import()，动态加载在 SW 里必然失败。',
    );
  }
  return await import('@/utils/supabaseFacade');
}
