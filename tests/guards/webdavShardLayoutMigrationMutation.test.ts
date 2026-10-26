/**
 * 「分片目录 1 位前缀 + 老库零改造可用」这组守卫的**变异自证**（2026-10-26）。
 *
 * ── 为什么必须有这个文件 ──────────────────────────────────────────────────
 *
 * 一条从来没红过的守卫，可能一直是绿的而什么也没守住。本仓的硬要求：
 * **每条新守卫都要证明它有检测力** ——
 *   · 把实现改回旧行为 ⇒ 守卫必须变红；
 *   · 把实现换成一个**等价的正确写法** ⇒ 守卫必须**仍然绿**（否则这条守卫
 *     钉的是长相而不是行为，等于逼着实现不敢改）。
 *
 * 沙箱里跑的是**守卫自己**（tests/guards/webdavShardLayoutMigration.test.ts），
 * 不是第二份探针 —— 两份实现会漂移，漂移了就变成「探针坏了」而不是
 * 「守卫抓到了」。
 *
 * ── 每条变异对应守卫里的哪条断言 ─────────────────────────────────────────
 *
 *   M1 前缀位数改回 2 位        ⇒ 「扫描只列 1 位前缀目录」变红
 *   M2 巡检间隔改回 5 分钟      ⇒ 「老库 30 分钟窗口内 ≤ 600 次」变红
 *   M3 读端不认旧路径          ⇒ 「老库的分片仍能下载」变红（老库变隐形数据）
 *   M4 写路径不跟随内容位置    ⇒ 「不能往新路径 PUT」变红（条件写必然 412）
 *   M4b 墓碑另写一份           ⇒ 「墓碑覆盖原来那一份」变红
 *   M5 裁决不看印记            ⇒ 「旧布局那份的印记更大 ⇒ 旧布局赢」变红
 *   M6 等价改写（内联 shardDir）⇒ 仍然全绿
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runMutationCases,
  assertMutationOutcome,
  type MutationCase,
} from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/webdavShardLayoutMigration.test.ts';
const ADAPTER = 'src/sync-backend/webdav/adapter.ts';
const LAYOUT = 'src/sync-backend/webdav/layout.ts';

const cases: MutationCase[] = [
  {
    name: 'M1 前缀位数改回 2 位（限额事故的形状）',
    testFile: GUARD,
    expectRed: true,
    expectedFailure: '扫描必须只列 1 位前缀目录',
    targets: [
      {
        path: LAYOUT,
        mutate: (source) => {
          const next = source.replace(
            `export function shardDir(id: string): string {
  assertSafeId(id);
  return \`\${GROUPS_DIR}/\${id.slice(0, 1)}\`;
}`,
            `export function shardDir(id: string): string {
  assertSafeId(id);
  return \`\${GROUPS_DIR}/\${id.slice(0, 2)}\`;
}`
          );
          assert.notEqual(next, source, 'M1 变异没有生效');
          return next;
        },
      },
    ],
  },
  {
    name: 'M2 巡检间隔改回 5 分钟（老库会撞坚果云的 600 次上限）',
    testFile: GUARD,
    expectRed: true,
    expectedFailure: '超过坚果云的',
    targets: [
      {
        path: ADAPTER,
        mutate: (source) => {
          const next = source.replace(
            'export const INDEX_VERIFY_INTERVAL_MS = 30 * 60_000;',
            'export const INDEX_VERIFY_INTERVAL_MS = 5 * 60_000;'
          );
          assert.notEqual(next, source, 'M2 变异没有生效');
          return next;
        },
      },
    ],
  },
  {
    name: 'M3 读端不认旧路径（老库变成隐形数据）',
    testFile: GUARD,
    expectRed: true,
    expectedFailure: '老布局里的会话必须能被下载',
    targets: [
      {
        path: ADAPTER,
        mutate: (source) => {
          const next = source.replace(
            `    for (const path of this.shardPathCandidates(id, loc)) {
      const got = await this.client.get(path);`,
            `    for (const path of [this.p(shardPath(id))]) {
      const got = await this.client.get(path);`
          );
          assert.notEqual(next, source, 'M3 变异没有生效');
          return next;
        },
      },
    ],
  },
  {
    name: 'M4 写路径不跟随内容所在的位置（老库上传先撞 412，重试里按印记「认输」）',
    testFile: GUARD,
    expectRed: true,
    expectedFailure: '不能往新路径 PUT',
    targets: [
      {
        path: ADAPTER,
        mutate: (source) => {
          const next = source.replace(
            `    let writePath = remote.exists && remote.path ? remote.path : this.p(shardPath(group.id));`,
            `    let writePath = this.p(shardPath(group.id));`
          );
          assert.notEqual(next, source, 'M4 变异没有生效');
          return next;
        },
      },
    ],
  },
  {
    name: 'M4b 墓碑另写一份（新路径）⇒ 两份并存 ⇒ 删除可能被判输',
    testFile: GUARD,
    expectRed: true,
    expectedFailure: '墓碑必须覆盖它原来所在的那一份',    targets: [
      {
        path: ADAPTER,
        mutate: (source) => {
          const next = source.replace(
            `      const writePath = remote.exists && remote.path ? remote.path : this.p(shardPath(id));`,
            `      const writePath = this.p(shardPath(id));`
          );
          assert.notEqual(next, source, 'M4b 变异没有生效');
          return next;
        },
      },
    ],
  },
  {
    name: 'M5 裁决不看印记（一律让新布局赢）',
    testFile: GUARD,
    expectRed: true,
    expectedFailure: '印记更大的那份说了算',
    targets: [
      {
        path: ADAPTER,
        mutate: (source) => {
          const next = source.replace(
            `    const cmp = compareStampsLoose(curHdr?.lastOp, legHdr?.lastOp);
    if (cmp >= 0) return { path: currentPath, loserPath: legacyPath };
    return { path: legacyPath, loc: 'legacy', loserPath: currentPath };`,
            `    void curHdr;
    void legHdr;
    return { path: currentPath, loserPath: legacyPath };`
          );
          assert.notEqual(next, source, 'M5 变异没有生效');
          return next;
        },
      },
    ],
  },
  {
    name: 'M6 等价改写（shardPath 内联 shardDir 的算法，行为不变）',
    testFile: GUARD,
    expectRed: false,
    targets: [
      {
        path: LAYOUT,
        mutate: (source) => {
          const next = source.replace(
            `export function shardPath(id: string): string {
  assertSafeId(id);
  return \`\${shardDir(id)}/\${id}.json\`;
}`,
            `export function shardPath(id: string): string {
  assertSafeId(id);
  return \`\${GROUPS_DIR}/\${id.slice(0, 1)}/\${id}.json\`;
}`
          );
          assert.notEqual(next, source, 'M6 变异没有生效');
          return next;
        },
      },
    ],
  },
];

describe('分片目录布局守卫的变异自证', () => {
  it('每条变异都落在预期的断言上（且等价改写不误报）', () => {
    const outcomes = runMutationCases(cases);
    assert.equal(outcomes.length, cases.length);
    outcomes.forEach((outcome, i) => {
      const testCase = cases[i];
      assertMutationOutcome(
        outcome,
        testCase.expectRed,
        `${testCase.name}（守卫：${testCase.testFile}）`
      );
    });
  });
});
