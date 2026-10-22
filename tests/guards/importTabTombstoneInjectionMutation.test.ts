/**
 * 变异自证：DS-43-3（**标签级**）那条线的守卫必须看得见破口。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * `tests/guards/importTabTombstoneInjection.test.ts` 钉的是「导入文件不得注入
 * 标签级墓碑」。听起来很扎实 —— 但一条从来没红过的守卫，可能一直是绿的
 * 而什么也没守住。唯一的验证办法是**把实现改坏，看守卫会不会红**；
 * 反过来，**把实现换成一个等价的正确写法，守卫必须仍然绿**
 * （否则这条守卫钉的是长相而不是行为，换个写法就误报，等于逼着实现不敢改）。
 *
 * ── 变异清单（每一条都必须是「真的会坏」）─────────────────────────────────
 *   ① 归一化层去掉标签级 `isDeleted: false`      ⇒ 守卫必须变红
 *   ② 落盘层去掉标签级 `isDeleted: false`        ⇒ 守卫必须变红
 *   ③ 归一化层把归零写反成 `isDeleted: true`     ⇒ 守卫必须变红
 *   ④ 落盘层把归零写反成 `isDeleted: true`       ⇒ 守卫必须变红
 *   ⑤ 落盘层不盖印记（`lastOp: stamp`）          ⇒ 守卫必须变红
 *   ⑥ 归一化层不归零墓碑时刻（`deletedAt`）        ⇒ 守卫必须变红
 *   ⑦ 等价改写（落盘层改成「先 push 再补字段」）   ⇒ 守卫必须**仍然绿**
 *   ⑧ 等价改写（归一化层把三个字段提成常量再展开） ⇒ 守卫必须**仍然绿**
 *
 * ── 为什么 ①② 要分开测 ──────────────────────────────────────────────────
 * 导入路径上**两道防线都在**（normalizeImportedGroup 与 applyImportGroups）。
 * 去掉任何一道，另一道照样把墓碑归零 ⇒ 端到端那两条断言**仍然绿**。
 * 这不是守卫的漏洞，是**两道防线各自独立成立**的正确表现 ——
 * 所以「每一道防线各自能不能独立成立」必须由这两条守卫分别钉住，
 * 而「端到端用户看到什么」由真机脚本负责。
 *
 * 沙箱的做法见 `tests/_helpers/mutationSandbox.ts`：变异只发生在沙箱副本里，
 * 共享工作树一个字节都不动。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/importTabTombstoneInjection.test.ts';
const NORMALIZE = 'src/core/normalizeTabsData.ts';
const MUTATION_OPS = 'src/core/mutationOps.ts';

/** 把源码里的一段文字换掉；找不到就抛（变异没生效 = 前提变了，必须让人知道）。 */
const replaceIn = (source: string, from: string, to: string): string => {
  if (!source.includes(from)) {
    throw new Error(`变异前提没成立：源码里找不到这段文字 ——\n${from}`);
  }
  const next = source.replace(from, to);
  if (next === source) throw new Error('变异没有生效（源码没变）');
  return next;
};

/** 归一化层那三行覆盖（isDeleted / deletedAt / lastOp）。 */
const NORMALIZE_OVERRIDES = `    isDeleted: false,
    deletedAt: undefined,
    lastOp: undefined,
  } as Tab;`;

/** 落盘层那三行覆盖（isDeleted / deletedAt / lastOp）。 */
const PERSIST_OVERRIDES = `            isDeleted: false,
            deletedAt: undefined,
            // 印记由**本机这次操作**盖（与组级 \`lastOp: stamp\` 同口径）：
            // 导入产生的行是本机新写的行，不能挂着文件里**别的设备**的印记
            // （那会让 maxObservedSeq 把本机 Lamport 时钟顶成一个外来数字，
            //   合并时本机永远赢 ⇒ 别的设备的较新编辑被覆盖丢失）。
            lastOp: stamp,
          });
          return acc;`;

describe('变异自证：DS-43-3（标签级）的守卫必须看得见破口', () => {
  it('① 归一化层去掉标签级归零 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '归一化层不归零标签级墓碑',
        testFile: GUARD,
        targets: [
          {
            path: NORMALIZE,
            mutate: source =>
              replaceIn(
                source,
                NORMALIZE_OVERRIDES,
                `    deletedAt: undefined,
    lastOp: undefined,
  } as Tab;`
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '归一化层：每个标签的 isDeleted 恒为 false（上游归一化这一道）',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让归一化层不再归零标签级墓碑');
  });

  it('② 落盘层去掉标签级归零 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '落盘层不归零标签级墓碑',
        testFile: GUARD,
        targets: [
          {
            path: MUTATION_OPS,
            mutate: source =>
              replaceIn(
                source,
                `            isDeleted: false,
            deletedAt: undefined,`,
                `            deletedAt: undefined,`
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '落盘层：每个标签的 isDeleted 恒为 false（applyImportGroups 这一道）',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让落盘层不再归零标签级墓碑');
  });

  it('③ 归一化层把归零写反成 true ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '归一化层归零写反',
        testFile: GUARD,
        targets: [
          {
            path: NORMALIZE,
            mutate: source =>
              replaceIn(
                source,
                NORMALIZE_OVERRIDES,
                `    isDeleted: true,
    deletedAt: undefined,
    lastOp: undefined,
  } as Tab;`
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '归一化层：每个标签的 isDeleted 恒为 false（上游归一化这一道）',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让归一化层把标签写成墓碑');
  });

  it('④ 落盘层把归零写反成 true ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '落盘层归零写反',
        testFile: GUARD,
        targets: [
          {
            path: MUTATION_OPS,
            mutate: source =>
              replaceIn(
                source,
                `            isDeleted: false,
            deletedAt: undefined,`,
                `            isDeleted: true,
            deletedAt: undefined,`
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '落盘层：每个标签的 isDeleted 恒为 false（applyImportGroups 这一道）',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让落盘层把标签写成墓碑');
  });

  it('⑤ 落盘层不盖印记 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '落盘层不盖本机印记',
        testFile: GUARD,
        targets: [
          {
            path: MUTATION_OPS,
            mutate: source =>
              replaceIn(
                source,
                PERSIST_OVERRIDES,
                `            isDeleted: false,
            deletedAt: undefined,
          });
          return acc;`
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '导入的标签不得带着文件里（别的设备）的操作印记',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让落盘层不再盖本机印记');
  });

  it('⑥ 归一化层不归零墓碑时刻 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '归一化层留着墓碑时刻',
        testFile: GUARD,
        targets: [
          {
            path: NORMALIZE,
            mutate: source =>
              replaceIn(
                source,
                NORMALIZE_OVERRIDES,
                `    isDeleted: false,
    lastOp: undefined,
  } as Tab;`
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '归一化层：每个标签的 isDeleted 恒为 false（上游归一化这一道）',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让归一化层留着墓碑时刻');
  });

  it('⑦ 等价改写（落盘层改成先 push 再补字段）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '落盘层换成等价写法',
        testFile: GUARD,
        targets: [
          {
            path: MUTATION_OPS,
            mutate: source =>
              replaceIn(
                source,
                PERSIST_OVERRIDES,
                `          });
          // 等价写法：先入队再补字段（行为与上面完全一致）
          const live = acc[acc.length - 1];
          live.isDeleted = false;
          live.deletedAt = undefined;
          live.lastOp = stamp;
          return acc;`
              ),
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把落盘层改成「先 push 再补字段」的等价写法');
  });

  it('⑧ 等价改写（归一化层把三个字段提成常量再展开）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '归一化层换成等价写法',
        testFile: GUARD,
        targets: [
          {
            path: NORMALIZE,
            mutate: source => {
              const withConst = replaceIn(
                source,
                '/** 云端/旧版本形状的单个标签 → 本地 Tab 形状（无法救回时返回 null）。 */',
                [
                  '/** 导入产生的标签恒为「活着的」：墓碑标记归零、同步印记交由落盘层盖。 */',
                  'const LIVE_IMPORTED_TAB_FIELDS = {',
                  '  isDeleted: false,',
                  '  deletedAt: undefined,',
                  '  lastOp: undefined,',
                  '} as const;',
                  '',
                  '/** 云端/旧版本形状的单个标签 → 本地 Tab 形状（无法救回时返回 null）。 */',
                ].join('\n')
              );
              return replaceIn(
                withConst,
                NORMALIZE_OVERRIDES,
                `    ...LIVE_IMPORTED_TAB_FIELDS,
  } as Tab;`
              );
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把归一化层改成「提常量再展开」的等价写法');
  });
});
