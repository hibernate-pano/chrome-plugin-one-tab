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
      rollupOptions: {
        input: {
          'src/popup/index': resolve(__dirname, 'src/popup/index.html'),
          'popup': resolve(__dirname, 'popup.html'),
          'confirm': resolve(__dirname, 'src/auth/confirm.html')
        },
        output: {
          // 手动配置代码分块策略
          manualChunks: (id) => {
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
        }
      }
    }
  };
});
