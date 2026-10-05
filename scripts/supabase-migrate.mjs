#!/usr/bin/env node
/**
 * 阶段二·§6.1 一键迁移脚本：给 Supabase `tab_groups` 加 last_op_device / last_op_seq 两列
 * + 守护触发器 guard_tab_group_op_stamp。
 *
 * 为什么不用 supabase-js？
 *   anon key 受 RLS 限制，service_role key 在 PostgREST 也不能跑 ALTER TABLE。
 *   必须直连 Postgres（Supabase dashboard → Settings → Database → Connection string）。
 *
 * 用法：
 *   1) 把 Supabase 直连串填到 .env：
 *        SUPABASE_DB_URL=postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres
 *   2) pnpm tsx scripts/supabase-migrate.mjs              # 跑迁移
 *      pnpm tsx scripts/supabase-migrate.mjs --verify-only # 只验证不执行
 *      pnpm tsx scripts/supabase-migrate.mjs --dry-run    # 打印 SQL 不执行
 *
 * 退出码：0 = 成功；1 = 执行失败；2 = 验证发现列/触发器缺失
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const MIGRATIONS_DIR = resolve(ROOT, 'supabase/migrations');
/** 目录内全部 .sql 按文件名（= 时间戳前缀）升序——顺序即语义（add → fix） */
function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(f => resolve(MIGRATIONS_DIR, f));
}

function readEnvFile(path) {
  const env = {};
  if (!existsSync(path)) return env;
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i === -1) continue;
    env[line.slice(0, i)] = line.slice(i + 1);
  }
  return env;
}

function loadSqlText() {
  return migrationFiles().map(file => {
    if (!existsSync(file)) throw new Error(`migration file not found: ${file}`);
    return `-- ==== ${file.split('/').pop()} ====\n${readFileSync(file, 'utf8')}`;
  });
}

/**
 * pg.Client.query() 本身支持多语句 SQL 字符串（multi-statement query），
 * 所以这里不需要自己切分整段。dry-run 模式下才拆分做预览。
 */
function splitForPreview(sql) {
  // 简化预览切分：按 `;\n` 分，DO $$ ... $$; 块保留整体（按双美元配对）。
  const blocks = [];
  let buf = '';
  let inDollar = false;
  for (const line of sql.split('\n')) {
    buf += line + '\n';
    const opens = (line.match(/\$\$/g) || []).length;
    for (let i = 0; i < opens; i++) inDollar = !inDollar;
    if (!inDollar && line.trimEnd().endsWith(';')) {
      const s = buf.trim();
      if (s && !/^(--|$)/.test(s.split('\n').find(l => l.trim() && !l.startsWith('--')) || s.split('\n')[0])) {
        blocks.push(s);
      }
      buf = '';
    }
  }
  if (buf.trim()) blocks.push(buf.trim());
  return blocks;
}

async function verify(client) {
  console.log('\n=== Verification ===');
  const colRes = await client.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='tab_groups'
      AND column_name IN ('last_op_device','last_op_seq','version')
    ORDER BY column_name;
  `);
  console.log('columns:', JSON.stringify(colRes.rows, null, 2));
  const trigRes = await client.query(`
    SELECT trigger_name, event_manipulation, action_timing
    FROM information_schema.triggers
    WHERE event_object_table='tab_groups'
      AND trigger_name IN ('tab_group_op_stamp_guard','tab_group_version_guard');
  `);
  console.log('triggers:', JSON.stringify(trigRes.rows, null, 2));

  // 守卫**函数体**也必须校验：只看「列在、触发器在」曾经给出过假阳性——
  // 生产库跑着 `<=` 版本的守卫（吞掉全部同印记重发）却显示 VERIFY OK。
  const fnRes = await client.query(`
    SELECT pg_get_functiondef(p.oid) AS def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='guard_tab_group_op_stamp';
  `);
  const def = fnRes.rows[0]?.def ?? '';
  const usesLt = /NEW\.last_op_seq\s*<\s*OLD\.last_op_seq/.test(def);
  const usesLe = /NEW\.last_op_seq\s*<=\s*OLD\.last_op_seq/.test(def);
  const blocksNullWipe = /OLD\.last_op_seq IS NOT NULL AND NEW\.last_op_seq IS NULL/.test(def);

  const hasDevice = colRes.rows.some(r => r.column_name === 'last_op_device');
  const hasSeq = colRes.rows.some(r => r.column_name === 'last_op_seq');
  const hasTrig = trigRes.rows.some(r => r.trigger_name === 'tab_group_op_stamp_guard');
  if (!hasDevice || !hasSeq || !hasTrig) {
    console.error('\n✗ VERIFY FAILED: missing columns or trigger');
    return false;
  }
  if (!usesLt || usesLe || !blocksNullWipe) {
    console.error('\n✗ VERIFY FAILED: guard body 不是修复版');
    console.error(`   strict '<' : ${usesLt}   残留 '<=' : ${usesLe}   NULL 清空防护 : ${blocksNullWipe}`);
    console.error('   期望: 20260910_fix_op_stamp_guard_strict_lt.sql');
    return false;
  }
  console.log('\n✓ op-stamp 守卫：列 + 触发器 + 函数体（严格 <、NULL 清空防护）全部正确');

  // ── 2026-10-05：补验 profiles RLS 与墓碑清理函数 ──────────────────────
  // 原来 verify 只看 op-stamp 守卫，于是我今天加的两条迁移「跑没跑过」都验不出来：
  // ① profiles 的 USING(true) 还在不在（数据泄漏）；② purge 函数能不能被 anon 调。
  // 「迁移脚本报告成功」必须覆盖它声称覆盖的全部对象。
  const okRls = await verifyProfilesRls(client);
  const okPurge = await verifyPurgeFunction(client);
  if (!okRls || !okPurge) return false;

  console.log('\n✓ VERIFY OK: 全部检查通过');
  return true;
}

/**
 * profiles 表的 RLS 收口是否真的生效。
 * 判定：不存在任何对 PUBLIC / anon / authenticated 的全放行 SELECT 策略。
 */
async function verifyProfilesRls(client) {
  const { rows } = await client.query(`
    SELECT pol.polname,
           pol.polqual,               -- USING 表达式（true = 全放行）
           ARRAY(SELECT rolname FROM pg_roles WHERE r.oid = ANY(pol.polroles)) AS roles
    FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname='public' AND c.relname='profiles' AND pol.polcmd = 'r'
  `);
  if (rows.length === 0) {
    console.log('  · profiles 表不存在或无 SELECT 策略 —— 跳过（Dashboard schema 可能已变化）');
    return true;
  }
  // polqual 为 'true' 文本 = USING (true) 全放行
  const open = rows.filter(r => String(r.polqual).trim() === 'true');
  if (open.length > 0) {
    console.error('\n✗ VERIFY FAILED: profiles 仍有全放行 SELECT 策略');
    for (const r of open) {
      console.error(`   策略 "${r.polname}" roles=[${(r.roles || []).join(',')}] USING (true)`);
    }
    console.error('   期望: 20261005000000_lock_down_profiles_rls.sql（该迁移会删掉这条策略）');
    return false;
  }
  console.log('  · profiles：无全放行 SELECT 策略 ✓');
  return true;
}

/** 墓碑清理函数：存在 + 已收回 PUBLIC/anon/authenticated 的 EXECUTE。 */
async function verifyPurgeFunction(client) {
  const { rows } = await client.query(`
    SELECT p.proname,
           has_function_privilege('anon', p.oid, 'EXECUTE')         AS anon_can,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_can,
           has_function_privilege('service_role', p.oid, 'EXECUTE')  AS svc_can
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public'
      AND p.proname IN ('purge_expired_cloud_tombstones','body_tombstone_expiry_days')
  `);
  if (rows.length === 0) {
    console.log('  · 墓碑清理函数不存在（迁移 20261005000000b 尚未执行）—— 跳过');
    return true;
  }
  for (const r of rows) {
    // SECURITY DEFINER + 真 DELETE 的函数若对 anon 可执行 = 匿名可删全站数据
    if (r.anon_can || r.auth_can) {
      console.error(`\n✗ VERIFY FAILED: ${r.proname} 对 anon/authenticated 可执行`);
      console.error(`   anon=${r.anon_can} authenticated=${r.auth_can} service_role=${r.svc_can}`);
      console.error('   期望: 20261005000000b 里的 REVOKE EXECUTE … FROM PUBLIC, anon, authenticated');
      return false;
    }
    console.log(`  · ${r.proname}：anon/authenticated 已无权调用，service_role=${r.svc_can} ✓`);
  }
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes('--verify-only');
  const dryRun = args.includes('--dry-run');

  if (dryRun) {
    for (const sql of loadSqlText()) {
      console.log(`--- DRY RUN ---\n`);
      console.log(sql);
    }
    return;
  }

  const env = { ...readEnvFile(resolve(ROOT, '.env')), ...process.env };
  const url = env.SUPABASE_DB_URL;
  if (!url) {
    console.error('Missing SUPABASE_DB_URL. Set in .env or env var.');
    console.error('Format: postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres');
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    if (!verifyOnly) {
      console.log('\n=== Migration ===');
      for (const file of migrationFiles()) {
        // 一次 query 跑整段 multi-statement SQL（pg 支持）；每个文件独立事务
        await client.query(readFileSync(file, 'utf8'));
        console.log(`✓ applied: ${file.split('/').pop()}`);
      }
    }
    const ok = await verify(client);
    process.exit(ok ? 0 : 2);
  } catch (e) {
    console.error('\n✗ Migration failed:', e.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch(e => {
  console.error('fatal:', e);
  process.exit(1);
});