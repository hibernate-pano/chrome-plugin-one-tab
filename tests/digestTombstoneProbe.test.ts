// 缺陷 1（P1）回归：云端墓碑行把 hasRemoteChanges 永久打成 true，
// up_to_date 短路永不命中 → 每 60s 一次全量下载（PBKDF2-100k × N + 整表写回
// + notifyGroupsChanged 唤醒所有管理页整表重载）。
//
// ── 失效链条（修复前）───────────────────────────────────────────────────────
//   probe.ts fetchTabGroupsDigest 只 .eq('user_id', uid)，**不过滤 is_deleted**
//   （按设计：云端删除是「行保留 + is_deleted=true」的墓碑，30 天后才 purge）
//   → syncDecision.ts hasRemoteChanges 第一行 `digest.length !== localGroups.length`
//   → 设备 A 删一个会话，B 设备下轮把组合并掉（本地 N-1 行）
//   → 云端那一行仍是墓碑 ⇒ digest.length = N（含墓碑）vs local = N-1
//   ⇒ 恒 true。影响面 = 用过一次跨端删除的用户 × 30 天 × 每台设备。
//
// ── 为什么这个分支在旧测试里是死代码 ────────────────────────────────────────
// tests/syncReliabilityP0P1.test.ts 的 9 条 hasRemoteChanges 用例**全是单组 fixture**，
// 两侧行数天然相等，那条长度短路永远命中不了「不等」分支，也就没有任何一条用例
// 建模「digest 里多出一行墓碑」这个真实形状。本文件专门补它。
//
// ── 同一失效模式的新变体（历史对照，见 tests/syncAuditFixes.test.ts 文件头）──
// 2026-09-28 的 #2：purge 队列不置 pending_upload → 云端多出行 → 行数比对恒不等
// → 探活永久失效。那次只修了 purge 队列那一侧；本次是**同一根因的另一个来源**
// （墓碑是**设计内的常驻行**，不是 bug 产生的多余行），方向与 1.22.15 那次相反：
//   1.22.15 的 digest 截断 = digest 少取 → 漏判 false（该修的不修）
//   本次          = digest 取全但含墓碑 → 恒判 true（不该修的照修）
//
// 修法：hasRemoteChanges 在**判定层**把墓碑行分出去（改判据），不在查询层
// 加 .eq('is_deleted', false) —— 后者会让 digest 行数与 count(exact) 总行数
// 脱钩，而 count 是探活自证「没被网关静默截断」的唯一信号。两处口径必须一致：
// probe 与 download 的 count 校验都在**未过滤**的行集上取数（见本文件末尾的
// 结构层用例 + download.ts 的注释）。
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};
const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 剥注释后读源码，避免注释里出现的名字造成误判（仓库既有惯例） */
function code(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const NOW = '2026-10-10T08:00:00.000Z';

type HasRemoteChanges = typeof import('../src/core/syncDecision.ts').hasRemoteChanges;
let hasRemoteChanges: HasRemoteChanges;

before(async () => {
  register(LOADER_PATH, import.meta.url);
  ({ hasRemoteChanges } = await import('../src/core/syncDecision.ts'));
});

function tab(id: string) {
  return { id, url: `https://${id}.example.com/`, title: id, createdAt: NOW, lastAccessed: NOW, pinned: false };
}

/** 本地活跃组（合并落盘后的形状：有标签、有 stamp、isDeleted 为 false/undefined） */
function localGroup(id: string, seq: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `g-${id}`,
    tabs: [tab(`${id}-t1`)],
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    version: 1,
    lastOp: { d: 'devA', s: seq },
    ...overrides,
  };
}

/** 云端 digest 活跃行（列全的形态） */
function cloudRow(id: string, seq: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    updated_at: NOW,
    version: 1,
    is_deleted: false,
    last_op_device: 'devA',
    last_op_seq: seq,
    ...overrides,
  };
}

/** 云端墓碑行：用户已删、按设计在 digest 里常驻 30 天 */
function tombstoneRow(id: string, seq: number, deletedAt = '2026-10-09T00:00:00.000Z') {
  return {
    id,
    updated_at: deletedAt,
    version: 1,
    is_deleted: true,
    deleted_at: deletedAt,
    last_op_device: 'devB',
    last_op_seq: seq,
  };
}

describe('缺陷 1：hasRemoteChanges 遇到 digest 里的墓碑行不得恒判 true', () => {
  // 复现主控报告的形状：本地 5 活跃 + 云端 5 活跃 + 1 墓碑。
  it('本地 5 活跃 + digest 5 活跃 + 1 墓碑 → 期望 false（修复前返回 true）', () => {
    const local = [0, 1, 2, 3, 4].map(i => localGroup(`g${i}`, 10 + i));
    const digest = [
      ...[0, 1, 2, 3, 4].map(i => cloudRow(`g${i}`, 10 + i)),
      tombstoneRow('g-deleted', 99),
    ];
    // 前提断言：修复前那条长度短路就在这里被击中
    assert.equal(digest.length, 6);
    assert.equal(local.length, 5);
    assert.equal(hasRemoteChanges(local as never, digest as never), false,
      '墓碑是「已吸收的删除」而不是新变更：B 设备本地已经把它合并掉了，' +
      '下一轮不该再触发全量下载。若这里返回 true ⇒ 每 60s 全量下载，30 天不断。');
  });

  it('多个墓碑（跨端删过多次）同样不得恒判 true', () => {
    const local = [0, 1].map(i => localGroup(`g${i}`, 10 + i));
    const digest = [
      ...[0, 1].map(i => cloudRow(`g${i}`, 10 + i)),
      tombstoneRow('gone-1', 50),
      tombstoneRow('gone-2', 51),
      tombstoneRow('gone-3', 52),
    ];
    assert.equal(hasRemoteChanges(local as never, digest as never), false);
  });

  it('墓碑数恰好等于「本地缺失数」时仍判无变更（墓碑不是新增）', () => {
    // 形状最容易出错的边界：云端有墓碑、本地恰好少了同样的组。
    // 旧判据：digest.length(含墓碑) !== local.length ⇒ true（假变更）。
    const local = [localGroup('g0', 10), localGroup('g1', 11)];
    const digest = [
      cloudRow('g0', 10),
      cloudRow('g1', 11),
      tombstoneRow('g2', 12),
      tombstoneRow('g3', 13),
    ];
    assert.equal(hasRemoteChanges(local as never, digest as never), false,
      '2 活跃 + 2 墓碑 对 2 本地：两侧活跃集合相同 ⇒ 无变更');
  });

  it('墓碑行的新增/消失本身不构成变更（墓碑只承载已生效的删除）', () => {
    const local = [localGroup('g0', 10)];
    const withMore = [cloudRow('g0', 10), tombstoneRow('t1', 11), tombstoneRow('t2', 12)];
    const withFewer = [cloudRow('g0', 10)];
    assert.equal(hasRemoteChanges(local as never, withMore as never), false);
    assert.equal(hasRemoteChanges(local as never, withFewer as never), false,
      '墓碑行被 purge 掉（少了一行）也不该把用户从 up_to_date 打进全量下载');
  });

  it('未迁移 schema（最小列 digest 无 is_deleted）仍按原口径判：不误伤也不漏判', () => {
    // tombstoneSupported=false → probe 回退 'id, updated_at'，行里没有 is_deleted。
    // 这时云端只能硬删，digest 里不存在墓碑 ⇒ 每行都算活跃。
    // 注意：本地含 lastOp 印记而 digest 没有印记列 ⇒ seq 不等 ⇒ true。
    // 云端有印记、本地无印记 → 也算变更（旧测试已钉，迁移不漏判）。
    const localWithStamp = [localGroup('g0', 10)];
    const stampCatched = [{ id: 'g0', updated_at: NOW, version: 1, is_deleted: false, last_op_device: 'devA', last_op_seq: 10 }];
    assert.equal(hasRemoteChanges(localWithStamp as never, stampCatched as never), false,
      '印记齐全且一致 ⇒ 短路命中');
    const minimalLocal = [{ ...localGroup('g0', 10), lastOp: undefined }];
    assert.equal(hasRemoteChanges(minimalLocal as never, [{ id: 'g0', updated_at: NOW, version: 1 }] as never), false,
      '最小列 digest + 无印记本地 ⇒ 短路命中（旧用例口径）');
    // 行数不等（硬删已发生）仍必须判 true —— 漏判会让该修的全量下载永不发生
    assert.equal(hasRemoteChanges(localWithStamp as never, [] as never), true);
  });
});

describe('缺陷 1：墓碑口径不得削弱任何真实变更信号', () => {
  const local = [localGroup('g0', 10), localGroup('g1', 11)];
  const base = [cloudRow('g0', 10), cloudRow('g1', 11)];

  it('云端新增组（活跃）→ true', () => {
    assert.equal(hasRemoteChanges(local as never, [...base, cloudRow('g2', 12)] as never), true);
  });

  it('云端硬删组（活跃行消失、无墓碑）→ true', () => {
    assert.equal(hasRemoteChanges(local as never, [base[0]] as never), true);
  });

  it('云端把本地某个组改成墓碑 → true（第一轮吸收，必须走全量）', () => {
    // 这是「删除广播刚到达」的时刻：本地还有该组的活跃副本 ⇒ 必须全量合并。
    const digest = [cloudRow('g0', 10), { ...base[1], is_deleted: true, last_op_seq: 30, last_op_device: 'devB' }];
    assert.equal(hasRemoteChanges(local as never, digest as never), true,
      '本地仍有该组活跃副本时，云端墓碑是一次真实的删除广播，不得被墓碑口径吞掉');
  });

  it('活跃行的 seq / updated_at / version 变化 → 一律 true', () => {
    assert.equal(hasRemoteChanges(local as never, [cloudRow('g0', 11), base[1]] as never), true);
    assert.equal(hasRemoteChanges(local as never, [{ ...base[0], updated_at: '2026-10-10T09:00:00.000Z' }, base[1]] as never), true);
    assert.equal(hasRemoteChanges(local as never, [{ ...base[0], version: 2 }, base[1]] as never), true);
  });

  it('本地有、云端活跃行没有（墓碑把 id 移出活跃集合）→ true：删除必须真的被吸收', () => {
    // 反向用例：本地 g1 还在，云端 g1 成了墓碑。判据：g1 ∈ local 且 ∉ cloudActive
    // ⇒ 命中「本地独有 id」⇒ true（墓碑行不被比对，但本地副本必须在合并里被服从）。
    const digest = [cloudRow('g0', 10), tombstoneRow('g1', 40)];
    assert.equal(hasRemoteChanges(local as never, digest as never), true);
  });

  it('本地含 isDeleted 残留组（老版本形状）时仍不漏判', () => {
    const withLegacy = [...local, { ...localGroup('g2', 12), isDeleted: true }];
    assert.equal(hasRemoteChanges(withLegacy as never, base as never), true,
      '本地多了一行（长度不等）→ 仍要触发全量由合并层裁决，不在探活层做形状判断');
  });
});

describe('缺陷 1：端到端 —— 吸收一次跨端删除后，下一轮探活短路必须命中', () => {
  // 设备 B 的完整两轮时序：
  //   轮 1：云端 5 活跃 + 1 墓碑（其中 1 个活跃行本地还没有）→ 合并后本地 5 活跃
  //   轮 2：云端仍是 5 活跃 + 1 墓碑 → 探活必须判 false（up_to_date，不下载）
  // 修复前两轮都判 true ⇒ 每轮一次全量下载，且这会持续 30 天。
  it('第一轮吸收删除 → 第二轮短路命中（不再触发全量下载）', () => {
    const round1Local = [localGroup('g0', 10), localGroup('g1', 11), localGroup('g2', 12)];
    const digestRound1 = [
      cloudRow('g0', 10),
      cloudRow('g1', 11),
      cloudRow('g2', 12),
      cloudRow('g3', 13), // 云端新增：轮 1 必须真的下载
      tombstoneRow('g3-old', 99), // 另一台设备删掉的
    ];
    // 轮 1：必然有变更（全量下载）
    assert.equal(hasRemoteChanges(round1Local as never, digestRound1 as never), true);

    // 合并落盘后的本地形状：云端活跃行全部进来，墓碑行不进来（mergeOpStamped
    // 对「仅云端有的墓碑」直接 continue），且吸收前本地那个组被墓碑服从掉。
    const round2Local = [localGroup('g0', 10), localGroup('g1', 11), localGroup('g2', 12), localGroup('g3', 13)];
    const digestRound2 = [...digestRound1];
    assert.equal(hasRemoteChanges(round2Local as never, digestRound2 as never), false,
      '轮 2 必须命中 up_to_date。修复前此处返回 true ⇒ 每 60s 全量下载持续 30 天。');
  });

  it('墓碑行在 30 天后被 purge（digest 行数净减少）不打断短路', () => {
    const local = [localGroup('g0', 10), localGroup('g1', 11)];
    const beforePurge = [cloudRow('g0', 10), cloudRow('g1', 11), tombstoneRow('old', 5)];
    const afterPurge = [cloudRow('g0', 10), cloudRow('g1', 11)];
    assert.equal(hasRemoteChanges(local as never, beforePurge as never), false);
    assert.equal(hasRemoteChanges(local as never, afterPurge as never), false);
  });
});

describe('缺陷 1：count 口径 —— 探活与全量必须在同一口径上', () => {
  // 结构层：把「不要在查询层加 is_deleted 过滤」这条约束钉住。
  // 它的理由不是洁癖：count(exact) 是探活自证「没被网关静默截断」的唯一信号，
  // digest 的逐回行数必须与 count 的总行数同口径，否则分页完整性自证失效。
  it('fetchTabGroupsDigest 不得对 digest 查询加 is_deleted 过滤', () => {
    const src = code('src/utils/supabase/probe.ts');
    // queryAll 是主路径与 42703 回退共用的分页体：任何 .eq('is_deleted' ...)
    // 都会让 digest 行数与 count 的未过滤总行数脱钩。
    const start = src.indexOf('const queryAll');
    assert.ok(start !== -1, '应能找到 queryAll');
    const body = src.slice(start, src.indexOf('// 未迁移 schema', start));
    assert.doesNotMatch(
      body,
      /is_deleted['"]\s*,\s*(false|'false'|"false")/,
      'digest 查询禁止过滤墓碑：过滤后 count(exact) 与逐回行数不同口径，' +
        '分页截断检测（唯一自证信号）随之失效。墓碑要在判定层分出去（hasRemoteChanges）。'
    );
  });

  it('download.ts 的 count 校验同样不加 is_deleted 过滤（两处口径一致）', () => {
    const src = code('src/utils/supabase/download.ts');
    const start = src.indexOf('const selectColumns');
    assert.ok(start !== -1, '应能找到 selectColumns');
    const body = src.slice(start, src.indexOf('// 下载用户设置', start));
    assert.doesNotMatch(
      body,
      /is_deleted['"]\s*,\s*(false|'false'|"false")/,
      'download 的 count 交叉校验必须与 probe 同口径（未过滤行集），否则两处校验互相打架'
    );
  });

  it('hasRemoteChanges 里墓碑被显式分出（判定层分口径）', () => {
    const src = code('src/core/syncDecision.ts');
    assert.match(
      src,
      /is_deleted === true/,
      'hasRemoteChanges 必须显式把墓碑行排除在活跃集合之外（否则行数判据恒不等）'
    );
  });
});