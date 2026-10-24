/**
 * PERF-04 守卫的**变异自证**（2026-10-24 审计）。
 *
 * ── 每条变异对应守卫里的哪条断言 ─────────────────────────────────────────
 *
 *   M1 去掉 single-flight（改回修复前的写法）  ⇒ 「迁移只跑 1 次」变红
 *      （这就是 2026-10-24 之前的实现：8 个并发调用各跑一遍整表迁移）
 *   M2 失败后不清空 initPromise                ⇒ 「失败后重试」变红
 *      （失败的 promise 被永久缓存 ⇒ 这个 realm 一次瞬时失败就永久坏掉）
 *   M3 等价改写（同一套语义换个表达式）        ⇒ 仍然全绿
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runMutationCases,
  assertMutationOutcome,
  type MutationCase,
} from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/storageInitSingleFlight.test.ts';
const ADAPTER = 'src/storage-kv/storageAdapter.ts';

/** 修复后的 single-flight 代码块（原样，供变异精确定位）。 */
const SINGLE_FLIGHT = `  initPromise ??= doInitialize();
  const pending = initPromise;
  try {
    await pending;
  } catch (error) {
    // 只清「本次那次」：若别的调用者已经发起了一次新的初始化，别把它清掉。
    if (initPromise === pending) initPromise = null;
    throw error;
  }`;

const cases: MutationCase[] = [
  {
    name: 'M1 去掉 single-flight（改回修复前的写法）',
    testFile: GUARD,
    expectRed: true,
    expectedFailure: '并发初始化必须只跑一次迁移',
    targets: [
      {
        path: ADAPTER,
        mutate: source => {
          const next = source.replace(SINGLE_FLIGHT, '  await doInitialize();');
          assert.notEqual(next, source, 'M1 变异没有生效');
          return next;
        },
      },
    ],
  },
  {
    name: 'M2 失败后不清空 initPromise',
    testFile: GUARD,
    expectRed: true,
    expectedFailure: '初始化失败后下一次调用会重试',
    targets: [
      {
        path: ADAPTER,
        mutate: source => {
          const next = source.replace(
            `  } catch (error) {
    // 只清「本次那次」：若别的调用者已经发起了一次新的初始化，别把它清掉。
    if (initPromise === pending) initPromise = null;
    throw error;
  }`,
            `  } catch (error) {
    throw error;
  }`
          );
          assert.notEqual(next, source, 'M2 变异没有生效');
          return next;
        },
      },
    ],
  },
  {
    name: 'M3 等价改写（同一套语义换个表达式）',
    testFile: GUARD,
    expectRed: false,
    targets: [
      {
        path: ADAPTER,
        mutate: source => {
          const next = source.replace(
            `  initPromise ??= doInitialize();
  const pending = initPromise;`,
            `  const pending = (initPromise ??= doInitialize());`
          );
          assert.notEqual(next, source, 'M3 变异没有生效');
          return next;
        },
      },
    ],
  },
];

describe('PERF-04 守卫的变异自证', () => {
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
