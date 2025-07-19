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
      rollupOptions: {
        input: {
          'background': resolve(__dirname, 'src/background.ts'),
          'src/popup/index': resolve(__dirname, 'src/popup/index.html'),
          'popup': resolve(__dirname, 'popup.html'),
          'confirm': resolve(__dirname, 'src/auth/confirm.html'),
          'wechat-login': resolve(__dirname, 'src/pages/wechat-login.html'),
          'oauth-callback': resolve(__dirname, 'src/pages/oauth-callback.html')
        },
        output: {
          // 暂时禁用手动分块以解决依赖解析问题
          // manualChunks: {
          //   // React 相关库打包到一起
          //   'react-vendor': ['react', 'react-dom', 'react-redux'],
          //   // Redux 相关库打包到一起
          //   'redux-vendor': ['@reduxjs/toolkit'],
          //   // Supabase 相关库打包到一起
          //   'supabase-vendor': ['@supabase/supabase-js'],
          //   // 工具函数打包到一起
          //   'utils': [
          //     './src/shared/utils/storage.ts',
          //     './src/shared/utils/supabase.ts',
          //     './src/shared/utils/syncUtils.ts',
          //     './src/shared/utils/syncHelpers.ts',
          //     './src/shared/utils/encryptionUtils.ts'
          //   ]
          // }
        }
      }
    }
  };
});
