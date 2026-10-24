/**
 * PERF-02 守卫的**变异自证**（2026-10-24 审计）。
 *
 * ── 每条变异对应守卫里的哪条断言 ─────────────────────────────────────────
 *
 *   M1 react-redux 改回与 @reduxjs/toolkit 同块 ⇒ ① 变红
 *      （这就是 2026-10-24 之前的分块规则 ⇒ SW 的静态闭包被拖进整包 React）
 *   M2 等价改写（判定顺序换一下）              ⇒ 仍然全绿
 *
 * ⚠️ 产物层（③）在沙箱里会跳过：变异沙箱只拷 src/tests/docs，
 *    **不拷 dist/** ⇒ 那一层需要真的构建过才有意义（CI 先 build 再 test，
 *    见 tests/guards/ciBuildBeforeTest.test.ts）。
 *    ⇒ 沙箱里能自证的是 ① 与 ②，这两层正是「块级依赖」那条边的**成因**。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runMutationCases,
  assertMutationOutcome,
  type MutationCase,
} from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/serviceWorkerNoReact.test.ts';
const POLICY = 'src/core/chunkingPolicy.ts';

const cases: MutationCase[] = [
  {
    name: 'M1 react-redux 改回与 @reduxjs/toolkit 同块',
    testFile: GUARD,
    expectRed: true,
    expectedFailure: 'react-redux 与 @reduxjs/toolkit 同块',
    targets: [
      {
        path: POLICY,
        mutate: (source) => {
          const next = source
            .replace(
              `  if (nm.includes('node_modules/react-redux')) {
    return 'react-redux-vendor';
  }
  if (nm.includes('node_modules/@reduxjs/toolkit')) {
    return 'redux-vendor';
  }`,
              `  if (
    nm.includes('node_modules/react-redux') ||
    nm.includes('node_modules/@reduxjs/toolkit')
  ) {
    return 'redux-vendor';
  }`
            )
            .replace(
              `      vendorChunkFor('/repo/node_modules/@reduxjs/toolkit/dist/index.mjs') ===
    vendorChunkFor('/repo/node_modules/react-redux/dist/react-redux.mjs')`,
              `      vendorChunkFor('/repo/node_modules/@reduxjs/toolkit/dist/index.mjs') ===
    vendorChunkFor('/repo/node_modules/react-redux/dist/react-redux.mjs')`
            );
          assert.notEqual(next, source, 'M1 变异没有生效');
          return next;
        },
      },
    ],
  },
  {
    name: 'M2 等价改写（判定顺序换一下）',
    testFile: GUARD,
    expectRed: false,
    targets: [
      {
        path: POLICY,
        mutate: (source) => {
          const next = source.replace(
            `  if (nm.includes('node_modules/react-redux')) {
    return 'react-redux-vendor';
  }
  if (nm.includes('node_modules/@reduxjs/toolkit')) {
    return 'redux-vendor';
  }`,
            `  if (nm.includes('node_modules/@reduxjs/toolkit')) {
    return 'redux-vendor';
  }
  if (nm.includes('node_modules/react-redux')) {
    return 'react-redux-vendor';
  }`
          );
          assert.notEqual(next, source, 'M2 变异没有生效');
          return next;
        },
      },
    ],
  },
];

describe('PERF-02 守卫的变异自证', () => {
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
