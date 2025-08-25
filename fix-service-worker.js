#!/usr/bin/env node

/**
 * 修复Chrome扩展Service Worker在生产环境中的问题
 *
 * 问题：
 * 1. @crxjs/vite-plugin 生成的 service-worker-loader.js 使用ES6模块导入
 * 2. Chrome扩展的Service Worker在某些情况下不能正确处理模块导入
 * 3. 需要将Service Worker作为独立文件输出
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DIST_DIR = path.join(__dirname, 'dist');
const MANIFEST_PATH = path.join(DIST_DIR, 'manifest.json');
const SERVICE_WORKER_LOADER_PATH = path.join(DIST_DIR, 'service-worker-loader.js');

console.log('🔧 开始修复Service Worker配置...');

try {
  // 1. 读取manifest.json
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error('manifest.json 不存在');
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  console.log('✅ 读取manifest.json成功');

  // 2. 检查service-worker-loader.js
  if (!fs.existsSync(SERVICE_WORKER_LOADER_PATH)) {
    console.log('⚠️  service-worker-loader.js 不存在，可能已经是独立文件');
    process.exit(0);
  }

  const loaderContent = fs.readFileSync(SERVICE_WORKER_LOADER_PATH, 'utf8');
  console.log('📄 service-worker-loader.js 内容:', loaderContent);

  // 3. 提取实际的service worker文件路径
  const importMatch = loaderContent.match(/import\s+['"](.+?)['"];?/);
  if (!importMatch) {
    throw new Error('无法从service-worker-loader.js中提取导入路径');
  }

  const actualServiceWorkerPath = importMatch[1];
  const fullServiceWorkerPath = path.join(DIST_DIR, actualServiceWorkerPath);

  console.log('🎯 找到实际的Service Worker文件:', actualServiceWorkerPath);

  // 4. 检查实际的service worker文件是否存在
  if (!fs.existsSync(fullServiceWorkerPath)) {
    throw new Error(`实际的Service Worker文件不存在: ${fullServiceWorkerPath}`);
  }

  // 5. 复制实际的service worker文件到根目录
  const targetServiceWorkerPath = path.join(DIST_DIR, 'service-worker.js');
  fs.copyFileSync(fullServiceWorkerPath, targetServiceWorkerPath);
  console.log('📋 复制Service Worker文件到:', targetServiceWorkerPath);

  // 6. 更新manifest.json中的service worker路径
  manifest.background.service_worker = 'service-worker.js';
  // 移除type: "module"，提高兼容性
  delete manifest.background.type;
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log('📝 更新manifest.json中的Service Worker路径，移除module类型');

  // 7. 删除不需要的service-worker-loader.js
  fs.unlinkSync(SERVICE_WORKER_LOADER_PATH);
  console.log('🗑️  删除service-worker-loader.js');

  // 8. 检查并清理可能的_metadata文件
  const files = fs.readdirSync(DIST_DIR);
  const metadataFiles = files.filter(file => file.startsWith('_'));

  if (metadataFiles.length > 0) {
    console.log('⚠️  发现以下以"_"开头的文件:', metadataFiles);
    metadataFiles.forEach(file => {
      const filePath = path.join(DIST_DIR, file);
      if (fs.statSync(filePath).isFile()) {
        fs.unlinkSync(filePath);
        console.log('🗑️  删除文件:', file);
      }
    });
  } else {
    console.log('✅ 没有发现以"_"开头的文件');
  }

  console.log('🎉 Service Worker修复完成！');
  console.log('');
  console.log('修复内容：');
  console.log('1. ✅ 将Service Worker从模块加载器改为独立文件');
  console.log('2. ✅ 更新manifest.json中的Service Worker路径');
  console.log('3. ✅ 清理不必要的加载器文件');
  console.log('4. ✅ 检查并清理可能的_metadata文件');
  console.log('');
  console.log('现在可以将dist目录打包为Chrome扩展了！');

} catch (error) {
  console.error('❌ 修复失败:', error.message);
  process.exit(1);
}
