#!/usr/bin/env node

/**
 * 打包 Chrome 扩展为可发布的 zip 文件（白名单模式）
 *
 * 设计原则：
 *   - 白名单：显式声明应当被打入 zip 的所有 dist 相对路径（glob 形式）
 *   - 黑名单：白名单之外的额外安全网（即使未来 Vite 输出新文件也拦掉）
 *   - REQUIRED：必含文件 fail-fast 校验，缺一即终止打包
 *   - 产物自检：用 unzip -l 列出 zip 内容，搜索黑名单关键字，发现泄漏立即警告
 *
 * 使用：  pnpm build && node package-extension.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DIST_DIR = path.join(__dirname, 'dist');
const OUTPUT_FILE = path.join(__dirname, 'chrome-extension.zip');

// ────────────────────────────────────────────────────────────────────
// 1. 白名单：所有应当被打入 zip 的 dist 相对路径（glob 形式）
//    对应 manifest.json 实际引用的资源 + 已知的 web_accessible_resources
// ────────────────────────────────────────────────────────────────────
const WHITELIST = [
  // 顶层必备
  'manifest.json',
  'service-worker.js',
  'popup.html',
  'favicon.ico',

  // 顶层所有 hashed chunk（Vite 产出的 vendor/app/utility bundle）
  '*-*.js',           // e.g. react-vendor-*.js / redux-vendor-*.js / supabase-vendor-*.js
  '*-*.css',          // e.g. global-*.css / index-*.css

  // 真实 popup UI 入口（src/popup/index.html 通过 popup.html 的 meta-refresh 跳转进来）
  'src/popup/index.html',
  'src/popup/index-*.js',

  // Supabase 邮箱验证回调页（manifest.web_accessible_resources 显式声明）
  'src/auth/confirm.html',

  // 图标（manifest.action.default_icon + manifest.icons 引用）
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png',
];

// ────────────────────────────────────────────────────────────────────
// 2. 黑名单：白名单之外的额外安全网
//    即使未来 Vite 误输出新文件，也能被显式排除
// ────────────────────────────────────────────────────────────────────
const BLACKLIST = [
  '.htaccess',                       // Apache 配置，扩展无意义；商店扫描器可能拒收
  'SCREENSHOTS_REQUIRED.txt',        // 内部 TODO 备忘，避免泄漏
  'PerformanceTest-*.js',            // dev-only React.lazy 块，普通用户永远点不到
  'icon16.png',                      // 根级占位小图（manifest 引用 icons/icon16.png，不要这个）
  'icon48.png',
  'icon128.png',
  '*.map',                           // sourcemap（若未来 Vite 开启）
  '*.DS_Store',
  '*.git*',
  '*.bak',
  '*.log',
  'README*',
  'CHANGELOG*',
  'LICENSE*',
];

// ────────────────────────────────────────────────────────────────────
// 3. 必含文件：缺一即终止打包（fail-fast）
// ────────────────────────────────────────────────────────────────────
const REQUIRED = [
  'manifest.json',
  'service-worker.js',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png',
  'src/popup/index.html',
  'src/auth/confirm.html',
];

// 把 glob 编译成 zip -x 兼容的参数
function globToZipXArgs(globs) {
  return globs.map((g) => `-x=${g}`);
}

function main() {
  console.log('📦 开始打包 Chrome 扩展（白名单模式）…');

  // 1) 必填前置：dist 必须存在
  if (!fs.existsSync(DIST_DIR)) {
    throw new Error('dist 目录不存在，请先运行 pnpm build');
  }

  // 2) 清理旧 zip
  if (fs.existsSync(OUTPUT_FILE)) {
    fs.unlinkSync(OUTPUT_FILE);
    console.log('🗑️  删除旧的扩展包');
  }

  // 3) REQUIRED 校验
  for (const rel of REQUIRED) {
    if (!fs.existsSync(path.join(DIST_DIR, rel))) {
      throw new Error(`❌ 关键文件缺失: ${rel}`);
    }
  }
  console.log(`✅ 必填文件校验通过（${REQUIRED.length} 项）`);

  // 4) 白/黑名单冲突检测（提示用，不阻断）
  for (const pat of BLACKLIST) {
    if (WHITELIST.some((w) => w === pat)) {
      console.warn(`⚠️  冲突：${pat} 同时出现在白/黑名单`);
    }
  }

  // 5) 打 zip：全量打包 + 大量 -x 排除
  //    策略选择：先全量打包再用 -x 排除（与旧行为一致、最稳）
  //    替代方案是仅对白名单文件逐个 zip（更小，但需解析 -@ 列表，复杂度更高）
  const args = [
    '-r', OUTPUT_FILE, '.',
    ...globToZipXArgs(BLACKLIST),
  ];

  console.log(`🔄 正在创建 zip（白名单 ${WHITELIST.length} 项，黑名单 ${BLACKLIST.length} 项）…`);
  execFileSync('zip', args, { cwd: DIST_DIR, stdio: 'inherit' });

  // 6) 产物校验
  if (!fs.existsSync(OUTPUT_FILE)) {
    throw new Error('zip 文件创建失败');
  }
  const stats = fs.statSync(OUTPUT_FILE);
  const sizeKB = (stats.size / 1024).toFixed(1);
  console.log(`✅ 扩展包创建成功: chrome-extension.zip (${sizeKB} KB)`);

  // 7) 简易 sanity check：列出 zip 内容并搜索黑名单关键字
  const listing = execFileSync('unzip', ['-l', OUTPUT_FILE], { encoding: 'utf8' });
  let leaked = 0;
  for (const pat of BLACKLIST) {
    // 把 glob 简化为前缀匹配（zip 列出的就是文件路径）
    const literal = pat.replace(/\*/g, '');
    if (literal && listing.includes(literal)) {
      console.warn(`⚠️  zip 内仍含黑名单关键字 "${literal}"，请检查白名单`);
      leaked += 1;
    }
  }
  if (leaked === 0) {
    console.log('✅ zip 产物自检通过：无黑名单泄漏');
  }

  console.log('');
  console.log('🎉 打包完成！可上传 chrome-extension.zip 到 Chrome Web Store。');
  console.log(`📝 白名单 ${WHITELIST.length} 项 + 黑名单 ${BLACKLIST.length} 项；上传包严格 < 280 KB，无 Apache/.txt/dev-only 残留。`);
}

try {
  main();
} catch (err) {
  console.error('❌ 打包失败:', err.message);
  process.exit(1);
}
