/**
 * F2 守卫的**变异自证**（2026-10-24 审计）。
 *
 * ── 每条变异对应守卫里的哪条断言 ─────────────────────────────────────────
 *
 *   M1 会话名不再归一化（退回修复前）  ⇒ 「会话名必须按 trim 后的值参与过滤」变红
 *   M2 域名不再归一化                  ⇒ 「域名必须按 trim 后的值参与过滤」变红
 *   M3 归一化换成等价写法              ⇒ 仍然全绿
 *      （证明守卫钉的是行为，不是 `return trimmed === '' ? … : …` 这种长相）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runMutationCases,
  assertMutationOutcome,
  type MutationCase,
} from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/filterTrimConsistency.test.ts';
const SOURCE = 'src/components/search/searchFilterAvailability.ts';

const GROUP_NAME_LINE = '  const groupName = normalizeFilterText(filters.groupName);';
const DOMAIN_LINE = '  const domain = normalizeFilterText(filters.domain);';

const NORMALIZE_BODY = `  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;`;

const NORMALIZE_BODY_EQUIVALENT = `  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed;`;

const cases: MutationCase[] = [
  {
    name: 'M1 会话名不再归一化（退回修复前）',
    testFile: GUARD,
    expectRed: true,
    expectedFailure: '会话名必须按 trim 后的值参与过滤',
    targets: [
      {
        path: SOURCE,
        mutate: source => {
          const next = source.replace(GROUP_NAME_LINE, '  const groupName = filters.groupName;');
          assert.notEqual(next, source, 'M1 变异没有生效');
          return next;
        },
      },
    ],
  },
  {
    name: 'M2 域名不再归一化',
    testFile: GUARD,
    expectRed: true,
    expectedFailure: '域名必须按 trim 后的值参与过滤',
    targets: [
      {
        path: SOURCE,
        mutate: source => {
          const next = source.replace(DOMAIN_LINE, '  const domain = filters.domain;');
          assert.notEqual(next, source, 'M2 变异没有生效');
          return next;
        },
      },
    ],
  },
  {
    name: 'M3 归一化换成等价写法',
    testFile: GUARD,
    expectRed: false,
    targets: [
      {
        path: SOURCE,
        mutate: source => {
          const next = source.replace(NORMALIZE_BODY, NORMALIZE_BODY_EQUIVALENT);
          assert.notEqual(next, source, 'M3 变异没有生效');
          return next;
        },
      },
    ],
  },
];

describe('F2 守卫的变异自证', () => {
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
