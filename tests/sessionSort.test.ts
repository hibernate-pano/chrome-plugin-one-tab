// 会话列表排序 —— 2026-10-22 审计 L-10 的守卫。
//
// 缺陷本体（L-10）：列表排序**写死**在渲染层的一段表达式里
// （`TabList.tsx`：`new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()`），
// 用户**没有任何排序入口** —— 筛选面板给的是「域名 / 会话名称 / 保存时间」三个
// **筛选**维度，排序这件事本身被写死了。
//
// 本文件守**判据层 + 默认层 + 持久化层 + Redux 层**四件事：
//   ① 判据层：`sortSessions` 四种键**每一个比较器分支**的行为
//      （含非法时间戳、同值兜底、稳定性、不改入参）；
//   ② 默认层：默认键是 `'saved'`（= 旧版写死的顺序 ⇒ 存量用户升级后顺序不变），
//      选项表与标签齐全，`isSessionSortKey` 只认这四种；
//   ③ 持久化层：排序键随设置落盘 / 读回，脏值 fail-safe 回落，存量用户回落到默认；
//   ④ Redux 层：`setSessionSort` 这个 action 真的写进了 `state.sessionSort`。
//
// 【为什么这里不守「接线」】渲染层（`TabList.tsx` / `SearchFilterPanel.tsx` /
// `SearchResultList.tsx`）由接线方负责；在接线落地之前把源码断言写在这里，
// 只会得到一个「红的但与人无关」的失败 ⇒ 守门人自己变成噪音。
// 判据层与状态层是**接线方改动不了**的东西 —— 那才是这里该守的。
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SESSION_SORT,
  SESSION_SORT_OPTIONS,
  isSessionSortKey,
  lastActivityAt,
  resolveSortControlPlacement,
  sessionSortLabel,
  sortSessions,
  type SessionSortKey,
} from '../src/core/sessionSort.ts';
import type { TabGroup } from '../src/types/tab.ts';

// ─────────────────────────────────────────────────────────────────────────
// 0. fixture
// ─────────────────────────────────────────────────────────────────────────

interface FixtureTab {
  lastAccessed?: string;
}

interface FixtureGroup {
  id: string;
  name: string;
  createdAt: string;
  updatedAt?: string;
  tabs?: FixtureTab[];
}

/** 造一个最小会话（只需要判据真正读到的那几个字段）。 */
const group = (
  id: string,
  name: string,
  createdAt: string,
  extra?: { updatedAt?: string; tabs?: FixtureTab[] }
): FixtureGroup => ({
  id,
  name,
  createdAt,
  updatedAt: extra?.updatedAt,
  tabs: extra?.tabs,
});

/** 只造标签（判据只读 `lastAccessed`）。 */
const tab = (lastAccessed?: string): FixtureTab => ({ lastAccessed });

/**
 * 旧版写死的那段排序表达式（L-10 修复前的 `TabList.tsx` 原文，逐字照抄）。
 *
 * 留着它不是为了「继续用它」，而是作为**判据的基准**：默认键在有效时间戳上
 * 必须与它逐元素等价（否则「默认排序不变」这句话就是假的）。
 */
const legacySort = (groups: FixtureGroup[]): FixtureGroup[] =>
  [...groups].sort(
    (left, right) =>
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
  );

const ids = (groups: FixtureGroup[]): string[] => groups.map(item => item.id);

// ─────────────────────────────────────────────────────────────────────────
// 1. 判据层 · saved（默认键）
// ─────────────────────────────────────────────────────────────────────────

describe('判据层 · saved：与旧版写死的排序逐元素等价', () => {
  // 刻意乱序 + 刻意同毫秒：
  //   · 乱序 ⇒ 排序真的做了事（不是原样返回）；
  //   · 同毫秒 ⇒ 覆盖「导入的一批会话共用同一个 now」这个真实场景
  //     （`oneTabFormatParser` 给所有导入组同一个时间戳）⇒ 稳定排序必须保住
  //     它们之间的相对顺序。
  const FIXTURE: FixtureGroup[] = [
    group('g5', '戊', '2026-05-05T09:00:00.000Z'),
    group('g2', '乙', '2026-02-02T09:00:00.000Z'),
    group('g4', '丁', '2026-04-04T09:00:00.000Z'),
    group('g1', '甲', '2026-01-01T09:00:00.000Z'),
    group('g3', '丙', '2026-03-03T09:00:00.000Z'),
  ];
  const SAME_MS_A = group('same-a', '同刻甲', '2026-06-06T12:00:00.000Z');
  const SAME_MS_B = group('same-b', '同刻乙', '2026-06-06T12:00:00.000Z');

  it('与旧表达式的结果逐元素一致', () => {
    assert.deepEqual(
      ids(sortSessions(FIXTURE, 'saved')),
      ids(legacySort(FIXTURE)),
      "'saved' 必须与旧版写死的排序完全一致"
    );
  });

  it('最新保存的排在最前', () => {
    const sorted = sortSessions(FIXTURE, 'saved');
    assert.equal(sorted[0].id, 'g5', 'createdAt 最大的（最近保存）应排第一');
    assert.equal(sorted[sorted.length - 1].id, 'g1', 'createdAt 最小的应排最后');
  });

  it('同毫秒的会话保持原有相对顺序（稳定排序）', () => {
    const withTies = [SAME_MS_A, group('x', '别的', '2026-07-07T09:00:00.000Z'), SAME_MS_B];
    const actual = ids(sortSessions(withTies, 'saved'));
    assert.deepEqual(
      actual,
      ['x', 'same-a', 'same-b'],
      '同毫秒的两个会话必须保持传入时的相对顺序（导入的一批会话共用同一个 now）'
    );
    assert.deepEqual(actual, ids(legacySort(withTies)), '与旧实现同口径（两边都稳定 ⇒ 结果一致）');
  });

  it('创建时间非法的会话当作「最旧」排最后（不是 NaN 抖动）', () => {
    // 这条判据同时钉住「非法时间戳 ⇒ -Infinity」这条硬规则：
    // 若时间解析失败时返回 `NaN`，比较函数会返回 `NaN`，而按 ES 规范
    // 「比较函数返回 NaN」被当作「相等」⇒ 顺序交给引擎的自由发挥（抖动）。
    const fixture = [
      group('invalid', '非法创建时间', '不是时间戳'),
      group('old', '旧', '2020-01-01T00:00:00.000Z'),
      group('new', '新', '2026-01-01T00:00:00.000Z'),
    ];
    assert.deepEqual(
      ids(sortSessions(fixture, 'saved')),
      ['new', 'old', 'invalid'],
      '非法时间戳必须被当作最旧（-Infinity），而不是 NaN（NaN ⇒ 顺序变成实现细节）'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 判据层 · accessed（最近访问）
// ─────────────────────────────────────────────────────────────────────────

describe('判据层 · accessed：按「会话最近一次动静」倒序', () => {
  const FIXTURE: FixtureGroup[] = [
    // 组的 updatedAt 决定
    group('by-group', '组更新过', '2026-01-01T00:00:00.000Z', {
      updatedAt: '2026-05-01T00:00:00.000Z',
    }),
    // 标签的 lastAccessed 比组的 updatedAt 更新 ⇒ 标签胜出
    group('by-tab', '标签更新过', '2026-01-02T00:00:00.000Z', {
      tabs: [tab('2026-06-01T00:00:00.000Z')],
    }),
    group('stale', '很久没动', '2026-01-03T00:00:00.000Z', {
      updatedAt: '2026-02-01T00:00:00.000Z',
    }),
    // 什么动静都没有
    group('no-activity', '没动过', '2026-01-04T00:00:00.000Z', { tabs: [] }),
    // 时间戳非法
    group('bad', '时间戳非法', '2026-01-05T00:00:00.000Z', {
      updatedAt: '不是时间戳',
      tabs: [tab('也不是时间戳')],
    }),
  ];

  it('按最近动静倒序；没有任何动静的排最后', () => {
    assert.deepEqual(ids(sortSessions(FIXTURE, 'accessed')), [
      'by-tab',
      'by-group',
      'stale',
      'bad',
      'no-activity',
    ]);
  });

  it('「什么都没有」的会话之间按 createdAt 倒序兜底（确定性）', () => {
    const actual = ids(sortSessions(FIXTURE, 'accessed'));
    assert.deepEqual(
      actual.slice(-2),
      ['bad', 'no-activity'],
      '同为「最旧」的两个会话必须按 createdAt 倒序兜底（bad 的 createdAt 更新）'
    );
  });

  it('lastActivityAt 取「组的 updatedAt」与「标签的 lastAccessed」里更新的那个', () => {
    const groupWins = group('g', '组', '2026-01-01T00:00:00.000Z', {
      updatedAt: '2026-05-01T00:00:00.000Z',
      tabs: [tab('2026-02-01T00:00:00.000Z')],
    });
    const tabWins = group('t', '标签', '2026-01-01T00:00:00.000Z', {
      updatedAt: '2026-02-01T00:00:00.000Z',
      tabs: [tab('2026-06-01T00:00:00.000Z')],
    });
    assert.equal(
      lastActivityAt(groupWins),
      new Date('2026-05-01T00:00:00.000Z').getTime(),
      '组的更新时间比标签新时，以组为准'
    );
    assert.equal(
      lastActivityAt(tabWins),
      new Date('2026-06-01T00:00:00.000Z').getTime(),
      '标签的访问时间比组的更新还新时，以标签为准'
    );
  });

  it('缺失 / 非法时间戳一律当作「最旧」（-Infinity），不得被当成 NaN', () => {
    assert.equal(lastActivityAt(group('x', '空', '2026-01-01T00:00:00.000Z')), -Infinity);
    assert.equal(
      lastActivityAt(
        group('x', '坏', '2026-01-01T00:00:00.000Z', {
          updatedAt: '乱码',
          tabs: [tab('乱码')],
        })
      ),
      -Infinity
    );
  });

  it('组的时间戳非法时，仍然按标签的有效时间排（不能整组被当成最旧）', () => {
    const fixture = [
      group('bad-group', '组时间戳非法', '2026-01-01T00:00:00.000Z', {
        updatedAt: '不是时间戳',
        tabs: [tab('2026-06-01T00:00:00.000Z')],
      }),
      group('other', '别的', '2026-02-01T00:00:00.000Z', {
        updatedAt: '2026-03-01T00:00:00.000Z',
      }),
    ];
    assert.deepEqual(
      ids(sortSessions(fixture, 'accessed')),
      ['bad-group', 'other'],
      '一个字段非法不能让整组的有效信号被吞掉'
    );
  });

  it('活动时间相同时按 createdAt 倒序兜底', () => {
    const fixture = [
      group('older', '同刻', '2026-01-01T00:00:00.000Z', { updatedAt: '2026-03-01T00:00:00.000Z' }),
      group('newer', '同刻', '2026-06-01T00:00:00.000Z', { updatedAt: '2026-03-01T00:00:00.000Z' }),
      group('other', '异刻', '2026-04-01T00:00:00.000Z', { updatedAt: '2026-01-01T00:00:00.000Z' }),
    ];
    assert.deepEqual(ids(sortSessions(fixture, 'accessed')), ['newer', 'older', 'other']);
  });

  it('同一份输入反复排序结果恒定（比较器不产生 NaN 抖动）', () => {
    const first = ids(sortSessions(FIXTURE, 'accessed'));
    const second = ids(sortSessions([...FIXTURE].reverse(), 'accessed'));
    const third = ids(sortSessions(FIXTURE, 'accessed'));
    assert.deepEqual(first, third, '同一份输入排序两次结果必须一致');
    assert.equal(second[0], 'by-tab', '最近动过的永远在前（与输入顺序无关）');
    assert.deepEqual([...second].sort(), [...first].sort(), '不能凭空丢会话');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. 判据层 · name（名称）
// ─────────────────────────────────────────────────────────────────────────

describe('判据层 · name：中文升序 + 同名按保存时间倒序', () => {
  it('按中文（zh-CN 拼音序）升序，不是按 Unicode 码点', () => {
    // 判别性用例：按码点 '波'(U+6CE2) 排在 '阿'(U+963F) 前面，
    // 按拼音则是「阿」在前 —— 两种排序在这里结论相反。
    const fixture = [
      group('bo', '波', '2026-01-01T00:00:00.000Z'),
      group('a', '阿', '2026-01-02T00:00:00.000Z'),
    ];
    assert.ok('阿' > '波', '前置：按码点这两个字是「波」在前');
    assert.deepEqual(ids(sortSessions(fixture, 'name')), ['a', 'bo'], '必须按 zh-CN 拼音序排（阿 a、波 b）');
  });

  it('与 localeCompare(b, zh-CN) 的参考实现一致', () => {
    const fixture = [
      group('1', '柠檬', '2026-01-01T00:00:00.000Z'),
      group('2', '阿狸', '2026-01-02T00:00:00.000Z'),
      group('3', '斑马', '2026-01-03T00:00:00.000Z'),
      group('4', '橙子', '2026-01-04T00:00:00.000Z'),
      group('5', '大熊', '2026-01-05T00:00:00.000Z'),
    ];
    const reference = [...fixture].sort((left, right) =>
      left.name.localeCompare(right.name, 'zh-CN')
    );
    assert.deepEqual(ids(sortSessions(fixture, 'name')), ids(reference));
  });

  it('同名时用 createdAt 倒序做第二判据', () => {
    const fixture = [
      group('older', '同名', '2026-01-01T00:00:00.000Z'),
      group('newer', '同名', '2026-06-01T00:00:00.000Z'),
      group('other', '异名', '2026-03-01T00:00:00.000Z'),
    ];
    assert.deepEqual(ids(sortSessions(fixture, 'name')), ['newer', 'older', 'other'], '同名里保存时间新的在前');
  });

  it('同名且时间戳也相同时保持原有相对顺序', () => {
    const a = group('a', '同名', '2026-01-01T00:00:00.000Z');
    const b = group('b', '同名', '2026-01-01T00:00:00.000Z');
    assert.deepEqual(ids(sortSessions([a, b], 'name')), ['a', 'b'], '完全同键时必须稳定');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. 判据层 · size（会话大小 = 标签数）
// ─────────────────────────────────────────────────────────────────────────

describe('判据层 · size：按标签数倒序', () => {
  const FIXTURE: FixtureGroup[] = [
    group('big', '标签最多', '2026-01-01T00:00:00.000Z', {
      tabs: [tab(), tab(), tab(), tab(), tab()],
    }),
    group('mid', '中等', '2026-01-02T00:00:00.000Z', { tabs: [tab(), tab()] }),
    group('small', '一个', '2026-01-03T00:00:00.000Z', { tabs: [tab()] }),
    // 空会话（tabs 是空数组）与「没有 tabs 字段」都算 0 个标签
    group('empty', '空的', '2026-03-01T00:00:00.000Z', { tabs: [] }),
    group('missing', '没有标签字段', '2026-01-01T00:00:00.000Z'),
  ];

  it('标签多的排前面', () => {
    assert.deepEqual(ids(sortSessions(FIXTURE, 'size')), [
      'big',
      'mid',
      'small',
      'empty',
      'missing',
    ]);
  });

  it('标签数相同时按 createdAt 倒序兜底（确定性）', () => {
    const fixture = [
      group('older', '两个', '2026-01-01T00:00:00.000Z', { tabs: [tab(), tab()] }),
      group('newer', '两个', '2026-06-01T00:00:00.000Z', { tabs: [tab(), tab()] }),
      group('other', '一个', '2026-03-01T00:00:00.000Z', { tabs: [tab()] }),
    ];
    assert.deepEqual(ids(sortSessions(fixture, 'size')), ['newer', 'older', 'other']);
  });

  it('缺 tabs 字段按 0 个标签算（不得当成 NaN / 排到最前）', () => {
    const fixture = [
      group('missing', '没有标签字段', '2026-06-01T00:00:00.000Z'),
      group('one', '一个', '2026-01-01T00:00:00.000Z', { tabs: [tab()] }),
    ];
    assert.deepEqual(ids(sortSessions(fixture, 'size')), ['one', 'missing']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. 判据层 · 通用性质
// ─────────────────────────────────────────────────────────────────────────

describe('判据层 · 通用性质', () => {
  const FIXTURE: FixtureGroup[] = [
    group('a', '甲', '2026-01-01T00:00:00.000Z', {
      updatedAt: '2026-02-01T00:00:00.000Z',
      tabs: [tab()],
    }),
    group('b', '乙', '2026-03-01T00:00:00.000Z'),
    group('c', '丙', '2026-02-01T00:00:00.000Z', {
      updatedAt: '2026-01-01T00:00:00.000Z',
      tabs: [tab(), tab()],
    }),
  ];

  for (const key of SESSION_SORT_OPTIONS.map(option => option.value)) {
    it(`不改入参、不丢成员、返回新数组（${key}）`, () => {
      const snapshot = JSON.stringify(FIXTURE);
      const result = sortSessions(FIXTURE, key);
      assert.equal(JSON.stringify(FIXTURE), snapshot, `sortSessions(${key}) 不得就地修改入参`);
      assert.notEqual(result, FIXTURE, '必须返回新数组');
      assert.equal(result.length, FIXTURE.length, '不得丢成员');
      assert.deepEqual(
        [...result].map(item => item.id).sort(),
        FIXTURE.map(item => item.id).sort(),
        `sortSessions(${key}) 不得凭空产生或丢掉会话`
      );
    });
  }

  it('未知排序键按默认键处理（fail-safe，不抛错）', () => {
    const bogus = 'not-a-key' as unknown as SessionSortKey;
    assert.deepEqual(
      ids(sortSessions(FIXTURE, bogus)),
      ids(sortSessions(FIXTURE, DEFAULT_SESSION_SORT)),
      '未知键必须退回默认键的顺序，而不是抛错或乱排'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. 判据层 · 排序控件的落位（收起时也必须可见）
// ─────────────────────────────────────────────────────────────────────────

describe('判据层 · 排序控件的落位', () => {
  it('面板收起 ⇒ 落在工具条上（不能藏在收起的面板里）', () => {
    assert.equal(
      resolveSortControlPlacement(false),
      'toolbar',
      '筛选面板默认收起 ⇒ 排序控件必须落在工具条上，否则它不可达'
    );
  });

  it('面板展开 ⇒ 落进面板（与其它筛选维度同一排）', () => {
    assert.equal(resolveSortControlPlacement(true), 'panel');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 7. 默认层：默认键、选项表、标签、合法性判定
// ─────────────────────────────────────────────────────────────────────────

describe('默认层 · 默认排序键与选项表', () => {
  it("默认键是 'saved'（= 旧版写死的顺序 ⇒ 存量用户顺序不变）", () => {
    assert.equal(DEFAULT_SESSION_SORT, 'saved');
  });

  it('选项表就是这四种，且默认项排在第一个', () => {
    assert.deepEqual(
      SESSION_SORT_OPTIONS.map(option => option.value),
      ['saved', 'accessed', 'name', 'size']
    );
    assert.equal(SESSION_SORT_OPTIONS[0].value, DEFAULT_SESSION_SORT);
  });

  it('每个选项都有中文标签（不能是裸 key）', () => {
    for (const option of SESSION_SORT_OPTIONS) {
      assert.ok(option.label.length > 0, `${option.value} 必须有标签`);
      assert.notEqual(option.label, option.value, `${option.value} 的标签不能就是 key 本身`);
    }
    assert.equal(sessionSortLabel('saved'), '最近保存');
    assert.equal(sessionSortLabel('accessed'), '最近访问');
    assert.equal(sessionSortLabel('name'), '名称');
    assert.equal(sessionSortLabel('size'), '会话大小（标签数）');
  });

  it('isSessionSortKey 只认这四种', () => {
    const legal: SessionSortKey[] = ['saved', 'accessed', 'name', 'size'];
    for (const key of legal) {
      assert.equal(isSessionSortKey(key), true, `${key} 必须是合法排序键`);
    }
    for (const bad of ['', 'Saved', 'recent', 'createdAt', 'updated', null, undefined, 42, {}]) {
      assert.equal(isSessionSortKey(bad), false, `${String(bad)} 不得被当成合法排序键`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 8. 持久化层 + Redux 层
// ─────────────────────────────────────────────────────────────────────────

/** localStorage 桩（无 indexedDB 时 storageAdapter 回退到它）。 */
const lsData = new Map<string, string>();
const localStorageStub = {
  get length() {
    return lsData.size;
  },
  key: (i: number) => [...lsData.keys()][i] ?? null,
  getItem: (k: string) => lsData.get(k) ?? null,
  setItem: (k: string, v: string) => {
    lsData.set(k, String(v));
  },
  removeItem: (k: string) => {
    lsData.delete(k);
  },
  clear: () => lsData.clear(),
};

// 桩必须在**导入 storage 之前**挂好（storageAdapter 在模块初始化时就要挑后端）。
(globalThis as Record<string, unknown>).window = { localStorage: localStorageStub };
(globalThis as Record<string, unknown>).localStorage = localStorageStub;
(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: {
      get: async () => ({}),
      set: async () => undefined,
      remove: async () => undefined,
    },
    onChanged: { addListener: () => undefined, removeListener: () => undefined },
  },
};

let storage: typeof import('../src/utils/storage.ts').storage;
let invalidateSettingsCache: typeof import('../src/utils/storage.ts').invalidateSettingsCache;
let validateSessionSort: typeof import('../src/utils/storage.ts').validateSessionSort;
let defaultSettings: typeof import('../src/utils/storage.ts').DEFAULT_SETTINGS;
let settingsColumnDefaults: typeof import('../src/utils/storage.ts').SETTINGS_COLUMN_DEFAULTS;
let settingsSlice: typeof import('../src/store/slices/settingsSlice.ts');

before(async () => {
  const storageModule = await import('../src/utils/storage.ts');
  storage = storageModule.storage;
  invalidateSettingsCache = storageModule.invalidateSettingsCache;
  validateSessionSort = storageModule.validateSessionSort;
  defaultSettings = storageModule.DEFAULT_SETTINGS;
  settingsColumnDefaults = storageModule.SETTINGS_COLUMN_DEFAULTS;
  settingsSlice = await import('../src/store/slices/settingsSlice.ts');
});

beforeEach(() => {
  invalidateSettingsCache();
});

describe('持久化层 · 排序键随设置落盘，存量用户回落到默认', () => {
  it('默认值就是默认排序键', () => {
    assert.equal(defaultSettings.sessionSort, DEFAULT_SESSION_SORT);
  });

  it('云端列的默认值也是默认排序键（NOT-NULL 兜底写进去的值必须合法）', () => {
    assert.equal(settingsColumnDefaults.session_sort, DEFAULT_SESSION_SORT);
  });

  it('非法值 fail-safe 回落成默认键（不抛错）', () => {
    assert.equal(validateSessionSort('saved'), 'saved');
    assert.equal(validateSessionSort('accessed'), 'accessed');
    assert.equal(validateSessionSort('name'), 'name');
    assert.equal(validateSessionSort('size'), 'size');
    // 存量用户：存储里**没有**这个键 ⇒ undefined
    assert.equal(validateSessionSort(undefined), 'saved', '存量用户必须回落到默认键');
    assert.equal(validateSessionSort(null), 'saved');
    assert.equal(validateSessionSort('recent'), 'saved');
    assert.equal(validateSessionSort('updated'), 'saved', '旧版键不再是合法键');
    assert.equal(validateSessionSort(7), 'saved');
  });

  it('存进去再读出来还是同一个键', async () => {
    await storage.setSettings({ ...defaultSettings, sessionSort: 'size' });
    invalidateSettingsCache();
    const settings = await storage.getSettings();
    assert.equal(settings.sessionSort, 'size');
  });

  it('存量用户（存储里没有这个键）读出来是默认键，其它设置不受影响', async () => {
    // 造一份**旧版本**会写下的设置：没有 sessionSort 这一项。
    await storage.setSettings({ ...defaultSettings, layoutMode: 'double' });
    const raw = lsData.get('user_settings');
    assert.ok(raw, '设置应当已经落盘');
    const legacyBlob = JSON.parse(raw) as Record<string, unknown>;
    delete legacyBlob.sessionSort;
    lsData.set('user_settings', JSON.stringify(legacyBlob));
    invalidateSettingsCache();

    const settings = await storage.getSettings();
    assert.equal(
      settings.sessionSort,
      'saved',
      '存量用户的排序键必须回落到默认（= 旧版写死的顺序 ⇒ 列表顺序不变）'
    );
    assert.equal(settings.layoutMode, 'double', '回落不得影响其它设置');
  });

  it('存储里的脏值被读路径自愈成默认键（而不是原样带进界面）', async () => {
    await storage.setSettings({ ...defaultSettings, sessionSort: 'size' });
    const raw = lsData.get('user_settings');
    assert.ok(raw, '设置应当已经落盘');
    const blob = JSON.parse(raw) as Record<string, unknown>;
    blob.sessionSort = '乱写的键';
    lsData.set('user_settings', JSON.stringify(blob));
    invalidateSettingsCache();

    const settings = await storage.getSettings();
    assert.equal(settings.sessionSort, 'saved', '脏值必须被读路径兜成默认键');
  });
});

describe('Redux 层 · setSessionSort', () => {
  it('action 写进 state.sessionSort', () => {
    const reducer = settingsSlice.default;
    const initial = reducer(undefined, { type: '@@init' });
    const next = reducer(initial, settingsSlice.setSessionSort('name'));
    assert.equal(next.sessionSort, 'name');
  });

  it('四种键都能写进去', () => {
    const reducer = settingsSlice.default;
    const initial = reducer(undefined, { type: '@@init' });
    for (const key of SESSION_SORT_OPTIONS.map(option => option.value)) {
      const next = reducer(initial, settingsSlice.setSessionSort(key));
      assert.equal(next.sessionSort, key);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 9. 接线契约：真实的 TabGroup 能直接喂给 sortSessions
// ─────────────────────────────────────────────────────────────────────────

describe('接线契约 · 真实的 TabGroup 数组可直接传入', () => {
  it('类型上成立（编译期断言：这段代码若不成立，tsc 直接报错）', () => {
    // 接线方要写的就是这一行：`sortSessions(groups, sessionSort)`。
    // 把它钉在测试里 ⇒ 判据与真实数据模型的接口不会悄悄对不上。
    // `pnpm type-check:tests` 覆盖 tests/ ⇒ 这里的类型错误会被拦下。
    const groups: TabGroup[] = [];
    const sorted: TabGroup[] = sortSessions(groups, 'saved');
    assert.deepEqual(sorted, []);
  });

  it('返回值仍然是 TabGroup[]（泛型不被擦掉，调用方拿得到完整类型）', () => {
    const groups = [] as TabGroup[];
    const sorted = sortSessions(groups, DEFAULT_SESSION_SORT);
    // 下面这行只有在返回类型是 TabGroup[] 时才编译得过（否则 groups[0] 是 never）
    const first: TabGroup | undefined = sorted[0];
    assert.equal(first, undefined);
  });
});
