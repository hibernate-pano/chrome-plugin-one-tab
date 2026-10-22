// version 守卫与印记全序对齐（迁移 20261020150000）的**真实 Postgres** 行为验证。
//
// ── 本文件钉的缺陷（2026-10-20 P0）────────────────────────────────────────
// 云端同时存在**两套裁决规则**，都挂在 tab_groups 的 BEFORE UPDATE 上：
//   ① guard_tab_group_version  —— 按 version 比大小裁决
//   ② guard_tab_group_op_stamp —— 按操作印记（seq → device）全序裁决
// 两者任一返回 NULL，整行 UPDATE 就被**静默吞掉**（HTTP 200、无 error）。
//
// version 是**每台设备各自的本地计数器**，跨设备根本不可比：
//   云端行：version=4、印记 (devA, 5000)（设备 A 改了 3 次）
//   设备 B：version=2、印记 (devB, 5001)（离线期间改了 1 次，但**更晚保存**）
// 旧 version 守卫判 `NEW.version(2) < OLD.version(4)` → RETURN NULL →
// **更晚保存的一方整行被吞**，B 的 tabs_data 永远上不去，且两台设备都
// 悄悄丢掉了那次编辑。这与 README 承诺的「整组由操作印记决胜、
// 后保存的一方赢」正好相反（README 那句「最后保存的一方为准」已于
// 2026-10-23 按 DS-43-18 更正为「印记决胜」—— 实际是本例的 B 赢）。
//
// 为什么必须用真 Postgres：BEFORE 触发器返回 NULL ⇒ 命令标记 UPDATE 0、
// 客户端收到 error=null，这件事用纯函数单测覆盖不了；而这里恰好是历史上
// 出过两次事故的地方（`<=` 吞掉全部软删 → 幽灵复活；op-stamp 重发被吞 →
// 跨设备删除失效）。
//
// 起不来必须判红：起停器只抛错（带 pg.log 尾部），由 gate() 把失败翻译成
// 每个用例的 fail —— 从 before hook 直接抛会让整组变 cancelled，
// 报告里 "fail 0" 看起来一切正常（那正是「假绿」）。SKIP_REASON 只留给
// 「二进制根本不存在」。
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
} from './_helpers/pgHarness.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = join(ROOT, 'supabase/migrations');

/** 本文件要验的那条迁移（把 version 守卫降级为「无印记时的兜底」）。 */
const ALIGN_FILE = '20261020150000_align_version_guard_with_op_stamp.sql';

/**
 * 迁移重放清单（**按文件名时间序**，与 supabase/migrations 目录里的真实顺序一致）。
 *
 * 顺序要点（下面有断言钉死）：
 *   1. 20260826064109 必须在 20260826061933 之后 —— 两者是同一个
 *      guard_tab_group_version 的 CREATE OR REPLACE。
 *   2. 20260909（印记列）必须在守卫用上印记列之前。
 *   3. 20260913132928（守卫加固：search_path + REVOKE）必须在两个守卫函数
 *      都存在之后。
 *   4. **20261020150000 必须在 20260826064109 之后**（它是同一个函数的新
 *      定义）**且在 20260913132928 之后**（它要重新钉一次 search_path，
 *      顺序反了会把加固抹掉）。
 */
const MIGRATIONS = [
  '20260825130248_add_is_deleted_tombstone.sql',
  '20260826061933_add_tab_group_version_guard.sql',
  '20260826064109_fix_version_guard_for_tombstones.sql',
  '20260909_add_op_stamp_columns.sql',
  '20260910_fix_op_stamp_guard_strict_lt.sql',
  '20260913132832_fix_op_stamp_device_tiebreak.sql',
  '20260913132928_harden_guard_functions.sql',
  ALIGN_FILE,
];

const SKIP_REASON = `${PG_MISSING_BINARIES_REASON}，跳过真实触发器集成测试`;

const GID = '11111111-1111-1111-1111-111111111111';
const USR = '22222222-2222-2222-2222-222222222222';
/** 首选端口（与 opStampGuard 的 5599、migrationReplay 的 5601 错开，避免并行撞车）。 */
const PREFERRED_PORT = 5603;

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

/** 执行一条 UPDATE，返回实际落库行数（BEFORE 触发器返回 NULL 时为 0 = 静默跳过） */
function updateRows(sql: string): number {
  const out = psql(sql);
  const m = out.match(/UPDATE (\d+)/);
  assert.ok(m, `psql 未返回 UPDATE 标记，原始输出: ${JSON.stringify(out)}`);
  return Number(m[1]);
}

interface RowState {
  version: number;
  last_op_seq: number | null;
  last_op_device: string | null;
  is_deleted: boolean;
  name: string;
  /** tabs_data 首元素的 by 字段：用来判「内容真的落库了吗」。 */
  marker: string;
}

/** 写入一行云端基线（可控 version / 印记 / 内容标记）。 */
function resetCloudRow(
  opts: {
    version?: number;
    seq?: number | null;
    device?: string | null;
    marker?: string;
    isDeleted?: boolean;
    name?: string;
  } = {}
): void {
  const version = opts.version ?? 4;
  const seq = opts.seq === undefined ? 5000 : opts.seq;
  const device = opts.device === undefined ? 'devA' : opts.device;
  const marker = opts.marker ?? 'A';
  const isDeleted = opts.isDeleted ?? false;
  const name = opts.name ?? 'G';
  psql(
    `DELETE FROM tab_groups WHERE id='${GID}';
     INSERT INTO tab_groups (id,user_id,name,is_deleted,version,tabs_data,updated_at,last_op_device,last_op_seq)
     VALUES ('${GID}','${USR}','${name}',${isDeleted},${version},
             '[{"id":"t1","by":"${marker}"}]'::jsonb, now(),
             ${device === null ? 'NULL' : `'${device}'`}, ${seq === null ? 'NULL' : seq});`
  );
}

function currentRow(): RowState {
  const out = psql(
    `SELECT version::text || '|' || COALESCE(last_op_seq::text,'NULL') || '|' ||
            COALESCE(last_op_device,'NULL') || '|' || is_deleted::text || '|' ||
            name || '|' || COALESCE(tabs_data->0->>'by','NONE')
     FROM tab_groups WHERE id='${GID}';`
  );
  const [version, seq, device, isDeleted, name, marker] = out.split('|');
  return {
    version: Number(version),
    last_op_seq: seq === 'NULL' ? null : Number(seq),
    last_op_device: device === 'NULL' ? null : device,
    is_deleted: isDeleted === 'true',
    name: name ?? '',
    marker: marker ?? 'NONE',
  };
}

// ── 永远执行的文本护栏：迁移文件本身必须写清取舍 ────────────────────────────
describe('20261020150000 迁移：文本护栏（不需要真库）', () => {
  const sqlText = readFileSync(join(MIGRATIONS_DIR, ALIGN_FILE), 'utf8');

  it('迁移文件必须存在（仓库的迁移目录是历史，只能加不能删）', () => {
    const files = readdirSync(MIGRATIONS_DIR);
    assert.ok(files.includes(ALIGN_FILE), `supabase/migrations 下缺少 ${ALIGN_FILE}`);
    for (const old of [
      '20260826064109_fix_version_guard_for_tombstones.sql',
      '20260913132832_fix_op_stamp_device_tiebreak.sql',
      '20260913132928_harden_guard_functions.sql',
    ]) {
      assert.ok(files.includes(old), `历史迁移 ${old} 消失了 —— 迁移目录是历史，不许删改`);
    }
  });

  it('重放清单里必须包含它，且排在 version 守卫现行版本与加固迁移之后', () => {
    assert.ok(MIGRATIONS.includes(ALIGN_FILE), `重放清单缺少 ${ALIGN_FILE}`);
    const idx = MIGRATIONS.indexOf(ALIGN_FILE);
    assert.ok(
      idx > MIGRATIONS.indexOf('20260826064109_fix_version_guard_for_tombstones.sql'),
      '必须排在 20260826064109 之后：两者是同一个函数的 CREATE OR REPLACE，顺序反了生效的是旧版'
    );
    assert.ok(
      idx > MIGRATIONS.indexOf('20260913132928_harden_guard_functions.sql'),
      '必须排在 20260913132928 之后：本迁移要重新钉一次 search_path，顺序反了会把加固抹掉'
    );
    assert.ok(
      idx > MIGRATIONS.indexOf('20260909_add_op_stamp_columns.sql'),
      '必须排在 20260909（印记列）之后：守卫要用到印记列'
    );
  });

  it('必须重定义 guard_tab_group_version（否则云端仍在用旧裁决规则）', () => {
    assert.match(
      sqlText,
      /CREATE OR REPLACE FUNCTION public\.guard_tab_group_version\(\)/,
      '没有重定义 public.guard_tab_group_version()'
    );
  });

  it('「两侧都无印记」的兜底分支必须同时检查 seq 与 device', () => {
    assert.match(
      sqlText,
      /OLD\.last_op_seq IS NULL OR OLD\.last_op_device IS NULL/,
      '兜底分支没有检查 OLD 的完整印记（只查 seq 会把「有 seq 没 device」的半印记行误判成无印记）'
    );
    assert.match(
      sqlText,
      /NEW\.last_op_seq IS NULL OR NEW\.last_op_device IS NULL/,
      '兜底分支没有检查 NEW 的完整印记'
    );
  });

  it('version 判据只能出现在「两侧都无印记」的兜底分支里', () => {
    const fn = sqlText.slice(sqlText.indexOf('CREATE OR REPLACE FUNCTION public.guard_tab_group_version'));
    const guardAt = fn.indexOf('OLD.last_op_seq IS NULL');
    const versionAt = fn.indexOf('NEW.version < OLD.version');
    assert.ok(guardAt >= 0, '找不到「两侧都无印记」的分支');
    assert.ok(versionAt >= 0, '找不到 version 判据（无印记时仍要保留旧兜底）');
    assert.ok(
      guardAt < versionAt,
      'version 判据出现在印记检查之前 —— 那样 version 会在两侧都有印记时也参与裁决（本缺陷的成因）'
    );
  });

  it('取舍必须写在注释里（否则后人会「顺手」把 version 判据加回来）', () => {
    assert.match(sqlText, /印记/, '迁移注释必须说明裁决权归印记');
    assert.match(sqlText, /兜底/, '迁移注释必须说明 version 降级为无印记时的兜底');
    assert.match(
      sqlText,
      /不要把 version 判据加回/,
      '迁移注释必须明确警告：不要把 version 判据加回「两侧都有印记」的分支'
    );
  });

  it('必须重新钉一次 search_path（CREATE OR REPLACE 会覆盖函数的 SET 配置）', () => {
    assert.match(
      sqlText,
      /ALTER FUNCTION public\.guard_tab_group_version\(\)\s*\n?\s*SET search_path = public/,
      '没有重新固定 search_path：20260913132928 的加固会被本迁移抹掉'
    );
  });
});

// ── 真实 Postgres：触发器行为 ───────────────────────────────────────────────
describe('version 守卫 × 印记全序（真实 Postgres）', { skip: PG_BINARIES_PRESENT ? false : SKIP_REASON }, () => {
  before(async () => {
    // 起库/初始化失败**不从 hook 抛**：node:test 会把整组标成 cancelled（fail 0 看起来全绿）。
    // 记进 setupError，由 gate() 在每个用例里 assert.fail —— 库起不来必须是红的。
    let inst: RunningPg | null = null;
    try {
      inst = await startPostgres({
        label: 'version 守卫 × 印记',
        preferredPort: PREFERRED_PORT,
        filePrefix: 'tapstack-pg-',
      });

      // 最小 fixtures：只保留迁移用到的列（真实库由 dashboard 建表，仓库无基线 schema）
      inst.psql(`CREATE TABLE public.tab_groups (
            id uuid PRIMARY KEY, user_id uuid NOT NULL, name text,
            is_deleted boolean NOT NULL DEFAULT false,
            version integer NOT NULL DEFAULT 1,
            tabs_data jsonb, updated_at timestamptz,
            device_id text, last_sync timestamptz);`);

      // 20260913132928_harden_guard_functions.sql 需要两类前置对象，plain PG 里都没有：
      //   1. 角色 anon / authenticated（Supabase 平台预置；迁移要对它们 REVOKE EXECUTE）
      //   2. 函数 public.handle_new_user()（真实定义在 20260303044058，依赖 auth.users，
      //      而 auth schema 只存在于 Supabase）。这里只放一个同签名的空壳。
      // 本文件的迁移还要对 anon/authenticated 做 REVOKE（角色不存在时裸 REVOKE 会
      // ERROR 并回滚整条迁移），所以角色必须先建出来。
      inst.psql(`DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
          END $$;`);
      inst.psql(`CREATE OR REPLACE FUNCTION public.handle_new_user()
            RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;`);

      for (const file of MIGRATIONS) {
        inst.psqlFile(join(MIGRATIONS_DIR, file));
      }
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

  gate('两个触发器都挂上了', () => {
    const names = psql(
      `SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger
       WHERE tgrelid='public.tab_groups'::regclass AND NOT tgisinternal;`
    );
    assert.equal(names, 'tab_group_op_stamp_guard,tab_group_version_guard');
  });

  // ── P0 核心回归：更晚保存的一方必须赢 ────────────────────────────────────
  gate('P0：云端 version=4/seq=5000，B 用 version=2/seq=5001 更新 ⇒ 必须落库 1 行且内容变成 B 的', () => {
    resetCloudRow({ version: 4, seq: 5000, device: 'devA', marker: 'A' });

    const rows = updateRows(
      `UPDATE tab_groups
       SET version=2, last_op_device='devB', last_op_seq=5001,
           tabs_data='[{"id":"t1","by":"B"}]'::jsonb
       WHERE id='${GID}';`
    );

    assert.equal(
      rows,
      1,
      '❌ 回归：更晚保存的一方（B，印记更大）被 version 守卫静默吞写（UPDATE 0）—— ' +
        '那一次编辑在两台设备上都永久丢失，且上传还会被报成成功'
    );
    const row = currentRow();
    assert.equal(row.version, 2, '落库后 version 应是本次上行的值');
    assert.equal(row.last_op_seq, 5001, '落库后印记必须是更晚保存那一方的');
    assert.equal(row.last_op_device, 'devB');
    assert.equal(row.marker, 'B', '❌ 回归：B 的 tabs_data 没有真的落库');
  });

  gate('P0 反向：更旧的印记仍然被拒收（降级不能变成「什么都能写」）', () => {
    resetCloudRow({ version: 4, seq: 5000, device: 'devA', marker: 'A' });
    const rows = updateRows(
      `UPDATE tab_groups
       SET version=9, last_op_device='devA', last_op_seq=4999,
           tabs_data='[{"id":"t1","by":"OLD"}]'::jsonb
       WHERE id='${GID}';`
    );
    assert.equal(rows, 0, '印记更旧的写入必须被 op-stamp 守卫拒收（哪怕 version 更大）');
    const row = currentRow();
    assert.equal(row.last_op_seq, 5000, '被拒收的写入不得改动印记');
    assert.equal(row.marker, 'A', '被拒收的写入不得改动内容');
  });

  // ── 两侧都无印记：旧 version 判据必须仍然生效（老客户端兜底）────────────
  gate('两侧都无印记时：旧 version 判据仍然生效（NEW.version < OLD.version ⇒ 拒收）', () => {
    resetCloudRow({ version: 4, seq: null, device: null, marker: 'A' });
    const rows = updateRows(`UPDATE tab_groups SET version=2, name='B' WHERE id='${GID}';`);
    assert.equal(rows, 0, '两侧都无印记时 version 更小的写入必须被拒收（老客户端的兜底判据）');
    assert.equal(currentRow().name, 'G', '被拒收的写入不得改动行内容');
  });

  gate('两侧都无印记时：version 不更小则放行', () => {
    resetCloudRow({ version: 4, seq: null, device: null, marker: 'A' });
    assert.equal(updateRows(`UPDATE tab_groups SET version=5, name='B' WHERE id='${GID}';`), 1);
    assert.equal(currentRow().name, 'B');
    resetCloudRow({ version: 4, seq: null, device: null, marker: 'A' });
    assert.equal(updateRows(`UPDATE tab_groups SET version=4, name='C' WHERE id='${GID}';`), 1);
    assert.equal(currentRow().name, 'C');
  });

  gate('两侧都无印记时：墓碑翻转仍然放行（删除意图必须传播）', () => {
    resetCloudRow({ version: 4, seq: null, device: null, marker: 'A' });
    const rows = updateRows(`UPDATE tab_groups SET is_deleted=true, version=1 WHERE id='${GID}';`);
    assert.equal(rows, 1, '墓碑翻转不能被 version 判据拦下（否则删除意图传播不出去、内容复活）');
    assert.equal(currentRow().is_deleted, true);
  });

  // ── 只有一侧有印记：version 不参与裁决 ───────────────────────────────────
  gate('只有一侧有印记时：version 不参与裁决（放行），哪怕 version 严格更小', () => {
    resetCloudRow({ version: 4, seq: null, device: null, marker: 'A' });
    const rows = updateRows(
      `UPDATE tab_groups
       SET version=2, last_op_device='devB', last_op_seq=5001,
           tabs_data='[{"id":"t1","by":"B"}]'::jsonb
       WHERE id='${GID}';`
    );
    assert.equal(rows, 1, '只有一侧有印记时 version 不得裁决（NULL 不是最小印记，是「不知道」）');
    const row = currentRow();
    assert.equal(row.last_op_seq, 5001);
    assert.equal(row.marker, 'B');
  });

  gate('反方向：OLD 有印记而 NEW 显式 NULL ⇒ 拒收（清空印记由 op-stamp 守卫负责，与 version 无关）', () => {
    resetCloudRow({ version: 4, seq: 5000, device: 'devA', marker: 'A' });
    const rows = updateRows(
      `UPDATE tab_groups SET version=2, last_op_seq=NULL, last_op_device=NULL WHERE id='${GID}';`
    );
    assert.equal(rows, 0, '显式清空印记的写入必须被拒收');
    assert.equal(currentRow().last_op_seq, 5000, '云端印记不得被清空');
  });

  // ── 生效版本必须是「新版」 ───────────────────────────────────────────────
  gate('库里生效的 version 守卫是新版（引用了印记列）', () => {
    const def = psql(`SELECT pg_get_functiondef('public.guard_tab_group_version()'::regprocedure);`);
    assert.match(def, /last_op_seq/, '生效的 version 守卫没有引用印记列：迁移 20261020150000 未生效');
    assert.match(def, /last_op_device/, '生效的 version 守卫没有引用 device 列');
  });

  gate('本迁移没有抹掉加固迁移的 search_path 固定', () => {
    const cfg = psql(
      `SELECT COALESCE(array_to_string(proconfig, ','), '') FROM pg_proc WHERE oid='public.guard_tab_group_version()'::regprocedure;`
    );
    assert.match(cfg, /search_path=public/, 'version 守卫函数没有固定 search_path');
  });

  gate('守卫函数的 EXECUTE 权限仍然只留给 owner（加固没被本迁移抹掉）', () => {
    const acl = psql(
      `SELECT COALESCE(array_to_string(proacl, ','), '') FROM pg_proc WHERE oid='public.guard_tab_group_version()'::regprocedure;`
    );
    assert.ok(
      !/authenticated/.test(acl),
      `守卫函数的 ACL 里仍有 authenticated：${acl}（加固迁移的 REVOKE 被本迁移抹掉了）`
    );
  });
});
