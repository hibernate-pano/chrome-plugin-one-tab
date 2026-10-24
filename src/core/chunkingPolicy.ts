/**
 * 构建分块策略（node_modules 那一半）—— 纯函数，可单测。
 *
 * ── 为什么把这段从 vite.config.ts 里搬出来 ────────────────────────────────
 *
 * 「哪些第三方包进哪一块」是**架构决定**，却原本写死在构建配置里 ⇒ 没有办法
 * 单测 ⇒ 只能靠「构建完看一眼产物」这种**纸面门**（而纸面门在没构建时
 * 静默跳过，看起来像验过了）。
 *
 * 与 `src/core/firstScreenPolicy.ts` 同一个套路：把判据搬成纯函数，
 * 配置只负责接线。
 *
 * ── 这条策略防的具体事故：Service Worker 静态拖着整包 React ──────────────
 *
 * 2026-10-24 审计 PERF-02：原先 react-redux 与 @reduxjs/toolkit 同在
 * `redux-vendor` 一块，而 **react-redux 依赖 react** ⇒ Rollup 的「手动块会
 * 吸收其依赖」规则把 react-vendor 也拖进 SW 的静态闭包。
 *
 * 而 SW 的源码图里 **0 个 import react / react-dom** —— 它一行 React 都不用
 * （ServiceWorkerGlobalScope 里没有 DOM）。实测：SW 静态闭包
 * 646.9KB raw / 202.0KB gzip ⇒ 拆开后 503.3KB / 155.7KB
 * （−143.6KB raw / −46.3KB gzip，−22.2%）。
 *
 * MV3 的 module service worker **每次被唤醒**（浏览器启动、alarms、任意消息）
 * 都要把这张静态图读回来并解析 ⇒ 这笔钱每次都付。
 *
 * ⚠️ 这不是「SW 启动快了 X ms」：这些字节来自本机扩展包（不走网络），
 * V8 解析 react-vendor ≈ 1.3ms，冷启动墙钟收益在噪声内。
 * 它是**字节与解析量的账**，不是「故障」。
 *
 * ── 为什么 react-redux 必须单独成块（而不是换个名字） ─────────────────────
 *
 * 关键不在块名叫什么，而在**谁和谁同块**：
 *   · `redux-vendor`（@reduxjs/toolkit）**不含** react ⇒ SW 需要它（store）
 *     但不需要 React；
 *   · `react-redux-vendor`（react-redux）**依赖** react ⇒ 谁静态可达它，
 *     谁就把 react 拖进来。
 *
 * ⇒ 只要 react-redux 与 @reduxjs/toolkit **不同块**，SW 就再也碰不到 React。
 *
 * ⚠️ 顺带记一个坑：判 react 包时**不能**用 `includes('node_modules/react')`
 * —— 它会连带匹配 `node_modules/react-redux` / `node_modules/react-dnd`，
 * 于是懒加载 chunk 被强行并进 react-vendor，vite 的 dynamic import 失效
 * （产物里 DndProvider chunk 只剩 143 字节的 re-export）。
 * ⇒ 精确匹配路径段 `node_modules/react/` 与 `node_modules/react-dom/`。
 */

/** 第三方包的分块名。`undefined` = 交给 Rollup 默认分块。 */
export type VendorChunkName = 'react-vendor' | 'redux-vendor' | 'react-redux-vendor';

/**
 * 这个模块 id 该进哪一块（node_modules 部分）。
 *
 * @param id Rollup 给的模块 id（绝对路径）
 * @returns 块名；`undefined` 表示「这块规则不管它」
 */
export function vendorChunkFor(id: string): VendorChunkName | undefined {
  const nm = id.replace(/\\/g, '/');
  // React 本体（react / react-dom）—— 精确路径段，别用 includes。
  if (/node_modules\/(react|react-dom)\//.test(nm)) {
    return 'react-vendor';
  }
  // react-redux 单独成块：它依赖 react ⇒ 谁静态可达它，谁就把 React 拖进来
  // （见文件头）。注意它与 @reduxjs/toolkit 的路径前缀互不包含，判定顺序无所谓。
  if (nm.includes('node_modules/react-redux')) {
    return 'react-redux-vendor';
  }
  if (nm.includes('node_modules/@reduxjs/toolkit')) {
    return 'redux-vendor';
  }
  return undefined;
}

/**
 * 这两个包**必须**分处不同的块。
 *
 * 写成函数而不是注释，是为了让守卫能直接调用它（而不是去 grep 配置文本）。
 * react-redux 依赖 react ⇒ 与 @reduxjs/toolkit 同块 ⇒ SW 的静态闭包被拖进
 * 整包 React（见文件头）。
 */
export function reduxPackagesShareChunk(): boolean {
  return (
    vendorChunkFor('/repo/node_modules/@reduxjs/toolkit/dist/index.mjs') ===
    vendorChunkFor('/repo/node_modules/react-redux/dist/react-redux.mjs')
  );
}
