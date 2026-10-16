// E2E 统一运行器 —— 顺序执行并汇总。
//
//   pnpm e2e                 跑全部（顺序执行，逐个打印尾部日志）
//   pnpm e2e -- --list       只列出会跑哪些
//   pnpm e2e -- --only=fresh 只跑名字含 fresh 的
//   pnpm e2e -- --no-cleanup 跳过收尾清理（保留本次运行的测试数据便于复现）
//
// ⚠️ 这些是**真实环境**测试：真实 Chromium（headed，加载 dist/ 扩展）。
//    2026-10-16 Supabase 下线、账号体系删除后：原先 4 支驱动已删登录 UI 的
//    数据安全脚本（tab-delete / background-sync / local-delete / stress）已改为
//    本机 dufs + WebDAV；加上 WebDAV 三支与其余本地脚本，登记表里的脚本
//    **一个都不需要账号/环境凭据**。这不是口号：任何重新 import 已死 login()
//    的登记脚本会被下面的 findDeadLoginImports 门禁判失败，改不回假防线。
//    因此：
//      - 不要在 CI 里无脑跑（需要 GUI 与网络）
//      - 跑之前先 `pnpm build`（脚本加载 dist/）
//      - 跑完由本文件的收尾钩子统一**上报**本次产生的测试账号；真 WebDAV 后端
//        不建账号，正常恒为空；若仍有脚本播报账号，会打印清单（不会静默吞掉）
//    单脚本也可以直接 `node scripts/<name>.mjs` 跑，便于定位失败。
//
// 顺序：从"基础能力"到"回归/压力"，前面失败也会继续跑完（便于一次拿到全貌），
// 最后以非零退出码反映是否有失败。
//
// 【登记表即门禁】scripts/ 下存在但没登记进 ORDER 的 e2e 脚本 = 写了永远不会跑
//   = 假防线。原先这里只打警告，于是 e2e-hard-delete-empty-group.mjs（1.22.0 硬删除
//   语义的核心回归）长期从不执行。现已升级为**直接失败**（退出码非 0）。

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  computeRegistryDiff, extractTestAccounts, findDeadLoginImports,
} from './e2e-support.mjs';

const ROOT = resolve(process.cwd());
const SCRIPTS_DIR = join(ROOT, 'scripts');

/** 顺序即依赖关系：先验证基础同步，再验证派生行为 */
const ORDER = [
  // 不需要登录、不连云端 —— 放最前面：这三个缺陷全是本地语义，此前正因为
  // 11 个脚本里 9 个都要 Supabase 账号才能跑，本地缺陷反而长期无人实测。
  // （2026-10-06 首次加入，当天就靠它抓出 e2e 场景写错导致的假通过。）
  'e2e-clean-dup-import-fix.mjs',          // 清理重复标签不报错 + 导入往返不丢数据（纯本地）
  // 2026-10-16：云端后端下线，4 个 Supabase 往返脚本同批删除
  // （e2e-sync-test / e2e-batched-sync-roundtrip / e2e-auto-upload-test /
  // e2e-fresh-device-edit-wins）：它们测的是已不存在的云端同步语义。
  'e2e-hard-delete-empty-group.mjs',        // 硬删除空组：删最后一个 tab → 整组物理消失（1.22.0 核心语义）
  'e2e-tab-delete-no-resurrect.mjs',        // 标签级删除跨设备传播（组级 LWW 整组覆盖）
  'e2e-background-sync-test.mjs',           // 后台 alarm 在 popup 关闭时拉取（SW 上下文验收）
  'e2e-local-delete-no-resurrect.mjs',      // 本地删除/点开不被覆盖（含正控）
  'e2e-stress-no-resurrect.mjs',            // 云端持续写入下的本地移除（含正控）
  'e2e-layout-empty-group.mjs',             // 布局切换不产生空壳会话
  'e2e-layout-column-split.mjs',            // 双栏左右按次序对分
  'e2e-tab-reorder.mjs',                    // 会话内标签拖拽转正：真实 mouse 拖拽（P0 受保护模式对照 + P1 跨组搬对行），纯本地',
  // WebDAV 后端三件套（2026-10-14 补登记：写入时漏登 ORDER，门禁抓到后补齐）。
  // 纯本地 —— 对 dufs（Rust 独立实现）跑协议往返，不连 Supabase。
  // 顺序即依赖：先协议事实（local），再跨上下文锁语义（lock），最后主机权限 + CSP（permission）。
  'e2e-webdav-local.mjs',                   // PROPFIND/PUT-If-Match 等协议事实 + 适配器完整往返（dufs + TS loader）
  'e2e-webdav-lock.mjs',                    // 锁定占位后端不回落 + 会话口令 options→SW 跨上下文镜像（真机）
  'e2e-webdav-permission.mjs',              // optional host 权限授予/拦截 + CSP connect-src 放行（真机）
];

/**
 * 需要 TS loader 的脚本：它们 `import('../src/....ts')` 直接跑真实源码
 * （打包产物里 core 模块未导出到 window，页面上下文也拿不到）。
 * run-e2e 默认用裸 `node <script>`，对 .ts 的 import 会 ERR_UNKNOWN_FILE_EXTENSION，
 * 故这几个脚本额外挂 --import + --experimental-strip-types。
 */
const NEEDS_TS_LOADER = new Set([
  'e2e-clean-dup-import-fix.mjs',
  'e2e-webdav-local.mjs',           // 直接 import src 的 WebDAV 适配器（见其头部「运行」说明）
]);

/**
 * 共享模块不是可执行脚本，不登记。
 * 这里用具名集合而不是 `includes('helper')` 之类的模糊匹配：漏掉一个共享模块时，
 * 下面的"存在但未登记"检查会立刻报错，而不是悄悄把共享模块当脚本跑。
 */
const SHARED_MODULES = new Set(['e2e-helpers.mjs', 'e2e-support.mjs']);

const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const skipCleanup = args.includes('--no-cleanup');
const only = (args.find(a => a.startsWith('--only=')) || '').split('=')[1] || '';

const available = readdirSync(SCRIPTS_DIR)
  .filter(f => /^e2e-.*\.mjs$/.test(f) && !SHARED_MODULES.has(f));
const { missing, extra } = computeRegistryDiff(available, ORDER);
// 登记表门禁：登记在 ORDER 里却仍 import 已死 login() 的脚本 = 写了但跑不了。
// （2026-10-16 账号 UI 删除后 login() 只会 20s 超时；见 e2e-support.mjs 的论证）
const deadLogin = findDeadLoginImports(ORDER, f => {
  const p = join(SCRIPTS_DIR, f);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
});

const selected = ORDER.filter(f => existsSync(join(SCRIPTS_DIR, f)) && (!only || f.includes(only)));

if (listOnly) {
  console.log('将按序执行：');
  selected.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  if (missing.length) console.log(`\n❌ ORDER 中但不存在：${missing.join(', ')}`);
  if (extra.length) console.log(`❌ 存在但未登记进 ORDER（永远不会执行，请登记）：${extra.join(', ')}`);
  if (deadLogin.length) {
    console.log(`❌ ORDER 里仍 import 已死 login() 的脚本（账号 UI 已删除，必挂）：${deadLogin.join(', ')}`);
  }
  process.exit(missing.length || extra.length || deadLogin.length ? 1 : 0);
}

// 「写了没登记」= 假防线，直接失败；「登记了但文件不在」= 陈旧条目，同样失败。
if (missing.length) console.error(`❌ ORDER 中但文件不存在（陈旧登记）：${missing.join(', ')}`);
if (extra.length) console.error(`❌ 存在但未登记进 ORDER 的脚本（写了永远不会跑）：${extra.join(', ')}`);
if (deadLogin.length) {
  console.error(`❌ ORDER 里的脚本仍 import 已死的 login()（点的是已删除的「登录 / 注册」UI）：${deadLogin.join(', ')}`);
}
if (missing.length || extra.length || deadLogin.length) {
  console.error('\n→ 在 scripts/run-e2e.mjs 的 ORDER 里登记/删除对应条目后再跑；');
  console.error('   已死 login() 的替代是 scripts/e2e-helpers.mjs 的 seedWebDav()（本机 dufs + WebDAV）。');
  process.exit(1);
}

if (!selected.length) { console.error('没有匹配的脚本'); process.exit(1); }

const results = [];
const accounts = new Set();
for (const file of selected) {
  const name = file.replace(/\.mjs$/, '');
  console.log(`\n${'='.repeat(72)}\n▶ ${file}  (${new Date().toISOString()})\n${'='.repeat(72)}`);
  const started = Date.now();
  // TS 脚本需要 loader（见 NEEDS_TS_LOADER）
  const nodeArgs = NEEDS_TS_LOADER.has(file)
    ? [
        '--import',
        join(ROOT, 'tests/_register-loader.mjs'),
        '--experimental-strip-types',
        join(SCRIPTS_DIR, file),
      ]
    : [join(SCRIPTS_DIR, file)];
  const r = spawnSync(process.execPath, nodeArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    timeout: 15 * 60_000,
    env: process.env,
  });
  const out = `${r.stdout || ''}${r.stderr ? `\n[stderr]\n${r.stderr}` : ''}`;
  const logPath = join(tmpdir(), `${name}.log`);
  try { writeFileSync(logPath, out); } catch { /* 日志写不了不影响判定 */ }
  // 账号从完整输出里抓（不是从截断的尾部），跑挂的脚本造的账号也一并收掉
  for (const email of extractTestAccounts(out)) accounts.add(email);
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(out.trim().split('\n').slice(-25).join('\n'));
  console.log(`◀ ${file}: exit=${r.status} 耗时=${seconds}s  (完整日志 ${logPath})`);
  results.push({ file, exit: r.status, seconds });
}

/**
 * 收尾：报告本次产生的测试账号。
 *
 * ── 2026-10-16 Supabase 下线后的口径 ───────────────────────────────────
 * 旧实现用 service_role 直连删 Supabase 账号与三张 user scoped 表。
 * 云端后端已删除，那个 API 不再存在，留着这段只会让 run-e2e.mjs 在模块顶层
 * import 一个已从 package.json 删掉的依赖 ⇒ `pnpm e2e` 直接崩在启动处，
 * 连 WebDAV 三支（真机可跑、仍然有效）都跑不了。
 *
 * 所以这里不再「清理」，只**如实上报**：真 WebDAV 后端不建账号，
 * 正常情况下 emails 恒为空；若仍有脚本播报了账号，就把清单打出来 ——
 * 绝不静默吞掉（.memory/e2e-assertion-must-distinguish-failure-modes.md）：
 * 残留账号曾持续占库，清理失败必须让人看见。
 */
async function cleanupAccounts(emails) {
  if (!emails.length) { console.log('\n🧹 本次运行没有产生测试账号，无需清理。'); return true; }
  console.warn(`\n⚠️  本次运行有 ${emails.length} 个脚本播报了测试账号，但云端后端已删除，无可清理对象。`);
  console.warn('   （这意味着还有脚本依赖已下线的登录流程，run-e2e 的登记/删除请一并处理）');
  for (const e of emails) console.warn(`   - ${e}`);
  return false;
}

let cleaned = true;
if (skipCleanup) {
  console.log(`\n🧹 已按 --no-cleanup 跳过清理。本次账号：${[...accounts].join(', ') || '(无)'}`);
} else {
  cleaned = await cleanupAccounts([...accounts].sort());
}

const failed = results.filter(r => r.exit !== 0);
console.log(`\n${'='.repeat(72)}\n汇总\n${'='.repeat(72)}`);
for (const r of results) {
  console.log(`${r.exit === 0 ? 'PASS' : 'FAIL'}  ${r.file.padEnd(42)} exit=${r.exit} ${r.seconds}s`);
}
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (!cleaned) console.log('⚠️  测试账号未全部清理（见上方清单）');
// 清理失败不判脚本失败（脚本本身可能全绿），但必须留在输出里
process.exit(failed.length ? 1 : 0);
