/**
 * PERF-01 守卫的**变异自证**（2026-10-24 审计）。
 *
 * ── 为什么必须有这个文件 ──────────────────────────────────────────────────
 *
 * 一条从来没红过的守卫，可能一直是绿的而什么也没守住。本仓的硬要求：
 * **每条新守卫都要证明它有检测力** ——
 *   · 把实现改回旧行为 ⇒ 守卫必须变红；
 *   · 把实现换成一个**等价的正确写法** ⇒ 守卫必须**仍然绿**（否则这条守卫
 *     钉的是长相而不是行为，等于逼着实现不敢改）。
 *
 * 沙箱里跑的是**守卫自己**（tests/webdavAdapter.test.ts 里的 PERF-01 那一节），
 * 不是第二份探针 —— 两份实现会漂移，漂移了就变成「探针坏了」而不是
 * 「守卫抓到了」。
 *
 * ── 每条变异对应守卫里的哪条断言 ─────────────────────────────────────────
 *
 *   M1 目录缓存失效（每个会话都重发整条目录链）⇒ MKCOL 次数超限那条变红
 *   M2 不建库根（少了链上的一级）              ⇒ 严格服务器 409，守卫变红
 *   M3 等价改写（Set 换成 Map）                 ⇒ 仍然全绿
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runMutationCases,
  assertMutationOutcome,
  type MutationCase,
} from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/webdavAdapter.test.ts';
const ADAPTER = 'src/sync-backend/webdav/adapter.ts';

/** ensureDir 的原文。 */
const ENSURE_DIR = `  private async ensureDir(fullPath: string): Promise<void> {
    const segments = fullPath.split('/').filter(Boolean);
    let acc = '';
    for (const seg of segments) {
      acc = acc ? \`\${acc}/\${seg}\` : seg;
      if (this.knownDirs.has(acc)) continue;
      // 405（已存在）被 client.mkcol 当成成功 ⇒ 这里可以放心记进缓存。
      await this.client.mkcol(acc);
      this.knownDirs.add(acc);
    }
  }`;

const cases: MutationCase[] = [
  {
    name: 'M1 目录缓存失效（每个会话都重发整条目录链）',
    testFile: GUARD,
    expectRed: true,
    expectedFailure: '超过上限',
    targets: [
      {
        path: ADAPTER,
        mutate: (source) => {
          const next = source.replace(
            ENSURE_DIR,
            `  private async ensureDir(fullPath: string): Promise<void> {
    const segments = fullPath.split('/').filter(Boolean);
    let acc = '';
    for (const seg of segments) {
      acc = acc ? \`\${acc}/\${seg}\` : seg;
      // 405（已存在）被 client.mkcol 当成成功 ⇒ 这里可以放心记进缓存。
      await this.client.mkcol(acc);
      this.knownDirs.add(acc);
    }
  }`
          );
          assert.notEqual(next, source, 'M1 变异没有生效');
          return next;
        },
      },
    ],
  },
  {
    name: 'M2 不建库根（目录链少了一级）',
    testFile: GUARD,
    expectRed: true,
    expectedFailure: '父目录不存在',
    targets: [
      {
        path: ADAPTER,
        mutate: (source) => {
          const next = source.replace(
            `      acc = acc ? \`\${acc}/\${seg}\` : seg;
      if (this.knownDirs.has(acc)) continue;`,
            `      acc = acc ? \`\${acc}/\${seg}\` : seg;
      if (acc === this.root) continue;
      if (this.knownDirs.has(acc)) continue;`
          );
          assert.notEqual(next, source, 'M2 变异没有生效');
          return next;
        },
      },
    ],
  },
  {
    name: 'M3 等价改写（目录缓存从 Set 换成 Map）',
    testFile: GUARD,
    expectRed: false,
    targets: [
      {
        path: ADAPTER,
        mutate: (source) => {
          const next = source
            .replace(
              '  private readonly knownDirs = new Set<string>();',
              '  private readonly knownDirs = new Map<string, true>();'
            )
            .replace(
              '      if (this.knownDirs.has(acc)) continue;',
              '      if (this.knownDirs.get(acc) === true) continue;'
            )
            .replace(
              '      this.knownDirs.add(acc);',
              '      this.knownDirs.set(acc, true);'
            );
          assert.notEqual(next, source, 'M3 变异没有生效');
          return next;
        },
      },
    ],
  },
];

describe('PERF-01 守卫的变异自证', () => {
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
