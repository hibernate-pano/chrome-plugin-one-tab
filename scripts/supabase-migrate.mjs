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
/**
 * 迁移文件名必须匹配 `<14位时间戳>_<snake_case>.sql`。
 *
 * 【为什么必须校验 —— 2026-10-06 的真实事故】
 * `20261005000000b_purge_expired_tombstones.sql` 的时间戳后多了一个字母 `b`。
 * 后果是**双重静默失败**：
 *   ① `supabase migration list` 对它只打一行 `Skipping migration ...
 *      (file name must match pattern)` 就略过——不报错、不中断、极易被刷屏冲掉；
 *   ② 而**本脚本**（当时）用 readdirSync 读全部 .sql、不看文件名，照跑不误。
 * 两者叠加的结果是：迁移文件躺在仓库里、测试全绿、`db push` 不报错，
 * 而生产库上对应的函数**根本没建**——「迁移已提交」与「迁移已执行」之间
 * 没有任何机制能证明一致（体检报告 P1-1 指的就是这个）。
 *
 * 现在两道闸：这里在**执行前**硬失败（fail fast，绝不带着非法文件去连库），
 * tests/guards/migrationFileNaming.test.ts 在**提交前**拦住。
 *
 * 【为什么允许 8 位日期前缀】仓库里 `20260826_` / `20260909_` / `20260910_`
 * 这三个历史文件用的是短版本号，CLI 接受、已执行、已在台账里，不是错误。
 * 改名会让文件名与台账版本号失配，风险大于收益，所以放行。
 */
const MIGRATION_NAME_PATTERN = /^(\d{8,14})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

/** 目录内全部 .sql 按文件名（= 时间戳前缀）升序——顺序即语义（add → fix） */
function migrationFiles() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const invalid = files.filter(f => !MIGRATION_NAME_PATTERN.test(f));
  if (invalid.length > 0) {
    // 抛错而不是打日志继续：非法命名的文件**不会**被 supabase CLI 执行，
    // 若本脚本却照跑，就制造出「本地跑了、线上没跑」的假象——
    // 这正是本次事故的形态。宁可在这里失败。
    throw new Error(
      `迁移文件名不合法（${invalid.length} 个）：\n` +
      invalid.map(f => `  · ${f}`).join('\n') +
      `\n\n必须形如 <时间戳>_<snake_case>.sql，例如 20261005000001_purge_expired_tombstones.sql。\n` +
      '时间戳后多一个字母（如 20261005000000b）会被 supabase CLI 静默跳过，\n' +
      '该迁移永远不会执行，且不会报任何错。已跳过迁移可用\n' +
      '  supabase migration repair --linked <version> --status applied\n' +
      '补登记（仅在该迁移已被手工执行过、只是台账漏记时）。'
    );
  }

  return files.map(f => resolve(MIGRATIONS_DIR, f));
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
  // 注意：**不要在这里 return**。三个检查相互独立，必须全部跑完再汇总 ——
  // 否则 op-stamp 一失败，profiles/purge 的检查根本没执行，输出会让人以为
  // 「只有 op-stamp 有问题」，而实际上可能是三个都坏了（或者只有另外两个坏了，
  // 修完 op-stamp 才发现还有下一层）。这在 2026-10-05 的本地实测里就出现过：
  // 最小 schema 没有 op-stamp 列 → 早退 → 新加的两项检查被跳过。
  let ok = true;
  if (!hasDevice || !hasSeq || !hasTrig) {
    console.error('\n✗ VERIFY FAILED: missing columns or trigger');
    ok = false;
  }
  if (!usesLt || usesLe || !blocksNullWipe) {
    console.error('\n✗ VERIFY FAILED: guard body 不是修复版');
    console.error(`   strict '<' : ${usesLt}   残留 '<=' : ${usesLe}   NULL 清空防护 : ${blocksNullWipe}`);
    console.error('   期望: 20260910_fix_op_stamp_guard_strict_lt.sql');
    ok = false;
  }
  if (ok) {
    console.log('\n✓ op-stamp 守卫：列 + 触发器 + 函数体（严格 <、NULL 清空防护）全部正确');
  }

  // ── 2026-10-05：补验 profiles RLS 与墓碑清理函数 ──────────────────────
  // 原来 verify 只看 op-stamp 守卫，于是我今天加的两条迁移「跑没跑过」都验不出来：
  // ① profiles 的 USING(true) 还在不在（数据泄漏）；② purge 函数能不能被 anon 调。
  // 「迁移脚本报告成功」必须覆盖它声称覆盖的全部对象。
  const okRls = await verifyProfilesRls(client);
  const okPurge = await verifyPurgeFunction(client);
  if (!okRls || !okPurge) ok = false;

  // ⚠️ 这里必须按 ok 决定输出与返回值：写成无条件 `console.log('VERIFY OK');
  // return true` 就是「对没发生的事报成功」—— 而这正是本轮修掉的那类缺陷
  // （迁移失败却看起来成功、删除登记失败却回 ok:true）。验证脚本自己
  // 谎报成功，会让所有依赖它的判断失效。
  if (!ok) {
    console.error('\n✗ VERIFY FAILED: 见上方各项失败原因');
    return false;
  }
  console.log('\n✓ VERIFY OK: 全部检查通过');
  return true;
}

/**
 * profiles 表的 RLS 收口是否真的生效。
 * 判定：不存在任何对 PUBLIC / anon / authenticated 的全放行 SELECT 策略。
 */
async function verifyProfilesRls(client) {
  // ⚠️⚠️ 两个踩过的坑，都只有真连库才暴露（静态检查与 --dry-run 一律放过）：
  //
  // 1) polroles 是 oid[]，要拿角色名得用 ARRAY(SELECT …)，而 ARRAY(SELECT …)
  //    形式下**没有 FROM 别名可引用**：`WHERE r.oid = ANY(pol.polroles)` 会报
  //    "missing FROM-clause entry for table r"。必须写全限定名 pg_roles.oid。
  //
  // 2) **pol.polqual 不是可读文本，是 pg_node_tree 的二进制表示**：
  //      USING (true) 存成 {CONST :consttype 16 … :constvalue 1 [ 1 0 0 …]}
  //    所以 `polqual === 'true'` 这个判定**永远不成立** —— 我第一版就这么写的，
  //    结果库里明明还有全放行策略，verify 却报「profiles ✓」（漏检，
  //    比报错危险得多：它让人以为已经收口）。
  //    正确做法是用 pg_get_expr 把它渲染回 SQL 文本。
  const { rows } = await client.query(`
    SELECT pol.polname,
           pg_get_expr(pol.polqual, pol.polrelid) AS qual,
           ARRAY(
             SELECT pg_roles.rolname FROM pg_roles
             WHERE pg_roles.oid = ANY(pol.polroles)
           ) AS roles
    FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname='public' AND c.relname='profiles' AND pol.polcmd = 'r'
  `);
  if (rows.length === 0) {
    console.log('  · profiles 表不存在或无 SELECT 策略 —— 跳过（Dashboard schema 可能已变化）');
    return true;
  }
  // pg_get_expr 渲染出的文本：USING (true) → 'true'，USING (( SELECT auth.uid() …)) → 那一长串
  const open = rows.filter(r => /^\s*true\s*$/i.test(String(r.qual)));
  if (open.length > 0) {
    console.error('\n✗ VERIFY FAILED: profiles 仍有全放行 SELECT 策略');
    for (const r of open) {
      // 策略角色是 PUBLIC 时 polroles = {0}，pg_roles 里查不到 ⇒ 数组为空。
      // 空数组恰好等价于「对所有人开放」，所以这里直接标成 PUBLIC。
      // 注意 pg 驱动把 oid[]/text[] 解析成**字符串** '{a,b}' 或数组，
      // 两种形态都要处理（直接 .join 会在字符串形态上报错）。
      const rawRoles = r.roles;
      let who;
      if (Array.isArray(rawRoles)) {
        who = rawRoles.length > 0 ? rawRoles.join(',') : 'PUBLIC(全体)';
      } else if (typeof rawRoles === 'string') {
        const inner = rawRoles.replace(/^\{|\}$/g, '').trim();
        who = inner.length > 0 ? inner.split(',').join(',') : 'PUBLIC(全体)';
      } else {
        who = 'PUBLIC(全体)';
      }
      console.error(`   策略 "${r.polname}" 适用角色=[${who}]  USING (${r.qual})`);
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
    console.log('  · 墓碑清理函数不存在（迁移 20261005000001 尚未执行）—— 跳过');
    return true;
  }
  for (const r of rows) {
    // SECURITY DEFINER + 真 DELETE 的函数若对 anon 可执行 = 匿名可删全站数据
    if (r.anon_can || r.auth_can) {
      console.error(`\n✗ VERIFY FAILED: ${r.proname} 对 anon/authenticated 可执行`);
      console.error(`   anon=${r.anon_can} authenticated=${r.auth_can} service_role=${r.svc_can}`);
      console.error('   期望: 20261005000001 里的 REVOKE EXECUTE … FROM PUBLIC, anon, authenticated');
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

  // Supabase 的连接串走 TLS（证书用 Supabase 自签根，故 rejectUnauthorized:false）。
  // 但**本地/staging 的裸 Postgres 不支持 SSL**，硬编码 ssl 会让连接直接失败
  // （"The server does not support SSL connections"），于是「在本地库上验证迁移」
  // 这件事根本做不到 —— 而那恰恰是执行生产迁移前最该做的。
  // 逃生开关：SUPABASE_DB_SSL=false 时不传 ssl。默认仍是开启，生产行为不变。
  const sslEnabled = (env.SUPABASE_DB_SSL ?? 'true').toLowerCase() !== 'false';
  const client = new pg.Client({
    connectionString: url,
    ...(sslEnabled ? { ssl: { rejectUnauthorized: false } } : {}),
  });
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