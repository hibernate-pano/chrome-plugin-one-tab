/**
 * RLS-DRIFT：**人工漂移核对 SQL 本身**必须有检测力（2026-10-24 审计）。
 *
 * ── 这条防的具体事故 ────────────────────────────────────────────────────
 *
 * `supabase/manual/migration_drift_check.sql` 是线上唯一**免凭据**的漂移
 * 核对入口（一条条 SELECT，粘进 Dashboard SQL Editor 就能跑）。修复前它：
 *
 *   ① **从不查 `pg_class.relrowsecurity`** —— 而 PostgreSQL 里
 *      「策略存在 ≠ 策略生效」：开关关着时，12 条策略全是死策略，
 *      anon key（随扩展产物公开）能拉走全站浏览历史。核对工具对这件事
 *      完全失声。
 *   ② Q1 的 CASE 只认 op-stamp 守卫的三个变体 ⇒ 现行的
 *      `guard_tab_group_version`（20261020150000 形状）落到 `UNKNOWN`；
 *      而把它**回退成旧版**时输出**逐字节相同** ⇒ 对 version 守卫零检测力。
 *
 * ── 这个守卫怎么证明它有检测力 ──────────────────────────────────────────
 *
 * 不读 SQL 文本猜，而是**在真 Postgres 上跑那份 SQL 原文**（用例直接从
 * `supabase/manual/migration_drift_check.sql` 里切出 Q0 / Q1 执行）：
 *   · RLS 关 → 开：Q0 的结论必须从 DRIFT 变成 ok；
 *   · 删掉一类策略：Q0 必须判 DRIFT（「策略类数不足 4」）；
 *   · version 守卫从现行版换成旧版：Q1 的结论必须从 VERSION-FALLBACK 变成 UNKNOWN。
 * 三条都是「同一个库、只改一处状态、结论必须不同」——
 * 若哪条 SQL 又退化成「看不出差别」，这里立刻红。
 *
 * ⚠️ 二进制缺失（没装 PostgreSQL）时**显式 skip**；装了但库起不来必须红
 *   （由 gate() 把 setup 失败变成用例失败，不是 cancelled）。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PG_BINARIES_PRESENT,
  PG_MISSING_BINARIES_REASON,
  startPostgres,
  type RunningPg,
} from '../_helpers/pgHarness.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SQL_FILE = resolve(ROOT, 'supabase/manual/migration_drift_check.sql');

/** 与 opStampGuard(5599) / migrationReplay(5601) / versionGuardOpStamp(5603) 错开。 */
const PREFERRED_PORT = 5605;

const SKIP_REASON = `${PG_MISSING_BINARIES_REASON}，跳过真实 Postgres 的漂移核对验证`;

/**
 * 从人工核对 SQL 里切出**指定那一条**语句。
 *
 * 为什么不去另抄一份：抄一份就等于「验的是抄件」——原文改了、抄件没改，
 * 这里照样绿。切出来的必须是**文件里那一条**。
 */
function extractStatement(mustContain: string): string {
  const raw = readFileSync(SQL_FILE, 'utf8');
  // 去掉 -- 行注释（注释里有分号会让切分错位）
  const stripped = raw.replace(/--[^\n]*/g, '');
  const statements = stripped
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
  const found = statements.filter(s => s.includes(mustContain));
  assert.equal(
    found.length,
    1,
    `核对 SQL 里应当恰好有一条包含 ${JSON.stringify(mustContain)} 的语句（找到 ${found.length} 条）`
  );
  return found[0];
}

const Q0 = extractStatement('relrowsecurity');
const Q1 = extractStatement('detected_version');

let pg: RunningPg | null = null;
let setupError: Error | null = null;

function ready(): RunningPg {
  const err = setupError;
  if (err) assert.fail(`Postgres 门禁启动/初始化失败，本用例不能算通过：\n${err.message}`);
  const inst = pg;
  assert.ok(inst, 'Postgres 门禁既没成功启动、也没留下失败原因（setup 逻辑有洞）');
  return inst;
}

function gate(name: string, fn: () => void): void {
  it(name, () => {
    ready();
    fn();
  });
}

function psql(sql: string): string {
  return ready().psql(sql);
}

/** 执行 Q0，返回 表名 → `${rls_on}|${verdict}`。 */
function q0(): Map<string, string> {
  const out = psql(Q0);
  const map = new Map<string, string>();
  for (const line of out.split('\n').filter(Boolean)) {
    const parts = line.split('|');
    assert.equal(parts.length, 5, `Q0 应当返回 5 列，实际：${JSON.stringify(line)}`);
    map.set(parts[0], `${parts[1]}|${parts[4]}`);
  }
  return map;
}

/** 执行 Q1，返回 函数名 → detected_version（最后一列）。 */
function q1(): Map<string, string> {
  const out = psql(Q1);
  const map = new Map<string, string>();
  for (const line of out.split('\n').filter(Boolean)) {
    const parts = line.split('|');
    map.set(parts[0], parts[parts.length - 1]);
  }
  return map;
}

/** 现行 `guard_tab_group_version`（20261020150000 形状：version 只在无印记时兜底）。 */
const VERSION_GUARD_CURRENT = `
CREATE OR REPLACE FUNCTION public.guard_tab_group_version()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.last_op_seq IS NULL OR OLD.last_op_device IS NULL)
     AND (NEW.last_op_seq IS NULL OR NEW.last_op_device IS NULL) THEN
    IF NEW.is_deleted IS DISTINCT FROM OLD.is_deleted THEN
      RETURN NEW;
    END IF;
    IF OLD.version IS NOT NULL AND NEW.version IS NOT NULL THEN
      IF NEW.version < OLD.version THEN
        RETURN NULL;
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$;`;

/** 旧版 `guard_tab_group_version`（20260826064109 形状：没有「无印记」这道门）。 */
const VERSION_GUARD_LEGACY = `
CREATE OR REPLACE FUNCTION public.guard_tab_group_version()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_deleted IS DISTINCT FROM OLD.is_deleted THEN
    RETURN NEW;
  END IF;
  IF OLD.version IS NOT NULL AND NEW.version IS NOT NULL THEN
    IF NEW.version < OLD.version THEN
      RETURN NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;`;

describe('RLS-DRIFT：漂移核对 SQL 必须能分出「RLS 开」与「RLS 关」', {
  skip: PG_BINARIES_PRESENT ? false : SKIP_REASON,
}, () => {
  before(async () => {
    let inst: RunningPg | null = null;
    try {
      inst = await startPostgres({
        label: 'RLS 漂移核对 SQL',
        preferredPort: PREFERRED_PORT,
        filePrefix: 'tapstack-pg-rls-',
      });

      // Q1 用 has_function_privilege('anon', …) ⇒ 角色必须先存在。
      inst.psql(`DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
              CREATE ROLE anon NOLOGIN;
            END IF;
          END $$;`);

      // 最小 fixtures：7 张表（真实库由 dashboard 建表，仓库没有基线 schema）。
      for (const table of [
        'tab_groups',
        'tabs',
        'user_settings',
        'profiles',
        'ai_usage_logs',
        'sync_snapshots',
        'sync_updates',
      ]) {
        inst.psql(`CREATE TABLE public.${table} (id bigint, user_id uuid);`);
      }
      // 三张浏览历史表各 4 类策略（select/insert/update/delete）。
      for (const table of ['tab_groups', 'tabs', 'user_settings']) {
        inst.psql(`
          CREATE POLICY ${table}_sel ON public.${table} FOR SELECT USING (true);
          CREATE POLICY ${table}_ins ON public.${table} FOR INSERT WITH CHECK (true);
          CREATE POLICY ${table}_upd ON public.${table} FOR UPDATE USING (true);
          CREATE POLICY ${table}_del ON public.${table} FOR DELETE USING (true);
        `);
      }
      // 「线上漂移态」：只有 tab_groups 的 RLS 没打开（这正是 20261009120000 之前的样子）。
      for (const table of [
        'tabs',
        'user_settings',
        'profiles',
        'ai_usage_logs',
        'sync_snapshots',
        'sync_updates',
      ]) {
        inst.psql(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
      }

      inst.psql(VERSION_GUARD_CURRENT);
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

  gate('Q0 必须查 relrowsecurity：关着的那张表要判 DRIFT', () => {
    const rows = q0();
    assert.equal(rows.size, 7, `Q0 应当覆盖 7 张表，实际 ${rows.size} 张`);
    assert.equal(
      rows.get('tab_groups'),
      'f|DRIFT: RLS 未启用（策略全是死策略）',
      'RLS 关着 + 4 条策略 ⇒ 必须判 DRIFT（策略行再多也是死策略）'
    );
    assert.equal(rows.get('tabs'), 't|ok', 'RLS 开着且 4 类策略齐备 ⇒ ok');
  });

  gate('把开关打开之后，同一份 SQL 的结论必须变（检测力自证）', () => {
    const before = q0();
    assert.match(before.get('tab_groups') ?? '', /DRIFT/);

    psql('ALTER TABLE public.tab_groups ENABLE ROW LEVEL SECURITY;');

    const after = q0();
    assert.equal(
      after.get('tab_groups'),
      't|ok',
      'RLS 打开后仍判 DRIFT ⇒ 这条 SQL 分不出「开」与「关」（零检测力）'
    );
  });

  gate('RLS 开着但策略缺一类 ⇒ 必须判 DRIFT（否则会静默锁死产品）', () => {
    psql('DROP POLICY user_settings_del ON public.user_settings;');
    const rows = q0();
    assert.equal(
      rows.get('user_settings'),
      't|DRIFT: 策略类数不足 4（RLS 开着时会出现默认拒绝）',
      '缺一类策略时，RLS 开着 = 默认拒绝 ⇒ 必须判 DRIFT'
    );
    // 复原，后面的用例不受影响
    psql('CREATE POLICY user_settings_del ON public.user_settings FOR DELETE USING (true);');
  });

  gate('Q1 必须认出现行 version 守卫（20261020150000 形状）', () => {
    const rows = q1();
    assert.equal(
      rows.get('guard_tab_group_version'),
      'VERSION-FALLBACK (20261020)  <- want this',
      '现行 version 守卫必须被认出来（修复前它落到 UNKNOWN）'
    );
  });

  gate('把 version 守卫换回旧版 ⇒ Q1 的结论必须变（回退要看得出来）', () => {
    const before = q1().get('guard_tab_group_version');

    psql(VERSION_GUARD_LEGACY);
    const legacy = q1().get('guard_tab_group_version');
    assert.equal(
      legacy,
      'UNKNOWN - read prosrc',
      '旧版 shape 应当落到 UNKNOWN（它确实不是现行版）'
    );
    assert.notEqual(
      legacy,
      before,
      '换成旧版之后结论没变 ⇒ 这条查询对 version 守卫零检测力（修复前正是如此）'
    );

    // 复原
    psql(VERSION_GUARD_CURRENT);
    assert.equal(q1().get('guard_tab_group_version'), before);
  });
});
