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
      // 为了Service Worker兼容性，禁用代码压缩
      minify: false,
      rollupOptions: {
        input: {
          'service-worker': resolve(__dirname, 'src/service-worker.ts'),
          'src/popup/index': resolve(__dirname, 'src/popup/index.html'),
          'popup': resolve(__dirname, 'popup.html'),
          'confirm': resolve(__dirname, 'src/auth/confirm.html')
        },
        output: {
          // 简化代码分块策略，避免Service Worker模块导入问题
          manualChunks: (id) => {
            // Service Worker相关的代码不进行分块
            if (id.includes('service-worker') || id.includes('background/TabManager')) {
              return undefined;
            }

            // 其他代码正常分块
            if (id.includes('node_modules')) {
              if (id.includes('react') || id.includes('react-dom') || id.includes('react-redux')) {
                return 'react-vendor';
              }
              if (id.includes('@reduxjs/toolkit')) {
                return 'redux-vendor';
              }
              if (id.includes('@supabase/supabase-js')) {
                return 'supabase-vendor';
              }
            }

            // 工具函数分块
            if (id.includes('src/utils/')) {
              return 'utils';
            }
          }
        }
      }
    }
  };
});
