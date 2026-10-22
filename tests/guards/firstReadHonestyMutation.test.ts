/**
 * 变异自证：SC-1 的守卫（首次读取没走完之前不许说「你没有会话」）必须看得见破口。
 *
 * 三个方向：
 *   ① 界面不再看「读完了」这个标志（**旧行为**）⇒ 守卫必须变红；
 *   ② slice 不再置位那个标志 ⇒ 守卫必须变红（接线层）；
 *   ③ **等价的正确写法** ⇒ 守卫必须**仍然绿**（证明它判的是行为，不是写法）。
 *
 * 沙箱的做法见 `tests/_helpers/mutationSandbox.ts`。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/firstReadHonesty.test.ts';

describe('变异自证：SC-1 的守卫必须看得见破口', () => {
  it('变异一：界面不再看「首次读取已完成」（旧行为）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '界面不再等首次读取',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/tabs/TabList.tsx',
            mutate: source => {
              const old = 'const firstReadPending = hasCompletedInitialLoad === false;';
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到首次读取判定');
              return source.replace(old, 'const firstReadPending = false;');
            },
          },
        ],
        expectRed: true,
        expectedFailure: '不许出现空态出口',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让界面不再等首次读取（回到旧行为）');
  });

  it('变异二：slice 不再置位「读完了」⇒ 守卫必须变红（接线层）', () => {
    const [outcome] = runMutationCases([
      {
        name: 'loadGroups.fulfilled 不置位',
        testFile: GUARD,
        targets: [
          {
            path: 'src/store/slices/tabSlice.ts',
            mutate: source => {
              const fulfilledAt = source.indexOf('.addCase(loadGroups.fulfilled');
              if (fulfilledAt < 0) throw new Error('变异前提没成立：找不到 loadGroups.fulfilled');
              const flag = 'state.hasCompletedInitialLoad = true;';
              const flagAt = source.indexOf(flag, fulfilledAt);
              if (flagAt < 0) throw new Error('变异前提没成立：找不到置位语句');
              return (
                source.slice(0, flagAt) +
                '// 变异：不再置位' +
                source.slice(flagAt + flag.length)
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: '就必须置位',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让 loadGroups 成功后不再置位「读完了」');
  });

  it('变异三：等价改写（=== false 换成 !）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '首次读取判定换成取反写法',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/tabs/TabList.tsx',
            mutate: source => {
              const old = 'const firstReadPending = hasCompletedInitialLoad === false;';
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到首次读取判定');
              return source.replace(
                old,
                'const firstReadPending = !hasCompletedInitialLoad;'
              );
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把首次读取判定换成等价的取反写法');
  });

  it('变异四：首次读取被挪到迁移之后（等 SW 往返）⇒ 守卫必须变红（启动层）', () => {
    const [outcome] = runMutationCases([
      {
        name: '读被挪到迁移之后',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/tabs/firstReadBootstrap.ts',
            mutate: source => {
              const old = `  // 读先走：首屏不许依赖一次 SW 往返。
  deps.read();
  try {
    void deps.runMigrations().catch((reason: unknown) => {
      deps.onMigrationsUnconfirmed(reason);
    });`;
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到启动序列');
              return source.replace(
                old,
                `  try {
    void deps.runMigrations().catch((reason: unknown) => {
      deps.onMigrationsUnconfirmed(reason);
    }).then(() => {
      deps.read();
    });`
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: '首次读取不许等那一次 SW 往返',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把首次读取挪到 SW 往返之后（回到旧顺序）');
  });

  it('变异五：等价改写（启动序列换成 async IIFE）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '启动序列换成等价的 async IIFE 写法',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/tabs/firstReadBootstrap.ts',
            mutate: source => {
              const old = `  // 读先走：首屏不许依赖一次 SW 往返。
  deps.read();
  try {
    void deps.runMigrations().catch((reason: unknown) => {
      deps.onMigrationsUnconfirmed(reason);
    });
  } catch (reason) {
    // 同步抛出（理论上不会）也归到「结果未知」，不许把启动流程带崩。
    deps.onMigrationsUnconfirmed(reason);
  }`;
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到启动序列');
              return source.replace(
                old,
                `  // 变异：等价的写法（读仍然先走，迁移仍然不影响读取）
  deps.read();
  void (async () => {
    try {
      await deps.runMigrations();
    } catch (reason) {
      deps.onMigrationsUnconfirmed(reason);
    }
  })();`
              );
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把启动序列换成等价的 async IIFE 写法');
  });
});
