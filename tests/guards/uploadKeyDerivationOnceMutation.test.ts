/**
 * PERF-05 守卫的**变异自证**（2026-10-24 审计）。
 *
 * ── 每条变异对应守卫里的哪条断言 ─────────────────────────────────────────
 *
 *   M1 自检改回 `decryptData`（从头再派生一次）  ⇒ 「每多一个会话只多一次派生」变红
 *      （这就是 2026-10-24 之前的实现：每组 2 次 PBKDF2-100k）
 *   M2 等价改写（先拿对象再取字段）                ⇒ 仍然全绿
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runMutationCases,
  assertMutationOutcome,
  type MutationCase,
} from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/uploadKeyDerivationOnce.test.ts';
const UPLOAD = 'src/utils/supabase/upload.ts';

const DESTRUCTURE = `              const { payload: encryptedData, decryptForSelfCheck } =
                await encryptCompressedDataWithSelfCheck(group.tabs_data, userId);`;

const cases: MutationCase[] = [
  {
    name: 'M1 自检改回 decryptData（从头再派生一次）',
    testFile: GUARD,
    expectRed: true,
    expectedFailure: '每多一个会话只多一次 PBKDF2 派生',
    targets: [
      {
        path: UPLOAD,
        mutate: source => {
          // 恢复修复前的形状：加密只要字符串，自检走 decryptData。
          let next = source.replace(
            `import { encryptCompressedDataWithSelfCheck } from '../encryptionUtils';`,
            `import { decryptData, encryptCompressedData } from '../encryptionUtils';`
          );
          next = next.replace(
            DESTRUCTURE,
            `              const encryptedData = await encryptCompressedData(group.tabs_data, userId);`
          );
          next = next.replace(
            'const roundTrip = await decryptForSelfCheck();',
            'const roundTrip = await decryptData<unknown>(encryptedData, userId);'
          );
          assert.notEqual(next, source, 'M1 变异没有生效');
          return next;
        },
      },
    ],
  },
  {
    name: 'M2 等价改写（先拿对象再取字段）',
    testFile: GUARD,
    expectRed: false,
    targets: [
      {
        path: UPLOAD,
        mutate: source => {
          let next = source.replace(
            DESTRUCTURE,
            `              const selfCheckable = await encryptCompressedDataWithSelfCheck(group.tabs_data, userId);
              const encryptedData = selfCheckable.payload;`
          );
          next = next.replace(
            'const roundTrip = await decryptForSelfCheck();',
            'const roundTrip = await selfCheckable.decryptForSelfCheck();'
          );
          assert.notEqual(next, source, 'M2 变异没有生效');
          return next;
        },
      },
    ],
  },
];

describe('PERF-05 守卫的变异自证', () => {
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
