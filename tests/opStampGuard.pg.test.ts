// 云端印记守卫触发器的真实行为验证（规则见 20260913_fix_op_stamp_device_tiebreak.sql）。
//
// 为什么必须用真 Postgres：触发器的行为（BEFORE UPDATE 返回 NULL → 该行被静默跳过、
// 命令标记为 UPDATE 0、客户端收到 error=null）无法用纯函数单测覆盖，而这里恰好是
// 历史上出过两次事故的地方：
//   1. version 守卫用 `<=` 吞掉全部软删 → 幽灵复活（20260827_fix_version_guard_for_tombstones.sql）
//   2. op-stamp 守卫重蹈覆辙：removeTab（§5.3 不盖组印记）重发时 NEW=OLD 被吞
//      → tabs_data 里的标签墓碑永不上云 → 跨设备删除失效
// 所以本文件跑真库，不是可选的锦上添花。
//
// 无 initdb/pg_ctl/psql 时整组 skip（并在报告里说明），不阻塞无 PG 的环境。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = [
  '20260825130248_add_is_deleted_tombstone.sql',
  '20260827_add_tab_group_version_guard.sql',
  '20260827_fix_version_guard_for_tombstones.sql',
  '20260909_add_op_stamp_columns.sql',
  '20260910_fix_op_stamp_guard_strict_lt.sql',
  '20260913_fix_op_stamp_device_tiebreak.sql',
];

function findBinary(name: string): string | null {
  try {
    return execFileSync('which', [name], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

const INITDB = findBinary('initdb');
const PG_CTL = findBinary('pg_ctl');
const PSQL = findBinary('psql');
const PG_AVAILABLE = Boolean(INITDB && PG_CTL && PSQL);
const SKIP_REASON = '未找到 initdb/pg_ctl/psql，跳过真实触发器集成测试（SQL 文本护栏仍会执行）';

const GID = '11111111-1111-1111-1111-111111111111';
const USR = '22222222-2222-2222-2222-222222222222';
const SOCKET_PORT = '5599';

let workDir = '';
let socketDir = '';
let dataDir = '';

function psql(sql: string): string {
  return execFileSync(
    PSQL as string,
    ['-h', socketDir, '-p', SOCKET_PORT, '-U', 'postgres', '-d', 'postgres', '-tA', '-c', sql],
    { encoding: 'utf8' }
  ).trim();
}

/** 执行一条 UPDATE，返回实际落库行数（BEFORE 触发器返回 NULL 时为 0 = 静默跳过） */
function updateRows(sql: string): number {
  const out = psql(sql);
  const m = out.match(/UPDATE (\d+)/);
  assert.ok(m, `psql 未返回 UPDATE 标记，原始输出: ${JSON.stringify(out)}`);
  return Number(m[1]);
}

function resetRow(opts: { stamp?: number | null; isDeleted?: boolean } = {}): void {
  const stamp = opts.stamp === undefined ? 100 : opts.stamp;
  const isDeleted = opts.isDeleted ?? false;
  psql(
    `DELETE FROM tab_groups WHERE id='${GID}';
     INSERT INTO tab_groups (id,user_id,name,is_deleted,version,tabs_data,updated_at,last_op_device,last_op_seq)
     VALUES ('${GID}','${USR}','G',${isDeleted ? 'true' : 'false'},1,
             '[{"id":"t1"},{"id":"t2"}]'::jsonb, now(), 'devA', ${stamp === null ? 'NULL' : stamp});`
  );
}

function currentRow(): { is_deleted: boolean; last_op_seq: number | null; tabs_data: unknown[] } {
  const out = psql(
    `SELECT is_deleted, COALESCE(last_op_seq::text,'NULL'),
            jsonb_array_length(tabs_data)::text || ':' || (tabs_data @> '[{"id":"t1","is_deleted":true}]')::text
     FROM tab_groups WHERE id='${GID}';`
  );
  const [isDeleted, seq, tabs] = out.split('|');
  return { is_deleted: isDeleted === 't', last_op_seq: seq === 'NULL' ? null : Number(seq), tabs_data: [tabs] };
}

// ── 永远执行的文本护栏：真正行为见下面的 PG 测试 ────────────────────────────
describe('op-stamp 守卫 SQL 文本护栏', () => {
  const sqlText = readFileSync(join(ROOT, 'supabase/migrations/20260913_fix_op_stamp_device_tiebreak.sql'), 'utf8');

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
    assert.ok(
      /OLD\.last_op_device IS NOT NULL AND NEW\.last_op_device IS NULL/.test(fn),
      '缺少 device NULL 清空防护'
    );
    assert.ok(/OLD\.last_op_seq IS NULL OR NEW\.last_op_seq IS NULL/.test(fn), '缺少 seq 任一侧 NULL 放行分支');
    assert.ok(/OLD\.last_op_device IS NULL OR NEW\.last_op_device IS NULL/.test(fn), '缺少 device 任一侧 NULL 放行分支');
  });

  it('守卫必须比较 device 平局，客户端与服务端全序一致', () => {
    const fn = sqlText.slice(sqlText.indexOf('CREATE OR REPLACE FUNCTION public.guard_tab_group_op_stamp'));
    assert.ok(
      /NEW\.last_op_seq\s*=\s*OLD\.last_op_seq/.test(fn)
      && /NEW\.last_op_device\s+COLLATE\s+"C"\s*<\s*OLD\.last_op_device\s+COLLATE\s+"C"/.test(fn),
      '缺少 seq 相等时按 device 字典序决胜'
    );
  });

  it('墓碑不得享有无条件翻转豁免（规格 §5：墓碑同样参与比印记）', () => {
    const fn = sqlText.slice(sqlText.indexOf('CREATE OR REPLACE FUNCTION public.guard_tab_group_op_stamp'));
    assert.ok(
      !/is_deleted IS DISTINCT FROM/.test(fn),
      '守卫里出现了 is_deleted 翻转豁免：落伍设备将能越因果序复活/删除，且把印记改小使守卫失效'
    );
  });
});

// ── 真实 Postgres：触发器行为 ───────────────────────────────────────────────
describe('op-stamp 守卫触发器（真实 Postgres）', { skip: PG_AVAILABLE ? false : SKIP_REASON }, () => {
  before(() => {
    workDir = mkdtempSync(join(tmpdir(), 'tapstack-pg-'));
    dataDir = join(workDir, 'data');
    socketDir = join(workDir, 'sock');
    mkdirSync(socketDir);

    execFileSync(INITDB as string, ['-D', dataDir, '-U', 'postgres', '--auth=trust', '--encoding=UTF8', '--locale=C'], {
      stdio: 'pipe',
    });
    execFileSync(
      PG_CTL as string,
      ['-D', dataDir, '-w', '-o', `-k ${socketDir} -c listen_addresses= -p ${SOCKET_PORT}`, '-l', join(workDir, 'pg.log'), 'start'],
      { stdio: 'pipe' }
    );

    // 最小 fixtures：只保留迁移用到的列（真实库由 dashboard 建表，仓库无基线 schema）
    psql(`CREATE TABLE public.tab_groups (
            id uuid PRIMARY KEY, user_id uuid NOT NULL, name text,
            is_deleted boolean NOT NULL DEFAULT false,
            version integer NOT NULL DEFAULT 1,
            tabs_data jsonb, updated_at timestamptz,
            device_id text, last_sync timestamptz);`);

    for (const file of MIGRATIONS) {
      execFileSync(PSQL as string, ['-h', socketDir, '-p', SOCKET_PORT, '-U', 'postgres', '-d', 'postgres', '-q', '-f', join(ROOT, 'supabase/migrations', file)], {
        stdio: 'pipe',
      });
    }
  });

  after(() => {
    try {
      if (dataDir) execFileSync(PG_CTL as string, ['-D', dataDir, '-m', 'immediate', 'stop'], { stdio: 'pipe' });
    } catch {
      /* 清理失败不掩盖测试结论 */
    }
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it('两个触发器都挂上了', () => {
    const names = psql(
      `SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger
       WHERE tgrelid='public.tab_groups'::regclass AND NOT tgisinternal;`
    );
    assert.equal(names, 'tab_group_op_stamp_guard,tab_group_version_guard');
  });

  // P0-1 核心回归：removeTab 不盖组印记（规格 §5.3），重发时 NEW.last_op_seq = OLD.last_op_seq。
  // 用 <= 时这一行被整行吞掉 → tabs_data 里的标签墓碑永不上云。
  it('同印记的标签级更新（removeTab 语义）必须落库', () => {
    resetRow();
    const rows = updateRows(
      `UPDATE tab_groups
       SET tabs_data='[{"id":"t1","is_deleted":true},{"id":"t2"}]'::jsonb, version=2
       WHERE id='${GID}';`
    );
    assert.equal(rows, 1, '同印记的 tabs_data 更新被守卫吞掉了（跨设备删除将永不传播）');
    assert.deepEqual(currentRow().tabs_data, ['2:true']);
  });

  it('更新的组级印记落库', () => {
    resetRow();
    assert.equal(updateRows(`UPDATE tab_groups SET last_op_seq=101, version=2 WHERE id='${GID}';`), 1);
  });

  it('seq 相等时按 device 字典序决胜，与客户端 compareStamps 一致', () => {
    resetRow({ stamp: 100 });
    assert.equal(
      updateRows(`UPDATE tab_groups SET last_op_device='dev0', version=2 WHERE id='${GID}';`),
      0,
      '相同 seq、较小 device 的写入应被拒绝'
    );
    assert.equal(updateRows(`UPDATE tab_groups SET last_op_device='devZ', version=2 WHERE id='${GID}';`), 1);
    assert.equal(currentRow().last_op_seq, 100);
  });

  it('seq 更大时即使 device 更小也应放行', () => {
    resetRow({ stamp: 100 });
    assert.equal(
      updateRows(`UPDATE tab_groups SET last_op_device='dev0', last_op_seq=101, version=2 WHERE id='${GID}';`),
      1
    );
    assert.equal(currentRow().last_op_seq, 101);
  });

  it('严格更旧的印记被静默跳过，且数据不变（不报错）', () => {
    resetRow();
    assert.equal(updateRows(`UPDATE tab_groups SET last_op_seq=50, version=2 WHERE id='${GID}';`), 0);
    assert.equal(currentRow().last_op_seq, 100, '被拒绝的写入不应改动行内容');
  });

  // 墓碑翻转不豁免（规格 §5：墓碑同样参与比印记）。相等放行即可覆盖真实删除路径：
  // 客户端 deleteGroup 盖新印记、Web 局部 UPDATE = OLD、markCloudGroupsAsDeleted = OLD+1。
  it('墓碑翻转：同印记放行、更新印记放行、更旧印记拒收', () => {
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

  it('恢复墓碑：盖更新印记才生效（规格 §5：恢复天然赢过旧墓碑）', () => {
    resetRow({ isDeleted: true });
    assert.equal(updateRows(`UPDATE tab_groups SET is_deleted=false, last_op_seq=101, version=3 WHERE id='${GID}';`), 1);
    assert.equal(currentRow().is_deleted, false);

    // 落伍设备的恢复写入（印记更旧）不得让已删组复活
    resetRow({ isDeleted: true });
    assert.equal(updateRows(`UPDATE tab_groups SET is_deleted=false, last_op_seq=1, version=3 WHERE id='${GID}';`), 0);
    assert.equal(currentRow().is_deleted, true);
  });

  it('OLD 无印记时放行（新客户端接管老行 / 两侧都无印记）', () => {
    resetRow({ stamp: null });
    assert.equal(updateRows(`UPDATE tab_groups SET last_op_seq=7, version=2 WHERE id='${GID}';`), 1, '新客户端接管老行被吞');
    resetRow({ stamp: null });
    assert.equal(updateRows(`UPDATE tab_groups SET name='x', version=2 WHERE id='${GID}';`), 1, '两侧 NULL 被吞');
  });

  // 复核发现的漏洞：客户端对「无印记实体」发送显式 NULL，会把云端印记清空（守卫从此失效）
  // 并把旧副本内容盖上去。故 OLD 有值 + NEW NULL 必须拒收。
  it('OLD 有印记而 NEW 显式 NULL：拒收，不得清空印记、不得覆盖内容', () => {
    resetRow();
    assert.equal(
      updateRows(`UPDATE tab_groups SET name='旧备份名字', last_op_seq=NULL, version=2 WHERE id='${GID}';`),
      0,
      'NULL 写入被放行 → 云端印记被清空，后续写入全部失去仲裁'
    );
    const row = currentRow();
    assert.equal(row.last_op_seq, 100, '云端印记不得被 NULL 覆盖');
  });

  it('同印记原样重发是幂等成功的（不再报错也不丢行）', () => {
    resetRow();
    assert.equal(updateRows(`UPDATE tab_groups SET tabs_data=tabs_data, version=2 WHERE id='${GID}';`), 1);
    assert.equal(updateRows(`UPDATE tab_groups SET tabs_data=tabs_data, version=2 WHERE id='${GID}';`), 1);
  });

  // Web 控制台（webApi.ts）的重命名/软删/恢复都是「局部 UPDATE」：payload 不带印记列，
  // 于是 NEW.last_op_seq 等于 OLD（而不是 NULL）。用 <= 时整条 Web 写入路径静默失效。
  it('Web 控制台的局部 UPDATE（不带印记列）必须生效', () => {
    resetRow();
    assert.equal(updateRows(`UPDATE tab_groups SET name='Web 改名', updated_at=now() WHERE id='${GID}';`), 1);
    assert.equal(updateRows(`UPDATE tab_groups SET is_deleted=true, updated_at=now() WHERE id='${GID}';`), 1);
    assert.equal(updateRows(`UPDATE tab_groups SET is_deleted=false, updated_at=now() WHERE id='${GID}';`), 1);
    assert.equal(currentRow().is_deleted, false);
  });
});
