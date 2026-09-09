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

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const MIGRATION_FILE = resolve(ROOT, 'supabase/migrations/20260909_add_op_stamp_columns.sql');

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
  if (!existsSync(MIGRATION_FILE)) {
    throw new Error(`migration file not found: ${MIGRATION_FILE}`);
  }
  return readFileSync(MIGRATION_FILE, 'utf8');
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

  const hasDevice = colRes.rows.some(r => r.column_name === 'last_op_device');
  const hasSeq = colRes.rows.some(r => r.column_name === 'last_op_seq');
  const hasTrig = trigRes.rows.some(r => r.trigger_name === 'tab_group_op_stamp_guard');
  if (!hasDevice || !hasSeq || !hasTrig) {
    console.error('\n✗ VERIFY FAILED: missing columns or trigger');
    return false;
  }
  console.log('\n✓ VERIFY OK: last_op_device, last_op_seq, guard trigger all present');
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes('--verify-only');
  const dryRun = args.includes('--dry-run');

  if (dryRun) {
    const sql = loadSqlText();
    console.log(`--- DRY RUN: ${MIGRATION_FILE} ---\n`);
    console.log(sql);
    return;
  }

  const env = { ...readEnvFile(resolve(ROOT, '.env')), ...process.env };
  const url = env.SUPABASE_DB_URL;
  if (!url) {
    console.error('Missing SUPABASE_DB_URL. Set in .env or env var.');
    console.error('Format: postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres');
    process.exit(1);
  }

  const sql = loadSqlText();

  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    if (!verifyOnly) {
      console.log('\n=== Migration ===');
      // 一次 query 跑整段 multi-statement SQL（pg 支持）
      await client.query(sql);
      console.log('✓ Migration applied');
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