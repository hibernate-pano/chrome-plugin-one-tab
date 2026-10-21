// 云端印记守卫触发器的真实行为验证（规则见 supabase/migrations/20260909_add_op_stamp_columns.sql）。
//
// 为什么必须用真 Postgres：触发器的行为（BEFORE UPDATE 返回 NULL → 该行被静默跳过、
// 命令标记为 UPDATE 0、客户端收到 error=null）无法用纯函数单测覆盖，而这里恰好是
// 历史上出过两次事故的地方：
//   1. version 守卫用 `<=` 吞掉全部软删 → 幽灵复活（20260826064109_fix_version_guard_for_tombstones.sql）
//   2. op-stamp 守卫重蹈覆辙：removeTab（§5.3 不盖组印记）重发时 NEW=OLD 被吞
//      → tabs_data 里的标签墓碑永不上云 → 跨设备删除失效
// 所以本文件跑真库，不是可选的锦上添花。
//
// 无 initdb/pg_ctl/psql 时整组 skip（并在报告里说明），不阻塞无 PG 的环境。
// 这是 SKIP_REASON 唯一允许出现的情形。**装了二进制但库起不来**必须判红：
// 起停器只抛错（带 pg.log 尾部），由 gate() 把失败翻译成每个用例的 fail ——
// 从 before hook 直接抛会让整组变 cancelled，报告里 fail 0 看起来一切正常。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PG_BINARIES_PRESENT,
  PG_MISSING_BINARIES_REASON,
  startPostgres,
  type RunningPg,
} from './_helpers/pgHarness.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * 迁移重放清单（**按文件名时间序**，与 supabase/migrations 目录里的真实顺序一致）。
 *
 * 2026-10-20 补进两个此前漏掉的文件 —— 它们是「仓库里的 schema 描述」的一部分，
 * 漏掉的后果不是「少测一点」，而是**线上行为与仓库描述不一致**：
 *   · 20260913132832：给守卫补上 **device 平局决胜**（同 seq 时按 device 字典序）。
 *     客户端 compareStamps 的全序是「先 seq，再 device」，服务端只比 seq 时，
 *     两台设备并发产生相同 seq 就会变成「最后写入者获胜」，与客户端判定不一致。
 *   · 20260913132928：给守卫函数固定 search_path 并撤销 anon/authenticated 的直接执行权。
 *
 * 顺序要点（两条都会在下面被断言钉死）：
 *   1. 20260913132832 必须排在 20260910 **之后** —— 两者都是 CREATE OR REPLACE
 *      同一个 guard_tab_group_op_stamp，后者在库里的生效版本才会带上 device 决胜。
 *   2. 20260913132928 必须排在两个守卫函数**都存在之后**，否则 ALTER/REVOKE 会失败。
 */
const MIGRATIONS = [
  '20260825130248_add_is_deleted_tombstone.sql',
  '20260826061933_add_tab_group_version_guard.sql',
  '20260826064109_fix_version_guard_for_tombstones.sql',
  '20260909_add_op_stamp_columns.sql',
  '20260910_fix_op_stamp_guard_strict_lt.sql',
  '20260913132832_fix_op_stamp_device_tiebreak.sql',
  '20260913132928_harden_guard_functions.sql',
];

const SKIP_REASON = `${PG_MISSING_BINARIES_REASON}，跳过真实触发器集成测试`;

const GID = '11111111-1111-1111-1111-111111111111';
const USR = '22222222-2222-2222-2222-222222222222';
/** 首选端口；被占用时起停器向后探测（连续 20 个都占满则显式失败）。 */
const PREFERRED_PORT = 5599;

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

function resetRow(opts: { stamp?: number | null; isDeleted?: boolean; device?: string } = {}): void {
  const stamp = opts.stamp === undefined ? 100 : opts.stamp;
  const isDeleted = opts.isDeleted ?? false;
  const device = opts.device ?? 'devA';
  psql(
    `DELETE FROM tab_groups WHERE id='${GID}';
     INSERT INTO tab_groups (id,user_id,name,is_deleted,version,tabs_data,updated_at,last_op_device,last_op_seq)
     VALUES ('${GID}','${USR}','G',${isDeleted ? 'true' : 'false'},1,
             '[{"id":"t1"},{"id":"t2"}]'::jsonb, now(), '${device}', ${stamp === null ? 'NULL' : stamp});`
  );
}

function currentRow(): {
  is_deleted: boolean;
  last_op_seq: number | null;
  last_op_device: string;
  tabs_data: unknown[];
} {
  const out = psql(
    `SELECT is_deleted, COALESCE(last_op_seq::text,'NULL'),
            jsonb_array_length(tabs_data)::text || ':' || (tabs_data @> '[{"id":"t1","is_deleted":true}]')::text,
            COALESCE(last_op_device,'NULL')
     FROM tab_groups WHERE id='${GID}';`
  );
  const [isDeleted, seq, tabs, device] = out.split('|');
  return {
    is_deleted: isDeleted === 't',
    last_op_seq: seq === 'NULL' ? null : Number(seq),
    last_op_device: device ?? 'NULL',
    tabs_data: [tabs],
  };
}

// ── 永远执行的文本护栏：真正行为见下面的 PG 测试 ────────────────────────────
describe('op-stamp 守卫 SQL 文本护栏', () => {
  const sqlText = readFileSync(join(ROOT, 'supabase/migrations/20260910_fix_op_stamp_guard_strict_lt.sql'), 'utf8');

  it('守卫必须用严格 `<`，不得回到 `<=`（历史上因此吞掉全部 delete/重发）', () => {
    const fn = sqlText.slice(sqlText.indexOf('CREATE OR REPLACE FUNCTION public.guard_tab_group_op_stamp'));
    assert.ok(
      /NEW\.last_op_seq\s*<\s*OLD\.last_op_seq/.test(fn),
      '守卫函数里没有找到 `NEW.last_op_seq < OLD.last_op_seq`（严格小于）'
    );
    assert.ok(
      !/NEW\.last_op_seq\s*<=\s*OLD\.last_op_seq/.test(fn),
      '守卫函数里存在 `NEW.last_op_seq <= OLD.last_op_seq`：会把同印记的合法重发（removeTab 的 tabs_data 更新）整行吞掉'
    );
  });

  it('守卫必须保留三种 NULL 语义（两侧 NULL/OLD NULL 放行，NEW NULL 拒收）', () => {
    const fn = sqlText.slice(sqlText.indexOf('CREATE OR REPLACE FUNCTION public.guard_tab_group_op_stamp'));
    assert.ok(
      /OLD\.last_op_seq IS NOT NULL AND NEW\.last_op_seq IS NULL/.test(fn),
      '缺少「OLD 有值 + NEW NULL 拒收」分支：客户端显式写 NULL 会清空云端印记、让守卫永久失效'
    );
    assert.ok(/OLD\.last_op_seq IS NULL OR NEW\.last_op_seq IS NULL/.test(fn), '缺少任一侧 NULL 放行分支');
  });

  it('墓碑不得享有无条件翻转豁免（规格 §5：墓碑同样参与比印记）', () => {
    const fn = sqlText.slice(sqlText.indexOf('CREATE OR REPLACE FUNCTION public.guard_tab_group_op_stamp'));
    assert.ok(
      !/is_deleted IS DISTINCT FROM/.test(fn),
      '守卫里出现了 is_deleted 翻转豁免：落伍设备将能越因果序复活/删除，且把印记改小使守卫失效'
    );
  });
});

// ── 文本护栏（续）：20260913 两个此前漏掉的迁移 ─────────────────────────────
//
// 这一组守的是「仓库里的 schema 描述 == 线上行为」。它永远执行（不需要真库），
// 与下面的真库行为用例互为补充：文本护栏抓「文件被改坏了」，真库抓「重放顺序错了」。
describe('20260913 迁移：设备平局决胜 + 守卫函数加固（文本护栏）', () => {
  const TIEBREAK_FILE = '20260913132832_fix_op_stamp_device_tiebreak.sql';
  const HARDEN_FILE = '20260913132928_harden_guard_functions.sql';
  const tiebreakSql = readFileSync(join(ROOT, 'supabase/migrations', TIEBREAK_FILE), 'utf8');
  const hardenSql = readFileSync(join(ROOT, 'supabase/migrations', HARDEN_FILE), 'utf8');

  it('重放清单里必须包含这两个迁移文件（漏掉 = 仓库描述与线上不一致）', () => {
    assert.ok(MIGRATIONS.includes(TIEBREAK_FILE), `MIGRATIONS 缺少 ${TIEBREAK_FILE}`);
    assert.ok(MIGRATIONS.includes(HARDEN_FILE), `MIGRATIONS 缺少 ${HARDEN_FILE}`);
  });

  it('设备平局迁移必须排在 20260910 之后（两者是同一个函数的 CREATE OR REPLACE）', () => {
    const idxStrict = MIGRATIONS.indexOf('20260910_fix_op_stamp_guard_strict_lt.sql');
    const idxTie = MIGRATIONS.indexOf(TIEBREAK_FILE);
    assert.ok(idxStrict >= 0, 'MIGRATIONS 里找不到 20260910 的严格小于修复迁移');
    assert.ok(idxTie > idxStrict, 'device 平局迁移必须排在 20260910 之后：否则生效的守卫函数是没有 device 决胜的旧版');
  });

  it('加固迁移必须排在两个守卫函数都定义之后', () => {
    const idxHarden = MIGRATIONS.indexOf(HARDEN_FILE);
    assert.ok(idxHarden > MIGRATIONS.indexOf('20260826061933_add_tab_group_version_guard.sql'),
      '加固迁移排在 version 守卫之前：ALTER FUNCTION 会因函数不存在而失败');
    assert.ok(idxHarden > MIGRATIONS.indexOf(TIEBREAK_FILE),
      '加固迁移排在 op-stamp 守卫之前：ALTER/REVOKE 会因函数不存在而失败');
  });

  it('同 seq 时必须按 device 字典序决胜（NEW.device < OLD.device ⇒ 拒收）', () => {
    const fn = tiebreakSql.slice(tiebreakSql.indexOf('CREATE OR REPLACE FUNCTION public.guard_tab_group_op_stamp'));
    assert.match(
      fn,
      /NEW\.last_op_seq\s*=\s*OLD\.last_op_seq[\s\S]{0,200}?NEW\.last_op_device\s+COLLATE\s+"C"\s*<\s*OLD\.last_op_device\s+COLLATE\s+"C"/,
      '守卫里找不到「seq 相等时按 device 字典序比较」的分支：并发产生相同 seq 的两台设备会在服务端变成「最后写入者获胜」，与客户端 compareStamps 的全序判定不一致'
    );
  });

  it('device 平局分支不得写成 `<=`（那会把同 device 的合法重发整行吞掉）', () => {
    const fn = tiebreakSql.slice(tiebreakSql.indexOf('CREATE OR REPLACE FUNCTION public.guard_tab_group_op_stamp'));
    assert.ok(
      !/NEW\.last_op_device\s+COLLATE\s+"C"\s*<=\s*OLD\.last_op_device\s+COLLATE\s+"C"/.test(fn),
      '守卫里存在 `NEW.last_op_device <= OLD.last_op_device`：同 device 同 seq 的合法重发（removeTab 的 tabs_data 更新）会被整行吞掉'
    );
  });

  it('加固迁移必须固定 search_path 并撤销 anon/authenticated/PUBLIC 的直接执行权', () => {
    assert.match(hardenSql, /ALTER FUNCTION public\.guard_tab_group_op_stamp\(\)\s*\n?\s*SET search_path = public/,
      'op-stamp 守卫没有固定 search_path');
    assert.match(hardenSql, /ALTER FUNCTION public\.guard_tab_group_version\(\)\s*\n?\s*SET search_path = public/,
      'version 守卫没有固定 search_path');
    assert.match(hardenSql, /REVOKE EXECUTE ON FUNCTION public\.guard_tab_group_op_stamp\(\)\s*\n?\s*FROM PUBLIC, anon, authenticated/,
      'op-stamp 守卫没有撤销直接执行权');
    assert.match(hardenSql, /REVOKE EXECUTE ON FUNCTION public\.handle_new_user\(\)\s*\n?\s*FROM PUBLIC, anon, authenticated/,
      'handle_new_user 没有撤销直接执行权');
  });
});

// ── 真实 Postgres：触发器行为 ───────────────────────────────────────────────
describe('op-stamp 守卫触发器（真实 Postgres）', { skip: PG_BINARIES_PRESENT ? false : SKIP_REASON }, () => {
  before(async () => {
    // 起库/初始化失败**不从 hook 抛**：node:test 会把整组标成 cancelled（fail 0 看起来全绿）。
    // 记进 setupError，由 gate() 在每个用例里 assert.fail —— 库起不来必须是红的。
    let inst: RunningPg | null = null;
    try {
      inst = await startPostgres({
        label: 'op-stamp 守卫',
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
      //      而 auth schema 只存在于 Supabase）。这里只放一个同签名的空壳，
      //      目的是让 REVOKE 有对象可撤销 —— 本文件不测它的业务行为。
      // 不补这两个的话，加固迁移会以「role does not exist / function does not exist」失败，
      // ON_ERROR_STOP=1 立刻中断重放 → 整组门禁变红（而且是「因为 fixture 缺东西」的红，
      // 不是「守卫有缺陷」的红 —— 那正是最容易被误判的一种红）。
      inst.psql(`DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
          END $$;`);
      inst.psql(`CREATE OR REPLACE FUNCTION public.handle_new_user()
            RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;`);

      for (const file of MIGRATIONS) {
        inst.psqlFile(join(ROOT, 'supabase/migrations', file));
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

  // P0-1 核心回归：removeTab 不盖组印记（规格 §5.3），重发时 NEW.last_op_seq = OLD.last_op_seq。
  // 用 <= 时这一行被整行吞掉 → tabs_data 里的标签墓碑永不上云。
  gate('同印记的标签级更新（removeTab 语义）必须落库', () => {
    resetRow();
    const rows = updateRows(
      `UPDATE tab_groups
       SET tabs_data='[{"id":"t1","is_deleted":true},{"id":"t2"}]'::jsonb, version=2
       WHERE id='${GID}';`
    );
    assert.equal(rows, 1, '同印记的 tabs_data 更新被守卫吞掉了（跨设备删除将永不传播）');
    assert.deepEqual(currentRow().tabs_data, ['2:true']);
  });

  gate('更新的组级印记落库', () => {
    resetRow();
    assert.equal(updateRows(`UPDATE tab_groups SET last_op_seq=101, version=2 WHERE id='${GID}';`), 1);
  });

  gate('严格更旧的印记被静默跳过，且数据不变（不报错）', () => {
    resetRow();
    assert.equal(updateRows(`UPDATE tab_groups SET last_op_seq=50, version=2 WHERE id='${GID}';`), 0);
    assert.equal(currentRow().last_op_seq, 100, '被拒绝的写入不应改动行内容');
  });

  // 墓碑翻转不豁免（规格 §5：墓碑同样参与比印记）。相等放行即可覆盖真实删除路径：
  // 客户端 deleteGroup 盖新印记、Web 局部 UPDATE = OLD、markCloudGroupsAsDeleted = OLD+1。
  gate('墓碑翻转：同印记放行、更新印记放行、更旧印记拒收', () => {
    // 同印记（Web 控制台软删：局部 UPDATE）→ 放行
    resetRow();
    assert.equal(updateRows(`UPDATE tab_groups SET is_deleted=true, updated_at=now() WHERE id='${GID}';`), 1);
    assert.equal(currentRow().is_deleted, true);

    // 更新印记（客户端 deleteGroup）→ 放行
    resetRow();
    assert.equal(updateRows(`UPDATE tab_groups SET is_deleted=true, last_op_seq=101, version=2 WHERE id='${GID}';`), 1);

    // 更旧印记（没看见过新写入的落伍设备）→ 拒收，不允许越因果序删/复活
    resetRow();
    assert.equal(updateRows(`UPDATE tab_groups SET is_deleted=true, last_op_seq=50, version=2 WHERE id='${GID}';`), 0);
    assert.equal(currentRow().is_deleted, false);
  });

  gate('恢复墓碑：盖更新印记才生效（规格 §5：恢复天然赢过旧墓碑）', () => {
    resetRow({ isDeleted: true });
    assert.equal(updateRows(`UPDATE tab_groups SET is_deleted=false, last_op_seq=101, version=3 WHERE id='${GID}';`), 1);
    assert.equal(currentRow().is_deleted, false);

    // 落伍设备的恢复写入（印记更旧）不得让已删组复活
    resetRow({ isDeleted: true });
    assert.equal(updateRows(`UPDATE tab_groups SET is_deleted=false, last_op_seq=1, version=3 WHERE id='${GID}';`), 0);
    assert.equal(currentRow().is_deleted, true);
  });

  gate('OLD 无印记时放行（新客户端接管老行 / 两侧都无印记）', () => {
    resetRow({ stamp: null });
    assert.equal(updateRows(`UPDATE tab_groups SET last_op_seq=7, version=2 WHERE id='${GID}';`), 1, '新客户端接管老行被吞');
    resetRow({ stamp: null });
    assert.equal(updateRows(`UPDATE tab_groups SET name='x', version=2 WHERE id='${GID}';`), 1, '两侧 NULL 被吞');
  });

  // 复核发现的漏洞：客户端对「无印记实体」发送显式 NULL，会把云端印记清空（守卫从此失效）
  // 并把旧副本内容盖上去。故 OLD 有值 + NEW NULL 必须拒收。
  gate('OLD 有印记而 NEW 显式 NULL：拒收，不得清空印记、不得覆盖内容', () => {
    resetRow();
    assert.equal(
      updateRows(`UPDATE tab_groups SET name='旧备份名字', last_op_seq=NULL, version=2 WHERE id='${GID}';`),
      0,
      'NULL 写入被放行 → 云端印记被清空，后续写入全部失去仲裁'
    );
    const row = currentRow();
    assert.equal(row.last_op_seq, 100, '云端印记不得被 NULL 覆盖');
  });

  gate('同印记原样重发是幂等成功的（不再报错也不丢行）', () => {
    resetRow();
    assert.equal(updateRows(`UPDATE tab_groups SET tabs_data=tabs_data, version=2 WHERE id='${GID}';`), 1);
    assert.equal(updateRows(`UPDATE tab_groups SET tabs_data=tabs_data, version=2 WHERE id='${GID}';`), 1);
  });

  // Web 控制台（webApi.ts）的重命名/软删/恢复都是「局部 UPDATE」：payload 不带印记列，
  // 于是 NEW.last_op_seq 等于 OLD（而不是 NULL）。用 <= 时整条 Web 写入路径静默失效。
  gate('Web 控制台的局部 UPDATE（不带印记列）必须生效', () => {
    resetRow();
    assert.equal(updateRows(`UPDATE tab_groups SET name='Web 改名', updated_at=now() WHERE id='${GID}';`), 1);
    assert.equal(updateRows(`UPDATE tab_groups SET is_deleted=true, updated_at=now() WHERE id='${GID}';`), 1);
    assert.equal(updateRows(`UPDATE tab_groups SET is_deleted=false, updated_at=now() WHERE id='${GID}';`), 1);
    assert.equal(currentRow().is_deleted, false);
  });

  // ── 20260913132832：同 seq 时的 device 平局决胜 ─────────────────────────
  //
  // 背景：客户端 compareStamps 的全序是「先 seq，再 device 字典序」。
  // 20260910 的服务端守卫只比 seq —— 两台设备并发产生**相同** seq 时，
  // 服务端会退化成「最后写入者获胜」，与客户端的确定性判定不一致：
  // 客户端认为 devB 赢（device 字典序更大），服务端却让最后写入的那个赢。
  // 结果就是「编辑成功但又变回去」的那类静默不一致。
  //
  // device 比较用 COLLATE "C"（字节序），与客户端的 JS 字符串比较在 ASCII 区间一致。
  // 用例里的 device 取值刻意只含小写字母：'devA' < 'devB' < 'devC'，
  // 避免大写字母在 C 序里排在所有小写之前这种反直觉陷阱。
  gate('同 seq 时：device 更小的写入被拒收（行不变），device 更大的写入被放行', () => {
    // 基线行：seq=100，device='devB'
    resetRow({ device: 'devB' });

    // NEW.device 字典序更小（'devA' < 'devB'）→ 拒收，行必须原样不动
    assert.equal(
      updateRows(`UPDATE tab_groups SET last_op_seq=100, last_op_device='devA', version=2 WHERE id='${GID}';`),
      0,
      '同 seq 但 device 更小的写入被放行了 → 服务端与客户端全序判定不一致（客户端会判 devB 赢）'
    );
    const rejected = currentRow();
    assert.equal(rejected.last_op_device, 'devB', '被拒收的写入不得改动 last_op_device');
    assert.equal(rejected.last_op_seq, 100, '被拒收的写入不得改动 last_op_seq');
    assert.equal(rejected.is_deleted, false);

    // NEW.device 字典序更大（'devC' > 'devB'）→ 放行
    assert.equal(
      updateRows(`UPDATE tab_groups SET last_op_seq=100, last_op_device='devC', version=2 WHERE id='${GID}';`),
      1,
      '同 seq 且 device 更大的写入被拒收了 → 客户端会判 devC 赢，两边判定必须一致'
    );
    assert.equal(currentRow().last_op_device, 'devC');
  });

  gate('同 seq 同 device（完全相同印记）仍然放行 —— 合法重发不得被吞', () => {
    resetRow({ device: 'devB' });
    assert.equal(
      updateRows(`UPDATE tab_groups SET last_op_seq=100, last_op_device='devB', tabs_data=tabs_data, version=2 WHERE id='${GID}';`),
      1,
      '完全相同印记的合法重发被吞了（removeTab 的 tabs_data 更新会永不落库 → 跨设备删除失效）'
    );
  });

  gate('seq 更大时 device 字典序更小也照样放行（seq 优先于 device）', () => {
    // 全序是「先 seq，再 device」：seq 更大就赢，不看 device。
    resetRow({ device: 'devB' });
    assert.equal(
      updateRows(`UPDATE tab_groups SET last_op_seq=101, last_op_device='devA', version=2 WHERE id='${GID}';`),
      1,
      'seq 更大却被拒收了：决胜顺序必须是「先 seq，再 device」'
    );
  });

  // 迁移顺序正确性的直接证据：库里生效的函数必须**是**带 device 决胜的那一版。
  // 如果重放顺序错了（20260913 排在 20260910 之前），生效的会是旧版函数，
  // 上面的行为用例恰好也会变红 —— 这里再从函数定义本身确认一次。
  gate('库里的生效守卫函数是带 device 决胜的那一版（迁移顺序正确）', () => {
    const def = psql(`SELECT pg_get_functiondef('public.guard_tab_group_op_stamp()'::regprocedure);`);
    assert.match(def, /COLLATE "C"/,
      '生效的守卫函数里没有 device 平局决胜：迁移重放顺序错了（20260913132832 必须排在 20260910 之后）');
  });

  gate('加固迁移已生效：守卫函数的 search_path 被固定为 public', () => {
    const cfg = psql(`SELECT COALESCE(array_to_string(proconfig, ','), '') FROM pg_proc WHERE oid='public.guard_tab_group_op_stamp()'::regprocedure;`);
    assert.match(cfg, /search_path=public/,
      '守卫函数没有固定 search_path：20260913132928_harden_guard_functions.sql 没有生效');
    const cfg2 = psql(`SELECT COALESCE(array_to_string(proconfig, ','), '') FROM pg_proc WHERE oid='public.guard_tab_group_version()'::regprocedure;`);
    assert.match(cfg2, /search_path=public/, 'version 守卫函数没有固定 search_path');
  });
});
