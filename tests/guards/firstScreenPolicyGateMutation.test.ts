/**
 * 变异自证：「首屏准入闸门必须看得见破口」（2026-10-23 第 50 轮）。
 *
 * 沙箱的做法见 `tests/_helpers/mutationSandbox.ts`。
 *
 * ⚠️ **为什么这个文件与守卫分开**：沙箱会把整个 `tests/` 目录拷一份再跑守卫
 *   —— 如果守卫自己调用 `runMutationCases`，沙箱里的那份会再开一个沙箱 ⇒
 *   无限递归（实测：整个测试进程挂住，300 秒不出结果）。
 *   仓库既有约定也是分开的：`xxxMutation.test.ts` 跑 `xxx.test.ts`。
 *
 * ── 这几条分别证明什么 ────────────────────────────────────────────────────
 *
 *   M1 闸门改回「找不到 popup 入口就静默放过」⇒ 「空 bundle 必须抛错」那条真的会红
 *   M2 第三方包白名单判定被摘掉（黑名单回魂）⇒ 「白名单外的包必须被拦」那条真的会红
 *   M3 **等价改写**（判空与查白名单各换一种写法）⇒ 守卫**仍然绿**
 *      （证明守卫钉的是「行为」不是「长相」：换一种正确写法不该被误报）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/firstScreenPolicyGate.test.ts';

describe('变异自证：首屏准入闸门必须看得见破口', () => {
  it('变异一：闸门改回「找不到入口就静默放过」⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '闸门又变回空转摆设',
        testFile: GUARD,
        targets: [
          {
            path: 'src/core/firstScreenPolicy.ts',
            mutate: source =>
              source.replace(
                '      if (!entry) throw new Error(FIRST_SCREEN_ENTRY_MISSING_MESSAGE);',
                '      if (!entry) return;'
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '空 bundle ⇒ 首屏准入闸门必须抛错',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把闸门改回「找不到 popup 入口就静默放过」');
  });

  it('变异二：白名单判定被摘掉（第三方包一律放行）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '第三方包白名单不再拦人',
        testFile: GUARD,
        targets: [
          {
            path: 'src/core/firstScreenPolicy.ts',
            mutate: source =>
              source.replace(
                '  if (isAllowedFirstScreenPackage(pkg)) return null;\n' +
                  '  return { id, package: pkg, reason: packageNotAllowedReason(pkg) };',
                '  return null;'
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '白名单外的第三方包进了首屏',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把第三方包的白名单判定摘掉');
  });

  it('变异三：入口改成「按块名认」（不看板块到底是不是弹窗页）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '闸门开始按块名认入口',
        testFile: GUARD,
        targets: [
          {
            path: 'src/core/firstScreenPolicy.ts',
            mutate: source =>
              source.replace(
                '  const byFacade = chunks.find(isPopupFacade);',
                "  const byFacade = chunks.find(c => c.name === 'src/popup/index');"
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '闸门认错了入口块',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把入口识别从「看板块的 facade」改回「按块名认」');
  });

  it('变异四：等价改写（换个写法判空 / 换个写法查白名单）⇒ 守卫必须仍然绿', () => {
    const [outcome] = runMutationCases([
      {
        name: '闸门改写成等价写法',
        testFile: GUARD,
        targets: [
          {
            path: 'src/core/firstScreenPolicy.ts',
            mutate: source =>
              source
                .replace(
                  '      if (!entry) throw new Error(FIRST_SCREEN_ENTRY_MISSING_MESSAGE);',
                  '      if (entry === null || entry === undefined) {\n' +
                    '        throw new Error(FIRST_SCREEN_ENTRY_MISSING_MESSAGE);\n' +
                    '      }'
                )
                .replace(
                  '  if (isAllowedFirstScreenPackage(pkg)) return null;',
                  '  if (FIRST_SCREEN_ALLOWED_PACKAGES.some(p => p.package === pkg)) return null;'
                ),
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把闸门改写成等价写法（判空与查白名单各换一种写法）');
  });
});
