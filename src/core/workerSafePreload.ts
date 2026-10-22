/**
 * Vite 的 `__vitePreload` 助手 —— **worker 安全版**（2026-10-23）。
 *
 * ── 这个文件解决什么问题 ────────────────────────────────────────────────
 * Vite 会给「含字面量动态 import 的 chunk」注入一个 `__vitePreload` 助手，
 * 作用是在真正 import 之前先往 DOM 里插 `<link rel="modulepreload">`，
 * 免得动态 import 形成下载瀑布。
 *
 * ⚠️ **原版助手假设自己有 DOM**：它第一件事就是
 * `document.getElementsByTagName('link')` + `document.querySelector(...)`。
 * 而 MV3 的 **module service worker 没有 document / window** ⇒
 * 只要 worker 侧执行到一次「目标块有静态依赖的动态 import」，
 * 就会抛 `ReferenceError: document is not defined`。
 *
 * 这个坑本仓踩过（2026-10-14）：当时的绕法是「SW 里不许用动态 import」，
 * 代价是**弹窗首屏必须静态下载整条云端栈**（Supabase SDK + 读写实现 +
 * WebDAV 适配器，gzip 约 100KB+）。首屏瘦身的改造要把动态 import
 * 请回来 ⇒ 必须先把助手本身修成 worker 安全的。
 *
 * ── 为什么不是「在 SW 里补一个 document 假壳」────────────────────────────
 * 因为 `typeof document !== 'undefined'` 是很多库判断「我在不在页面里」
 * 的惯用写法（Supabase SDK 就在用它决定要不要碰 localStorage）。
 * 在 SW 里塞一个假 document ⇒ 这些库会误判自己在页面里 ⇒ 行为漂移，
 * 而且漂移得很安静。**让助手自己在没有 DOM 时退化成「直接 import」**
 * 才不碰任何全局状态。
 *
 * ── 改了什么（相对于 Vite 6.4.3 的原版）──────────────────────────────
 * 只加了一处：`typeof document === 'undefined'` 时**直接返回 baseModule()**，
 * 即「不做预加载提示，直接 import」。DOM 分支**逐字照抄** Vite 原版
 * （包括 `vite:preloadError` 事件与 CSS 预载的等待），
 * 所以页面侧的行为与 Vite 原版**完全一致**。
 *
 * ── 为什么生成代码而不是直接改 node_modules ────────────────────────────
 * 改 node_modules 会在下一次 `pnpm install` 时被冲掉，而且没人会知道。
 * 这里改成**在构建期替换掉 vite 的那个虚拟模块**
 * （`\0vite/preload-helper.js`），替换逻辑写在 vite.config.ts 里，
 * 替换出来的代码由本文件生成 ⇒ 有版本、有测试、有说明。
 */

/** 生成助手代码时需要由构建配置决定的两处表达式。 */
export interface PreloadHelperOptions {
  /**
   * `scriptRel` 的取值表达式（字符串字面量或函数调用）。
   *
   * Vite 的口径：`build.modulePreload.polyfill` 为真 ⇒ 固定用
   * `'modulepreload'`；否则运行时探测（老浏览器回落到 `'preload'`）。
   */
  readonly scriptRel: string;
  /**
   * `assetsURL` 的函数表达式。
   *
   * Vite 的口径：相对 base（`'./'` / `''`）或用了 `experimental.renderBuiltUrl`
   * ⇒ `new URL(dep, importerUrl).href`；否则 `base + dep`。
   */
  readonly assetsURL: string;
}

/**
 * 生成 `__vitePreload` 助手的模块代码。
 *
 * ⚠️ 生成的代码里有一处 `__VITE_IS_MODERN__`：那是 vite 自己在
 * `renderChunk` 阶段按产物格式替换的占位符（es ⇒ `true`）。
 * 直接跑这段代码（单测）时需要自己替换掉，否则会抛 ReferenceError。
 */
export function buildWorkerSafePreloadCode(options: PreloadHelperOptions): string {
  const { scriptRel, assetsURL } = options;
  // ⚠️ 下面这个模板里**故意**不用反引号模板串（Vite 原版用了两处），
  // 改成字符串拼接：这样这段代码本身可以安全地嵌在模板串里，
  // 而 `${` 也不会被外层模板提前求值。
  return `const scriptRel = ${scriptRel};
const assetsURL = ${assetsURL};
const seen = {};
export const __vitePreload = function preload(baseModule, deps, importerUrl) {
  // ★ worker（MV3 module service worker）里没有 DOM ⇒ 不做预加载提示，直接 import。
  // 页面侧走下面的原版逻辑，行为与 vite 一字不差。
  if (typeof document === 'undefined') {
    return baseModule();
  }
  let promise = Promise.resolve();
  if (__VITE_IS_MODERN__ && deps && deps.length > 0) {
    const allSettled = function (promises) {
      return Promise.all(promises.map((p) => Promise.resolve(p).then(
        (value) => ({ status: 'fulfilled', value }),
        (reason) => ({ status: 'rejected', reason })
      )));
    };
    const links = document.getElementsByTagName('link');
    const cspNonceMeta = document.querySelector('meta[property=csp-nonce]');
    const cspNonce = (cspNonceMeta && cspNonceMeta.nonce) || (cspNonceMeta && cspNonceMeta.getAttribute('nonce'));
    promise = allSettled(deps.map((dep) => {
      dep = assetsURL(dep, importerUrl);
      if (dep in seen) return;
      seen[dep] = true;
      const isCss = dep.endsWith('.css');
      const cssSelector = isCss ? '[rel="stylesheet"]' : '';
      const isBaseRelative = !!importerUrl;
      if (isBaseRelative) {
        for (let i = links.length - 1; i >= 0; i--) {
          const link = links[i];
          if (link.href === dep && (!isCss || link.rel === 'stylesheet')) return;
        }
      } else if (document.querySelector('link[href="' + dep + '"]' + cssSelector)) return;
      const link = document.createElement('link');
      link.rel = isCss ? 'stylesheet' : scriptRel;
      if (!isCss) {
        link.as = 'script';
      }
      link.crossOrigin = '';
      link.href = dep;
      if (cspNonce) {
        link.setAttribute('nonce', cspNonce);
      }
      document.head.appendChild(link);
      if (isCss) {
        return new Promise((res, rej) => {
          link.addEventListener('load', res);
          link.addEventListener('error', () => rej(new Error('Unable to preload CSS for ' + dep)));
        });
      }
    }));
  }
  function handlePreloadError(err) {
    const e = new Event('vite:preloadError', { cancelable: true });
    e.payload = err;
    window.dispatchEvent(e);
    if (!e.defaultPrevented) {
      throw err;
    }
  }
  return promise.then((res) => {
    for (const item of res || []) {
      if (item.status !== 'rejected') continue;
      handlePreloadError(item.reason);
    }
    return baseModule().catch(handlePreloadError);
  });
};
`;
}
