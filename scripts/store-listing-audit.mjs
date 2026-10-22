#!/usr/bin/env node
/**
 * 商店文案体检（2026-10-23 · 第 43 轮 R-8）。
 *
 * 抓线上 Chrome Web Store 的公开页 ⇒ 抽出「版本 / 简介 / 详细描述」⇒ 用
 * `scripts/store-listing-judge.mjs` 的判据，**按线上自己声称的那个版本**核对：
 * 哪些话是假的、哪些该说的没说。
 *
 * ── 为什么需要这个脚本 ────────────────────────────────────────────────────
 *
 * **商店文案没有 API 通道。**  CWS v1.1 的 `Item` 只暴露
 * `id / itemError / crxVersion / uploadState / publicKey / kind`，
 * v2 只暴露 `media.upload` ⇒ **改文案只能在商店后台人工粘贴**。
 * 于是这件事天然是「人做的」，但**判据应该是机器做的** —— 否则每次都要靠人
 * 记得去核对，而这份文案已经证明过一次：线上那份描述的是另一个产品
 * （「分组管理 / 自动折叠空分组」这种本产品从来就没有的功能）。
 *
 * 用法：
 *   node scripts/store-listing-audit.mjs            # 体检线上（要联网）
 *   node scripts/store-listing-audit.mjs --offline   # 用仓库里的真实快照体检
 *   node scripts/store-listing-audit.mjs --print-text # 只打印「该粘到后台的文案」
 *
 * 退出码：有违规 ⇒ 1；干净 ⇒ 0；连不上 ⇒ 2（环境问题，不算「通过」）。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LIVE_LISTING_URL,
  extractLiveListing,
  extractRepoListing,
  judgeListing,
} from './store-listing-judge.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = resolve(ROOT, 'tests/fixtures/store-listing-live-2026-10-23.html');

const args = process.argv.slice(2);
const offline = args.includes('--offline');
const printTextOnly = args.includes('--print-text');

const read = rel => readFileSync(resolve(ROOT, rel), 'utf8');

async function fetchLive() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(LIVE_LISTING_URL, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return { kind: 'notFound', status: res.status };
    return { kind: 'ok', body: await res.text() };
  } catch (err) {
    return { kind: 'offline', error: String(err) };
  }
}

function pasteable(repo) {
  return [
    '## Short Description',
    repo.shortDescription,
    '',
    '## Detailed Description',
    repo.detailedDescription,
  ].join('\n');
}

const repo = extractRepoListing(read('CHROMEWEBSTORE.md'));

if (printTextOnly) {
  process.stdout.write(pasteable(repo) + '\n');
  process.exit(0);
}

const fetched = offline ? { kind: 'ok', body: readFileSync(FIXTURE, 'utf8') } : await fetchLive();

if (fetched.kind === 'notFound') {
  console.error(`✗ 线上商店页返回 HTTP ${fetched.status} —— 商店条目打不开。`);
  process.exit(2);
}
if (fetched.kind === 'offline') {
  console.error(`✗ 连不上线上商店页（${fetched.error}）—— 这是环境问题，**不算通过**。`);
  process.exit(2);
}

const live = extractLiveListing(fetched.body);
if (!live || !live.version) {
  console.error('✗ 线上页面里找不到版本号 —— 抓取到的不是商店详情页（页面结构变了？）。');
  process.exit(2);
}

const violations = judgeListing({
  version: live.version,
  tagline: live.tagline,
  description: live.description,
});

console.log('══════════════════════════════════════════════════════════════');
console.log(` 线上商店页：${LIVE_LISTING_URL}`);
console.log(` 版本 ${live.version}（${live.updated ?? '未知'}）`);
console.log('══════════════════════════════════════════════════════════════');
console.log('');
console.log('【简介】' + (live.tagline || '（空）'));
console.log('');
console.log('【详细描述】');
console.log(live.description || '（空）');
console.log('');

if (violations.length === 0) {
  console.log('✅ 线上文案在该版本下没有发现问题。');
  process.exit(0);
}

console.log(`❌ 发现 ${violations.length} 处问题（判据针对的是它自己声称的 ${live.version}）：`);
console.log('');
// 按「问题」聚合，不按「出现在哪一段」罗列 —— 同一个毛病在中文段和英文段各犯一次，
// 那还是**一个**毛病，读者要的是「有哪几件事不对」。
const grouped = new Map();
for (const v of violations) {
  const g = grouped.get(v.code) ?? { ...v, where: [] };
  g.where.push(v.where);
  grouped.set(v.code, g);
}
for (const v of grouped.values()) {
  const label = v.kind === 'lie' ? '说了假话' : '漏说了';
  console.log(`  · [${label}] ${v.code}（${v.where.join('、')}）`);
  console.log(`      命中：${v.evidence}`);
  console.log(`      原因：${v.why}`);
  console.log('');
}
console.log('修法：把商店后台的文案替换成下面这段（CHROMEWEBSTORE.md 的 Store Listing 段）。');
console.log('⚠️ 商店文案**没有 API 通道**，只能人工粘贴。');
console.log('⚠️ 若线上版本还是 1.25.1，而文案里出现「撤销」—— 那是 1.26.0 才有的能力，');
console.log('   要么先发 1.26.0 再换文案，要么先把「撤销」那段摘掉。');
console.log('');
console.log('────────── 该粘到后台的内容 ──────────');
console.log(pasteable(repo));
process.exit(1);
