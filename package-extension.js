#!/usr/bin/env node

/**
 * 打包Chrome扩展为可发布的zip文件
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

  // 3. 验证关键文件
  const requiredFiles = [
    'manifest.json',
    'service-worker.js',
    'icons/icon16.png',
    'icons/icon48.png',
    'icons/icon128.png'
  ];

  for (const file of requiredFiles) {
    const filePath = path.join(DIST_DIR, file);
    if (!fs.existsSync(filePath)) {
      throw new Error(`关键文件缺失: ${file}`);
    }
  }
  console.log('✅ 关键文件验证通过');

  // 4. 检查manifest.json中的service worker配置
  const manifestPath = path.join(DIST_DIR, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  
  if (manifest.background.service_worker !== 'service-worker.js') {
    throw new Error(`Service Worker配置错误: ${manifest.background.service_worker}`);
  }
  console.log('✅ Service Worker配置验证通过');

  // 5. 检查是否有以"_"开头的文件
  const checkForReservedFiles = (dir) => {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (file.startsWith('_')) {
        throw new Error(`发现保留字文件名: ${file}`);
      }
      const fullPath = path.join(dir, file);
      if (fs.statSync(fullPath).isDirectory()) {
        checkForReservedFiles(fullPath);
      }
    }
  };

  checkForReservedFiles(DIST_DIR);
  console.log('✅ 文件名验证通过');

  // 6. 创建zip文件
  console.log('🔄 正在创建zip文件...');
  
  // 使用系统的zip命令
  const zipCommand = `cd "${DIST_DIR}" && zip -r "${OUTPUT_FILE}" . -x "*.DS_Store" "*.git*"`;
  execSync(zipCommand, { stdio: 'inherit' });

  // 7. 验证zip文件
  if (!fs.existsSync(OUTPUT_FILE)) {
    throw new Error('zip文件创建失败');
  }

  const stats = fs.statSync(OUTPUT_FILE);
  console.log(`✅ 扩展包创建成功: chrome-extension.zip (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

  console.log('');
  console.log('🎉 打包完成！');
  console.log('');
  console.log('📋 修复内容总结：');
  console.log('1. ✅ Service Worker从模块加载器改为独立文件');
  console.log('2. ✅ 清理了所有以"_"开头的保留字文件');
  console.log('3. ✅ 验证了所有关键文件的存在');
  console.log('4. ✅ 确认了manifest.json配置正确');
  console.log('');
  console.log('📤 现在可以将 chrome-extension.zip 上传到Chrome Web Store了！');
  console.log('');
  console.log('🔧 如果仍然遇到问题，请检查：');
  console.log('- Chrome扩展开发者模式是否启用');
  console.log('- 是否有其他扩展冲突');
  console.log('- 浏览器版本是否支持Manifest V3');

} catch (error) {
  console.error('❌ 打包失败:', error.message);
  process.exit(1);
}
