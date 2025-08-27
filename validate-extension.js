#!/usr/bin/env node

/**
 * 验证 Chrome 扩展构建产物是否符合生产环境要求
 * 特别检查 Service Worker 状态码 11 问题的解决情况
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DIST_DIR = path.join(__dirname, 'dist');
const MANIFEST_PATH = path.join(DIST_DIR, 'manifest.json');
const SERVICE_WORKER_PATH = path.join(DIST_DIR, 'service-worker.js');

console.log('🔍 开始验证 Chrome 扩展构建产物...\n');

// 验证结果存储
const validationResults = {
  manifest: { passed: false, issues: [] },
  serviceWorker: { passed: false, issues: [] },
  fileStructure: { passed: false, issues: [] },
  overall: { passed: false, score: 0 }
};

// 验证 manifest.json
function validateManifest() {
  console.log('📋 验证 manifest.json...');
  
  if (!fs.existsSync(MANIFEST_PATH)) {
    validationResults.manifest.issues.push('❌ manifest.json 文件不存在');
    return;
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    
    // 检查 Service Worker 配置
    if (!manifest.background) {
      validationResults.manifest.issues.push('❌ 缺少 background 配置');
    } else {
      if (manifest.background.service_worker !== 'service-worker.js') {
        validationResults.manifest.issues.push('❌ Service Worker 路径不正确');
      } else {
        validationResults.manifest.issues.push('✅ Service Worker 路径配置正确');
      }
      
      // 检查是否移除了 type: "module"
      if (manifest.background.type) {
        validationResults.manifest.issues.push('⚠️  仍然包含 type 配置，可能导致兼容性问题');
      } else {
        validationResults.manifest.issues.push('✅ 已移除 type 配置，提高兼容性');
      }
    }
    
    // 检查版本和基本信息
    if (manifest.manifest_version === 3) {
      validationResults.manifest.issues.push('✅ 使用 Manifest V3');
    } else {
      validationResults.manifest.issues.push('⚠️  使用非标准 Manifest 版本');
    }
    
    // 检查权限
    const requiredPermissions = ['tabs', 'storage', 'notifications'];
    const hasAllPermissions = requiredPermissions.every(perm => 
      manifest.permissions && manifest.permissions.includes(perm)
    );
    
    if (hasAllPermissions) {
      validationResults.manifest.issues.push('✅ 包含所有必需权限');
    } else {
      validationResults.manifest.issues.push('⚠️  可能缺少必需权限');
    }
    
    validationResults.manifest.passed = validationResults.manifest.issues.filter(i => i.includes('❌')).length === 0;
    
  } catch (error) {
    validationResults.manifest.issues.push(`❌ manifest.json 解析失败: ${error.message}`);
  }
}

// 验证 Service Worker
function validateServiceWorker() {
  console.log('⚙️  验证 Service Worker...');
  
  if (!fs.existsSync(SERVICE_WORKER_PATH)) {
    validationResults.serviceWorker.issues.push('❌ service-worker.js 文件不存在');
    return;
  }

  try {
    const content = fs.readFileSync(SERVICE_WORKER_PATH, 'utf8');
    const fileSize = fs.statSync(SERVICE_WORKER_PATH).size;
    
    // 文件大小检查
    if (fileSize > 0) {
      validationResults.serviceWorker.issues.push(`✅ Service Worker 文件大小: ${Math.round(fileSize / 1024)}KB`);
    } else {
      validationResults.serviceWorker.issues.push('❌ Service Worker 文件为空');
      return;
    }
    
    // 检查是否是压缩后的代码
    if (content.includes('\n') && content.split('\n').length > 10) {
      validationResults.serviceWorker.issues.push('⚠️  代码未压缩，可能影响加载性能');
    } else {
      validationResults.serviceWorker.issues.push('✅ 代码已压缩');
    }
    
    // 检查潜在的语法问题
    const syntaxIssues = [];
    
    // 检查 ES 模块语法（这是状态码 11 的常见原因）
    if (content.includes('import ') && !content.includes('// import')) {
      syntaxIssues.push('ES模块导入语句');
    }
    
    if (content.includes('export ') && !content.includes('// export')) {
      syntaxIssues.push('ES模块导出语句');
    }
    
    // 检查顶层 await
    if (content.match(/^\s*await\s/m)) {
      syntaxIssues.push('顶层await语句');
    }
    
    // 检查 TypeScript 残留
    if (content.includes(': string') || content.includes(': number') || content.includes(': boolean')) {
      syntaxIssues.push('TypeScript类型注解');
    }
    
    if (syntaxIssues.length > 0) {
      validationResults.serviceWorker.issues.push(`❌ 发现潜在语法问题: ${syntaxIssues.join(', ')}`);
    } else {
      validationResults.serviceWorker.issues.push('✅ 未发现已知语法问题');
    }
    
    // 检查 Chrome APIs 使用
    const chromeAPIs = ['chrome.tabs', 'chrome.runtime', 'chrome.storage', 'chrome.action'];
    const usedAPIs = chromeAPIs.filter(api => content.includes(api));
    
    if (usedAPIs.length > 0) {
      validationResults.serviceWorker.issues.push(`✅ 正确使用 Chrome APIs: ${usedAPIs.join(', ')}`);
    } else {
      validationResults.serviceWorker.issues.push('⚠️  未检测到 Chrome APIs 使用');
    }
    
    // 检查是否被 IIFE 包装
    if (content.trim().startsWith('(function()') || content.trim().startsWith('(() =>')) {
      validationResults.serviceWorker.issues.push('✅ 代码被 IIFE 包装，提高兼容性');
    } else {
      validationResults.serviceWorker.issues.push('⚠️  代码未被 IIFE 包装');
    }
    
    // 简单的语法检查
    try {
      // 注意：这不是完整的 JavaScript 解析，只是基本检查
      new Function(content);
      validationResults.serviceWorker.issues.push('✅ 基本语法检查通过');
    } catch (syntaxError) {
      validationResults.serviceWorker.issues.push(`❌ 语法错误: ${syntaxError.message}`);
    }
    
    validationResults.serviceWorker.passed = validationResults.serviceWorker.issues.filter(i => i.includes('❌')).length === 0;
    
  } catch (error) {
    validationResults.serviceWorker.issues.push(`❌ Service Worker 分析失败: ${error.message}`);
  }
}

// 验证文件结构
function validateFileStructure() {
  console.log('📁 验证文件结构...');
  
  const requiredFiles = [
    'manifest.json',
    'service-worker.js',
    'icons/icon16.png',
    'icons/icon48.png',
    'icons/icon128.png'
  ];
  
  const missingFiles = [];
  const presentFiles = [];
  
  requiredFiles.forEach(file => {
    const filePath = path.join(DIST_DIR, file);
    if (fs.existsSync(filePath)) {
      presentFiles.push(file);
    } else {
      missingFiles.push(file);
    }
  });
  
  if (presentFiles.length > 0) {
    validationResults.fileStructure.issues.push(`✅ 存在的必需文件: ${presentFiles.join(', ')}`);
  }
  
  if (missingFiles.length > 0) {
    validationResults.fileStructure.issues.push(`❌ 缺失的必需文件: ${missingFiles.join(', ')}`);
  }
  
  // 检查不应该存在的文件
  const unwantedFiles = [];
  const files = fs.readdirSync(DIST_DIR);
  
  files.forEach(file => {
    if (file.startsWith('_') || file.includes('loader') || file.includes('chunk')) {
      unwantedFiles.push(file);
    }
  });
  
  if (unwantedFiles.length > 0) {
    validationResults.fileStructure.issues.push(`⚠️  发现可能不需要的文件: ${unwantedFiles.join(', ')}`);
  } else {
    validationResults.fileStructure.issues.push('✅ 没有发现不需要的构建文件');
  }
  
  validationResults.fileStructure.passed = missingFiles.length === 0;
}

// 计算总体评分
function calculateOverallScore() {
  const components = ['manifest', 'serviceWorker', 'fileStructure'];
  const passedComponents = components.filter(comp => validationResults[comp].passed).length;
  
  validationResults.overall.score = Math.round((passedComponents / components.length) * 100);
  validationResults.overall.passed = validationResults.overall.score >= 80;
}

// 生成报告
function generateReport() {
  console.log('\n📊 验证报告\n');
  
  // Manifest 验证结果
  console.log('📋 Manifest 验证:');
  validationResults.manifest.issues.forEach(issue => console.log(`  ${issue}`));
  console.log(`  状态: ${validationResults.manifest.passed ? '✅ 通过' : '❌ 失败'}\n`);
  
  // Service Worker 验证结果
  console.log('⚙️  Service Worker 验证:');
  validationResults.serviceWorker.issues.forEach(issue => console.log(`  ${issue}`));
  console.log(`  状态: ${validationResults.serviceWorker.passed ? '✅ 通过' : '❌ 失败'}\n`);
  
  // 文件结构验证结果
  console.log('📁 文件结构验证:');
  validationResults.fileStructure.issues.forEach(issue => console.log(`  ${issue}`));
  console.log(`  状态: ${validationResults.fileStructure.passed ? '✅ 通过' : '❌ 失败'}\n`);
  
  // 总体评估
  console.log('🎯 总体评估:');
  console.log(`  评分: ${validationResults.overall.score}/100`);
  console.log(`  状态: ${validationResults.overall.passed ? '✅ 通过' : '❌ 需要改进'}\n`);
  
  // 针对状态码 11 问题的特别说明
  console.log('🚀 关于状态码 11 问题:');
  const hasModuleType = validationResults.manifest.issues.some(i => i.includes('仍然包含 type 配置'));
  const hasSyntaxIssues = validationResults.serviceWorker.issues.some(i => i.includes('发现潜在语法问题'));
  
  if (!hasModuleType && !hasSyntaxIssues) {
    console.log('  ✅ 已解决可能导致状态码 11 的主要问题');
    console.log('  ✅ 移除了 type: "module" 配置');
    console.log('  ✅ Service Worker 语法检查通过');
    console.log('  ✅ 建议可以发布到 Chrome 应用商店');
  } else {
    console.log('  ⚠️  仍存在可能导致状态码 11 的问题');
    if (hasModuleType) {
      console.log('  - 需要移除 manifest.json 中的 type 配置');
    }
    if (hasSyntaxIssues) {
      console.log('  - 需要修复 Service Worker 中的语法问题');
    }
  }
  
  console.log('\n💡 建议下一步:');
  if (validationResults.overall.passed) {
    console.log('  1. 在本地 Chrome 中加载扩展进行测试');
    console.log('  2. 验证所有功能正常工作');
    console.log('  3. 打包上传到 Chrome 应用商店');
    console.log('  4. 监控用户反馈，确认问题已解决');
  } else {
    console.log('  1. 修复上述发现的问题');
    console.log('  2. 重新运行验证脚本');
    console.log('  3. 确保所有验证项目通过');
  }
}

// 主函数
try {
  validateManifest();
  validateServiceWorker();
  validateFileStructure();
  calculateOverallScore();
  generateReport();
  
  process.exit(validationResults.overall.passed ? 0 : 1);
  
} catch (error) {
  console.error('❌ 验证过程中发生错误:', error.message);
  process.exit(1);
}