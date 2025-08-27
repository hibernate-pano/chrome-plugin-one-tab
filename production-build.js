#!/usr/bin/env node

/**
 * 生产环境构建脚本
 * 专门解决 Chrome 插件 Service Worker 状态码 11 问题
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🚀 开始生产环境构建流程...\n');

try {
  // 1. 清理旧的构建产物
  console.log('🧹 清理旧的构建产物...');
  if (fs.existsSync('dist')) {
    execSync('rm -rf dist', { stdio: 'inherit' });
  }

  // 2. 运行 Vite 构建
  console.log('⚙️  运行 Vite 构建...');
  execSync('npm run build', { stdio: 'inherit' });
  
  // 3. 运行 Service Worker 修复脚本
  console.log('🔧 修复 Service Worker...');
  execSync('node fix-service-worker-enhanced.js', { stdio: 'inherit' });
  
  // 4. 运行验证脚本
  console.log('✅ 运行验证...');
  execSync('node validate-extension.js', { stdio: 'inherit' });
  
  // 5. 创建生产环境标记
  console.log('📝 创建生产环境标记...');
  const buildInfo = {
    buildTime: new Date().toISOString(),
    version: JSON.parse(fs.readFileSync('manifest.json', 'utf8')).version,
    target: 'production',
    serviceWorkerFixed: true
  };
  
  fs.writeFileSync('dist/BUILD_INFO.json', JSON.stringify(buildInfo, null, 2));
  
  console.log('\n🎉 生产环境构建完成！');
  console.log('📦 可以打包 dist 目录上传到 Chrome 商店了');
  
} catch (error) {
  console.error('❌ 构建失败:', error.message);
  process.exit(1);
}