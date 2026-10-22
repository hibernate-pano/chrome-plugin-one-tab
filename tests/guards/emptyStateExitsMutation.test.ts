/**
 * 变异自证：R-12 的守卫（空态出口「点了会发生什么」）必须真的看得见破口。
 *
 * 变异的三个方向：
 *   ① 出口**静默**（点了没反应也没提示）—— 那正是 R-12 的缺陷本体；
 *   ② 出口集合**不看登录态**（已登录的用户看到「登录」按钮）—— 审计点名的形状；
 *   ③ 等价的正确改写（switch 换成查表）—— 守卫必须**仍然绿**，
 *      证明它判的是行为、不是写法。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/emptyStateExits.test.ts';

/** 等价改写：把 switch 换成查表（行为一模一样）。 */
const LOOKUP_TABLE_BODY = `  const effects: Record<EmptyStateAction, (deps: EmptyStateExitDeps) => boolean> = {
    login: deps => {
      if (!deps.openAuth) return false;
      deps.openAuth();
      return true;
    },
    download: deps => {
      deps.restoreFromCloud();
      return true;
    },
    options: deps => {
      deps.openOptions();
      return true;
    },
    import: deps => deps.requestImport(),
  };
  const performed = effects[action](deps);

`;

describe('变异自证：空态出口这条守卫必须看得见破口', () => {
  it('变异一：登录出口在宿主没接上时静默（旧行为）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '登录出口静默无反应',
        testFile: GUARD,
        targets: [
          {
            path: 'src/core/emptyStateExits.ts',
            // 旧行为：`onOpenAuth?.('login')` —— 宿主没接上就什么都不做。
            mutate: source =>
              source.replace(
                `      if (deps.openAuth) {
        deps.openAuth();
        performed = true;
      }`,
                `      deps.openAuth?.();
      performed = true;`
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '必须出声说明',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让登录出口在宿主没接上时静默无反应');
  });

  it('变异二：导入出口在没人订阅时静默 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '导入出口静默无反应',
        testFile: GUARD,
        targets: [
          {
            path: 'src/core/emptyStateExits.ts',
            mutate: source =>
              source.replace(
                '      performed = deps.requestImport();',
                '      deps.requestImport();\n      performed = true;'
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '导入出口：没有订阅者',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让导入出口在没人订阅时静默无反应');
  });

  it('变异三：出口集合不看登录态（已登录也给「登录」按钮）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '出口集合忽略登录态',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/tabs/emptyStateActions.ts',
            mutate: source =>
              source.replace(
                "  return input.isAuthenticated ? ['download', 'import'] : ['login', 'import'];",
                "  return ['login', 'import'];"
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '云端已登录：给「从云端恢复」',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让出口集合忽略登录态');
  });

  it('等价改写：把 switch 换成查表（行为一模一样）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: 'switch 换成查表',
        testFile: GUARD,
        targets: [
          {
            path: 'src/core/emptyStateExits.ts',
            mutate: source => {
              const start = source.indexOf('  let performed = false;');
              const end = source.indexOf("  if (performed) return { kind: 'handled' };");
              if (start < 0 || end < 0) throw new Error('变异前提没成立：找不到 switch 段');
              return source.slice(0, start) + LOOKUP_TABLE_BODY + source.slice(end);
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把出口对应的查表化（行为一模一样）');
  });

  it('变异四：冷启动不再把缓存登录态送进 store（旧行为）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '冷启动不 dispatch 缓存登录态',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/app/AuthProvider.tsx',
            // 旧行为：缓存登录态只被读、被打日志，不进 store。
            mutate: source =>
              source.replace(
                /^\s*dispatch\(setFromCache\(\{ user: cachedAuth\.user, isAuthenticated: true \}\)\);\n/m,
                ''
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '正常路径',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让冷启动不再把缓存里的登录态送进 store');
  });
});
