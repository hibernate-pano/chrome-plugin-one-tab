/**
 * 变异自证：「CI 必须先构建再跑单测」这条守卫必须看得见破口。
 *
 * 沙箱的做法见 `tests/fixtures/ciWorkflowSandbox.ts`。
 *
 * ── 这几条分别证明什么 ────────────────────────────────────────────────────
 *
 *   M1 把构建步骤挪到单测**后面**（还原 2026-10-23 之前的顺序）
 *      ⇒ 「构建必须排在单测之前」那条真的会红
 *   M2 构建步骤挂上 `continue-on-error` ⇒ 「构建步骤是阻塞步骤」那条真的会红
 *   M3 把跳过时的 `console.error` 删掉（还原成静默 skip）
 *      ⇒ 「跳过时必须显眼地喊一声」那条真的会红
 *   M4 **等价改写**（构建步骤换个名字 / 换个等价的写法）
 *      ⇒ 守卫**仍然绿**（判据钉的是「顺序」与「阻塞性」，不是步骤的名字）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertWorkflowMutationOutcome,
  runWorkflowMutationCases,
} from '../fixtures/ciWorkflowSandbox.ts';

const GUARD = 'tests/guards/ciBuildBeforeTest.test.ts';

describe('变异自证：CI 必须先构建再跑单测', () => {
  it('变异一：把构建步骤挪到单测之后 ⇒ 守卫必须变红', () => {
    const [outcome] = runWorkflowMutationCases([
      {
        name: '构建又排在单测后面了',
        testFile: GUARD,
        targets: [
          {
            path: '.github/workflows/verify.yml',
            mutate: source => {
              const buildStep = `      - name: 构建（产物级首屏断言的前置：dist 必须先存在）\n        run: pnpm build\n\n`;
              if (!source.includes(buildStep)) {
                throw new Error('没找到构建步骤 —— 工作流被改过了？');
              }
              // 先删掉构建步骤，再插到「单测」步骤之后。
              const withoutBuild = source.replace(buildStep, '');
              const testStep = `      - name: 单测（含真实 Postgres 触发器集成测试）\n        run: pnpm test\n`;
              if (!withoutBuild.includes(testStep)) {
                throw new Error('没找到单测步骤 —— 工作流被改过了？');
              }
              return withoutBuild.replace(
                testStep,
                `${testStep}\n${buildStep.replace(/\n$/, '')}\n`
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: '构建步骤必须排在单测之前',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertWorkflowMutationOutcome(outcome, true, '把构建步骤挪到单测之后');
  });

  it('变异二：构建步骤挂上 continue-on-error ⇒ 守卫必须变红', () => {
    const [outcome] = runWorkflowMutationCases([
      {
        name: '构建变成非阻塞步骤',
        testFile: GUARD,
        targets: [
          {
            path: '.github/workflows/verify.yml',
            mutate: source =>
              source.replace(
                '      - name: 构建（产物级首屏断言的前置：dist 必须先存在）\n        run: pnpm build\n',
                '      - name: 构建（产物级首屏断言的前置：dist 必须先存在）\n' +
                  '        continue-on-error: true # 非阻塞\n' +
                  '        run: pnpm build\n'
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '构建步骤挂了 continue-on-error',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertWorkflowMutationOutcome(outcome, true, '把构建步骤挂上 continue-on-error');
  });

  it('变异三：跳过产物级断言时不喊一声（还原成静默 skip）⇒ 守卫必须变红', () => {
    const [outcome] = runWorkflowMutationCases([
      {
        name: '产物级断言又变成静默跳过',
        testFile: GUARD,
        targets: [
          {
            path: 'tests/guards/firstScreenBudget.test.ts',
            mutate: source =>
              source
                .replace('      console.error(msg);\n', '')
                .replace('      t.diagnostic(msg);\n', ''),
          },
        ],
        expectRed: true,
        expectedFailure: '跳过产物级断言时必须往 stderr',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertWorkflowMutationOutcome(outcome, true, '把跳过时的告警删掉（还原成静默 skip）');
  });

  it('变异四：等价改写（构建步骤换个名字）⇒ 守卫必须仍然绿', () => {
    const [outcome] = runWorkflowMutationCases([
      {
        name: '构建步骤只是改了名字',
        testFile: GUARD,
        targets: [
          {
            path: '.github/workflows/verify.yml',
            mutate: source =>
              source.replace(
                '      - name: 构建（产物级首屏断言的前置：dist 必须先存在）\n',
                '      - name: 产物（dist 必须先存在）\n'
              ),
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertWorkflowMutationOutcome(outcome, false, '把构建步骤换个名字（判据钉的是顺序，不是名字）');
  });
});
