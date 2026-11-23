#!/usr/bin/env node

/**
 * 打包Chrome扩展为可发布的zip文件（简化版本）
 * 信任@crxjs/vite-plugin的构建结果
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { checkSupabaseConfigInArtifacts } from './scripts/lib/supabaseBuildGate.mjs';

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

  // 4.5 **产物闸门**：产物里必须真的内联了 Supabase 配置，否则**拒绝出包**。
  //
  // 【为什么这道闸不是多余的】构建期那道闸（vite.config.ts）查的是**配置形态**，
  // 它拦不住「配置是桩值/占位符」——那依然是「有值」，构建照样成功。
  // 而 2026-11-21 的线上事故正是这一类：配置**整段缺失**，
  // vite 静默放行 ⇒ 产物里既没有项目地址也没有密钥 ⇒ 用户点登录就报
  // 「Supabase 配置缺失」。
  // ⇒ 这里直接看**产物本身**：必须能找到**本项目的**地址与完整形态的 key。
  //   （地址钉死是为了防「连错项目」—— 那种症状是「登录成功但库里什么都没有」，
  //    比直接报错更难查；地址是公开信息，钉死它不新增任何暴露面。）
  const artifactTexts = [];
  const collectArtifactTexts = (dir) => {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (fs.statSync(full).isDirectory()) {
        collectArtifactTexts(full);
      } else if (/\.(js|html|json)$/.test(entry)) {
        artifactTexts.push(fs.readFileSync(full, 'utf8'));
      }
    }
  };
  collectArtifactTexts(DIST_DIR);
  const artifactGate = checkSupabaseConfigInArtifacts(artifactTexts);
  if (!artifactGate.ok) {
    throw new Error(
      '拒绝出包：构建产物里没有 Supabase 配置 —— ' +
        artifactGate.problems.join('；') +
        '\n' +
        '（这个包装上去 = 线上用户点登录就报「Supabase 配置缺失」。' +
        '先修构建期的 .env / .env.local，再重新 pnpm build。）'
    );
  }
  console.log('✅ 产物里已内联 Supabase 配置（登录可用）');

  // 5. 创建zip文件
  console.log('🔄 正在创建zip文件...');

  // 改用 execFileSync + 数组参数：DIST_DIR/OUTPUT_FILE 即使将来改为外部输入，
  // 也不会被 shell 解析为额外 token，从模式上消除命令注入风险。
  execFileSync(
    'zip',
    ['-r', OUTPUT_FILE, '.', '-x', '*.DS_Store', '*.git*'],
    { cwd: DIST_DIR, stdio: 'inherit' }
  );

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
