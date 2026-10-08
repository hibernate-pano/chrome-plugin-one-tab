// 迁移全量重放两遍的门禁（2026-10-07 新增）。
//
// 【本文件要防的那类 bug】
// supabase/migrations 里混着一批「早期直接在 Dashboard 建立、后来从远端迁移历史
// 原样还原」的文件，里面是裸 `create policy` / `alter publication … add table`。
// 在「对象已存在」的库上重放必然抛 42710 duplicate_object，而
// scripts/supabase-migrate.mjs 用一个 try 包住整个 for 循环、出错即 process.exit(1)：
//   · 排在后面的文件**从未被尝试**（含 20261005000000 的 profiles PII 收口、
//     20261005000001 对 anon 的 REVOKE）；
//   · verify() 根本不跑。
// 于是形成最难发现的一种失效：**仓库里有安全迁移，线上从没生效，也没有任何报错**。
//
// 【为什么必须是真库、并且 fixture 必须长得像 Dashboard】
// 空库**复现不出来** —— 存在性守卫在空库上找不到任何东西，于是全都乖乖放行。
// 必须先把表、Dashboard 的默认宽松策略、以及 supabase_realtime 的成员关系造出来，
// 才等价于「生产库上再跑一次」。这一点是靠在真 PG 16 上实测确认的，不是推断。
//
// 无 initdb/pg_ctl/psql 时整组 skip（下面的 SQL 文本护栏仍会执行），不阻塞无 PG 环境。
// 这是 SKIP_REASON 唯一允许出现的情形：**装了二进制但库起不来**必须判红 ——
// 起停器只抛错（带 pg.log 尾部），由 gate() 翻译成每个用例的 fail，
// 而不是让 before hook 抛出把整组变成 cancelled（报告里 fail 0 看起来一切正常）。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PG_BINARIES_PRESENT,
  PG_MISSING_BINARIES_REASON,
  startPostgres,
  type RunningPg,
} from '../_helpers/pgHarness.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGDIR = join(ROOT, 'supabase', 'migrations');

const SKIP_REASON = `${PG_MISSING_BINARIES_REASON}，跳过真实重放测试`;

/** 首选端口；被占用时起停器向后探测（连续 20 个都占满则显式失败）。 */
const PREFERRED_PORT = 5601;

const migrationFiles = readdirSync(MIGDIR)
  .filter(f => f.endsWith('.sql'))
  .sort();

/**
 * Dashboard 形状的基线：表 + Dashboard 默认宽松策略 + realtime 成员关系都已存在。
 * 这是复现重放失败的必要条件；空库不会失败。
 */
const DASHBOARD_FIXTURE = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.tab_groups (
  id text PRIMARY KEY, user_id uuid, name text, tabs_data jsonb,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS public.user_settings (
  user_id uuid PRIMARY KEY, use_double_column_layout boolean DEFAULT false);
CREATE TABLE IF NOT EXISTS public.tabs (id text PRIMARY KEY, group_id text, user_id uuid);

DROP POLICY IF EXISTS "Allow all operations for authenticated users" ON public.tab_groups;
CREATE POLICY "Allow all operations for authenticated users" ON public.tab_groups FOR ALL USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Allow all operations for authenticated users" ON public.user_settings;
CREATE POLICY "Allow all operations for authenticated users" ON public.user_settings FOR ALL USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Allow all operations for authenticated users" ON public.tabs;
CREATE POLICY "Allow all operations for authenticated users" ON public.tabs FOR ALL USING (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY, email text NOT NULL, plan text DEFAULT 'free',
  ai_usage_count int DEFAULT 0, ai_daily_count int DEFAULT 0, ai_reset_at date DEFAULT CURRENT_DATE);
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
CREATE POLICY "Users can view own profile" ON public.profiles FOR SELECT USING (auth.uid() = id);
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE USING (auth.uid() = id);
DROP POLICY IF EXISTS "Anyone can view public profile fields" ON public.profiles;
CREATE POLICY "Anyone can view public profile fields" ON public.profiles FOR SELECT USING (true);

CREATE TABLE IF NOT EXISTS public.ai_usage_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, prompt text NOT NULL,
  created_at timestamptz DEFAULT now());
DROP POLICY IF EXISTS "Users can view own AI usage" ON public.ai_usage_logs;
CREATE POLICY "Users can view own AI usage" ON public.ai_usage_logs FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can insert own AI usage" ON public.ai_usage_logs;
CREATE POLICY "Users can insert own AI usage" ON public.ai_usage_logs FOR INSERT WITH CHECK (auth.uid() = user_id);

ALTER PUBLICATION supabase_realtime ADD TABLE public.tab_groups;
ALTER PUBLICATION supabase_realtime ADD TABLE public.user_settings;
`;

/**
 * golden 库的种子（比照 DASHBOARD_FIXTURE 里「迁移不建的部分」，但只留最小集）：
 * 同一集群上的第二个**全新空库**只有这些前置对象 —— 迁力默认存在、但本仓任何
 * 迁移都不建的：三张基表（tab_groups / user_settings / tabs）与 auth 基础设施、
 * publication 壳。public 下**不存在任何 policy、publication 也没有任何成员** ——
 * 所有 CREATE POLICY / ADD TABLE 的存在性守卫都会真放行、真执行。
 * profiles / ai_usage_logs / sync_* 连表都不预建：建表与建策略都交给迁移自己。
 * 刻意不预建 policy 与成员关系，这正是「永远跳过的守卫」唯一暴露的地方。
 */
const GOLDEN_SEED = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;

-- 迁移假定已存在的基表（Dashboard 建、本仓迁移不建）。只建表，不带任何 policy。
CREATE TABLE IF NOT EXISTS public.tab_groups (
  id text PRIMARY KEY, user_id uuid, name text, tabs_data jsonb,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS public.user_settings (
  user_id uuid PRIMARY KEY, use_double_column_layout boolean DEFAULT false);
CREATE TABLE IF NOT EXISTS public.tabs (id text PRIMARY KEY, group_id text, user_id uuid);
`;

/**
 * 描述终态的快照。第二遍重放之后它必须与第一遍逐字相同 —— 这就是「幂等」的定义。
 * 覆盖策略（含 USING/WITH CHECK 原文）、publication 成员、RLS 开关、
 * 触发器、函数（含 SECURITY DEFINER 与 ACL，因为 REVOKE 是安全迁移的重点）。
 */
const SNAPSHOT_SQL = `
SELECT 'POLICY|'||tablename||'|'||policyname||'|'||cmd||'|'||permissive||'|'
     ||coalesce(qual,'-')||'|'||coalesce(with_check,'-')
FROM pg_policies WHERE schemaname='public' ORDER BY 1;
SELECT 'PUB|'||pubname||'|'||schemaname||'|'||tablename FROM pg_publication_tables ORDER BY 1;
SELECT 'RLS|'||c.relname||'|'||c.relrowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='r' ORDER BY 1;
SELECT 'TRIGGER|'||c.relname||'|'||t.tgname||'|'||md5(pg_get_triggerdef(t.oid))
FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY 1;
SELECT 'FUNC|'||p.proname||'|'||pg_get_function_identity_arguments(p.oid)||'|'||p.prosecdef||'|'
     ||coalesce(array_to_string(p.proacl,','),'-')||'|'||md5(pg_get_functiondef(p.oid))
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY 1;
SELECT 'COL|'||table_name||'|'||column_name||'|'||data_type||'|'||is_nullable||'|'||coalesce(column_default,'-')
FROM information_schema.columns WHERE table_schema='public' ORDER BY 1;
`;

let pg: RunningPg | null = null;
let setupError: Error | null = null;

/** 真库没起来时把每个用例判成 fail —— 不是 cancelled，也不是 skip。 */
function ready(): RunningPg {
  const err = setupError;
  if (err) assert.fail(`Postgres 门禁启动/初始化失败，本用例不能算通过：\n${err.message}`);
  const inst = pg;
  assert.ok(inst, 'Postgres 门禁既没成功启动、也没留下失败原因（setup 逻辑有洞）');
  return inst;
}

/** 门禁版 it：先确认真库可用，再跑用例；起不来 ⇒ 每个用例都红。 */
function gate(name: string, fn: () => void): void {
  it(name, () => {
    ready();
    fn();
  });
}

function psql(sql: string): string {
  return ready().psql(sql);
}

/** 按顺序跑完整个迁移目录；返回失败清单而不是第一个错误就中断（要的是全景）。 */
function replayAll(): { file: string; error: string }[] {
  return replayAllOn('postgres');
}

/** 同 replayAll，但目标库可指定 —— golden 比对要把同一套迁移重放到第二个全新空库上。 */
function replayAllOn(database: string): { file: string; error: string }[] {
  const failures: { file: string; error: string }[] = [];
  for (const file of migrationFiles) {
    try {
      ready().psqlFileOn(database, join(MIGDIR, file), ['-1']);
    } catch (e: unknown) {
      const err = e as { stderr?: string; message?: string };
      const text = String(err.stderr || err.message || '');
      const m = text.match(/ERROR:[\s\S]*?(?=\n|$)/);
      failures.push({ file, error: m ? m[0].trim() : text.slice(0, 200) });
    }
  }
  return failures;
}

// ── 永远执行的文本护栏：把「裸语句」本身挡在提交之前 ──────────────────────────
// 真库重放测试在无 PG 的环境会 skip，所以这一层必须独立存在。
// 注意它只断言**结构**（每条 DDL 都落在 dollar-quote 块的存在性守卫里），不代替行为验证。

/**
 * 收集文件里所有 dollar-quote 块覆盖的区间。
 * 必须同时认 $$ 与 $tag$ 两种写法：仓库里两种都在用（20261005000000 用 $body$），
 * 只认 $$ 会让受守卫的语句被误报成裸语句。
 */
function doBlockSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  const openRe = /DO\s*\$([A-Za-z_][A-Za-z0-9_]*)?\$/gi;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(text)) !== null) {
    const tag = m[1] ?? '';
    const close = `$${tag}$`;
    const closeAt = text.indexOf(close, m.index + m[0].length);
    if (closeAt === -1) continue; // 未闭合：交给真库重放测试去报语法错
    spans.push([m.index, closeAt + close.length]);
    openRe.lastIndex = closeAt + close.length;
  }
  return spans;
}

/**
 * 剥掉 SQL 注释（-- 行注释与 // 星块注释），供「代码里不得出现 X」类断言使用。
 * 否则注释里写一句示例 SQL 就能骗过子串检查（见下方 pg_policies 断言的说明）。
 *
 * -- 的处理有两个坑：
 *   · '://'（https:// …）里的 // 不是注释 —— 断言用 (?<!:)// 把它排除，
 *     否则一行 URL 会把整行当成注释截掉，恰好藏住行尾要检的词。
 *   · `--` 可能出现在 dollar-quote 字符串或字符串字面量内部 —— 本函数
 *     不解析字符串（那会把 dollar-quote 状态机整个复制进来）。这对当前
 *     断言是**保守方向**：字符串内部的 -- 会被多剥，只会让检查更宽松，
 *     不会把合法 SQL 误判成违规。仓库现状里也不存在这种行。
 */
function stripSqlComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(?<!:)--.*/g, '');
}

/** 读脚本源码并剥注释 —— 与 stripSqlComments 同口径，防「注释里写样例骗过检查」。 */
function scriptCode(rel: string): string {
  return stripSqlComments(readFileSync(join(ROOT, rel), 'utf8'));
}

describe('migrate.mjs 的 verify：缺失 = 失败，绝不「跳过并报成功」', () => {
  // 【这段历史】2026-10-05 的 verifyProfilesRls 在 profiles 表不存在时打印「跳过」
  // 并 return true —— 而「profiles 不存在」的唯一解释是 20260303044037（建表，
  // CREATE TABLE IF NOT EXISTS 在任何库上都会生效）之后的迁移从未在此库执行，
  // 含 20261005000000 的 PII 收口与 20261005000001 的 REVOKE。于是形成
  // 「安全迁移从未执行却 VERIFY OK」的假成功。purge 分支同日已改成缺失即失败，
  // profiles 分支迟至 2026-10-08 才关上 —— 本测试钉死这两处，防止再改回去。
  const SRC = 'scripts/supabase-migrate.mjs';

  it('verifyProfilesRls：profiles 表不存在必须失败（缺失 ≠ 可跳过）', () => {
    const body = scriptCode(SRC);
    const start = body.indexOf('async function verifyProfilesRls');
    const end = body.indexOf('async function verifyPurgeFunction');
    assert.ok(start !== -1 && end !== -1 && end > start, 'verifyProfilesRls 函数不见了（脚本结构变了？）');
    const fn = body.slice(start, end);
    // 失败分支必须同时有：点破本质的错误文案 + return false。只改文案不改返回值不算数。
    assert.ok(
      fn.includes('安全迁移从未在此库执行') && fn.includes('return false;'),
      'verifyProfilesRls 在 profiles 表不存在时必须报「表不存在 = 安全迁移从未在此库执行」并 return false。' +
        '写「跳过 + return true」就是复活「安全迁移从未执行却 VERIFY OK」的老 P0。'
    );
    // 紧邻的 tbl.length === 0 分支里不允许 return true —— 把「跳过成功」按死在分支里。
    const branch = fn.match(/if \(tbl\.length === 0\) \{[\s\S]*?\n {2}\}/);
    assert.ok(branch, 'tbl.length === 0 分支不见了（脚本结构变了？）');
    assert.ok(
      !branch[0].includes('return true'),
      'profiles 表不存在的分支里出现了 return true —— 这就是「跳过并报成功」本尊'
    );
  });

  it('verifyPurgeFunction：purge 函数缺失必须失败（与 profiles 同一口径）', () => {
    const body = scriptCode(SRC);
    const start = body.indexOf('async function verifyPurgeFunction');
    const end = body.indexOf('async function main');
    assert.ok(start !== -1 && end !== -1 && end > start, 'verifyPurgeFunction 函数不见了（脚本结构变了？）');
    const fn = body.slice(start, end);
    assert.ok(
      /missing/.test(fn) && fn.includes('return false;'),
      'verifyPurgeFunction 在 purge 函数缺失时必须 return false（缺失 = 没应用，不是无从检查）'
    );
    // 「函数不存在」的唯一合法出路是失败：不得有「查完行数为 0 就 return true」的分支。
    assert.ok(
      !/rows\.length === 0\)\s*\{[\s\S]{0,200}?return true;/.test(fn),
      'verifyPurgeFunction 里存在「rows.length === 0 → return true」—— 缺函数被报成通过'
    );
  });
});

describe('迁移幂等：SQL 结构护栏', () => {
  it('每条 create policy 都必须落在 dollar-quote 守卫块里', () => {
    const offenders: string[] = [];
    for (const file of migrationFiles) {
      const text = readFileSync(join(MIGDIR, file), 'utf8');
      const spans = doBlockSpans(text);

      const polRe = /^[ \t]*create\s+policy\b/gim;
      let m: RegExpExecArray | null;
      while ((m = polRe.exec(text)) !== null) {
        const at = m.index;
        if (!spans.some(([s, e]) => at >= s && at < e)) {
          const line = text.slice(0, at).split('\n').length;
          offenders.push(`${file}:${line}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `以下 create policy 是裸语句：重放第二遍会抛 42710，而迁移器在第一个失败文件处就 process.exit(1)，后续迁移（含安全迁移）永不执行：\n  ${offenders.join('\n  ')}`
    );
  });

  it('每条 alter publication … add table 都必须落在 dollar-quote 守卫块里', () => {
    const offenders: string[] = [];
    for (const file of migrationFiles) {
      const text = readFileSync(join(MIGDIR, file), 'utf8');
      const spans = doBlockSpans(text);

      const pubRe = /^[ \t]*alter\s+publication\b[^\n]*\badd\s+table\b/gim;
      let m: RegExpExecArray | null;
      while ((m = pubRe.exec(text)) !== null) {
        const at = m.index;
        if (!spans.some(([s, e]) => at >= s && at < e)) {
          const line = text.slice(0, at).split('\n').length;
          offenders.push(`${file}:${line}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `以下 alter publication … add table 是裸语句：重放第二遍会抛 42710（本文件排在迁移序列最前，一挂就断掉全部后续迁移）：\n  ${offenders.join('\n  ')}`
    );
  });

  it('守卫查的是 pg_catalog.pg_policy 基表，不是按角色过滤的 pg_policies 视图', () => {
    // 视图按 pg_has_role(polroles,'USAGE') 过滤：非表 owner 角色看不见策略，
    // 会被误判成「不存在」于是静默跳过——正是守卫要防的那种假阴性。
    // 注意：这里必须断言**代码里**有 pg_catalog.pg_policy，下面的「禁用 pg_policies」
    // 断言负责反方向（代码里不得出现视图名）；两者合起来把正反两个坑都堵住。
    for (const file of migrationFiles) {
      const text = readFileSync(join(MIGDIR, file), 'utf8');
      if (!/create\s+policy/i.test(text)) continue;
      assert.ok(
        /pg_catalog\.pg_policy/.test(text),
        `${file} 里有 create policy 但看不到 pg_catalog.pg_policy 守卫`
      );
    }
  });

  it('剥离注释后不得出现 pg_policies —— 一行注释就能骗过子串检查（2026-10-07 加强）', () => {
    // 【旧版本怎么被绕过】旧实现只断言整文件含 pg_catalog.pg_policy 子串，
    // 而 20251014063156:14 等文件的**注释**里就有这串 —— 把守卫查询本身退回到
    // pg_policies 视图（`SELECT 1 FROM pg_policies WHERE …`），注释一个字不动，
    // 这个检查照样绿。视图按 pg_has_role(polroles,'USAGE') 过滤：service_role
    // 连接、或角色不是表 owner 时看不到部分策略 → 误判「不存在」→ 静默跳过或
    // 重复创建，两种都是真事故。
    // 【为什么比子串断言更强】本断言要求**剥离注释后的代码**里连 pg_policies
    // 这个词都不允许出现。pg_catalog.pg_policy 是基表名，不含 pg_policies
    // 子串，所以不误伤；注释里的教学性提及（上面 4 个文件）也被剥离，不计入。
    // 【只检一词、不做其他启发式】守卫查询若用视图，一定写 `from pg_policies`
    // 或 `pg_catalog.pg_policies`，两者都包含该词；不含该词就不可能是视图查询。
    for (const file of migrationFiles) {
      const stripped = stripSqlComments(readFileSync(join(MIGDIR, file), 'utf8'));
      assert.ok(
        !/pg_policies/i.test(stripped),
        `${file} 的代码（剥除注释后）里出现了 pg_policies 视图 —— 守卫必须直查\n` +
          `  pg_catalog.pg_policy 基表。视图按 pg_has_role(polroles,'USAGE') 做可见性\n` +
          `  过滤，service_role / 非 owner 角色看不到部分策略，会误判成「不存在」而\n` +
          `  静默跳过或重复创建。注意：只在注释里提 pg_policies 不算（注释已剥除），\n` +
          `  但把查询本身写成 pg_policies 一定算。`
      );
    }
  });

  it('迁移注释里提到 dollar-quote 分隔符时不得与 DO 写在同行', () => {
    // 写在 `DO $$` 同一行会让 -- 落进字符串内部、字符串在第二个分隔符处提前闭合
    // → 42601 语法错，首跑即炸（本项目历史上真踩过）。
    // 判据是「开头分隔符之后、本行之内是否又出现同一分隔符」，对 $tag$ 同样成立。
    const offenders: string[] = [];
    for (const file of migrationFiles) {
      const lines = readFileSync(join(MIGDIR, file), 'utf8').split('\n');
      lines.forEach((line, i) => {
        // 整行注释不是 SQL：文档里举例写 `DO $body$ … $body$` 会被下面误判。
        if (line.trimStart().startsWith('--')) return;
        const m = line.match(/DO\s*(\$[A-Za-z_0-9]*\$)/);
        if (!m) return;
        const delim = m[1];
        const rest = line.slice((m.index ?? 0) + m[0].length);
        if (rest.includes(delim)) offenders.push(`${file}:${i + 1}`);
      });
    }
    assert.deepEqual(
      offenders,
      [],
      `以下 DO 行在分隔符之后又出现了同一分隔符（例如把含分隔符的注释写在同行），会导致字符串提前闭合：\n  ${offenders.join('\n  ')}`
    );
  });
});

// ── 真库行为验证 ─────────────────────────────────────────────────────────────
describe('迁移全量重放两遍（真实 Postgres）', { skip: PG_BINARIES_PRESENT ? false : SKIP_REASON }, () => {
  before(async () => {
    // 起库失败**不从 hook 抛**：node:test 会把整组标成 cancelled（fail 0 看起来全绿）。
    // 记进 setupError，由 gate() 在每个用例里 assert.fail —— 库起不来必须是红的。
    let inst: RunningPg | null = null;
    try {
      inst = await startPostgres({
        label: '迁移重放',
        preferredPort: PREFERRED_PORT,
        filePrefix: 'tapstack-replay-',
      });
      pg = inst;
    } catch (e) {
      setupError = e instanceof Error ? e : new Error(String(e));
      inst?.stop();
      pg = null;
    }
  });

  after(() => {
    pg?.stop();
  });

  gate('Dashboard 形状的库上：第一遍零失败，第二遍零失败，且两遍终态逐字相同', () => {
    psql(DASHBOARD_FIXTURE);

    const pass1 = replayAll();
    assert.deepEqual(
      pass1.map(f => f.file),
      [],
      `第一遍重放就失败了（重放链路会在第一个失败文件处 process.exit(1)，后面的迁移永不执行）：\n${pass1
        .map(f => `  ${f.file}\n    ${f.error}`)
        .join('\n')}`
    );

    const afterPass1 = psql(SNAPSHOT_SQL);

    const pass2 = replayAll();
    assert.deepEqual(
      pass2.map(f => f.file),
      [],
      `第二遍重放失败 —— 迁移不是幂等的（这正是生产上「重放中途退出、后续安全迁移从未执行」的根因）：\n${pass2
        .map(f => `  ${f.file}\n    ${f.error}`)
        .join('\n')}`
    );

    const afterPass2 = psql(SNAPSHOT_SQL);
    assert.equal(afterPass1, afterPass2, '第二遍重放改变了终态：守卫不只是「跳过」，还改动了 schema');
    assert.ok(afterPass1.split('\n').length > 40, `快照行数过少（${afterPass1.split('\n').length}），夹具可能没建起来`);
  });

  gate('第二遍重放后 20261005000000 的安全收口依然成立（anon 读 profiles 全放行策略已消失）', () => {
    const open = psql(
      `SELECT count(*) FROM pg_catalog.pg_policy pol
       JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname='public' AND c.relname='profiles' AND pol.polcmd='r'
         AND pg_get_expr(pol.polqual, pol.polrelid) = 'true';`
    );
    assert.equal(open, '0', 'profiles 仍有全放行 SELECT 策略：PII 收口迁移没生效或被重放打回');
  });

  gate('第二遍重放后 purge 函数仍对 anon/authenticated 不可执行（REVOKE 未被重放打回）', () => {
    const rows = psql(
      `SELECT p.proname||'|'||has_function_privilege('anon', p.oid, 'EXECUTE')::text||'|'||
              has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname IN ('purge_expired_cloud_tombstones','body_tombstone_expiry_days')
       ORDER BY 1;`
    );
    const lines = rows.split('\n').filter(Boolean);
    assert.equal(lines.length, 2, `应存在 2 个 purge 相关函数，实到 ${lines.length} 个：\n${rows}`);
    for (const line of lines) {
      const [name, anon, auth] = line.split('|');
      assert.equal(anon, 'false', `${name} 对 anon 可执行（REVOKE 未生效）`);
      assert.equal(auth, 'false', `${name} 对 authenticated 可执行（REVOKE 未生效）`);
    }
  });

  gate('golden 双库比对：fixture 库与全新空库重放后的 policy 名字集合与 realtime 成员集合一致', () => {
    // 【为什么需要 golden】上面的幂等断言只能证明「两遍重放终态相同」，证明不了
    // 「每条守卫的谓词写对了」：夹具库预先种好了 Dashboard 形状的对象，若某条
    // 存在性守卫的谓词写错（比如 polname 拼错），守卫就**永远跳过**，两遍都跳过，
    // 快照照样逐字相等 —— 全套绿，而那条策略从未被创建。
    // 【golden 的定义】同一集群里再建一个全新空库（对象事先不存在），把同一套
    // 迁移全量重放上去。空库上没有可跳过的既有对象，所有守卫必然真执行；
    // 若夹具库上有守卫永远跳过，两库终态就会出现差异 → 红。
    // 【只比名字集合，不比 qual/with_check/列定义】夹具的 profiles 列集合是
    // Dashboard 简化版（缺 created_at/stripe_customer_id 等），与迁移建的不同；
    // 夹具的 qual 也是 Dashboard 宽松版（FOR ALL、不带 (select auth.uid()) 包装）。
    // 比这些必然误报。而「每张表的 policy 名字集合」与「supabase_realtime 的
    // 成员表集合」不涉及列/表达式，恰是「守卫谓词写错 → 永远跳过」唯一暴露面：
    // 谓词错 ⇒ 那条策略/成员在夹具库上缺失 ⇒ 集合不一致。
    // 【policy 名字集合从哪来】直接查 pg_catalog.pg_policy 基表（与守卫同口径，
    // 不经 pg_policies 视图的角色可见性过滤），按 tablename 分组取 polname 集合。
    const inst = ready();
    inst.psqlOn('postgres', 'DROP DATABASE IF EXISTS replay_golden');
    inst.psqlOn('postgres', 'CREATE DATABASE replay_golden');
    try {
      // 全新空库上同样先建角色/auth.uid()/publication：这些由夹具而非迁移提供
      //（迁移只做 ADD TABLE / CREATE POLICY），缺了它们迁移首跑就会炸。
      inst.psqlOn('replay_golden', GOLDEN_SEED);
      const goldenPass = replayAllOn('replay_golden');
      assert.deepEqual(
        goldenPass.map(f => f.file),
        [],
        `golden 全新空库上重放失败了 —— 空库上不存在性守卫应全部放行、CREATE 应全部\n真执行，这里失败说明迁移在「首跑」路径上就不是幂等的：\n${goldenPass
          .map(f => `  ${f.file}\n    ${f.error}`)
          .join('\n')}`
      );

      // 期望状态 = 全新空库重放出来的终态（所有 CREATE 都真执行的版本），
      // 实际状态 = Dashboard 形状夹具库重放两遍后的终态。
      const policyNamesOf = (db: string) =>
        inst
          .psqlOn(
            db,
            `SELECT c.relname||'|'||pol.polname
             FROM pg_catalog.pg_policy pol
             JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' ORDER BY 1;`
          )
          .split('\n')
          .filter(Boolean);
      const realtimeMembersOf = (db: string) =>
        inst
          .psqlOn(
            db,
            `SELECT tablename FROM pg_catalog.pg_publication_tables
             WHERE pubname = 'supabase_realtime' AND schemaname = 'public' ORDER BY 1;`
          )
          .split('\n')
          .filter(Boolean);

      const expectedPolicies = policyNamesOf('replay_golden');
      const expectedRealtime = realtimeMembersOf('replay_golden');
      const actualPolicies = policyNamesOf('postgres');
      const actualRealtime = realtimeMembersOf('postgres');

      // 空库上一切真执行，集合不该为空 —— 空期望会让断言退化为「两边都空」。
      assert.ok(
        expectedPolicies.length >= 15,
        `golden 库只重放出 ${expectedPolicies.length} 条 policy（应 ≥15），迁移可能根本没生效`
      );
      assert.ok(
        expectedRealtime.length >= 2,
        `golden 库的 supabase_realtime 只有 ${expectedRealtime.length} 个成员（应 ≥2）`
      );

      assert.deepEqual(
        actualPolicies,
        expectedPolicies,
        'fixture 库与 golden 全新空库的 policy 名字集合不一致 —— 下方 diff 左侧\n' +
          '（fixture 实际）缺失的每一行，都对应一条「守卫谓词写错导致永远跳过」的\n' +
          '迁移：仓库里写着这条 CREATE POLICY，夹具库上却从未生效。'
      );
      assert.deepEqual(
        actualRealtime,
        expectedRealtime,
        'fixture 库与 golden 全新空库的 supabase_realtime 成员表集合不一致 ——\n' +
          '缺失的成员表对应一条「publication 存在性守卫谓词写错导致永远跳过」的 ADD TABLE。'
      );
    } finally {
      inst.psqlOn('postgres', 'DROP DATABASE IF EXISTS replay_golden');
    }
  });
});
