/**
 * GAP1-1 守卫的**变异自证**（2026-10-24 审计）。
 *
 * ── 为什么必须有这个文件 ──────────────────────────────────────────────────
 *
 * 一条从来没红过的守卫，可能一直是绿的而什么也没守住。本仓的硬要求：
 * **每条新守卫都要证明它有检测力** ——
 *   · 把实现改回旧行为 ⇒ 守卫必须变红；
 *   · 把实现换成一个**等价的正确写法** ⇒ 守卫必须**仍然绿**（否则这条守卫
 *     钉的是长相而不是行为，等于逼着实现不敢改）。
 *
 * 沙箱里跑的是**守卫自己**（tests/guards/settingsCrossRealmWrite.test.ts），
 * 不是第二份探针 —— 两份实现会漂移，漂移了就变成「探针坏了」而不是
 * 「守卫抓到了」。
 *
 * ── 每条变异对应守卫里的哪条断言 ─────────────────────────────────────────
 *
 *   M1 落盘改回「整份盲写」（写本 realm 的整份 state）      ⇒ ① 变红
 *   M2 意图只看 state 差值、不看 action 载荷               ⇒ ② 变红
 *   M3 落盘改成「磁盘真值 + 相对磁盘的差值」                ⇒ ① 变红
 *   M4 失效通道断掉（store 不订阅总线）                     ⇒ ③ 变红
 *   M5 importDetailed 的合并底改回缓存读                    ⇒ 导入那条变红
 *   M6 exportData 改回缓存读                                ⇒ 导出那条变红
 *   M7 等价改写（用 Object.assign 逐字段赋值）              ⇒ 仍然全绿
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runMutationCases,
  assertMutationOutcome,
  type MutationCase,
} from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/settingsCrossRealmWrite.test.ts';
const SLICE = 'src/store/slices/settingsSlice.ts';
const STORE = 'src/store/index.ts';
const STORAGE = 'src/utils/storage.ts';

/** 落盘那段的原文（写路径的「按字段」部分）。 */
const FIELD_LEVEL_WRITE = `    const disk = await storage.getSettingsForWrite();
    const intent = snapshotIntent();
    const next: UserSettings = { ...disk };
    for (const [key, value] of intent) {
      // 逐字段赋值而不是 spread：只让**用户动过的**字段离开磁盘真值。
      (next as unknown as Record<string, unknown>)[key as string] = value;
    }`;

/**
 * M1：整份盲写（把本 realm 的整份 state 写回磁盘）。
 *
 * ⚠️ 保留 `const intent = snapshotIntent();` 这一行：后面还要用它清意图表。
 * 少了它，变异会变成「运行时报错」而不是「行为变了」⇒ 守卫红在别处，
 * 证明不了任何事（那正是本文件要防的假检测力）。
 */
const M1 = `    const disk = await storage.getSettingsForWrite();
    const intent = snapshotIntent();
    const { settings } = getState();
    const next: UserSettings = { ...settings };`;

const cases: MutationCase[] = [
  {
    name: 'M1 落盘改回「整份盲写」',
    testFile: GUARD,
    expectRed: true,
    expectedFailure: 'realm B 的写**不许**把 realm A 刚写的字段盖回旧值',
    targets: [
      {
        path: SLICE,
        mutate: (source) => {
          const next = source
            .replace(FIELD_LEVEL_WRITE, M1)
            .replace(
              "  'settings/saveSettings',\n  async () => {",
              "  'settings/saveSettings',\n  async (_: void, { getState }: { getState: () => { settings: UserSettings } }) => {"
            );
          assert.notEqual(next, source, 'M1 变异没有生效');
          return next;
        },
      },
    ],
  },
  {
    name: 'M2 意图只看 state 差值、不看 action 载荷',
    testFile: GUARD,
    expectRed: true,
    expectedFailure: '用户点过的值必须写下去',
    targets: [
      {
        path: SLICE,
        mutate: (source) => {
          const next = source.replace(
            `  const fromAction = intentFromAction(action);
  if (fromAction) {
    for (const [key, value] of fromAction) pendingIntent.set(key, value);
    return;
  }`,
            `  const fromAction = null as Map<keyof UserSettings, unknown> | null;
  if (fromAction) {
    for (const [key, value] of fromAction) pendingIntent.set(key, value);
    return;
  }`
          );
          assert.notEqual(next, source, 'M2 变异没有生效');
          return next;
        },
      },
    ],
  },
  {
    name: 'M3 落盘改成「磁盘真值 + 相对磁盘的差值」',
    testFile: GUARD,
    expectRed: true,
    expectedFailure: 'realm B 的写**不许**把 realm A 刚写的字段盖回旧值',
    targets: [
      {
        path: SLICE,
        mutate: (source) => {
          const next = source
            .replace(FIELD_LEVEL_WRITE, `    const disk = await storage.getSettingsForWrite();
    const intent = snapshotIntent();
    const { settings } = getState();
    const next: UserSettings = { ...disk };
    for (const key of Object.keys(disk) as Array<keyof UserSettings>) {
      if (settings[key] !== disk[key]) {
        (next as unknown as Record<string, unknown>)[key as string] = settings[key];
      }
    }`)
            .replace(
              "  'settings/saveSettings',\n  async () => {",
              "  'settings/saveSettings',\n  async (_: void, { getState }: { getState: () => { settings: UserSettings } }) => {"
            );
          assert.notEqual(next, source, 'M3 变异没有生效');
          return next;
        },
      },
    ],
  },
  {
    name: 'M4 失效通道断掉（store 不订阅总线）',
    testFile: GUARD,
    expectRed: true,
    expectedFailure: 'realm B 必须被刷新',
    targets: [
      {
        path: STORE,
        mutate: (source) => {
          const next = source.replace(
            `  subscribeSettingsChanged(() => {
    void dispatchReloadSettings(store.dispatch);
  });`,
            `  void subscribeSettingsChanged;`
          );
          assert.notEqual(next, source, 'M4 变异没有生效');
          return next;
        },
      },
    ],
  },
  {
    name: 'M5 importDetailed 的合并底改回缓存读',
    testFile: GUARD,
    expectRed: true,
    expectedFailure: '备份里没有的字段必须保住磁盘上的真值',
    targets: [
      {
        path: STORAGE,
        mutate: (source) => {
          const next = source.replace(
            '          const currentSettings = await this.getSettingsForWrite();',
            '          const currentSettings = await this.getSettings();'
          );
          assert.notEqual(next, source, 'M5 变异没有生效');
          return next;
        },
      },
    ],
  },
  {
    name: 'M6 exportData 改回缓存读',
    testFile: GUARD,
    expectRed: true,
    expectedFailure: '备份必须导出磁盘真值',
    targets: [
      {
        path: STORAGE,
        mutate: (source) => {
          const next = source.replace(
            '    const settings = await this.getSettingsForWrite();',
            '    const settings = await this.getSettings();'
          );
          assert.notEqual(next, source, 'M6 变异没有生效');
          return next;
        },
      },
    ],
  },
  {
    name: 'M7 等价改写（Object.assign 逐字段赋值）',
    testFile: GUARD,
    expectRed: false,
    targets: [
      {
        path: SLICE,
        mutate: (source) => {
          const next = source.replace(FIELD_LEVEL_WRITE, `    const disk = await storage.getSettingsForWrite();
    const intent = snapshotIntent();
    const next: UserSettings = { ...disk };
    Object.assign(next as unknown as Record<string, unknown>, Object.fromEntries(intent));`);
          assert.notEqual(next, source, 'M7 变异没有生效');
          return next;
        },
      },
    ],
  },
];

describe('GAP1-1 守卫的变异自证', () => {
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
