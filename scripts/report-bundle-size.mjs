#!/usr/bin/env node
/**
 * 首屏体积门（2026-10-05 改写；前身是「V2 影子双写体积报告」）。
 *
 * ── 为什么改写 ────────────────────────────────────────────────────────
 * 前身只统计 yjs / y-indexeddb / dexie 三个包的 gzip 体积，预算 120KB，
 * 超了只打印 ALERT 并 exit 0。而那三个包连同影子双写链已在本次瘦身中删除，
 * 于是这个脚本变成了「为一个已不存在的东西服务的门」——它测的量不存在，
 * 也没有任何地方（package.json / validate / CI）调用它。
 *
 * docs/v2-plan.md 曾承诺「超预算阻断发布」，实际从未接线。现在把它改成
 * 一个**真的会被拦下**的门，且测的量是用户真正在等的那个：**popup 首屏
 * 打开时必须下载的全部资源**（entry 的 modulepreload 清单 + 自身 + CSS）。
 *
 * 为什么测「首屏」而不是「dist 总量」：
 *   - 弹窗是一个 400KB 宽的 popup，用户点一下就期待它立刻出现；
 *   - 懒加载的 chunk（设置页、诊断面板等）不在首屏清单里，不该计入；
 *   - dist 总量会被无关的历史产物污染，动辄误报。
 *
 * 用法：`pnpm build` 之后运行（validate 里已自动串好）。
 * 退出码：0 = 在预算内；1 = 超预算或 dist 缺失（门禁真的拦得住才算门禁）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIST = join(ROOT, 'dist');

/**
 * 首屏预算（gzip KB）。
 *
 * 数字来自本次瘦身后的实测：747KB → 674KB raw / 约 205KB gzip。
 * 取 240KB 留约 15% 余量：既能容纳正常增长，又能在「不小心把一个大依赖
 * 引进首屏」时立刻变红。参照值（2026-10-05 实测 gzip）：
 *   supabase-vendor 31.4 / react-vendor 46.0 / utils 35.5 /
 *   popup entry 44.0 / tabGroupSync 5.5 / 两条 CSS 20.7 ≈ 205KB
 */
const BUDGET_KB = 240;

function gzipKb(path) {
  if (!existsSync(path)) return null;
  return gzipSync(readFileSync(path)).length / 1024;
}

if (!existsSync(DIST)) {
  // 静默跳过会是「纸面门」的另一种形式：没构建却显示通过。
  // 但 validate 里 build 在本脚本之后跑，所以到这里必然有 dist；
  // 单独调用本脚本而没构建时报错是正确的。
  console.error('✗ dist/ 不存在。请先 `pnpm build` 再运行体积门。');
  process.exit(1);
}

// popup 的真实入口 HTML。取 src/popup/index.html（popup.html 只是重定向壳）。
const entryHtml = join(DIST, 'src/popup/index.html');
if (!existsSync(entryHtml)) {
  console.error(`✗ 找不到首屏入口 ${entryHtml}。构建产物结构变了？`);
  process.exit(1);
}

const html = readFileSync(entryHtml, 'utf8');

/** 解析 entry HTML 里引用的所有本地资源（去掉 query/hash，解析相对路径）。 */
function referencedAssets() {
  const refs = new Set();
  // modulepreload / script / link[rel=stylesheet]
  for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const url = m[1];
    if (/^(https?:)?\/\//.test(url) || url.startsWith('data:')) continue;
    refs.add(url.replace(/[?#].*$/, ''));
  }
  return [...refs];
}

const assets = referencedAssets()
  .map(rel => {
    const abs = resolve(dirname(entryHtml), rel);
    // 防目录穿越：entry 里出现 ../ 也能解析到 dist 内，但越界就该报错
    if (!abs.startsWith(DIST)) return { rel, abs, gzipKb: null, escaped: true };
    return { rel, abs, gzipKb: gzipKb(abs), escaped: false };
  })
  .sort((a, b) => (b.gzipKb ?? 0) - (a.gzipKb ?? 0));

const escaped = assets.filter(a => a.escaped);
if (escaped.length > 0) {
  console.error('✗ 首屏 HTML 引用了 dist/ 之外的资源：');
  for (const a of escaped) console.error(`    ${a.rel}`);
  process.exit(1);
}

const missing = assets.filter(a => a.gzipKb === null);
if (missing.length > 0) {
  console.error('✗ 首屏 HTML 引用了不存在的文件（构建产物与 HTML 不一致）：');
  for (const a of missing) console.error(`    ${a.rel}`);
  process.exit(1);
}

const entryGzip = gzipKb(entryHtml) ?? 0;
const total = assets.reduce((sum, a) => sum + (a.gzipKb ?? 0), 0) + entryGzip;

console.log('=== popup 首屏体积（gzip）===\n');
for (const a of assets) {
  console.log(`  ${a.gzipKb.toFixed(1).padStart(7)}KB  ${a.rel}`);
}
console.log(`  ${entryGzip.toFixed(1).padStart(7)}KB  ${entryHtml.slice(DIST.length + 1)}（入口 HTML 自身）`);
console.log(`\n  首屏合计 ${total.toFixed(1)}KB / 预算 ${BUDGET_KB}KB`);

if (total > BUDGET_KB) {
  console.error(
    `\n✗ 首屏体积超预算 ${(total - BUDGET_KB).toFixed(1)}KB。\n` +
      '  这个量是用户点开弹窗时必须等的全部资源。它只会因为「把新依赖引进首屏」增长。\n' +
      '  修法：① 把不急用的功能改成动态 import（别进 entry 的 modulepreload 清单）；\n' +
      '        ② 检查 vite.config.ts 的 manualChunks —— 分块规则写错会让懒加载 chunk\n' +
      '           被打进 vendor 桶并被预加载（历史上就这么多背了 30KB gzip）。\n' +
      '  不要直接调大预算——先确认这次增长是不是必要的。'
  );
  process.exit(1);
}

console.log(`\n✅ 体积门控通过：${total.toFixed(1)}KB ≤ ${BUDGET_KB}KB`);
