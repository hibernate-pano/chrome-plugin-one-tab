/**
 * RLS-DRIFT 守卫的**变异自证**（2026-10-24 审计）。
 *
 * ── 每条变异对应守卫里的哪条断言 ─────────────────────────────────────────
 *
 *   M1 Q0 不再看 relrowsecurity（退回修复前）  ⇒ 「关着的那张表要判 DRIFT」变红
 *      （修复前整份核对都不查这个开关 ⇒「RLS 关、策略全在」与「RLS 开」同形）
 *   M2 Q1 不再认现行 version 守卫              ⇒ 「认出现行 version 守卫」变红
 *      （修复前现行版落到 UNKNOWN，回退成旧版时输出逐字节相同）
 *   M3 等价改写（Q1 的 CASE 分支换个顺序）     ⇒ 仍然全绿
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runMutationCases,
  assertMutationOutcome,
  type MutationCase,
} from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/rlsDriftCheckQuery.pg.test.ts';
const SQL = 'supabase/manual/migration_drift_check.sql';

const RLS_BRANCH = `         WHEN NOT c.relrowsecurity THEN 'DRIFT: RLS 未启用（策略全是死策略）'`;

const VERSION_BRANCH = `         WHEN p.proname = 'guard_tab_group_version'
              AND pg_get_functiondef(p.oid) LIKE '%last_op_seq IS NULL%'
              AND pg_get_functiondef(p.oid) LIKE '%NEW.version < OLD.version%'
           THEN 'VERSION-FALLBACK (20261020)  <- want this'`;

const cases: MutationCase[] = [
  {
    name: 'M1 Q0 不再看 relrowsecurity（退回修复前）',
    testFile: GUARD,
    expectRed: true,
    expectedFailure: 'RLS 关着 + 4 条策略 ⇒ 必须判 DRIFT',
    targets: [
      {
        path: SQL,
        mutate: source => {
          const next = source.replace(RLS_BRANCH, '');
          assert.notEqual(next, source, 'M1 变异没有生效');
          return next;
        },
      },
    ],
  },
  {
    name: 'M2 Q1 不再认现行 version 守卫',
    testFile: GUARD,
    expectRed: true,
    expectedFailure: '现行 version 守卫必须被认出来',
    targets: [
      {
        path: SQL,
        mutate: source => {
          const next = source.replace(VERSION_BRANCH, '');
          assert.notEqual(next, source, 'M2 变异没有生效');
          return next;
        },
      },
    ],
  },
  {
    name: 'M3 等价改写（Q1 的 CASE 分支换个顺序）',
    testFile: GUARD,
    expectRed: false,
    targets: [
      {
        path: SQL,
        mutate: source => {
          // 把两条 op-stamp 分支互换位置（判定结果不变）。
          const a = `         WHEN pg_get_functiondef(p.oid) LIKE '%NEW.last_op_seq <= OLD.last_op_seq%' THEN 'LEGACY <= (20260909 BUG)'
         WHEN pg_get_functiondef(p.oid) LIKE '%NEW.last_op_seq < OLD.last_op_seq%' THEN 'SEQ-ONLY (20260910)'`;
          const b = `         WHEN pg_get_functiondef(p.oid) LIKE '%NEW.last_op_seq < OLD.last_op_seq%' THEN 'SEQ-ONLY (20260910)'
         WHEN pg_get_functiondef(p.oid) LIKE '%NEW.last_op_seq <= OLD.last_op_seq%' THEN 'LEGACY <= (20260909 BUG)'`;
          const next = source.replace(a, b);
          assert.notEqual(next, source, 'M3 变异没有生效');
          return next;
        },
      },
    ],
  },
];

describe('RLS-DRIFT 守卫的变异自证', () => {
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
