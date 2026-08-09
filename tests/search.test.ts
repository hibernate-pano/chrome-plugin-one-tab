// search.ts 测试：钉死 AdvancedSearch 的核心搜索逻辑。
//
// search 是 TabStack 用户每天必用的功能（找回 2 周前的工作会话）。
// 任何搜索逻辑回归（大小写、pinned bonus、跨字段匹配）都会让用户找不到东西。
// 这些都是纯函数测试，零依赖，可重复跑。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

const NOW = '2026-06-04T08:00:00.000Z';

function makeTab(overrides: Record<string, unknown> = {}) {
  return {
    id: 't-1',
    url: 'https://example.com/page',
    title: 'Example Page',
    favicon: '',
    createdAt: NOW,
    lastAccessed: NOW,
    pinned: false,
    ...overrides,
  };
}

function makeGroup(overrides: Record<string, unknown> = {}) {
  return {
    id: 'g-1',
    name: 'Work',
    tabs: [makeTab()],
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    version: 1,
    ...overrides,
  };
}

before(async () => {
  register(LOADER_PATH);
});

describe('AdvancedSearch.search: 基础匹配', () => {
  it('空 query 返回 []', async () => {
    const { AdvancedSearch } = await import('@/utils/search');
    const groups = [makeGroup()];
    assert.deepEqual(AdvancedSearch.search(groups, { query: '' }), []);
    assert.deepEqual(AdvancedSearch.search(groups, { query: '   ' }), [], '纯空白 query 也应返回 []');
  });

  it('匹配标题（partial 默认）', async () => {
    const { AdvancedSearch } = await import('@/utils/search');
    const groups = [makeGroup({ tabs: [makeTab({ title: 'GitHub Repository' })] })];
    const results = AdvancedSearch.search(groups, { query: 'github' });
    assert.equal(results.length, 1);
    assert.equal(results[0].tab.title, 'GitHub Repository');
  });

  it('匹配 URL（默认开启）', async () => {
    const { AdvancedSearch } = await import('@/utils/search');
    const groups = [makeGroup({ tabs: [makeTab({ title: 'Other', url: 'https://github.com/user/repo' })] })];
    const results = AdvancedSearch.search(groups, { query: 'github' });
    assert.equal(results.length, 1, 'URL 部分匹配应能找到');
  });

  it('匹配 group name', async () => {
    const { AdvancedSearch } = await import('@/utils/search');
    const groups = [makeGroup({ name: 'Research Papers', tabs: [makeTab({ title: 'Unrelated Title' })] })];
    const results = AdvancedSearch.search(groups, { query: 'research' });
    assert.equal(results.length, 1, 'group name 匹配也应返回 tab');
  });

  it('匹配 notes', async () => {
    const { AdvancedSearch } = await import('@/utils/search');
    const groups = [makeGroup({
      tabs: [makeTab({ title: 'Generic' })],
      notes: 'TODO: review important bug fix',
    })];
    const results = AdvancedSearch.search(groups, { query: 'important' });
    assert.equal(results.length, 1, 'notes 匹配也应返回');
  });

  it('完全不匹配返回 []', async () => {
    const { AdvancedSearch } = await import('@/utils/search');
    const groups = [makeGroup({ tabs: [makeTab({ title: 'Hello', url: 'https://hello.com' })] })];
    assert.deepEqual(AdvancedSearch.search(groups, { query: 'xyz123' }), []);
  });
});

describe('AdvancedSearch.search: exactMatch 选项', () => {
  it('exactMatch=true 时 partial 不再匹配', async () => {
    const { AdvancedSearch } = await import('@/utils/search');
    const groups = [makeGroup({ tabs: [makeTab({ title: 'GitHub Pro' })] })];
    // partial: 'github' 匹配 'GitHub Pro'
    assert.equal(AdvancedSearch.search(groups, { query: 'github' }).length, 1);
    // exact: 'github' 不匹配 'GitHub Pro'
    assert.equal(AdvancedSearch.search(groups, { query: 'github', exactMatch: true }).length, 0);
  });

  it('exactMatch=true 时精确匹配能找到', async () => {
    const { AdvancedSearch } = await import('@/utils/search');
    const groups = [makeGroup({ tabs: [makeTab({ title: 'GitHub Pro' })] })];
    // case-insensitive exact
    assert.equal(AdvancedSearch.search(groups, { query: 'GitHub Pro' }).length, 1);
    // exact 精确匹配
    assert.equal(
      AdvancedSearch.search(groups, { query: 'GitHub Pro', exactMatch: true }).length,
      1
    );
  });
});

describe('AdvancedSearch.search: caseSensitive 选项', () => {
  it('默认 case-insensitive', async () => {
    const { AdvancedSearch } = await import('@/utils/search');
    const groups = [makeGroup({ tabs: [makeTab({ title: 'GitHub' })] })];
    assert.equal(AdvancedSearch.search(groups, { query: 'github' }).length, 1);
    assert.equal(AdvancedSearch.search(groups, { query: 'GITHUB' }).length, 1);
  });

  it('caseSensitive=true 时大小写必须严格匹配', async () => {
    const { AdvancedSearch } = await import('@/utils/search');
    const groups = [makeGroup({ tabs: [makeTab({ title: 'GitHub' })] })];
    assert.equal(AdvancedSearch.search(groups, { query: 'github', caseSensitive: true }).length, 0);
    assert.equal(AdvancedSearch.search(groups, { query: 'GitHub', caseSensitive: true }).length, 1);
  });
});

describe('AdvancedSearch.search: 字段开关', () => {
  it('searchTitles=false 不匹配 title', async () => {
    const { AdvancedSearch } = await import('@/utils/search');
    const groups = [makeGroup({ tabs: [makeTab({ title: 'SpecialTitle' })] })];
    assert.equal(AdvancedSearch.search(groups, { query: 'special', searchTitles: false }).length, 0);
  });

  it('searchUrls=false 不匹配 url', async () => {
    const { AdvancedSearch } = await import('@/utils/search');
    const groups = [makeGroup({ tabs: [makeTab({ url: 'https://specialdomain.com/x' })] })];
    assert.equal(AdvancedSearch.search(groups, { query: 'specialdomain', searchUrls: false }).length, 0);
  });

  it('searchNotes=false 不匹配 notes', async () => {
    const { AdvancedSearch } = await import('@/utils/search');
    const groups = [makeGroup({
      tabs: [makeTab({ title: 'NoMatch' })],
      notes: 'specialkeyword in notes',
    })];
    assert.equal(AdvancedSearch.search(groups, { query: 'specialkeyword', searchNotes: false }).length, 0);
  });
});

describe('AdvancedSearch.search: 过滤器', () => {
  it('domainFilter 过滤 hostname', async () => {
    const { AdvancedSearch } = await import('@/utils/search');
    const groups = [
      makeGroup({ tabs: [makeTab({ url: 'https://github.com/a', title: 'GH' })] }),
      makeGroup({ tabs: [makeTab({ url: 'https://gitlab.com/b', title: 'GL' })] }),
    ];
    const results = AdvancedSearch.search(groups, { query: '.com', domainFilter: 'github' });
    assert.equal(results.length, 1, '应只返回 github.com 的结果');
    assert.equal(results[0].tab.title, 'GH');
  });

  it('groupNameFilter 过滤 group', async () => {
    const { AdvancedSearch } = await import('@/utils/search');
    const groups = [
      makeGroup({ id: 'g-1', name: 'Work', tabs: [makeTab({ title: 'A' })] }),
      makeGroup({ id: 'g-2', name: 'Personal', tabs: [makeTab({ title: 'A' })] }),
    ];
    const results = AdvancedSearch.search(groups, { query: 'A', groupNameFilter: 'Work' });
    assert.equal(results.length, 1);
    assert.equal(results[0].group.name, 'Work');
  });

  it('pinnedOnly 只返回 pinned tab', async () => {
    const { AdvancedSearch } = await import('@/utils/search');
    const groups = [makeGroup({
      tabs: [
        makeTab({ id: 't-1', title: 'PinnedOne', pinned: true }),
        makeTab({ id: 't-2', title: 'PinnedTwo', pinned: false }),
      ],
    })];
    const results = AdvancedSearch.search(groups, { query: 'Pinned', pinnedOnly: true });
    assert.equal(results.length, 1);
    assert.equal(results[0].tab.id, 't-1');
  });

  it('unpinnedOnly 只返回非 pinned tab', async () => {
    const { AdvancedSearch } = await import('@/utils/search');
    const groups = [makeGroup({
      tabs: [
        makeTab({ id: 't-1', title: 'PinnedOne', pinned: true }),
        makeTab({ id: 't-2', title: 'NotPinned', pinned: false }),
      ],
    })];
    const results = AdvancedSearch.search(groups, { query: 'P', unpinnedOnly: true });
    assert.equal(results.length, 1);
    assert.equal(results[0].tab.id, 't-2');
  });
});

describe('AdvancedSearch.search: 评分排序', () => {
  it('pinned tab 比非 pinned 同匹配分更高', async () => {
    const { AdvancedSearch, SCORE_WEIGHTS } = await import('@/utils/search');
    const groups = [makeGroup({
      tabs: [
        makeTab({ id: 't-1', url: 'https://x.com/1', title: 'Match', pinned: false }),
        makeTab({ id: 't-2', url: 'https://x.com/2', title: 'Match', pinned: true }),
      ],
    })];
    const results = AdvancedSearch.search(groups, { query: 'Match' });
    assert.equal(results.length, 2);
    assert.ok(
      results[0].tab.id === 't-2',
      'pinned 应排在前面（bonus 分）'
    );
    assert.equal(
      results[0].score - results[1].score,
      SCORE_WEIGHTS.PINNED_BONUS,
      'pinned bonus 应等于 PINNED_BONUS'
    );
  });

  it('title exact 匹配比 partial 评分高', async () => {
    const { AdvancedSearch, SCORE_WEIGHTS } = await import('@/utils/search');
    const groups = [
      makeGroup({ tabs: [makeTab({ id: 't-1', title: 'Hello world', url: 'https://other.com' })] }),
      makeGroup({ tabs: [makeTab({ id: 't-2', title: 'exact', url: 'https://exact.com' })] }),
    ];
    const results = AdvancedSearch.search(groups, { query: 'exact', exactMatch: true });
    // t-2 应该 title + url 都 exact 匹配，得分最高
    assert.equal(results.length, 1);
    assert.equal(results[0].tab.id, 't-2');
  });

  it('结果按 score 降序', async () => {
    const { AdvancedSearch } = await import('@/utils/search');
    const groups = [
      makeGroup({ id: 'g-1', tabs: [makeTab({ id: 't-low', title: 'just contains keyword', url: 'https://other.com' })] }),
      makeGroup({ id: 'g-2', tabs: [makeTab({ id: 't-high', title: 'keyword', url: 'https://keyword.com' })] }),
    ];
    const results = AdvancedSearch.search(groups, { query: 'keyword' });
    assert.ok(results.length >= 1);
    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i - 1].score >= results[i].score, '结果必须按 score 降序');
    }
  });
});

describe('AdvancedSearch.search: matches 元数据', () => {
  it('返回 matches 数组说明命中字段', async () => {
    const { AdvancedSearch } = await import('@/utils/search');
    const groups = [makeGroup({
      name: 'Research',
      tabs: [makeTab({ title: 'GitHub Article', url: 'https://github.com/x' })],
    })];
    const results = AdvancedSearch.search(groups, { query: 'github' });
    assert.equal(results.length, 1);
    const fields = results[0].matches.map(m => m.field);
    assert.ok(fields.includes('title'), 'title 匹配应在 matches 中');
    assert.ok(fields.includes('url'), 'url 匹配应在 matches 中');
  });

  it('match.startIndex 正确', async () => {
    const { AdvancedSearch } = await import('@/utils/search');
    const groups = [makeGroup({ tabs: [makeTab({ title: 'Some GitHub Project' })] })];
    const results = AdvancedSearch.search(groups, { query: 'github' });
    const titleMatch = results[0].matches.find(m => m.field === 'title');
    assert.ok(titleMatch);
    assert.equal(titleMatch.startIndex, 5, 'github 在 "Some GitHub Project" 中位于索引 5');
  });
});

describe('AdvancedSearch.getSuggestions', () => {
  it('空 input 返回 []', async () => {
    const { AdvancedSearch } = await import('@/utils/search');
    assert.deepEqual(AdvancedSearch.getSuggestions([makeGroup()], ''), []);
  });

  it('从 group name / title / url hostname 提取建议', async () => {
    const { AdvancedSearch } = await import('@/utils/search');
    const groups = [
      makeGroup({
        name: 'GitHub Repos',
        notes: 'GitHub notes',
        tabs: [
          makeTab({ title: 'GitHub Home', url: 'https://github.com/abc' }),
          makeTab({ title: 'Other', url: 'https://other.com' }),
        ],
      }),
    ];
    const suggestions = AdvancedSearch.getSuggestions(groups, 'git');
    assert.ok(suggestions.includes('GitHub Repos'), 'group name 应作为建议');
    assert.ok(suggestions.includes('GitHub Home'), 'tab title 应作为建议');
    assert.ok(suggestions.includes('github.com'), 'hostname 应作为建议');
  });

  it('去重', async () => {
    const { AdvancedSearch } = await import('@/utils/search');
    const groups = [
      makeGroup({
        name: 'SameName',
        tabs: [
          makeTab({ title: 'SameName', url: 'https://a.com' }),
          makeTab({ title: 'SameName', url: 'https://b.com' }),
        ],
      }),
    ];
    const suggestions = AdvancedSearch.getSuggestions(groups, 'same');
    assert.equal(suggestions.length, 1, '去重后只应有 1 个');
  });

  it('limit 限制返回数量', async () => {
    const { AdvancedSearch } = await import('@/utils/search');
    const groups = [
      makeGroup({ name: 'a1', tabs: [makeTab({ title: 'a2' })] }),
      makeGroup({ name: 'a3', tabs: [makeTab({ title: 'a4' })] }),
      makeGroup({ name: 'a5', tabs: [makeTab({ title: 'a6' })] }),
    ];
    const suggestions = AdvancedSearch.getSuggestions(groups, 'a', 2);
    assert.equal(suggestions.length, 2);
  });

  it('忽略无效 URL', async () => {
    const { AdvancedSearch } = await import('@/utils/search');
    const groups = [
      makeGroup({ tabs: [makeTab({ url: 'not-a-valid-url', title: 'Test' })] }),
    ];
    const suggestions = AdvancedSearch.getSuggestions(groups, 'test');
    assert.ok(suggestions.includes('Test'), '标题仍应作为建议');
  });
});

describe('AdvancedSearch.getFilterOptions', () => {
  it('返回唯一 domains 和 groupNames', async () => {
    const { AdvancedSearch } = await import('@/utils/search');
    const groups = [
      makeGroup({ name: 'Group A', tabs: [makeTab({ url: 'https://github.com/1' })] }),
      makeGroup({ name: 'Group B', tabs: [makeTab({ url: 'https://github.com/2' })] }),
      makeGroup({ name: 'Group C', tabs: [makeTab({ url: 'https://gitlab.com/1' })] }),
    ];
    const options = AdvancedSearch.getFilterOptions(groups);
    assert.deepEqual(options.domains, ['github.com', 'gitlab.com']);
    assert.deepEqual(options.groupNames, ['Group A', 'Group B', 'Group C']);
  });

  it('跳过无效 URL', async () => {
    const { AdvancedSearch } = await import('@/utils/search');
    const groups = [
      makeGroup({ tabs: [makeTab({ url: 'invalid-url' })] }),
      makeGroup({ tabs: [makeTab({ url: 'https://valid.com' })] }),
    ];
    const options = AdvancedSearch.getFilterOptions(groups);
    assert.deepEqual(options.domains, ['valid.com']);
  });

  it('空数组返回空 options', async () => {
    const { AdvancedSearch } = await import('@/utils/search');
    assert.deepEqual(AdvancedSearch.getFilterOptions([]), { domains: [], groupNames: [] });
  });
});

describe('applySearchFilters: 后期过滤', () => {
  it('domain 过滤', async () => {
    const { applySearchFilters } = await import('@/utils/search');
    const results = [
      { tab: makeTab({ url: 'https://github.com/1' }), group: makeGroup(), score: 1, matches: [] },
      { tab: makeTab({ url: 'https://gitlab.com/2' }), group: makeGroup(), score: 1, matches: [] },
    ] as any;
    const filtered = applySearchFilters(results, { domain: 'github' });
    assert.equal(filtered.length, 1);
  });

  it('pinned=only 过滤非 pinned', async () => {
    const { applySearchFilters } = await import('@/utils/search');
    const results = [
      { tab: makeTab({ pinned: true }), group: makeGroup(), score: 1, matches: [] },
      { tab: makeTab({ pinned: false }), group: makeGroup(), score: 1, matches: [] },
    ] as any;
    const filtered = applySearchFilters(results, { pinned: 'only' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].tab.pinned, true);
  });

  it('pinned=exclude 过滤 pinned', async () => {
    const { applySearchFilters } = await import('@/utils/search');
    const results = [
      { tab: makeTab({ pinned: true }), group: makeGroup(), score: 1, matches: [] },
      { tab: makeTab({ pinned: false }), group: makeGroup(), score: 1, matches: [] },
    ] as any;
    const filtered = applySearchFilters(results, { pinned: 'exclude' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].tab.pinned, false);
  });

  it('pinned=all 不影响结果', async () => {
    const { applySearchFilters } = await import('@/utils/search');
    const results = [
      { tab: makeTab({ pinned: true }), group: makeGroup(), score: 1, matches: [] },
      { tab: makeTab({ pinned: false }), group: makeGroup(), score: 1, matches: [] },
    ] as any;
    assert.equal(applySearchFilters(results, { pinned: 'all' }).length, 2);
  });
});

describe('buildSessionSearchResults: 按 session 分组', () => {
  it('同一 group 的多个 tab 合并到一个 session', async () => {
    const { buildSessionSearchResults } = await import('@/utils/search');
    const group = makeGroup({
      id: 'g-1',
      tabs: [
        makeTab({ id: 't-1', title: 'Match A' }),
        makeTab({ id: 't-2', title: 'Match B' }),
      ],
    });
    const results = [
      { tab: group.tabs[0], group, score: 50, matches: [] },
      { tab: group.tabs[1], group, score: 30, matches: [] },
    ] as any;
    const sessions = buildSessionSearchResults(results);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].matches.length, 2);
    assert.equal(sessions[0].score, 50, 'session score = 最高 tab score');
  });

  it('不同 group 拆为多个 session', async () => {
    const { buildSessionSearchResults } = await import('@/utils/search');
    const g1 = makeGroup({ id: 'g-1', tabs: [makeTab({ id: 't-1' })] });
    const g2 = makeGroup({ id: 'g-2', tabs: [makeTab({ id: 't-2' })] });
    const results = [
      { tab: g1.tabs[0], group: g1, score: 50, matches: [] },
      { tab: g2.tabs[0], group: g2, score: 30, matches: [] },
    ] as any;
    const sessions = buildSessionSearchResults(results);
    assert.equal(sessions.length, 2);
  });

  it('按 score 降序排序', async () => {
    const { buildSessionSearchResults } = await import('@/utils/search');
    const g1 = makeGroup({ id: 'g-1', tabs: [makeTab()] });
    const g2 = makeGroup({ id: 'g-2', tabs: [makeTab()] });
    const results = [
      { tab: g1.tabs[0], group: g1, score: 30, matches: [] },
      { tab: g2.tabs[0], group: g2, score: 50, matches: [] },
    ] as any;
    const sessions = buildSessionSearchResults(results);
    assert.equal(sessions[0].group.id, 'g-2', '高分 group 应在前');
  });
});
