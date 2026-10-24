import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';
import { resolve } from 'path';
import { writeFileSync, readFileSync } from 'fs';
import {
  firstScreenChunkFor,
  firstScreenPolicyGate,
} from './src/core/firstScreenPolicy';
import { vendorChunkFor } from './src/core/chunkingPolicy';
import { buildWorkerSafePreloadCode } from './src/core/workerSafePreload';

// 创建临时 manifest，不包含 service worker
const tempManifest = {
  ...manifest,
  background: undefined
};

/**
 * worker 安全的 `__vitePreload` 助手（2026-10-23）。
 *
 * ── 为什么必须换掉 vite 那个虚拟模块 ─────────────────────────────────────
 * vite 会给「含字面量动态 import 的 chunk」注入 `__vitePreload`，
 * 用来在 import 之前先插 `<link rel="modulepreload">`（免下载瀑布）。
 * 原版助手**假设自己有 DOM**（第一件事就是 `document.getElementsByTagName`），
 * 而 MV3 的 module service worker 没有 document ⇒
 * `ReferenceError: document is not defined`。
 *
 * 本仓 2026-10-14 踩过一次，绕法是「SW 里不许用动态 import」，
 * 代价是弹窗首屏必须静态下载整条云端栈。首屏瘦身要把动态 import 请回来，
 * 就必须先把助手修成 worker 安全的（见 src/core/workerSafePreload.ts）。
 *
 * ── 怎么换 ───────────────────────────────────────────────────────────────
 * `vite:build-import-analysis` 往 chunk 里注入
 * `import { __vitePreload } from "\0vite/preload-helper.js"`。
 * 我们用 `enforce: 'pre'` 的插件**抢在它前面**把这个 id 解析成自己的 id，
 * 再由 `load` 返回替换后的实现（DOM 分支与 vite 原版逐字相同，
 * 只多了「没有 document 就直接 import」这一句）。
 */
function workerSafePreloadHelper() {
  const VITE_HELPER_ID = '\0vite/preload-helper.js';
  const PATCHED_HELPER_ID = '\0tapstack/worker-safe-preload-helper.js';
  let rootConfig: any = null;
  return {
    name: 'tapstack:worker-safe-preload-helper',
    enforce: 'pre' as const,
    configResolved(config: any) {
      rootConfig = config;
    },
    resolveId(id: string) {
      if (id === VITE_HELPER_ID) return PATCHED_HELPER_ID;
      return null;
    },
    load(this: any, id: string) {
      if (id !== PATCHED_HELPER_ID) return null;
      const config = (this.environment && this.environment.config) || rootConfig;
      if (!config) {
        throw new Error('worker 安全的 preload 助手：拿不到构建配置');
      }
      // ── 下面两处的口径与 vite 原版逐字一致 ──────────────────────────
      // scriptRel：polyfill 开着就固定 'modulepreload'，否则运行时探测。
      const modulePreload = config.build && config.build.modulePreload;
      const scriptRel =
        modulePreload && modulePreload.polyfill
          ? "'modulepreload'"
          : `/* @__PURE__ */ (${detectScriptRel.toString()})()`;
      // assetsURL：相对 base / renderBuiltUrl ⇒ 用 importerUrl 解析绝对地址。
      const base = config.base;
      const renderBuiltUrl = config.experimental && config.experimental.renderBuiltUrl;
      const isRelativeBase = base === './' || base === '';
      const assetsURL =
        renderBuiltUrl || isRelativeBase
          ? 'function(dep, importerUrl) { return new URL(dep, importerUrl).href }'
          : `function(dep) { return ${JSON.stringify(base)}+dep }`;
      return {
        code: buildWorkerSafePreloadCode({ scriptRel, assetsURL }),
        moduleSideEffects: false,
      };
    },
  };
}

/**
 * vite 内部的 `detectScriptRel`（运行时探测浏览器支不支持 modulepreload）。
 * 逐字照抄：只有 `build.modulePreload.polyfill` 关掉时才会用到它。
 */
function detectScriptRel() {
  const relList =
    typeof document !== 'undefined' && document.createElement('link').relList;
  return relList && relList.supports && relList.supports('modulepreload')
    ? 'modulepreload'
    : 'preload';
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // 加载环境变量
  const env = loadEnv(mode, process.cwd());

  return {
    // 生产环境移除 console 与 debugger
    esbuild: {
      // 保留 console.warn/error：生产环境出问题时（尤其错误边界与同步失败）
      // 完全没有日志会让线上排查只能靠猜；只清掉调试级日志与 debugger。
      drop: mode === 'production' ? ['debugger'] : [],
      pure:
        mode === 'production'
          ? ['console.log', 'console.info', 'console.debug']
          : [],
    },
    // 设置相对路径基础路径，避免Chrome扩展中的绝对路径问题
    base: './',
    plugins: [
      react(),
      crx({
        manifest: tempManifest,
        contentScripts: {
          preambleCode: false,
        },
      }),
      firstScreenPolicyGate(),
      // 放在 react() 之后即可：它只跟 vite 内部的虚拟模块打交道。
      workerSafePreloadHelper(),
      // 自定义插件：在构建后恢复 manifest.json
      {
        name: 'restore-manifest',
        closeBundle() {
          try {
            const manifestPath = resolve(__dirname, 'dist/manifest.json');
            const manifestContent = JSON.parse(readFileSync(manifestPath, 'utf-8'));
            
            // 恢复 background 配置（模块化 service worker）
            manifestContent.background = {
              service_worker: 'service-worker.js',
              type: 'module'
            };
            
            writeFileSync(manifestPath, JSON.stringify(manifestContent, null, 2));
            console.log('✅ 已恢复 manifest.json 中的 background 配置');
          } catch (error) {
            console.error('❌ 恢复 manifest.json 失败:', error);
          }
        }
      }
    ],
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      // 增加警告阈值到 1000KB，减少不必要的警告
      chunkSizeWarningLimit: 1000,
      // 为Chrome扩展设置相对路径
      assetsDir: '',
      rollupOptions: {
        input: {
          'src/popup/index': resolve(__dirname, 'src/popup/index.html'),
          // 2026-10-14：设置页。独立窗口的原因见 OptionsPage.tsx 文件头 ——
          // popup 菜单只有 256px 宽且是瞬态的，塞不下 WebDAV 表单。
          'src/options/index': resolve(__dirname, 'src/options/index.html'),
          'popup': resolve(__dirname, 'popup.html'),
          // 2026-10-05：删掉 confirm 入口（src/auth/confirm.html 一并删除）。
          // 它是死代码：① supabase.auth.signUp 从未配置 redirectTo（auth.ts:13
          // 只传 email+password），所以没有任何邮件会指向它；② 页面里的
          // verifyUrl 算出来后从未使用（const 赋值后无引用），且 redirect_to=
          // 是空值 —— 即使被访问也不会真正校验；③ 它是 manifest 里
          // web_accessible_resources 唯一的存在理由，而那条规则把页面暴露给
          // 任何 *.supabase.co 页面（钓鱼页可把它 iframe 进去）。
          // 保留一个「看起来在处理邮箱验证、实则什么都不做」的页面，
          // 风险（WAR 暴露 + 未来有人误以为它在用）大于价值。
          'service-worker': resolve(__dirname, 'src/service-worker.ts')
        },
        output: {
          entryFileNames: (chunk) =>
            chunk.name === 'service-worker' ? 'service-worker.js' : '[name]-[hash].js',
          // 手动配置代码分块策略
          manualChunks: (id) => {
            // 第三方包的分块判据在 `src/core/chunkingPolicy.ts`（纯函数、可单测）。
            //
            // 为什么要搬出去：① 构建配置不该是「没人能测的判据」；
            // ② 2026-10-24 审计 PERF-02 —— react-redux 与 @reduxjs/toolkit
            // 必须**分块**：前者依赖 react ⇒ 同块会把 react-vendor 拖进
            // Service Worker 的静态闭包（SW 一行 React 都不用，因为它没有 DOM）。
            // 实测：SW 静态闭包 646.9KB raw / 202.0KB gzip ⇒ 拆开后
            // 503.3KB / 155.7KB（−143.6KB raw / −46.3KB gzip，−22.2%）。
            // MV3 的 module SW 每次被唤醒都要把这张图读回来并解析。
            const vendor = vendorChunkFor(id);
            if (vendor) return vendor;
            // ── 2026-10-23（首屏瘦身）：准入策略驱动的分块 ──────────────────
            //
            // 【旧规则为什么被删掉】原先有一条
            //   `if (nm.includes('src/utils/')) return 'utils';`
            // 它把**整个 src/utils/** 塞进一个块。于是：弹窗只要静态 import
            // 了 utils 里的任意一个模块（哪怕只是 authCache），
            // 就得连带下载 upload / download / diagnostics / perfTrace ……
            // 一个「兜底式 catch-all」看起来很整齐，实际是**首屏体积的搬运工**。
            //
            // 【新规则】哪些模块该单独成块、哪些不许进首屏，由
            // `src/core/firstScreenPolicy.ts` 说了算（纯函数，可单测）。
            //
            // ⚠️ **只有 SDK 那组会拿到块名**：Rollup 的 manualChunks 会把
            // 「手动分块里的模块的依赖」一并吸进那个块 ⇒ 给**本仓源码**起块名时，
            // 那块会顺带吞掉共享模块（src/utils/storage.ts、src/types/tab.ts …），
            // 于是「谁引用了共享模块」这条边会把整个手动块拖进首屏。
            // 实测：给 Supabase 那组起块名后首屏从 175.9KB 反弹回 262.4KB。
            // SDK 那组例外 —— 它的依赖全是 node_modules 里的包，吸进同一块正确。
            //
            // 【没进策略表的模块】一律返回 undefined ⇒ Rollup 默认分块
            // （按「谁静态可达」自然切分：只被 SW / 设置页用到的模块
            //  自动不进 popup 的首屏）。
            return firstScreenChunkFor(id) ?? undefined;
          }
        }
      }
    }
  };
});
