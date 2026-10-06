// E2E 统一运行器 —— 顺序执行并汇总。
//
//   pnpm e2e                 跑全部（顺序执行，逐个打印尾部日志）
//   pnpm e2e -- --list       只列出会跑哪些
//   pnpm e2e -- --only=fresh 只跑名字含 fresh 的
//   pnpm e2e -- --no-cleanup 跳过收尾清理（只想留账号复现时用）
//
// ⚠️ 这些是**真实环境**测试：真实 Supabase 后端 + 真实 Chromium（headed，加载 dist/ 扩展），
//    每个脚本各注册一个 e2e-*@test.tapstack.dev 测试账号。因此：
//      - 不要在 CI 里无脑跑（需要 GUI 与网络，且会写线上库）
//      - 跑之前先 `pnpm build`（脚本加载 dist/）
//      - 含 e2e-deadhandle-supabase-timeout.mjs 时必须用**缩短上界**的构建：
//        VITE_SYNC_REQUEST_TIMEOUT_MS=3000 pnpm build
//        （它要验证「挂住的请求会被中止」，45s 的生产上界会让脚本整体超时；
//          该脚本自己会 fail fast 说明这一点，不会静默假绿）
//      - 跑完由本文件的收尾钩子统一删除本次产生的测试账号；没有 service_role 时
//        打印待清理清单（不会静默吞掉）
//    单脚本也可以直接 `node scripts/<name>.mjs` 跑，便于定位失败。
//
// 顺序：从"基础能力"到"回归/压力"，前面失败也会继续跑完（便于一次拿到全貌），
// 最后以非零退出码反映是否有失败。
//
// 【登记表即门禁】scripts/ 下存在但没登记进 ORDER 的 e2e 脚本 = 写了永远不会跑
//   = 假防线。原先这里只打警告，于是 e2e-hard-delete-empty-group.mjs（1.22.0 硬删除
//   语义的核心回归）长期从不执行。现已升级为**直接失败**（退出码非 0）。

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createClient } from '@supabase/supabase-js';
import {
  computeRegistryDiff, extractTestAccounts, loadEnv, SERVICE_ROLE_ENV,
} from './e2e-support.mjs';

const ROOT = resolve(process.cwd());
const SCRIPTS_DIR = join(ROOT, 'scripts');

/** 顺序即依赖关系：先验证基础同步，再验证派生行为 */
const ORDER = [
  // 不需要登录、不连云端 —— 放最前面：这三个缺陷全是本地语义，此前正因为
  // 11 个脚本里 9 个都要 Supabase 账号才能跑，本地缺陷反而长期无人实测。
  // （2026-10-06 首次加入，当天就靠它抓出 e2e 场景写错导致的假通过。）
  'e2e-clean-dup-import-fix.mjs',          // 清理重复标签不报错 + 导入往返不丢数据（纯本地）
  'e2e-deadhandle-supabase-timeout.mjs',   // IDB 死句柄自愈 + 请求级超时真会触发（需登录 + 缩短上界构建）
  'e2e-sync-test.mjs',                      // 基础：A 保存上传 → B 登录下载
  'e2e-auto-upload-test.mjs',               // 保存后自动上传（云端直查）
  'e2e-hard-delete-empty-group.mjs',        // 硬删除空组：删最后一个 tab → 整组物理消失（1.22.0 核心语义）
  'e2e-tab-delete-no-resurrect.mjs',        // 标签级删除跨设备传播（组级 LWW 整组覆盖）
  'e2e-fresh-device-edit-wins.mjs',         // 新设备编辑必须胜出（P0-2 回归）
  'e2e-background-sync-test.mjs',           // 60s alarm 在 popup 关闭时拉取（SW 上下文验收）
  'e2e-local-delete-no-resurrect.mjs',      // 本地删除/点开不被覆盖（含正控）
  'e2e-stress-no-resurrect.mjs',            // 云端持续写入下的本地移除（含正控）
  'e2e-layout-empty-group.mjs',             // 布局切换不产生空壳会话
  'e2e-layout-column-split.mjs',            // 双栏左右按次序对分
  'e2e-web-dashboard-sync.mjs',             // Web 仪表盘跨端写入（需 SHIM_CHROME_STORAGE=1 才全绿，见脚本头）
];

/**
 * 需要 TS loader 的脚本：它们 `import('../src/....ts')` 直接跑真实源码
 * （打包产物里 core 模块未导出到 window，页面上下文也拿不到）。
 * run-e2e 默认用裸 `node <script>`，对 .ts 的 import 会 ERR_UNKNOWN_FILE_EXTENSION，
 * 故这几个脚本额外挂 --import + --experimental-strip-types。
 */
const NEEDS_TS_LOADER = new Set(['e2e-clean-dup-import-fix.mjs']);

/**
 * 需要「缩短的请求超时上界」的脚本。
 *
 * 它要验证的是「挂住的请求真的会被中止」——这个判据无法用 45s 的生产上界验证
 * （等 45s 没有意义）。构建时注入 VITE_SYNC_REQUEST_TIMEOUT_MS=3000。
 * 生产构建不带该变量 ⇒ 上界恒为 45s（client.ts 三元兜底，已由单测钉住）。
 */
const NEEDS_SHORT_TIMEOUT = new Set(['e2e-deadhandle-supabase-timeout.mjs']);

/**
 * 收尾要清的表（service_role 直连，绕开 RLS）。
 * 只列应用真会写的表：legacy 的 `tabs` 表自 1.2x 起只读不写（src/utils/supabase/upload.ts
 * 里只做 select 回退），e2e 不会在它上面留数据。
 */
const USER_SCOPED_TABLES = ['tab_groups', 'sync_updates', 'sync_snapshots'];

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

const selected = ORDER.filter(f => existsSync(join(SCRIPTS_DIR, f)) && (!only || f.includes(only)));

if (listOnly) {
  console.log('将按序执行：');
  selected.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  if (missing.length) console.log(`\n❌ ORDER 中但不存在：${missing.join(', ')}`);
  if (extra.length) console.log(`❌ 存在但未登记进 ORDER（永远不会执行，请登记）：${extra.join(', ')}`);
  process.exit(missing.length || extra.length ? 1 : 0);
}

// 「写了没登记」= 假防线，直接失败；「登记了但文件不在」= 陈旧条目，同样失败。
if (missing.length) console.error(`❌ ORDER 中但文件不存在（陈旧登记）：${missing.join(', ')}`);
if (extra.length) console.error(`❌ 存在但未登记进 ORDER 的脚本（写了永远不会跑）：${extra.join(', ')}`);
if (missing.length || extra.length) {
  console.error('\n→ 在 scripts/run-e2e.mjs 的 ORDER 里登记/删除对应条目后再跑。');
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
 * 收尾清理本次产生的测试账号。
 * 有 service_role 就真删（连同该用户在云端留下的会话数据），没有就打印待清理清单——
 * 绝不静默吞掉：残留账号会持续占库，清理失败必须让人看见。
 */
async function cleanupAccounts(emails) {
  if (!emails.length) { console.log('\n🧹 本次运行没有产生测试账号，无需清理。'); return true; }
  console.log(`\n🧹 清理本次产生的 ${emails.length} 个测试账号…`);
  const env = loadEnv({ cwd: ROOT });
  const url = env.VITE_SUPABASE_URL;
  const serviceKey = env[SERVICE_ROLE_ENV];
  if (!url || !serviceKey) {
    console.warn(`⚠️  未配置 ${SERVICE_ROLE_ENV}，无法自动清理。请手动在 Supabase 控制台删除：`);
    for (const e of emails) console.warn(`   - ${e}`);
    return false;
  }
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const problems = [];
  for (const email of emails) {
    let userId = null;
    try {
      // 账号是刚注册的，listUsers 按创建时间倒序，取前几页足够命中；翻满为止更稳。
      for (let page = 1; page <= 5 && !userId; page++) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) throw error;
        const hit = (data?.users || []).find(u => (u.email || '').toLowerCase() === email);
        if (hit) userId = hit.id;
        if ((data?.users || []).length < 1000) break;
      }
      if (!userId) { console.log(`   • ${email}: 云端不存在（脚本没跑到注册那步），跳过`); continue; }
      for (const table of USER_SCOPED_TABLES) {
        const { error } = await admin.from(table).delete().eq('user_id', userId);
        // 表不存在/无 user_id 列属于"本来就没数据"，只记不判失败；其余一律记账
        if (error && !/does not exist|not exist|schema cache/i.test(error.message)) {
          problems.push(`${email} / ${table}: ${error.message}`);
        }
      }
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) { problems.push(`${email}: 删除用户失败 ${error.message}`); continue; }
      console.log(`   ✅ 已删除 ${email}`);
    } catch (e) {
      problems.push(`${email}: ${e.message}`);
    }
  }
  if (problems.length) {
    console.error('⚠️  以下账号/数据未能自动清理，请手动处理：');
    for (const p of problems) console.error(`   - ${p}`);
    return false;
  }
  return true;
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
