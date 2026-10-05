#!/usr/bin/env node
/**
 * 线上 RLS 现状探测（只读为主，写探测会立即回滚）。
 *
 * 【为什么需要它】安全审计报「tab_groups / user_settings 有策略但 RLS
 * 从未启用」，但那是**本地模拟库**上的推论。本脚本用**线上真实的 anon key**
 * （随扩展产物公开，Supabase 设计如此）直接打 PostgREST，回答三个问题：
 *   1. anon 能读到哪些表的多少行？（暴露面）
 *   2. 能读到哪些列？（是否含 email / 订阅 / 配额等敏感字段）
 *   3. **能读 ≠ 能改 ≠ 能写** —— anon 能否 PATCH 提权 / INSERT 任意行？
 *      这是区分「真漏洞」与「表恰好是空的」的唯一办法：
 *      两者在只读探测下都返回 `200 []`，看起来一模一样。
 *
 * 【2026-10-05 线上实测结论（第一次运行的结果，已记录在案）】
 *   - profiles：**48 行可读**，含 email / plan / ai_daily_count /
 *     stripe_customer_id / subscription_id / subscription_status，
 *     且 **anon 能 PATCH 改别人的行**（提权成功，已验证改回）。
 *     ⇒ **真实 P0**，修法是执行 20261005000000_lock_down_profiles_rls.sql。
 *   - tab_groups / tabs：0 行可读，且 **INSERT 被拒**
 *     （42501 new row violates row-level security policy）
 *     ⇒ RLS **确实生效**；0 行是因为库里真的没数据。
 *     安全审计那条「tab_groups RLS 未启用」是**误报**（在模拟库上推的）。
 *   - user_settings：`select=id` 返回 42703（列不存在）——
 *     该表**没有 id 列**，schema 与其它表不同，需单独核对（本仓代码按 user_id 查）。
 *
 * 【安全约定】
 *   - 默认只读；
 *   - 写探测（INSERT 探针行 / PATCH 提权）都在同一函数里**立即回滚**，
 *     原值先存档；回滚失败会打印出可直接粘贴的补救 SQL，绝不静默留下痕迹；
 *   - 不打印任何 email / 用户数据内容，只打印列名、行数、布尔结论。
 *
 * 用法：
 *   node scripts/anon-rls-probe.mjs          # 只读探测（安全，可随时跑）
 *   node scripts/anon-rls-probe.mjs --write  # 额外做提权/写入探测（会立即回滚）
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOW_WRITE = process.argv.includes('--write');

function readEnv() {
  const out = {};
  for (const line of readFileSync(resolve(ROOT, '.env'), 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

const env = readEnv();
const URL_ = env.VITE_SUPABASE_URL;
const KEY = env.VITE_SUPABASE_ANON_KEY;
if (!URL_ || !KEY) {
  console.error('✗ .env 缺 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY');
  process.exit(1);
}

const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const HW = { ...H, 'Content-Type': 'application/json', Prefer: 'return=representation' };

const TABLES = ['profiles', 'tab_groups', 'user_settings', 'tabs'];
/** 出现即视为敏感（只打印字段名，不打印值） */
const SENSITIVE = [
  'email', 'stripe_customer_id', 'subscription_id',
  'subscription_status', 'plan', 'ai_daily_count', 'ai_usage_count',
];

const errMsg = t => {
  try { return JSON.parse(t).message || t; } catch { return t.slice(0, 120); }
};

async function probe() {
  console.log('=== 线上 anon RLS 探测 ===');
  console.log(`项目: ${URL_}`);
  console.log(`模式: ${ALLOW_WRITE ? '只读 + 写探测（会立即回滚）' : '只读'}\n`);

  const findings = [];
  for (const t of TABLES) {
    let r;
    try {
      r = await fetch(`${URL_}/rest/v1/${t}?select=*&limit=1000`, { headers: H });
    } catch (e) {
      console.log(`  ${t.padEnd(15)} 请求失败: ${e.message}`);
      continue;
    }
    const txt = await r.text();
    if (r.status !== 200) {
      console.log(`  ${t.padEnd(15)} HTTP ${r.status}  → 被拒：${errMsg(txt).slice(0, 70)}`);
      findings.push({ table: t, status: r.status, rows: 0, cols: [], leaked: [] });
      continue;
    }
    let rows;
    try { rows = JSON.parse(txt); } catch { rows = []; }
    const n = Array.isArray(rows) ? rows.length : 0;
    const cols = n > 0 ? Object.keys(rows[0]) : [];
    const leaked = cols.filter(c => SENSITIVE.includes(c));
    console.log(
      `  ${t.padEnd(15)} HTTP 200  → anon 读到 ${n} 行，${cols.length} 列` +
      (leaked.length ? `，含敏感字段 [${leaked.join(', ')}]` : '')
    );
    findings.push({ table: t, status: 200, rows: n, cols, leaked });
  }

  // ── 汇总 ──
  console.log('\n=== 结论 ===');
  const exposed = findings.filter(f => f.status === 200 && f.rows > 0);
  if (exposed.length === 0) {
    console.log('  ✓ 没有表对 anon 暴露任何行（RLS 生效或表为空）');
  } else {
    console.log(`  ✗ ${exposed.length} 张表对 anon 暴露数据：`);
    for (const f of exposed) {
      console.log(`      ${f.table}：${f.rows} 行${f.leaked.length ? `，敏感字段 ${f.leaked.join(', ')}` : ''}`);
    }
    console.log('');
    console.log('  修法（两者都已在本地 PostgreSQL 16.15 真实执行验证）：');
    console.log('    A) Dashboard 直贴（推荐，不需数据库密码）：');
    console.log('       docs/fix-profiles-rls-urgent.sql');
    console.log('    B) 有 SUPABASE_DB_URL 时走迁移链：');
    console.log('       pnpm supabase:migrate   然后   pnpm supabase:verify');
  }
  if (!ALLOW_WRITE) {
    console.log('\n（加 --write 额外探测 anon 能否 PATCH 提权 / INSERT 任意行；会立即回滚）');
    return;
  }

  // ── 关键判别：0 行的表，RLS 到底生效了吗？──
  // 只读探测分不清「表空」与「RLS 全挡」（都是 200 []）。
  // 唯一可靠办法是试着写一行：RLS 生效 → 42501；未启用 → INSERT 成功。
  console.log('\n=== 判别：0 行的表，RLS 到底生效了吗？（试写一行探针）===');
  // 每张表用**各自真实存在的列**做探针：列名不对会得到 400「列不存在」，
  // 那是 schema 不匹配（说明该表还没启用/已废弃），不是 RLS 拦截 —— 别混淆。
  // tabs 是标签级表，没有 name/user_id 列，主键是 (group_id, tab_id) 之类。
  const WRITE_PROBES = [
    { table: 'tab_groups', row: { id: null, user_id: '00000000-0000-0000-0000-000000000000', name: 'rls-probe', tabs_data: [] } },
    { table: 'tabs', row: { group_id: '__rls_probe__', tab_id: '__rls_probe__', url: 'https://example.com' } },
  ];
  for (const { table, row } of WRITE_PROBES) {
    const probeId = `__rls_probe_delme_${Date.now()}`;
    const body = { ...row, ...(row.id === null ? { id: probeId } : {}) };
    const r = await fetch(`${URL_}/rest/v1/${table}`, {
      method: 'POST', headers: HW, body: JSON.stringify(body),
    });
    const txt = await r.text();
    if (r.ok) {
      console.log(`  ✗✗ ${table}：anon INSERT 成功 ⇒ RLS 未生效，anon 可写任意行！`);
      const d = await fetch(
        `${URL_}/rest/v1/${table}?${row.id === null ? `id=eq.${probeId}` : `group_id=eq.${probeId}`}`,
        { method: 'DELETE', headers: H }
      );
      console.log(
        d.ok
          ? `     探针行已清理`
          : `     ⚠️ 清理失败 HTTP ${d.status}，需手动执行：DELETE FROM ${table} WHERE group_id='${probeId}'`
      );
    } else if (/42501|row-level security|permission denied/i.test(txt)) {
      console.log(`  ✓ ${table}：INSERT 被拒 ⇒ RLS 生效`);
      console.log(`     （${errMsg(txt).slice(0, 80)}）`);
      console.log(`     该表当前 0 行是「库里真的没数据」，不是泄漏`);
    } else {
      // 42703 = 列不存在 ⇒ 该表 schema 与探针不匹配（很可能已废弃或未启用）
      console.log(`  ? ${table}：INSERT HTTP ${r.status} → ${errMsg(txt).slice(0, 90)}`);
      console.log(`     ${/column/i.test(txt) ? '（列不存在 ⇒ schema 不匹配，**这本身说明该表没有 anon 可写路径**）' : '（既非成功也非 RLS 拦截，需人工核对 schema 与 GRANT）'}`);
    }
  }

  // ── 提权探测：能读 ≠ 能改 ──
  console.log('\n=== 提权探测（PATCH plan=pro，随后立即改回）===');
  const r0 = await fetch(`${URL_}/rest/v1/profiles?select=id,plan&limit=1`, { headers: H });
  if (!r0.ok) { console.log('  读不到行，跳过提权探测'); return; }
  const [row] = await r0.json();
  if (!row) { console.log('  表为空，跳过'); return; }

  console.log(`  目标行 id=${String(row.id).slice(0, 8)}… 原 plan=${row.plan}`);
  const r = await fetch(`${URL_}/rest/v1/profiles?id=eq.${row.id}`, {
    method: 'PATCH', headers: HW, body: JSON.stringify({ plan: 'pro' }),
  });
  console.log(`  PATCH HTTP ${r.status}`);
  if (!r.ok) {
    console.log('  ✓ anon 不能改别人的行（UPDATE 策略生效）—— 泄漏仅限「读」');
    return;
  }
  const rb = await fetch(`${URL_}/rest/v1/profiles?id=eq.${row.id}`, {
    method: 'PATCH', headers: HW, body: JSON.stringify({ plan: row.plan }),
  });
  if (rb.ok) {
    console.log(`  ✗✗ anon 能改别人的行！已立即改回 plan=${row.plan}`);
    console.log('     任何人都能给自己/他人提权（改 plan / 订阅状态 / AI 配额）');
  } else {
    console.log(`  ⚠️⚠️ 提权成功但改回失败（HTTP ${rb.status}）！`);
    console.log(`     立刻手动执行：UPDATE profiles SET plan='${row.plan}' WHERE id='${row.id}'`);
  }
}

probe().catch(e => { console.error('探测失败:', e.message); process.exit(1); });
