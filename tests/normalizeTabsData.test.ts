// normalizeTabsData 单元测试——钉死 tabs_data 形状归一化行为。
//
// 背景：云端 tab_groups.tabs_data 存在历史坏行（解密/JSON.parse 后非数组），
// 直接 .map 会抛出 "c.map is not a function"（生产压缩代码），
// 导致整次下载/合并失败。任何放宽形状校验的 PR 都会先在这里爆红。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

before(async () => {
  register(LOADER_PATH);
});

describe('normalizeTabsData: 形状归一化', () => {
  it('数组直通：合法 TabData[] 原样返回（同一引用）', async () => {
    const { normalizeTabsData } = await import('@/core/normalizeTabsData');
    const arr = [
      { id: '1', url: 'https://a.com', title: 'A', created_at: '2024-01-01', last_accessed: '2024-01-01' },
      { id: '2', url: 'https://b.com', title: 'B', created_at: '2024-01-02', last_accessed: '2024-01-02' },
    ];
    const result = normalizeTabsData(arr, 'group-1');
    assert.strictEqual(result, arr);
    assert.strictEqual(result.length, 2);
  });

  it('空数组也直通，不告警降级', async () => {
    const { normalizeTabsData } = await import('@/core/normalizeTabsData');
    const arr: unknown[] = [];
    assert.strictEqual(normalizeTabsData(arr), arr);
  });

  it('wrapper 恢复：{ tabs: [...] } 返回内层数组', async () => {
    const { normalizeTabsData } = await import('@/core/normalizeTabsData');
    const inner = [{ id: '1', url: 'https://a.com', title: 'A', created_at: '', last_accessed: '' }];
    const result = normalizeTabsData({ tabs: inner, name: '坏行' }, 'group-2');
    assert.strictEqual(result, inner);
  });

  it('wrapper 恢复：{ tabs_data: [...] } / { groups: [...] } / { tabsData: [...] } 均可恢复', async () => {
    const { normalizeTabsData } = await import('@/core/normalizeTabsData');
    const a = [{ id: '1', url: 'u', title: 't', created_at: '', last_accessed: '' }];
    const b = [{ id: '2', url: 'u', title: 't', created_at: '', last_accessed: '' }];
    const c = [{ id: '3', url: 'u', title: 't', created_at: '', last_accessed: '' }];
    assert.strictEqual(normalizeTabsData({ tabs_data: a }), a);
    assert.strictEqual(normalizeTabsData({ groups: b }), b);
    assert.strictEqual(normalizeTabsData({ tabsData: c }), c);
  });

  it('wrapper 无数组字段：降级为空数组', async () => {
    const { normalizeTabsData } = await import('@/core/normalizeTabsData');
    assert.deepStrictEqual(normalizeTabsData({ foo: 'bar' }, 'group-3'), []);
    assert.deepStrictEqual(normalizeTabsData({ tabs: 'not-an-array' }, 'group-3'), []);
  });

  it('非数组降级：对象/null/字符串/数字/undefined → 空数组', async () => {
    const { normalizeTabsData } = await import('@/core/normalizeTabsData');
    assert.deepStrictEqual(normalizeTabsData(null, 'group-4'), []);
    assert.deepStrictEqual(normalizeTabsData('random string', 'group-4'), []);
    assert.deepStrictEqual(normalizeTabsData(42, 'group-4'), []);
    assert.deepStrictEqual(normalizeTabsData(undefined, 'group-4'), []);
    assert.deepStrictEqual(normalizeTabsData(true, 'group-4'), []);
  });

  it('contextId 缺省时不抛错', async () => {
    const { normalizeTabsData } = await import('@/core/normalizeTabsData');
    assert.deepStrictEqual(normalizeTabsData('bad'), []);
  });
});

// 2026-10-06 降噪定性（docs/health-check-2026-10-05-v1.22.11.md §7.1）：
// wrapper 恢复是**预期中的兼容路径在工作**，不是故障 —— 每 60s 一轮的全量下载
// 反复打 warn 只会让真异常淹没在噪声里（线上日志 3 组 × 2 轮刷屏的正是它）。
// 钉死：恢复成功不进 console.warn（生产静默）；「无法恢复」仍必须出声。
describe('normalizeTabsData: 告警级别（降噪契约）', () => {
  /** 捕获 console.warn：logWarn 唯一出口就是它。 */
  async function captureWarns(run: () => void | Promise<unknown>): Promise<unknown[][]> {
    const warns: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args); };
    try {
      await run();
    } finally {
      console.warn = original;
    }
    return warns;
  }

  it('wrapper 恢复成功：返回内层数组且不打 console.warn', async () => {
    const { normalizeTabsData } = await import('@/core/normalizeTabsData');
    const inner = [{ id: '1', url: 'https://a.com', title: 'A', created_at: '', last_accessed: '' }];
    let result: unknown;
    const warns = await captureWarns(() => {
      result = normalizeTabsData({ tabs: inner }, 'group-warn-1');
    });
    assert.strictEqual(result, inner, '恢复结果本身不受降级影响');
    assert.equal(warns.length, 0, '恢复成功是预期行为，生产控制台不应出现 warn');
  });

  it('无法恢复（形状彻底读不出）：仍必须打 console.warn', async () => {
    const { normalizeTabsData } = await import('@/core/normalizeTabsData');
    let result: unknown;
    const warns = await captureWarns(() => {
      result = normalizeTabsData({ foo: 'bar' }, 'group-warn-2');
    });
    assert.deepStrictEqual(result, [], '读不出来降级空数组的语义不变');
    assert.equal(warns.length, 1, '真异常必须出声 —— 降噪只降成功路径');
    assert.match(String(warns[0][0]), /无法恢复/);
  });

  it('标量/空形状降级：同样必须打 console.warn', async () => {
    const { normalizeTabsData } = await import('@/core/normalizeTabsData');
    const warns = await captureWarns(() => {
      normalizeTabsData('not-json-shape', 'group-warn-3');
    });
    assert.equal(warns.length, 1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// JSON 备份导入路径（normalizeImportedGroup / normalizeImportedTab / asIso）
// 2026-01-01 修复三处导入缺陷后的回归钉：
//   ① 容器选择：空 `tabs: []` 不得遮蔽有内容的 `tabs_data`（原 `??` 链只看
//     null/undefined，空数组照样选中）；
//   ② 数字纪元毫秒时间戳：原来被当作不可解析 → 替换成 now（与 asIso「不编造
//     时间」的注释直接矛盾）；现在合法输入原值换算、绝不替换；
//   ③ 旧版真值标志：`pinned: 1` / `is_locked: "true"` 等原来被压成 false。
// 任何一条回退都会先在这里爆红。
// ────────────────────────────────────────────────────────────────────────────
describe('normalizeImportedGroup: 容器选择（空数组遮蔽）', () => {
  const validTab = { url: 'https://a.com', title: 'A', created_at: '2024-01-01T00:00:00Z', last_accessed: '2024-01-01T00:00:00Z' };

  it('① 空 tabs 不遮蔽有内容的 tabs_data（w2 缺陷①的复现输入）', async () => {
    const { normalizeImportedGroup } = await import('@/core/normalizeTabsData');
    const g = normalizeImportedGroup({ tabs: [], tabs_data: [validTab] });
    assert.strictEqual(g.tabs.length, 1, '`tabs: []` 选中后 `tabs_data` 被丢弃 → 导入报「全部为空」');
    assert.strictEqual(g.tabs[0].url, 'https://a.com');
  });

  it('① 遮蔽修复对四个键都生效：非空键优先于前面的空数组键', async () => {
    const { normalizeImportedGroup } = await import('@/core/normalizeTabsData');
    const t1 = [{ ...validTab, url: 'https://tabsData.com' }];
    const t2 = [{ ...validTab, url: 'https://groups.com' }];
    assert.strictEqual(normalizeImportedGroup({ tabs: [], tabsData: t1 }).tabs.length, 1);
    assert.strictEqual(normalizeImportedGroup({ tabs: [], tabs_data: [], groups: t2 }).tabs[0].url, 'https://groups.com');
  });

  it('① 全空时保留「明确是空组」的语义：回退到第一个存在的键，而不是变 undefined', async () => {
    const { normalizeImportedGroup } = await import('@/core/normalizeTabsData');
    const g = normalizeImportedGroup({ name: '空组', tabs: [] });
    assert.deepStrictEqual(g.tabs, [], '明确空组 ≠ 没有组');
    assert.strictEqual(g.name, '空组');
  });

  it('① 多键同 non-empty：按 tabs → tabs_data → tabsData → groups 优先级取第一个', async () => {
    const { normalizeImportedGroup } = await import('@/core/normalizeTabsData');
    const a = [{ ...validTab, url: 'https://from-tabs.com' }];
    const b = [{ ...validTab, url: 'https://from-tabs_data.com' }];
    const g = normalizeImportedGroup({ tabs: a, tabs_data: b });
    assert.strictEqual(g.tabs[0].url, 'https://from-tabs.com');
  });

  it('① 回退必须传「存在的值」而不只是数组：嵌套 wrapper {tabs:{...}} 仍恢复（防中间版本回归）', async () => {
    const { normalizeImportedGroup } = await import('@/core/normalizeTabsData');
    const g = normalizeImportedGroup({
      tabs_data: { tabs: [{ ...validTab, url: 'https://wrapped.example.com' }] },
    });
    assert.strictEqual(g.tabs.length, 1, '回退只认数组会把嵌套 wrapper 对象变成 undefined → 没有组');
    assert.strictEqual(g.tabs[0].url, 'https://wrapped.example.com');
  });

  it('① 回退必须传「存在的值」：字符串化 JSON 也照常交给 normalizeTabsData（诚实失败）', async () => {
    const { normalizeImportedGroup } = await import('@/core/normalizeTabsData');
    const warns: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args); };
    try {
      const g = normalizeImportedGroup({ name: 'S', tabs_data: '[{"url":"https://a.com"}]' });
      assert.deepStrictEqual(g.tabs, []);
      assert.strictEqual(g.name, 'S');
    } finally {
      console.warn = original;
    }
    assert.ok(warns.length >= 1, '诚实失败必须出声');
  });
});

describe('normalizeImportedGroup: 时间戳不编造', () => {
  it('② 合法 ISO 字符串原样保留（正向基线，秒级精度不丢）', async () => {
    const { normalizeImportedGroup } = await import('@/core/normalizeTabsData');
    const g = normalizeImportedGroup({
      name: 'x',
      createdAt: '2020-05-05T05:05:05Z',
      tabs: [{ url: 'https://a.com', createdAt: '2019-03-03T03:03:03Z', lastAccessed: '2019-03-04T03:03:03Z' }],
    });
    assert.strictEqual(g.createdAt, '2020-05-05T05:05:05.000Z');
    assert.strictEqual(g.tabs[0].createdAt, '2019-03-03T03:03:03.000Z');
    assert.strictEqual(g.tabs[0].lastAccessed, '2019-03-04T03:03:03.000Z');
  });

  it('② 数字纪元毫秒正常换算，绝不替换成 now（w2 缺陷②的复现输入）', async () => {
    const { normalizeImportedGroup } = await import('@/core/normalizeTabsData');
    const before = Date.now();
    const g = normalizeImportedGroup({
      name: 'x',
      created_at: 1767225600000,
      tabs: [{ url: 'https://a.com', created_at: 1767225600000, last_accessed: 1700000000000 }],
    });
    const after = Date.now();
    const expected = '2026-01-01T00:00:00.000Z'; // 1767225600000
    assert.strictEqual(g.createdAt, expected, '数字纪元被当作不可解析 → 替换成 now');
    assert.strictEqual(g.tabs[0].createdAt, expected);
    assert.strictEqual(g.tabs[0].lastAccessed, '2023-11-14T22:13:20.000Z'); // 1700000000000
    // 防回归：即便断言的常量错了，这里也保证不是 now
    const createdMs = new Date(g.createdAt).getTime();
    assert.ok(createdMs < before - 1000 || createdMs > after + 1000, 'createdAt 不应落在「现在」附近');
    assert.strictEqual(g.updatedAt, '2026-01-01T00:00:00.000Z', 'updatedAt 缺失 → 回退到组 createdAt（现状保持）');
  });

  it('② 真正非法/缺失的时间戳：仍然回退到 now（现状保持）', async () => {
    const { normalizeImportedGroup } = await import('@/core/normalizeTabsData');
    const before = Date.now();
    const g = normalizeImportedGroup({ name: 'x', tabs: [{ url: 'https://a.com', createdAt: 'not-a-date' }] });
    const after = Date.now();
    assert.ok(new Date(g.createdAt).getTime() >= before - 1000);
    assert.ok(new Date(g.createdAt).getTime() <= after + 1000);
    assert.ok(new Date(g.tabs[0].createdAt).getTime() >= before - 1000);
  });

  it('② 非有限数字（NaN/Infinity）当作非法 → 回退，不产出 Invalid Date', async () => {
    const { normalizeImportedGroup } = await import('@/core/normalizeTabsData');
    const before = Date.now();
    const g = normalizeImportedGroup({ name: 'x', created_at: Number.NaN, tabs: [{ url: 'https://a.com', created_at: Number.POSITIVE_INFINITY }] });
    assert.ok(new Date(g.createdAt).getTime() >= before - 1000, 'NaN 不能变成 Invalid Date');
    assert.ok(new Date(g.tabs[0].createdAt).getTime() >= before - 1000, 'Infinity 不能变成 Invalid Date');
    assert.strictEqual(g.tabs[0].createdAt, g.tabs[0].lastAccessed, 'lastAccessed 缺失 → 回退到 createdAt，但那已是 now');
  });
});

describe('normalizeImportedGroup: 旧版真值标志', () => {
  const cases = [
    ['true 原样', true, true],
    ['数字 1', 1, true],
    ['字符串 "1"', '1', true],
    ['字符串 "true"（大小写不敏感）', 'TRUE', true],
    ['数字 0', 0, false],
    ['字符串 "0"', '0', false],
    ['字符串 "yes"', 'yes', false],
    ['undefined', undefined, false],
  ] as const;

  it('③ pinned 接受 true/1/"1"/"true"（大小写不敏感），其余 false', async () => {
    const { normalizeImportedGroup } = await import('@/core/normalizeTabsData');
    for (const [label, input, expected] of cases) {
      const g = normalizeImportedGroup({ tabs: [{ url: 'https://a.com', pinned: input, created_at: '2024-01-01T00:00:00Z' }] });
      assert.strictEqual(g.tabs[0].pinned, expected, `pinned = ${String(input)}（${label}）`);
    }
  });

  it('③ isLocked 接受 true/1/"1"/"true"（大小写不敏感），is_locked 同口径', async () => {
    const { normalizeImportedGroup } = await import('@/core/normalizeTabsData');
    for (const [label, input, expected] of cases) {
      const viaNew = normalizeImportedGroup({ isLocked: input, tabs: [] });
      const viaOld = normalizeImportedGroup({ is_locked: input, tabs: [] });
      assert.strictEqual(viaNew.isLocked, expected, `isLocked = ${String(input)}（${label}）`);
      assert.strictEqual(viaOld.isLocked, expected, `is_locked = ${String(input)}（${label}）`);
    }
  });

  it('③ 修复前：pinned: 1 / is_locked: "true" 都被压成 false（复现锚点，反向钉死）', async () => {
    const { normalizeImportedGroup } = await import('@/core/normalizeTabsData');
    const g = normalizeImportedGroup({ tabs: [{ url: 'https://a.com', pinned: 1, created_at: '2024-01-01T00:00:00Z' }], is_locked: 1 });
    assert.strictEqual(g.tabs[0].pinned, true, '修复前 pinned: 1 → false');
    assert.strictEqual(g.isLocked, true, '修复前 is_locked: 1 → false');
  });
});

describe('normalizeImportedGroup: 字符串化 tabs_data（诚实失败）', () => {
  it('④ 字符串化 JSON 产出空组（现状保持，不做二次 JSON.parse）', async () => {
    const { normalizeImportedGroup } = await import('@/core/normalizeTabsData');
    const warns: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args); };
    try {
      const g = normalizeImportedGroup({ name: '坏行', tabs_data: '[{"url":"https://a.com"}]' });
      assert.deepStrictEqual(g.tabs, []);
      assert.strictEqual(g.name, '坏行', '组本身仍在，不是被整个丢掉');
    } finally {
      console.warn = original;
    }
    assert.ok(warns.length >= 1, '诚实失败必须出声');
    assert.match(String(warns[warns.length - 1][0]), /无法恢复/);
  });
});
