/**
 * WebDAV 传输栈（client + adapter + 权限）的**加载器注册表**（2026-10-23）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * 与 Supabase 门面同一个原因：**service worker 里 `import()` 被 Chrome 禁止**
 * （见 core/runtimeRealm.ts），而 SW 侧同样要能建 WebDAV 后端。
 *
 * 但这里比 Supabase 那边多一层讲究：
 *   · `webdav/config.ts`（配置读写，gzip 约 1.8KB）**每次解析后端都要**
 *     —— 它是轻的，值得留在首屏（静态引入）；
 *   · `webdav/client.ts` + `webdav/adapter.ts`（传输与适配器，源码 150KB）
 *     **只有真的要建 WebDAV 后端时**才用得上 —— 它们必须留在首屏之外。
 *
 * ⇒ 本注册表只管**重的那一半**（传输栈），配置那一半走静态 import。
 *
 * ⚠️ **SW 入口必须注册**（src/service-worker.ts 启动时注册静态加载器）。
 */

import { isServiceWorkerRealm } from '@/core/runtimeRealm';

/** WebDAV 传输栈的形状（类型位置 ⇒ 编译后消失，不产生静态依赖）。 */
export interface WebDavTransport {
  WebDavClient: typeof import('./webdav/client').WebDavClient;
  WebDavBackendAdapter: typeof import('./webdav/adapter').WebDavBackendAdapter;
  hasHostPermission: typeof import('./webdav/permission').hasHostPermission;
}

/** 加载传输栈的方式。 */
export type WebDavTransportLoader = () => Promise<WebDavTransport>;

let registeredLoader: WebDavTransportLoader | null = null;

/**
 * 注册传输栈加载器（**Service Worker 入口专用**）。
 *
 * 页面侧不要调用：页面走默认的动态加载即可。
 */
export function setWebDavTransportLoader(loader: WebDavTransportLoader): void {
  registeredLoader = loader;
}

/**
 * 拿到 WebDAV 传输栈。
 *
 * 页面：默认路径是动态 import（首屏不下载，真同步时才下）。
 * SW：必须由入口注册静态加载器；没注册就**明确报错**。
 */
export async function loadWebDavTransport(): Promise<WebDavTransport> {
  if (registeredLoader) return registeredLoader();
  if (isServiceWorkerRealm()) {
    throw new Error(
      'Service Worker 里必须注册静态的 WebDAV 传输栈加载器' +
        '（由 src/service-worker.ts 在启动时注册）—— ' +
        'service worker 不允许 import()，动态加载在 SW 里必然失败。',
    );
  }
  const [client, adapter, permission] = await Promise.all([
    import('./webdav/client'),
    import('./webdav/adapter'),
    import('./webdav/permission'),
  ]);
  return {
    WebDavClient: client.WebDavClient,
    WebDavBackendAdapter: adapter.WebDavBackendAdapter,
    hasHostPermission: permission.hasHostPermission,
  };
}
