import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// TapStack 网页版独立构建配置
// 与 Chrome 扩展构建（vite.config.ts）分离，产物输出到 dist-web/ 供 Vercel 部署。
// root 指向 src/web，使 index.html 正确作为应用入口输出到 dist-web/ 根。
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const root = resolve(__dirname, 'src/web');

  return {
    root,
    base: '/',
    plugins: [react()],
    resolve: {
      alias: {
        // 保留 @ 别名指向项目 src/，供复用扩展的 utils / services / types
        '@': resolve(__dirname, './src'),
      },
    },
    build: {
      outDir: resolve(__dirname, 'dist-web'),
      emptyOutDir: true,
      chunkSizeWarningLimit: 1000,
      assetsDir: 'assets',
      rollupOptions: {
        input: resolve(root, 'index.html'),
        output: {
          entryFileNames: 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash].[ext]',
        },
      },
    },
    define: {
      // 注入 Supabase 配置到 import.meta.env，供 src/utils/supabase.ts 读取
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(env.VITE_SUPABASE_URL ?? ''),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(env.VITE_SUPABASE_ANON_KEY ?? ''),
    },
  };
});
