import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';
import { resolve } from 'path';
import { writeFileSync, readFileSync } from 'fs';

// 创建临时 manifest，不包含 service worker
const tempManifest = {
  ...manifest,
  background: undefined
};

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
            // React 相关库打包到一起
            //
            // 【为什么要用精确路径而不是 includes('node_modules/react')】
            // 旧规则用 `id.includes('node_modules/react')`，它会连带匹配
            // `node_modules/react-dnd` / `react-redux` 之外的一切 react* 包，
            // 于是懒加载 chunk 被强行并进 react-vendor，vite 的 dynamic import
            // 失效（产物里 DndProvider chunk 只剩 143 字节的 re-export）。
            // 这里改成「路径段精确匹配」，只认真正的 react / react-dom。
            const nm = id.replace(/\\/g, '/');
            if (/node_modules\/(react|react-dom)\//.test(nm)) {
              return 'react-vendor';
            }
            // Redux 相关库打包到一起
            if (nm.includes('node_modules/@reduxjs/toolkit') || nm.includes('node_modules/react-redux')) {
              return 'redux-vendor';
            }
            // Supabase 相关库打包到一起
            if (nm.includes('node_modules/@supabase/supabase-js')) {
              return 'supabase-vendor';
            }
            // 工具函数打包到一起
            if (nm.includes('src/utils/')) {
              return 'utils';
            }
          }
        }
      }
    }
  };
});
