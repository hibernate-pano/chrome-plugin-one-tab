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
      rollupOptions: {
        input: {
          'service-worker': resolve(__dirname, 'src/service-worker.ts'),
          'src/popup/index': resolve(__dirname, 'src/popup/index.html'),
          'popup': resolve(__dirname, 'popup.html'),
          'confirm': resolve(__dirname, 'src/auth/confirm.html'),
          'wechat-login': resolve(__dirname, 'src/pages/wechat-login.html')
        }
      }
    }
  };
});
