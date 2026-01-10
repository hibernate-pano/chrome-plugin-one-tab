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
      drop: mode === 'production' ? ['console', 'debugger'] : []
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
            
            // 恢复 background 配置
            manifestContent.background = {
              service_worker: 'service-worker.js'
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
      // 优化压缩
      minify: 'esbuild',
      // 源码映射（生产环境禁用）
      sourcemap: mode !== 'production',
      // 目标浏览器
      target: 'esnext',
      rollupOptions: {
        input: {
          'src/popup/index': resolve(__dirname, 'src/popup/index.html'),
          'popup': resolve(__dirname, 'popup.html'),
          'confirm': resolve(__dirname, 'src/auth/confirm.html')
        },
        output: {
          // 手动配置代码分块策略 - 优化版
          manualChunks: (id) => {
            // React 核心库
            if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) {
              return 'react-core';
            }
            // React 生态库
            if (id.includes('node_modules/react-redux') || id.includes('node_modules/react-window')) {
              return 'react-ecosystem';
            }
            // Redux 相关库
            if (id.includes('node_modules/@reduxjs/toolkit') || id.includes('node_modules/redux')) {
              return 'redux-vendor';
            }
            // Supabase 相关库
            if (id.includes('node_modules/@supabase/')) {
              return 'supabase-vendor';
            }
            // 拖拽相关库
            if (id.includes('node_modules/@dnd-kit/') || id.includes('node_modules/react-dnd')) {
              return 'dnd-vendor';
            }
            // 工具库
            if (id.includes('node_modules/lodash') || id.includes('node_modules/lz-string') || id.includes('node_modules/nanoid')) {
              return 'utils-vendor';
            }
            // 应用工具函数
            if (id.includes('src/utils/')) {
              return 'app-utils';
            }
            // 服务层
            if (id.includes('src/services/')) {
              return 'services';
            }
            // 存储层
            if (id.includes('src/store/')) {
              return 'store';
            }
          }
        }
      }
    }
  };
});
