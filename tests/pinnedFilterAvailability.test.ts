// 「固定标签页」筛选器在默认配置下是死控件 —— 2026-10-20 审计 A-5 的回归。
//
// ── 缺陷 ────────────────────────────────────────────────────────────────
//
// 搜索面板一直挂着「固定标签页」筛选器（全部 / 仅固定 / 排除固定）。
// 但 `collectPinnedTabs`（设置里的「保存固定标签页」）**默认关闭**，
// 而这个开关决定了存进会话的标签带不带 `pinned` 标记：
//
//   设置关闭 ⇒ 存进去的标签 `pinned` 恒为 false
//   ⇒「仅固定」永远 0 结果
//   ⇒「排除固定」等价于「全部」
//
// 于是在**默认配置**下这个筛选器纯属摆设：占着筛选面板的一行，
// 还让空态提示无条件承诺「可结合域名、保存时间和固定标签筛选」。
//
// ── 修法 ────────────────────────────────────────────────────────────────
//
// 设置关闭时**不渲染**这个 select（用户开了设置它自己就出现），
// 并且**作废**残留的筛选条件（设置页在另一个标签页改动时，
// 本页可能已经设过条件 —— 条件继续生效就成了「隐形筛掉结果」）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { resolveEffectiveSearchFilters } from '../src/components/search/searchFilterAvailability.ts';
import { applySearchFilters, type SearchFilters, type SearchResult } from '../src/utils/search.ts';
import type { Tab, TabGroup } from '../src/types/tab.ts';

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

// ─────────────────────────────────────────────────────────────────────────
// 0. 前置事实：默认配置就是「不保存固定标签页」
// ─────────────────────────────────────────────────────────────────────────

describe('前置事实：collectPinnedTabs 默认关闭', () => {
  it('设置项默认值是 false', () => {
    const storage = read('src/utils/storage.ts');
    const match = storage.match(/collectPinnedTabs\s*:\s*(true|false)/);
    assert.ok(match, 'storage.ts 的 DEFAULT_SETTINGS 里必须能读到 collectPinnedTabs 的默认值');
    assert.equal(
      match[1],
      'false',
      '默认配置决定了「固定标签页」筛选器是死控件 —— 若这里改成 true，本文件的前提失效，需要重写'
    );
  });

  it('保存时按 collectPinnedTabs 过滤掉固定标签（存进去的标签 pinned 恒为 false）', () => {
    // 关键前提：设置关闭时，固定标签**根本进不来** ⇒ 会话里的标签 pinned 恒为 false。
    // 若这一条不成立（例如保存时保留了 pinned 标记），筛选器就不是死控件，
    // 「隐藏它」的结论也就错了。
    const filters = read('src/domain/tabGroup/filters.ts');
    assert.match(
      filters,
      /if\s*\(!includePinned\s*&&\s*tab\.pinned\)/,
      'filterValidTabs 必须在 includePinned 为假时跳过固定标签'
    );

    const manager = read('src/background/TabManager.ts');
    assert.match(
      manager,
      /includePinned:\s*collectPinnedTabs/,
      '保存路径必须把设置原样传给 includePinned'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 1. 纯函数：筛选条件的有效性
// ─────────────────────────────────────────────────────────────────────────

describe('resolveEffectiveSearchFilters：设置关闭时条件一并作废', () => {
  it('设置开启 ⇒ 条件原样保留', () => {
    const filters: SearchFilters = { pinned: 'only', domain: 'example.com' };
    assert.deepEqual(resolveEffectiveSearchFilters(filters, true), filters);
  });

  it('设置关闭 ⇒ pinned 条件被摘掉', () => {
    const filters: SearchFilters = { pinned: 'only', domain: 'example.com' };
    const effective = resolveEffectiveSearchFilters(filters, false);
    assert.equal(effective.pinned, undefined);
  });

  it('设置关闭 ⇒ 其余筛选条件不受影响', () => {
    const filters: SearchFilters = {
      pinned: 'exclude',
      domain: 'example.com',
      groupName: '调研',
      savedWithin: '7d',
    };
    const effective = resolveEffectiveSearchFilters(filters, false);
    assert.equal(effective.domain, 'example.com');
    assert.equal(effective.groupName, '调研');
    assert.equal(effective.savedWithin, '7d');
  });

  it('没有 pinned 条件时返回原对象（不制造无谓的新引用）', () => {
    const filters: SearchFilters = { domain: 'example.com' };
    assert.equal(
      resolveEffectiveSearchFilters(filters, false),
      filters,
      '每次渲染都造新对象 ⇒ useMemo 永远失效 ⇒ 搜索管线全量重算'
    );
  });

  it('不修改入参', () => {
    const filters: SearchFilters = { pinned: 'only' };
    resolveEffectiveSearchFilters(filters, false);
    assert.equal(filters.pinned, 'only', '不得就地改调用方的对象');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 端到端：条件作废后，结果集不再被 pinned 筛掉
// ─────────────────────────────────────────────────────────────────────────

const makeTab = (overrides: Partial<Tab> = {}): Tab => ({
  id: 'tab-1',
  url: 'https://example.com/a',
  title: '示例',
  createdAt: '2026-10-20T00:00:00.000Z',
  lastAccessed: '2026-10-20T00:00:00.000Z',
  pinned: false,
  ...overrides,
});

const makeGroup = (tabs: Tab[]): TabGroup => ({
  id: 'group-1',
  name: '会话',
  tabs,
  createdAt: '2026-10-20T00:00:00.000Z',
  updatedAt: '2026-10-20T00:00:00.000Z',
  isLocked: false,
});

const makeResult = (tab: Tab): SearchResult => ({
  tab,
  group: makeGroup([tab]),
  score: 1,
  matches: [],
});

describe('端到端：设置关闭时，pinned 条件不再筛掉结果', () => {
  it('条件残留 + 设置关闭 ⇒ 结果一条不少', () => {
    const results = [makeResult(makeTab({ id: 't1' })), makeResult(makeTab({ id: 't2' }))];
    const stale: SearchFilters = { pinned: 'only' };

    // 反证：条件生效时，「仅固定」会把未固定的标签全部筛掉
    assert.equal(applySearchFilters(results, stale).length, 0, '前提：pinned=false 的标签过不了「仅固定」');

    // 修复后：设置关闭 ⇒ 条件作废 ⇒ 结果全部保留
    const effective = resolveEffectiveSearchFilters(stale, false);
    assert.equal(applySearchFilters(results, effective).length, 2);
  });

  it('设置开启时「仅固定」照常生效（没有把功能一并关掉）', () => {
    const results = [
      makeResult(makeTab({ id: 't1', pinned: true })),
      makeResult(makeTab({ id: 't2', pinned: false })),
    ];
    const effective = resolveEffectiveSearchFilters({ pinned: 'only' }, true);
    const filtered = applySearchFilters(results, effective);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].tab.id, 't1');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. 组件接线：UI 与有效性由同一个开关决定
// ─────────────────────────────────────────────────────────────────────────

describe('组件接线：UI 可见性与筛选有效性同源', () => {
  const component = () => read('src/components/search/SearchResultList.tsx');
  // 2026-10-20 审计 A-14 起，筛选面板在独立文件里（筛选必须不依赖搜索词可达，
  // 而它原先住在只在有搜索词时才挂载的 SearchResultList 内部）。
  // 守卫钉的是**不变量**（可见性与有效性同源），不是它住在哪个文件里。
  const panel = () => read('src/components/search/SearchFilterPanel.tsx');
  const filterState = () => read('src/components/search/useSearchFilters.ts');

  it('组件读的是 settings.collectPinnedTabs', () => {
    // 读设置的那一行现在在持有筛选状态的层（列表层），面板消费它传下来的开关。
    const sources = `${component()}\n${filterState()}\n${panel()}`;
    assert.match(
      sources,
      /useAppSelector\(state\s*=>\s*state\.settings\.collectPinnedTabs\)/,
      '必须读真实设置项，不能用别的开关代替'
    );
  });

  it('「固定标签页」select 被 collectPinnedTabs 条件包裹', () => {
    const src = panel();
    const guard = src.indexOf('{collectPinnedTabs && (');
    assert.ok(guard > -1, 'pinned select 必须放在 {collectPinnedTabs && (...)} 里');
    // 用 `</label>` 收尾的文本来定位，避免命中注释里的同名词
    const label = src.indexOf('固定标签页\n');
    assert.ok(label > guard, '「固定标签页」label 必须落在条件块内部');
    const selectEnd = src.indexOf('</select>', label);
    assert.ok(selectEnd > label, '必须能找到 pinned select 的结束标签');
    const blockEnd = src.indexOf(')}', selectEnd);
    assert.ok(blockEnd > selectEnd, '条件块必须在 select 之后闭合');
  });

  it('过滤走的是 effectiveFilters，而不是原始 filters', () => {
    const src = component();
    assert.match(
      src,
      /applySearchFilters\(baseResults,\s*effectiveFilters\)/,
      '过滤必须用 effectiveFilters —— 否则条件作废只是摆设'
    );
  });

  it('空态提示不无条件承诺「固定标签」筛选', () => {
    const src = component();
    const hint = src.match(/<li>\s*\{collectPinnedTabs[\s\S]*?<\/li>/);
    assert.ok(hint, '空态提示里的那句筛选说明必须是条件渲染的');
    assert.match(hint[0], /collectPinnedTabs\s*\?/, '两套文案必须由同一个开关切换');
  });
});
