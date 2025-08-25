#!/usr/bin/env node

/**
 * 验证Chrome扩展是否符合发布要求
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DIST_DIR = path.join(__dirname, 'dist');
const MANIFEST_PATH = path.join(DIST_DIR, 'manifest.json');

console.log('🔍 开始验证Chrome扩展...');

const errors = [];
const warnings = [];

try {
  // 1. 检查基本文件结构
  if (!fs.existsSync(DIST_DIR)) {
    errors.push('dist目录不存在');
  }

  if (!fs.existsSync(MANIFEST_PATH)) {
    errors.push('manifest.json不存在');
  }

  // 2. 验证manifest.json
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    console.log('✅ manifest.json格式正确');
  } catch (e) {
    errors.push('manifest.json格式错误');
  }

  if (manifest) {
    // 检查Service Worker配置
    if (!manifest.background || !manifest.background.service_worker) {
      errors.push('Service Worker配置缺失');
    } else if (manifest.background.service_worker !== 'service-worker.js') {
      errors.push(`Service Worker路径错误: ${manifest.background.service_worker}`);
    }

    // 检查是否有type: "module"
    if (manifest.background && manifest.background.type === 'module') {
      warnings.push('建议移除background.type: "module"以提高兼容性');
    }

    // 检查manifest版本
    if (manifest.manifest_version !== 3) {
      errors.push('必须使用Manifest V3');
    }

    // 检查必需的权限
    const requiredPermissions = ['tabs', 'storage'];
    const missingPermissions = requiredPermissions.filter(
      perm => !manifest.permissions?.includes(perm)
    );
    if (missingPermissions.length > 0) {
      errors.push(`缺少必需权限: ${missingPermissions.join(', ')}`);
    }
  }

  // 3. 检查Service Worker文件
  const serviceWorkerPath = path.join(DIST_DIR, 'service-worker.js');
  if (!fs.existsSync(serviceWorkerPath)) {
    errors.push('service-worker.js文件不存在');
  } else {
    const content = fs.readFileSync(serviceWorkerPath, 'utf8');
    if (content.includes('import ') || content.includes('export ')) {
      warnings.push('Service Worker包含ES模块语法，可能影响兼容性');
    }
    console.log('✅ Service Worker文件存在');
  }

  // 4. 检查图标文件
  const iconSizes = [16, 48, 128];
  for (const size of iconSizes) {
    const iconPath = path.join(DIST_DIR, 'icons', `icon${size}.png`);
    if (!fs.existsSync(iconPath)) {
      errors.push(`图标文件缺失: icon${size}.png`);
    }
  }

  // 5. 检查保留字文件名
  const checkReservedNames = (dir, relativePath = '') => {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const relativeFile = path.join(relativePath, file);
      
      if (file.startsWith('_')) {
        errors.push(`发现保留字文件名: ${relativeFile}`);
      }
      
      if (fs.statSync(fullPath).isDirectory()) {
        checkReservedNames(fullPath, relativeFile);
      }
    }
  };

  checkReservedNames(DIST_DIR);

  // 6. 检查文件大小
  const stats = getDirectorySize(DIST_DIR);
  if (stats.size > 10 * 1024 * 1024) { // 10MB
    warnings.push(`扩展包较大: ${(stats.size / 1024 / 1024).toFixed(2)}MB`);
  }

  console.log('');
  console.log('📊 验证结果:');
  console.log(`文件总数: ${stats.fileCount}`);
  console.log(`总大小: ${(stats.size / 1024 / 1024).toFixed(2)}MB`);
  
  if (errors.length === 0) {
    console.log('');
    console.log('🎉 验证通过！扩展可以正常发布');
    
    if (warnings.length > 0) {
      console.log('');
      console.log('⚠️  注意事项:');
      warnings.forEach(warning => console.log(`- ${warning}`));
    }
  } else {
    console.log('');
    console.log('❌ 验证失败，发现以下错误:');
    errors.forEach(error => console.log(`- ${error}`));
    
    if (warnings.length > 0) {
      console.log('');
      console.log('⚠️  警告:');
      warnings.forEach(warning => console.log(`- ${warning}`));
    }
    
    process.exit(1);
  }

} catch (error) {
  console.error('❌ 验证过程出错:', error.message);
  process.exit(1);
}

function getDirectorySize(dir) {
  let size = 0;
  let fileCount = 0;
  
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    
    if (stat.isDirectory()) {
      const subResult = getDirectorySize(fullPath);
      size += subResult.size;
      fileCount += subResult.fileCount;
    } else {
      size += stat.size;
      fileCount++;
    }
  }
  
  return { size, fileCount };
}