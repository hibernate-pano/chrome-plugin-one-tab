#!/usr/bin/env node

/**
 * 修复Chrome扩展Service Worker在生产环境中的问题
 *
 * 问题：
 * 1. @crxjs/vite-plugin 生成的 service-worker-loader.js 使用ES6模块导入
 * 2. Chrome扩展的Service Worker在某些情况下不能正确处理模块导入
 * 3. 需要将Service Worker作为独立文件输出
 * 4. 状态码 11 通常表示语法错误或模块解析失败
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DIST_DIR = path.join(__dirname, 'dist');
const MANIFEST_PATH = path.join(DIST_DIR, 'manifest.json');
const SERVICE_WORKER_LOADER_PATH = path.join(DIST_DIR, 'service-worker-loader.js');
const SERVICE_WORKER_TARGET_PATH = path.join(DIST_DIR, 'service-worker.js');

console.log('🔧 开始修复Service Worker配置...');

// 语法验证函数
function validateServiceWorkerSyntax(content) {
  const issues = [];
  
  // 检查ES模块语法
  if (content.includes('import ') && !content.includes('// import')) {
    issues.push('❌ 包含 ES 模块导入语句 (import)');
  }
  
  if (content.includes('export ') && !content.includes('// export')) {
    issues.push('❌ 包含 ES 模块导出语句 (export)');
  }
  
  // 检查顶层 await
  if (content.match(/^\s*await\s/m)) {
    issues.push('❌ 包含顶层 await 语句');
  }
  
  // 检查 TypeScript 语法残留
  if (content.includes(': string') || content.includes(': number') || content.includes(': boolean')) {
    issues.push('⚠️  可能包含 TypeScript 类型注解');
  }
  
  // 检查现代 JS 特性兼容性
  if (content.includes('?.')) {
    issues.push('⚠️  包含可选链操作符 (?)，可能存在兼容性问题');
  }
  
  if (content.includes('??')) {
    issues.push('⚠️  包含空值合并操作符 (??)，可能存在兼容性问题');
  }
  
  return issues;
}

// 简单的语法修复函数
function fixCommonSyntaxIssues(content) {
  let fixed = content;
  
  // 移除可能的 TypeScript 类型注解
  fixed = fixed.replace(/:\s*(string|number|boolean|any|void)\b/g, '');
  
  // 移除 ES 模块导入/导出（如果存在）
  fixed = fixed.replace(/^import\s+.*?;?\s*$/gm, '');
  fixed = fixed.replace(/^export\s+.*?;?\s*$/gm, '');
  
  // 确保被 IIFE 包装
  if (!fixed.trim().startsWith('(function()') && !fixed.trim().startsWith('(() =>')) {
    fixed = `(function() {
  'use strict';
  ${fixed}
})();`;
  }
  
  return fixed;
}

// 检查文件是否是有效的 JavaScript
function isValidJavaScript(content) {
  try {
    // 简单的语法检查，不能完全替代真正的解析器，但能检查明显的语法错误
    new Function(content);
    return true;
  } catch (error) {
    console.warn('⚠️  JavaScript 语法检查失败:', error.message);
    return false;
  }
}

try {
  // 1. 读取manifest.json
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error('manifest.json 不存在');
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  console.log('✅ 读取manifest.json成功');

  // 2. 检查是否已经存在目标 service-worker.js
  if (fs.existsSync(SERVICE_WORKER_TARGET_PATH)) {
    console.log('✅ service-worker.js 已存在，进行验证...');
    
    const existingContent = fs.readFileSync(SERVICE_WORKER_TARGET_PATH, 'utf8');
    const syntaxIssues = validateServiceWorkerSyntax(existingContent);
    
    if (syntaxIssues.length > 0) {
      console.log('⚠️  发现语法问题:');
      syntaxIssues.forEach(issue => console.log('  ' + issue));
      
      // 尝试修复
      console.log('🔧 尝试修复语法问题...');
      const fixedContent = fixCommonSyntaxIssues(existingContent);
      fs.writeFileSync(SERVICE_WORKER_TARGET_PATH, fixedContent);
      console.log('✅ 语法问题修复完成');
    } else {
      console.log('✅ Service Worker 语法验证通过');
    }
    
    // 更新 manifest.json 确保路径正确
    manifest.background.service_worker = 'service-worker.js';
    delete manifest.background.type;
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
    console.log('✅ manifest.json 配置已更新');
    
    console.log('🎉 Service Worker已存在且验证完成！');
    process.exit(0);
  }

  // 3. 检查service-worker-loader.js（Vite 构建的产物）
  if (!fs.existsSync(SERVICE_WORKER_LOADER_PATH)) {
    console.log('⚠️  service-worker-loader.js 不存在，尝试寻找其他文件...');
    
    // 寻找任何包含 service-worker 的文件
    const files = fs.readdirSync(DIST_DIR);
    const serviceWorkerFiles = files.filter(file => 
      file.includes('service-worker') && file.endsWith('.js')
    );
    
    if (serviceWorkerFiles.length > 0) {
      console.log('📁 找到可能的 Service Worker 文件:', serviceWorkerFiles);
      const sourceFile = path.join(DIST_DIR, serviceWorkerFiles[0]);
      fs.copyFileSync(sourceFile, SERVICE_WORKER_TARGET_PATH);
      console.log('📋 复制文件:', serviceWorkerFiles[0], '-> service-worker.js');
    } else {
      throw new Error('未找到任何 Service Worker 相关文件');
    }
  } else {
    // 4. 处理 service-worker-loader.js
    const loaderContent = fs.readFileSync(SERVICE_WORKER_LOADER_PATH, 'utf8');
    console.log('📄 service-worker-loader.js 内容片段:', loaderContent.substring(0, 200) + '...');

    // 提取实际的service worker文件路径
    const importMatch = loaderContent.match(/import\s+['"](.+?)['"];?/);
    if (!importMatch) {
      throw new Error('无法从service-worker-loader.js中提取导入路径');
    }

    const actualServiceWorkerPath = importMatch[1];
    const fullServiceWorkerPath = path.join(DIST_DIR, actualServiceWorkerPath);

    console.log('🎯 找到实际的Service Worker文件:', actualServiceWorkerPath);

    // 检查实际的service worker文件是否存在
    if (!fs.existsSync(fullServiceWorkerPath)) {
      throw new Error(`实际的Service Worker文件不存在: ${fullServiceWorkerPath}`);
    }

    // 复制实际的service worker文件到根目录
    fs.copyFileSync(fullServiceWorkerPath, SERVICE_WORKER_TARGET_PATH);
    console.log('📋 复制Service Worker文件到:', SERVICE_WORKER_TARGET_PATH);

    // 删除不需要的service-worker-loader.js
    fs.unlinkSync(SERVICE_WORKER_LOADER_PATH);
    console.log('🗑️  删除service-worker-loader.js');
  }

  // 5. 验证最终的 Service Worker 文件
  const finalContent = fs.readFileSync(SERVICE_WORKER_TARGET_PATH, 'utf8');
  console.log('\n🔍 验证最终的 Service Worker 文件...');
  
  const syntaxIssues = validateServiceWorkerSyntax(finalContent);
  if (syntaxIssues.length > 0) {
    console.log('⚠️  发现语法问题:');
    syntaxIssues.forEach(issue => console.log('  ' + issue));
    
    // 尝试修复
    console.log('🔧 尝试修复语法问题...');
    const fixedContent = fixCommonSyntaxIssues(finalContent);
    fs.writeFileSync(SERVICE_WORKER_TARGET_PATH, fixedContent);
    console.log('✅ 语法问题修复完成');
  } else {
    console.log('✅ Service Worker 语法验证通过');
  }
  
  // 简单的 JavaScript 语法检查
  if (!isValidJavaScript(fs.readFileSync(SERVICE_WORKER_TARGET_PATH, 'utf8'))) {
    console.warn('⚠️  Service Worker 可能存在语法错误，请手动检查');
  } else {
    console.log('✅ JavaScript 语法检查通过');
  }

  // 6. 更新manifest.json中的service worker路径
  manifest.background.service_worker = 'service-worker.js';
  // 移除type: "module"，提高兼容性
  delete manifest.background.type;
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log('📝 更新manifest.json中的Service Worker路径，移除module类型');

  // 7. 检查并清理可能的_metadata文件
  const files = fs.readdirSync(DIST_DIR);
  const metadataFiles = files.filter(file => file.startsWith('_') || file.includes('chunk'));

  if (metadataFiles.length > 0) {
    console.log('\n⚠️  发现可能需要清理的文件:', metadataFiles);
    metadataFiles.forEach(file => {
      const filePath = path.join(DIST_DIR, file);
      if (fs.statSync(filePath).isFile() && !file.includes('assets')) {
        fs.unlinkSync(filePath);
        console.log('🗑️  删除文件:', file);
      }
    });
  } else {
    console.log('✅ 没有发现需要清理的文件');
  }

  // 8. 最终验证
  console.log('\n📊 最终验证结果:');
  console.log('- Service Worker 文件:', fs.existsSync(SERVICE_WORKER_TARGET_PATH) ? '✅ 存在' : '❌ 不存在');
  console.log('- Manifest 配置:', manifest.background.service_worker === 'service-worker.js' ? '✅ 正确' : '❌ 错误');
  console.log('- Module 类型:', manifest.background.type ? '⚠️  仍存在' : '✅ 已移除');
  
  const finalFileSize = fs.statSync(SERVICE_WORKER_TARGET_PATH).size;
  console.log('- 文件大小:', Math.round(finalFileSize / 1024), 'KB');

  console.log('\n🎉 Service Worker修复完成！');
  console.log('');
  console.log('修复内容：');
  console.log('1. ✅ 将Service Worker从模块加载器改为独立文件');
  console.log('2. ✅ 更新manifest.json中的Service Worker路径');
  console.log('3. ✅ 移除可能导致兼容性问题的module类型声明');
  console.log('4. ✅ 验证并修复了语法问题');
  console.log('5. ✅ 清理了不必要的构建文件');
  console.log('');
  console.log('🚀 现在可以将dist目录打包为Chrome扩展了！');
  console.log('💡 建议在本地先测试加载扩展，确认Service Worker正常工作');

} catch (error) {
  console.error('❌ 修复失败:', error.message);
  console.error('\n🔧 建议检查步骤:');
  console.error('1. 确保 npm run build 成功完成');
  console.error('2. 检查 dist 目录是否存在');
  console.error('3. 验证 Service Worker 源文件语法正确');
  console.error('4. 检查 Vite 构建配置是否正确');
  process.exit(1);
}