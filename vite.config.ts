import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';
import { resolve } from 'path';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // 加载环境变量
  const env = loadEnv(mode, process.cwd());

  return {
    // 设置相对路径基础路径，避免Chrome扩展中的绝对路径问题
    base: './',
    plugins: [
      react(),
      crx({ manifest }),
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
          'service-worker': resolve(__dirname, 'src/service-worker.js'),
          'src/popup/index': resolve(__dirname, 'src/popup/index.html'),
          'popup': resolve(__dirname, 'popup.html'),
          'confirm': resolve(__dirname, 'src/auth/confirm.html')
        },
        output: {
          // 确保 Service Worker 输出为独立文件，不使用哈希
          entryFileNames: (chunkInfo) => {
            if (chunkInfo.name === 'service-worker') {
              return 'service-worker.js';
            }
            return '[name]-[hash].js';
          },
          // Service Worker 不分块，避免动态导入
          chunkFileNames: (chunkInfo) => {
            if (chunkInfo.name && chunkInfo.name.includes('service-worker')) {
              return 'service-worker.js';
            }
            return '[name]-[hash].js';
          },
          // 手动配置代码分块策略
          manualChunks: (id) => {
            // Service Worker 不分块，保持独立
            if (id.includes('service-worker.js')) {
              return undefined;
            }
            // React 相关库打包到一起
            if (id.includes('node_modules/react') || id.includes('node_modules/react-dom') || id.includes('node_modules/react-redux')) {
              return 'react-vendor';
            }
            // Redux 相关库打包到一起
            if (id.includes('node_modules/@reduxjs/toolkit')) {
              return 'redux-vendor';
            }
            // Supabase 相关库打包到一起
            if (id.includes('node_modules/@supabase/supabase-js')) {
              return 'supabase-vendor';
            }
            // 工具函数打包到一起
            if (id.includes('src/utils/')) {
              return 'utils';
            }
          }
        },
        external: (id) => {
          // Service Worker 不应该引用外部模块
          if (id.includes('service-worker.js')) {
            return false;
          }
          return false;
        }
      }
    }
  };
});
