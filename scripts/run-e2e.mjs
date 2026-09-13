// E2E 统一运行器 —— 6 个既有脚本 + 2 个新增脚本，顺序执行并汇总。
//
//   pnpm e2e                 跑全部（顺序执行，逐个打印尾部日志）
//   pnpm e2e -- --list       只列出会跑哪些
//   pnpm e2e -- --only=fresh 只跑名字含 fresh 的
//
// ⚠️ 这些是**真实环境**测试：真实 Supabase 后端 + 真实 Chromium（headed，加载 dist/ 扩展），
//    每个脚本各注册一个 e2e-*@test.tapstack.dev 测试账号。因此：
//      - 不要在 CI 里无脑跑（需要 GUI 与网络，且会写线上库）
//      - 跑之前先 `pnpm build`（脚本加载 dist/）
//      - 测试账号会残留（脚本内会提示；可用 supabase service_role 清理）
//    单脚本也可以直接 `node scripts/<name>.mjs` 跑，便于定位失败。
//
// 顺序：从"基础能力"到"回归/压力"，前面失败也会继续跑完（便于一次拿到全貌），
// 最后以非零退出码反映是否有失败。

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(process.cwd());
const SCRIPTS_DIR = join(ROOT, 'scripts');

/** 顺序即依赖关系：先验证基础同步，再验证派生行为 */
const ORDER = [
  'e2e-sync-test.mjs',                      // 基础：A 保存上传 → B 登录下载
  'e2e-auto-upload-test.mjs',               // 保存后自动上传（云端直查）
  'e2e-tab-delete-no-resurrect.mjs',        // 标签级墓碑跨设备传播（P0-1 回归）
  'e2e-fresh-device-edit-wins.mjs',         // 新设备编辑必须胜出（P0-2 回归）
  'e2e-background-sync-test.mjs',           // 60s alarm 在 popup 关闭时拉取（SW 上下文验收）
  'e2e-local-delete-no-resurrect.mjs',      // 本地删除/点开不被覆盖（含正控）
  'e2e-stress-no-resurrect.mjs',            // 云端持续写入下的本地意图（含正控）
  'e2e-web-dashboard-sync.mjs',             // Web 仪表盘跨端写入（需 SHIM_CHROME_STORAGE=1 才全绿，见脚本头）
];

const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const only = (args.find(a => a.startsWith('--only=')) || '').split('=')[1] || '';

const available = readdirSync(SCRIPTS_DIR).filter(f => /^e2e-.*\.mjs$/.test(f) && !f.includes('helper'));
const missing = ORDER.filter(f => !existsSync(join(SCRIPTS_DIR, f)));
const extra = available.filter(f => !ORDER.includes(f));

const selected = ORDER.filter(f => existsSync(join(SCRIPTS_DIR, f)) && (!only || f.includes(only)));

if (listOnly) {
  console.log('将按序执行：');
  selected.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  if (missing.length) console.log(`\n⚠️ ORDER 中但不存在：${missing.join(', ')}`);
  if (extra.length) console.log(`⚠️ 存在但未登记进 ORDER：${extra.join(', ')}`);
  process.exit(0);
}

if (missing.length) console.log(`⚠️ 跳过不存在的脚本：${missing.join(', ')}`);
if (extra.length) console.log(`⚠️ 未登记进 ORDER 的脚本（不会被执行）：${extra.join(', ')}`);
if (!selected.length) { console.error('没有匹配的脚本'); process.exit(1); }

const results = [];
for (const file of selected) {
  const name = file.replace(/\.mjs$/, '');
  console.log(`\n${'='.repeat(72)}\n▶ ${file}  (${new Date().toISOString()})\n${'='.repeat(72)}`);
  const started = Date.now();
  const r = spawnSync(process.execPath, [join(SCRIPTS_DIR, file)], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    timeout: 15 * 60_000,
    env: process.env,
  });
  const out = `${r.stdout || ''}${r.stderr ? `\n[stderr]\n${r.stderr}` : ''}`;
  const logPath = join(tmpdir(), `${name}.log`);
  try { writeFileSync(logPath, out); } catch { /* 日志写不了不影响判定 */ }
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(out.trim().split('\n').slice(-25).join('\n'));
  console.log(`◀ ${file}: exit=${r.status} 耗时=${seconds}s  (完整日志 ${logPath})`);
  results.push({ file, exit: r.status, seconds });
}

const failed = results.filter(r => r.exit !== 0);
console.log(`\n${'='.repeat(72)}\n汇总\n${'='.repeat(72)}`);
for (const r of results) {
  console.log(`${r.exit === 0 ? 'PASS' : 'FAIL'}  ${r.file.padEnd(42)} exit=${r.exit} ${r.seconds}s`);
}
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
