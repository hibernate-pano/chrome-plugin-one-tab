#!/usr/bin/env node

/**
 * 打包Chrome扩展为可发布的zip文件（简化版本）
 * 信任@crxjs/vite-plugin的构建结果
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DIST_DIR = path.join(__dirname, 'dist');
const OUTPUT_FILE = path.join(__dirname, 'chrome-extension.zip');

console.log('📦 开始打包Chrome扩展...');

try {
  // 1. 检查dist目录是否存在
  if (!fs.existsSync(DIST_DIR)) {
    throw new Error('dist目录不存在，请先运行 pnpm build');
  }

  // 2. 删除旧的zip文件
  if (fs.existsSync(OUTPUT_FILE)) {
    fs.unlinkSync(OUTPUT_FILE);
    console.log('🗑️  删除旧的扩展包');
  }

  // 3. 基本验证（只检查关键文件，不修改任何构建结果）
  const requiredFiles = [
    'manifest.json',
    'icons/icon16.png',
    'icons/icon48.png', 
    'icons/icon128.png'
  ];

  for (const file of requiredFiles) {
    const filePath = path.join(DIST_DIR, file);
    if (!fs.existsSync(filePath)) {
      console.warn(`⚠️  关键文件可能缺失: ${file}`);
    }
  }
  console.log('✅ 基本文件验证完成');

  // 4. 检查是否有以"_"开头的文件（但不删除，只警告）
  const checkForReservedFiles = (dir, relativePath = '') => {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (file.startsWith('_')) {
        console.warn(`⚠️  发现以"_"开头的文件: ${path.join(relativePath, file)}`);
      }
      const fullPath = path.join(dir, file);
      if (fs.statSync(fullPath).isDirectory()) {
        checkForReservedFiles(fullPath, path.join(relativePath, file));
      }
    }
  };

  checkForReservedFiles(DIST_DIR);

  // 5. 创建zip文件
  console.log('🔄 正在创建zip文件...');
  
  const zipCommand = `cd "${DIST_DIR}" && zip -r "${OUTPUT_FILE}" . -x "*.DS_Store" "*.git*"`;
  execSync(zipCommand, { stdio: 'inherit' });

  // 6. 验证zip文件
  if (!fs.existsSync(OUTPUT_FILE)) {
    throw new Error('zip文件创建失败');
  }

  const stats = fs.statSync(OUTPUT_FILE);
  console.log(`✅ 扩展包创建成功: chrome-extension.zip (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

  console.log('');
  console.log('🎉 打包完成！');
  console.log('');
  console.log('📤 现在可以将 chrome-extension.zip 上传到Chrome Web Store了！');
  console.log('');
  console.log('📝 注意：');
  console.log('- 本脚本信任@crxjs/vite-plugin的构建结果');
  console.log('- 如有问题，请检查vite和@crxjs插件版本兼容性');

} catch (error) {
  console.error('❌ 打包失败:', error.message);
  process.exit(1);
}
