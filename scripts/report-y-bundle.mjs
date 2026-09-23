#!/usr/bin/env node
/**
 * V2 影子双写 · 体积门控报告（预算 120KB gzip，见 src/core/yShadowConfig.ts BUNDLE_GZIP_BUDGET_KB）。
 *
 * 用法：pnpm build 后执行 `node scripts/report-y-bundle.mjs`
 * - 统计 yjs / y-indexeddb / dexie 三个新增依赖的 ESM 载荷 gzip 体积；
 * - 统计 dist/ 下各 JS chunk 的 gzip 体积，定位 Y 相关异步 chunk；
 * - 与 120KB 预算比较：超预算打印 ALERT（告警 + 精确数字，不以非零退出码
 *   阻断构建——影子链路为动态 import 异步 chunk，主包不受影响，见报告）。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const BUDGET_KB = 120;

function gzKb(path) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path);
  return { rawKb: raw.length / 1024, gzipKb: gzipSync(raw).length / 1024 };
}

function resolveDep(rel) {
  const p = join(ROOT, 'node_modules', rel);
  return existsSync(p) ? p : null;
}

console.log('=== TapStack V2 影子双写 · 体积报告 ===\n');

// 1) 新增依赖载荷
const depFiles = {
  yjs: ['yjs/dist/yjs.mjs'],
  'y-indexeddb': ['y-indexeddb/dist/y-indexeddb.mjs', 'y-indexeddb/dist/y-indexeddb.cjs'],
  dexie: ['dexie/dist/dexie.mjs'],
};
let depGzipTotal = 0;
for (const [name, rels] of Object.entries(depFiles)) {
  const rel = rels.find(r => resolveDep(r));
  const p = rel ? resolveDep(rel) : null;
  if (!p) {
    console.log(`  [${name}] 未安装（${rel} 缺失）`);
    continue;
  }
  const s = gzKb(p);
  depGzipTotal += s.gzipKb;
  console.log(`  [${name}] raw ${s.rawKb.toFixed(1)}KB / gzip ${s.gzipKb.toFixed(1)}KB  (${rel})`);
}
console.log(`\n  新增依赖 gzip 合计：${depGzipTotal.toFixed(1)}KB（预算 ${BUDGET_KB}KB）`);

// 2) 构建产物 chunk
const dist = join(ROOT, 'dist');
if (existsSync(dist)) {
  console.log('\n  dist/ JS chunk（gzip）：');
  const files = [];
  const walk = dir => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.js')) files.push(p);
    }
  };
  walk(dist);
  let total = 0;
  for (const f of files.sort()) {
    const s = gzKb(f);
    total += s.gzipKb;
    const tag = /yjs|y-indexeddb|dexie|yShadow|ydoc|yMaterialize|yTranslate/i.test(f) ? '  ← Y 相关' : '';
    console.log(`    ${f.slice(dist.length + 1)}  gzip ${s.gzipKb.toFixed(1)}KB${tag}`);
  }
  console.log(`  dist JS gzip 合计：${total.toFixed(1)}KB`);
} else {
  console.log('\n  dist/ 不存在（尚未构建），仅报告依赖载荷。');
}

// 3) 门控结论
console.log('');
if (depGzipTotal > BUDGET_KB) {
  console.log(`  ⚠️  ALERT：新增依赖 gzip ${depGzipTotal.toFixed(1)}KB 超过 ${BUDGET_KB}KB 预算（见上精确数字）。`);
  console.log('  缓解：yjs/dexie/y-indexeddb 仅经动态 import() 引入（vite 异步 chunk），');
  console.log('  主 SW 入口与 popup 首屏不受影响；异步 chunk 仅灰度命中用户加载。');
} else {
  console.log(`  ✅ 体积门控通过：新增依赖 gzip ${depGzipTotal.toFixed(1)}KB ≤ ${BUDGET_KB}KB。`);
}
