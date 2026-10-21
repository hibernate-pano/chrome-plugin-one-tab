// 筛选器必须**不依赖搜索词**可达，且筛选条件必须**跨搜索持续存在**
// （2026-10-20 审计 A-14）。
//
// ── 这个文件要防的具体事故 ────────────────────────────────────────────────
//
// 事故 ①：**筛选器不可达**（声明 ≠ 行为）
//
//   README 写「可按域名、固定标签、保存时间继续筛选」；
//   商店页写「会话搜索：按会话名、标签标题/网址查找，支持按域名过滤」；
//   引导页有「按域名过滤」「按时间过滤」两张**能力卡片**（给新用户看的速览）。
//
//   而实现上三个筛选器只住在 `SearchResultList` 里，它只在**有搜索词**时挂载：
//     `TabList`: `{searchQuery ? <SearchResultList/> : ...}`
//
//   ⇒ 用户想做的事（「我记得是某个网站的那些标签，但记不清网址」）被卡在
//   「必须先输入一个搜索词」上 —— 而他正因为记不清网址才搜不出来。
//   「按域名过滤」被降级成「搜索结果的二次收窄器」，不再是文档承诺的检索入口。
//   引导页那两张卡片对**新用户**说的就是一件做不到的事。
//
// 事故 ②：**筛选条件随搜索词一起丢失**
//
//   `filters` / `showFilters` 原先是 `SearchResultList` 的内部 `useState`
//   ⇒ 清空搜索词 ⇒ 组件卸载 ⇒ **筛选条件与面板展开状态全部丢失**。
//
//   用户场景：搜「react」→ 展开筛选 → 选「7 天内」→ 搜错了 → 清空重搜「redux」
//   ⇒ 条件没了。而「换个关键词继续筛」是搜索的**主用法**。
//
// 事故 ③：**看不见但条件在生效**
//
//   条件生效时用户必须看得见（徽章 + 「清空筛选」）。
//   任何「条件在筛结果、界面上却看不出来」的形态都是最坏的隐形行为。
//
// ── 判据从代码取事实还是从文档取事实 ─────────────────────────────────────
//
// **从代码取事实**（判据一律基于实现里真实存在的结构，不基于任何文案字面量）：
//
//   · 筛选控件（域名 / 会话名 / 保存时间 / 固定标签）在**没有搜索词**时
//     也必须能渲染 ⇒ 判据是「面板的渲染点不被搜索词条件包住」。
//   · 筛选状态的**动作集合里不得有**「按搜索词重置」这一类动作
//     ⇒ 判据是 reducer 的 action 类型集合。
//   · 「没有搜索词时不得说『没找到与 X 相关』」⇒ 判据是**渲染出来的事实**
//     （真的渲染一遍，看输出的 HTML 里有没有那句话），不是源码里有没有这句。
//
// **从文档取事实**的只有一处，且只用来确认「文档确实承诺了这件事」：
//   README / 商店页 / 引导页都写了「按域名过滤」这类能力。
//   这一条是为了让守卫在**文档把承诺删掉**时也红（那时产品就该同步收文案）。
//
// ── 为什么这样判 ─────────────────────────────────────────────────────────
//
// · 「筛选器可达」是**产品能力**层面的不变量，只能由「控件在无搜索词时也渲染」
//   来证明。断言「源码里有这个 input」不够 —— 它可能在一条永不渲染的分支里。
//   所以这里用 `react-dom/server` **真的渲染一遍**（本仓没有 DOM 环境，
//   但服务端渲染能给出真实的 HTML 字符串，见 tests/overwritePreviewRender.test.ts）。
// · 「条件不丢失」是**状态机**层面的不变量。断言「源码里没有 useEffect 清条件」
//   是间接推断（将来换个写法照样会丢）；断言「reducer 没有这类动作」是
//   结构性保证 —— 搜索词压根不在状态机里。
// · 空态文案这类**诚实度**问题只能靠渲染后的 HTML 判定：源码里写着「没有找到」
//   但那段 JSX 永远走不到，一样是骗用户。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  initialSearchFilterState,
  searchFilterReducer,
} from '../../src/components/search/searchFilterState.ts';
import {
  buildBrowseResults,
  countActiveSearchFilters,
  resolveActiveFilterState,
  resolveSearchViewMode,
} from '../../src/components/search/searchBrowseMode.ts';
import { applySearchFilters, type SearchFilters } from '../../src/utils/search.ts';
import type { Tab, TabGroup } from '../../src/types/tab.ts';

const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

/** 去注释后的源码：注释里会引用旧写法，不能参与断言。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

const TAB_LIST = read('src/components/tabs/TabList.tsx');
const SEARCH_RESULT_LIST = read('src/components/search/SearchResultList.tsx');
const FILTER_PANEL = read('src/components/search/SearchFilterPanel.tsx');
const FILTER_STATE = read('src/components/search/searchFilterState.ts');
const FILTER_HOOK = read('src/components/search/useSearchFilters.ts');
const README = read('README.md');
const STORE_PAGE = read('CHROMEWEBSTORE.md');
const ONBOARDING = read('src/components/onboarding/OnboardingSteps.tsx');

// ════════════════════════════════════════════════════════════════════════
// 0. 文档确实承诺了「按域名 / 按时间过滤」这件事
//    （守卫在文档把承诺收掉时也要红 —— 那时产品就该同步改代码）
// ════════════════════════════════════════════════════════════════════════

describe('0. 前置事实：文档确实把筛选当独立能力承诺', () => {
  it('README 承诺了按域名 / 按时间筛选', () => {
    assert.match(README, /域名/, 'README 必须声明按域名筛选');
  });

  it('商店页承诺了按域名过滤', () => {
    assert.match(STORE_PAGE, /域名过滤/, '商店页必须声明按域名过滤');
  });

  it('引导页把「按域名过滤」「按时间过滤」列为能力', () => {
    // 这两张卡片是给新用户看的「产品能做什么」速览。
    // 若某张卡片描述的能力需要先做某个前置操作才生效，那张卡片本身就是误导。
    assert.match(ONBOARDING, /按域名过滤/, '引导页必须列出按域名过滤');
    assert.match(ONBOARDING, /按时间过滤/, '引导页必须列出按时间过滤');
  });

  it('文档不得把筛选说成「搜索之后才能用」', () => {
    // 修复前：筛选器只在有搜索词时才渲染 ⇒ 文档（README / 商店页 / 引导页）
    // 把它当独立能力宣传，实际上要「先输入一个搜索词」才能用。
    //
    // 判据：文档**不得**把筛选描述成搜索结果的后续步骤。
    // 措辞可以变（不钉字面量），但语义不能是「搜完才能筛」。
    const docs = `${README}\n${STORE_PAGE}`;
    for (const line of docs.split('\n')) {
      assert.doesNotMatch(
        line,
        /继续筛选|再筛选|搜索结果.{0,6}筛选|筛选.{0,6}搜索结果/,
        `这句把筛选说成了搜索之后的后续步骤：${line.trim()}\n` +
          '筛选必须是不依赖搜索词的独立入口'
      );
    }
  });

  it('README 不得无条件承诺「固定标签」筛选（它有显示前提）', () => {
    // 「固定标签页」筛选器只在设置里开启「保存固定标签页」时出现
    // （关闭时存进会话的标签 pinned 恒为 false，这个筛选器形同虚设）。
    // 无条件承诺它 = 引导用户去找一个他看不到的控件。
    const filterLine = README.split('\n').find(line => line.includes('固定标签') && line.includes('筛选'));
    if (filterLine) {
      assert.match(
        filterLine,
        /设置|开启|仅在|才会出现|不出现|关闭/,
        `README 无条件承诺了「固定标签」筛选：${filterLine.trim()}`
      );
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// 1. 判据层（纯函数）：形态、计数、有效性
// ════════════════════════════════════════════════════════════════════════

describe('1. 视图形态：有搜索词才搜，没搜索词但有条件就筛', () => {
  it('有搜索词 ⇒ 搜索形态（既有行为不变）', () => {
    assert.equal(resolveSearchViewMode('react', false), 'search');
    assert.equal(resolveSearchViewMode('react', true), 'search');
  });

  it('没搜索词、没条件 ⇒ 列表形态（首页性质不变）', () => {
    assert.equal(resolveSearchViewMode('', false), 'list');
    assert.equal(resolveSearchViewMode('   ', false), 'list');
  });

  it('没搜索词、有条件 ⇒ 筛选浏览形态（筛选器成为独立检索入口）', () => {
    assert.equal(resolveSearchViewMode('', true), 'browse');
    assert.equal(resolveSearchViewMode('  ', true), 'browse');
  });

  it('三种形态必须两两不同（否则「形态」这个词没有意义）', () => {
    const modes = new Set([
      resolveSearchViewMode('q', false),
      resolveSearchViewMode('', false),
      resolveSearchViewMode('', true),
    ]);
    assert.equal(modes.size, 3, '三种输入必须给出三种不同形态');
  });
});

describe('1b. 生效条件的计数：与「筛选浏览」形态用同一口径', () => {
  it('纯空白不算生效', () => {
    assert.equal(countActiveSearchFilters({ domain: '   ', groupName: '' }), 0);
  });

  it('四个维度各自都算生效', () => {
    assert.equal(countActiveSearchFilters({ domain: 'github.com' }), 1);
    assert.equal(countActiveSearchFilters({ groupName: '调研' }), 1);
    assert.equal(countActiveSearchFilters({ savedWithin: '7d' }), 1);
    assert.equal(countActiveSearchFilters({ pinned: 'only' }), 1);
    assert.equal(countActiveSearchFilters({ pinned: 'exclude' }), 1);
  });

  it("'all' 不是生效的筛选", () => {
    assert.equal(countActiveSearchFilters({ pinned: 'all' }), 0);
  });

  it('计数与形态判定同源：计数 > 0 ⇔ 进入筛选浏览形态', () => {
    // 徽章说「0 个筛选」而视图却已按条件筛过 —— 那是最坏的隐形行为。
    const cases: SearchFilters[] = [
      {},
      { domain: 'github.com' },
      { groupName: '调研', savedWithin: '7d' },
      { domain: '  ' },
    ];
    for (const filters of cases) {
      const count = countActiveSearchFilters(filters);
      const mode = resolveSearchViewMode('', count > 0);
      assert.equal(
        mode === 'browse',
        count > 0,
        `条件 ${JSON.stringify(filters)} ⇒ 计数 ${count}，形态 ${mode}，两者必须一致`
      );
    }
  });
});

describe('1c. 固定标签条件在设置关闭时作废（可见性与有效性同源）', () => {
  it('设置关闭 ⇒ 固定标签条件不参与过滤，计数也不含它', () => {
    const { effectiveFilters, activeFilterCount } = resolveActiveFilterState(
      { pinned: 'only', domain: 'github.com' },
      false
    );
    assert.equal(effectiveFilters.pinned, undefined);
    assert.equal(activeFilterCount, 1, '只剩域名一个维度生效');
  });

  it('设置开启 ⇒ 条件原样保留', () => {
    const { effectiveFilters, activeFilterCount } = resolveActiveFilterState(
      { pinned: 'only' },
      true
    );
    assert.equal(effectiveFilters.pinned, 'only');
    assert.equal(activeFilterCount, 1);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2. 空搜索词下的结果集：必须是**全部标签**
//    （否则会话级筛选没有判据可作用 ⇒「按会话名找」永远筛不出东西）
// ════════════════════════════════════════════════════════════════════════

const makeTab = (overrides: Partial<Tab> = {}): Tab => ({
  id: 'tab-1',
  url: 'https://example.com/a',
  title: '示例',
  createdAt: '2026-10-20T00:00:00.000Z',
  lastAccessed: '2026-10-20T00:00:00.000Z',
  pinned: false,
  ...overrides,
});

const makeGroup = (overrides: Partial<TabGroup> = {}): TabGroup => ({
  id: 'group-1',
  name: '会话',
  tabs: [],
  createdAt: '2026-10-20T00:00:00.000Z',
  updatedAt: '2026-10-20T00:00:00.000Z',
  isLocked: false,
  ...overrides,
});

describe('2. 会话级筛选在空搜索词下必须能命中', () => {
  it('结果集含全部会话的全部标签', () => {
    const groups = [
      makeGroup({ id: 'g1', name: '甲', tabs: [makeTab({ id: 't1' }), makeTab({ id: 't2' })] }),
      makeGroup({ id: 'g2', name: '乙', tabs: [makeTab({ id: 't3' })] }),
    ];
    const results = buildBrowseResults(groups);
    assert.equal(results.length, 3, '三个标签都要在结果集里');
    assert.deepEqual(
      results.map(r => r.tab.id).sort(),
      ['t1', 't2', 't3']
    );
  });

  it('「按会话名筛选」在空搜索词下能筛出该会话的标签', () => {
    const groups = [
      makeGroup({ id: 'g1', name: '调研资料', tabs: [makeTab({ id: 't1' })] }),
      makeGroup({ id: 'g2', name: '购物车', tabs: [makeTab({ id: 't2' })] }),
    ];
    const browse = buildBrowseResults(groups);
    const filtered = applySearchFilters(browse, { groupName: '调研' });
    assert.equal(filtered.length, 1, '会话级筛选必须有判据可作用');
    assert.equal(filtered[0].tab.id, 't1');
  });

  it('「按保存时间筛选」在空搜索词下能筛出会话', () => {
    const groups = [
      makeGroup({ id: 'g1', name: '旧会话', createdAt: '2020-01-01T00:00:00.000Z', tabs: [makeTab({ id: 't1' })] }),
      makeGroup({ id: 'g2', name: '新会话', createdAt: new Date().toISOString(), tabs: [makeTab({ id: 't2' })] }),
    ];
    const browse = buildBrowseResults(groups);
    const filtered = applySearchFilters(browse, { savedWithin: '24h' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].tab.id, 't2');
  });

  it('「按域名筛选」在空搜索词下能筛出标签（标签级判据）', () => {
    const groups = [
      makeGroup({ id: 'g1', tabs: [makeTab({ id: 't1', url: 'https://github.com/x' })] }),
      makeGroup({ id: 'g2', tabs: [makeTab({ id: 't2', url: 'https://example.com/y' })] }),
    ];
    const browse = buildBrowseResults(groups);
    const filtered = applySearchFilters(browse, { domain: 'github.com' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].tab.id, 't1');
  });

  it('会话级条件命中时，该会话的标签**全部**入选（不是只入选一条）', () => {
    const groups = [
      makeGroup({ id: 'g1', name: '调研', tabs: [makeTab({ id: 't1' }), makeTab({ id: 't2' })] }),
    ];
    const filtered = applySearchFilters(buildBrowseResults(groups), { groupName: '调研' });
    assert.equal(filtered.length, 2, '会话入选 ⇒ 它的标签都该在结果里');
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3. 状态机层：筛选条件不随搜索词丢失
// ════════════════════════════════════════════════════════════════════════

describe('3. 筛选状态机：没有任何动作能清掉条件', () => {
  it('动作集合里不得有「按搜索词重置」这类动作', () => {
    // 结构性保证：搜索词压根不在状态机里 ⇒ 它不可能影响条件。
    // 这比「源码里没有 useEffect 清条件」强得多（后者是间接推断）。
    const actions = [...FILTER_STATE.matchAll(/type:\s*'([^']+)'/g)].map(m => m[1]);
    assert.ok(actions.length > 0, '应能找到动作类型');
    for (const action of actions) {
      assert.doesNotMatch(
        action,
        /query|search|reset|clearAll/i,
        `动作「${action}」看起来会重置条件 —— 搜索词变化不得影响筛选条件`
      );
    }
  });

  it('持有状态的 hook 不得接收搜索词作为输入', () => {
    // 【为什么要这一条】上一版守卫只查了 reducer 的动作名，于是「在 hook 里
    // 用一个 effect 监听搜索词、变了就清条件」这个**真实缺陷形态**完全逃过了
    // （变异验证 M2 实测：31 条守卫全绿）。
    //
    // 根因：状态机的动作名是干净的，但**触发动作的时机**不在动作名里。
    // 「状态的所有者不得知道搜索词」才是那条不变式的结构性保证 ——
    // 它不知道搜索词，就不可能被搜索词影响。
    const hook = stripComments(FILTER_HOOK);
    const signature = hook.match(/export const useSearchFilters\s*=\s*\(([^)]*)\)/);
    assert.ok(signature, '应能找到 useSearchFilters 的签名');
    assert.equal(
      signature[1].trim(),
      '',
      `useSearchFilters 不得接收参数（当前收到「${signature[1]}」）—— ` +
        '持有筛选状态的地方一旦知道搜索词，就可能被搜索词影响'
    );
  });

  it('持有状态的 hook 里不得有 effect（外部输入无法借它重置条件）', () => {
    // 与上一条同源：**唯一**能让状态随外部输入变化的方式就是 effect。
    // 「清空搜索词 ⇒ 条件消失」这种缺陷在实现上必然长得像
    // 「useEffect(…, [searchQuery]) 里 dispatch(clear)」。
    const hook = stripComments(FILTER_HOOK);
    assert.doesNotMatch(
      hook,
      /useEffect/,
      'useSearchFilters 里不得有 useEffect —— 那是「外部输入重置筛选条件」的唯一入口'
    );
  });

  it('每个动作只有一条派发路径（不得有第二条隐藏的重置路径）', () => {
    // 判据：状态只能被用户的三个显式操作改变。
    // 若同一个动作在两处被派发（例如「用户点清空」+「搜索词变化时自动清」），
    // 就多出了一条用户没点过、却把条件清掉的路径。
    const hook = stripComments(FILTER_HOOK);
    const dispatched = [...hook.matchAll(/dispatch\(\s*\{\s*type:\s*'([^']+)'/g)].map(m => m[1]);
    assert.ok(dispatched.length > 0, '应能找到派发的动作');
    const explicit = new Set(dispatched);
    assert.equal(
      explicit.size,
      dispatched.length,
      `动作被派发了多次：${dispatched.join(', ')} —— 存在用户没点过也能触发状态的路径`
    );
    for (const action of dispatched) {
      assert.match(
        action,
        /^filters\/(update|clear|togglePanel)$/,
        `动作「${action}」不在三个显式用户操作之内`
      );
    }
  });

  it('设了条件之后，任何一个动作都不会把它清掉（除「用户显式清空」）', () => {
    const withFilters = { filters: { domain: 'github.com' }, showFilters: true };
    // 遍历所有非清空动作
    const actionTypes = [...FILTER_STATE.matchAll(/type:\s*'(filters\/[a-zA-Z]+)'/g)].map(m => m[1]);
    for (const type of actionTypes) {
      if (type === 'filters/clear') continue;
      const next = searchFilterReducer(withFilters, {
        type,
        updater: (current: Record<string, unknown>) => current,
      } as never);
      assert.deepEqual(
        next.filters,
        withFilters.filters,
        `动作「${type}」不得清掉筛选条件`
      );
    }
  });

  it('「展开/收起面板」不动条件，「改条件」不动展开状态', () => {
    const state = { filters: { domain: 'github.com' }, showFilters: false };
    const toggled = searchFilterReducer(state, { type: 'filters/togglePanel' });
    assert.equal(toggled.showFilters, true);
    assert.deepEqual(toggled.filters, state.filters);

    const updated = searchFilterReducer(state, {
      type: 'filters/update',
      updater: () => ({ domain: 'example.com' }),
    });
    assert.equal(updated.showFilters, false, '改条件不得顺手展开/收起面板');
    assert.deepEqual(updated.filters, { domain: 'example.com' });
  });

  it('「清空筛选」清掉条件，但**保留**面板展开状态', () => {
    // 用户刚清空条件，通常是要马上重设 —— 面板一收起来就得再点一次。
    const cleared = searchFilterReducer(
      { filters: { domain: 'github.com' }, showFilters: true },
      { type: 'filters/clear' }
    );
    assert.deepEqual(cleared.filters, {});
    assert.equal(cleared.showFilters, true, '清空条件不该把面板收起来');
  });

  it('reducer 不就地修改入参', () => {
    const state = { filters: { domain: 'github.com' }, showFilters: true };
    const snapshot = JSON.stringify(state);
    searchFilterReducer(state, { type: 'filters/clear' });
    searchFilterReducer(state, { type: 'filters/togglePanel' });
    assert.equal(JSON.stringify(state), snapshot, '不得就地改调用方的对象');
  });

  it('初始状态是「无条件、面板收起」', () => {
    assert.deepEqual(initialSearchFilterState.filters, {});
    assert.equal(initialSearchFilterState.showFilters, false);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 4. 接线层：状态住在列表层，筛选面板在无搜索词时也渲染
// ════════════════════════════════════════════════════════════════════════

describe('4. 接线：筛选状态必须活得比结果视图久', () => {
  it('筛选状态由列表层持有（reducer 不在结果视图里）', () => {
    // 结果视图卸载时筛选条件不能跟着没 ⇒ 状态必须住在它外面。
    assert.ok(
      !/useReducer\(searchFilterReducer|useState<SearchFilters>/.test(SEARCH_RESULT_LIST),
      '筛选状态不得住在结果视图里（它只在有搜索词时挂载 ⇒ 卸载即丢）'
    );
    assert.match(
      FILTER_HOOK,
      /useReducer\(searchFilterReducer/,
      '筛选状态必须由列表层的 hook 持有'
    );
    assert.match(
      TAB_LIST,
      /useSearchFilters\(\)/,
      '列表层必须真的持有筛选状态'
    );
  });

  it('结果视图消费列表层给的筛选状态（不是自己造一份）', () => {
    assert.match(
      TAB_LIST,
      /<SearchResultList[^>]*filterControls=/,
      '结果视图必须接收列表层持有的筛选状态'
    );
  });

  it('空搜索词下的结果集必须来自「全部标签」（否则会话级筛选无判据可作用）', () => {
    // 【这一条是被变异验证逼出来的】第一版守卫只测了 `buildBrowseResults` 这个
    // 纯函数本身；实测的变异验证 M6 揭示：把组件里的调用换成「空搜索词下返回空集」
    // （即结果集仍只含搜索命中的标签），**全部守卫依然全绿** ——
    // 因为函数是对的，错的是「组件用它」。
    //
    // 判据：组件在**无搜索词**的那条分支上必须真的用「全部标签」这个来源。
    const src = stripComments(SEARCH_RESULT_LIST);
    const browseUse = src.indexOf('buildBrowseResults(groups)');
    assert.ok(
      browseUse > -1,
      '组件必须在空搜索词的分支上用 buildBrowseResults（全部标签）作为结果集来源'
    );
    // 且这个调用必须在「无搜索词 ⇒ 用全部标签」的判断里，而不是只在搜索分支里。
    const queryBranch = src.indexOf('if (normalizedSearchQuery)');
    assert.ok(queryBranch > -1, '应能找到按搜索词分叉的源头');
    assert.ok(
      browseUse > queryBranch,
      'buildBrowseResults 必须落在「没有搜索词」的那一侧（否则空搜索词时结果集是空的）'
    );
  });

  it('筛选条件生效时，视图形态必须真的跟着变（不许「筛了但看不见」）', () => {
    // 【这一条是被变异验证逼出来的】实测的变异验证 M7：把视图形态的判定
    // 改成「忽略生效的筛选条件」（`resolveSearchViewMode(searchQuery, false)`），
    // 全部守卫**依然全绿** —— 而界面上条件明明生效、列表却显示着全部会话。
    //
    // 那是「看不见但条件在生效」的最坏形态：用户以为筛过了，其实没筛。
    //
    // 判据：视图形态的判定必须**读**生效的筛选条件（不是恒 false、
    // 也不是读某个别的计数）。
    const src = stripComments(TAB_LIST);
    assert.match(
      src,
      /resolveSearchViewMode\(\s*searchQuery\s*,\s*filterControls\.activeFilterCount\s*>\s*0\s*\)/,
      '视图形态必须由「有没有生效的筛选条件」决定 —— 否则条件生效了界面也不变'
    );
  });

  it('筛选面板在列表层被渲染（无搜索词时也有入口）', () => {
    assert.match(
      TAB_LIST,
      /<SearchFilterSection/,
      '列表层必须渲染筛选区 —— 否则无搜索词时筛选器不可达'
    );
  });

  it('列表层的筛选区渲染**不被**搜索词条件包住', () => {
    // 判据：渲染 <SearchFilterSection 的那一段里不得出现
    // 「只有有搜索词才渲染」的写法（如 `{searchQuery && (...)}`）。
    const at = TAB_LIST.indexOf('<SearchFilterSection');
    assert.ok(at > -1, '应能找到列表层的筛选区');
    const before = TAB_LIST.lastIndexOf('{', at);
    const line = TAB_LIST.slice(Math.max(0, before - 40), at);
    assert.doesNotMatch(
      line,
      /searchQuery\s*&&|searchQuery\s*\?/,
      '列表层的筛选区不得被搜索词条件包住 —— 那样筛选器在空搜索时不可达'
    );
  });

  it('筛选面板的控件在同一处渲染（不得出现第二份筛选面板）', () => {
    // 「只渲染一份」的硬要求是**状态**只有一份；这里额外守住「控件不重复定义」。
    const domainInputs = [...FILTER_PANEL.matchAll(/id=\{FILTER_IDS\.domain\}/g)].length;
    assert.equal(domainInputs, 1, '域名筛选控件只能定义一处');
    assert.ok(
      !/id=\{FILTER_IDS\.domain\}/.test(SEARCH_RESULT_LIST),
      '结果视图里不得再自己定义一份筛选控件'
    );
  });

  it('筛选面板的展开状态由列表层控制（结果视图不自己管）', () => {
    assert.ok(
      !/useState\(false\)/.test(SEARCH_RESULT_LIST) || !/showFilters/.test(SEARCH_RESULT_LIST),
      '结果视图不得自己管筛选面板的展开状态'
    );
  });
});

// ════════════════════════════════════════════════════════════════════════
// 5. 渲染层：空搜索词时不得出现误导性的空态
//    （本仓没有 DOM 环境，用 react-dom/server 真的渲染一遍）
// ════════════════════════════════════════════════════════════════════════

/** react-dom/server 依赖 window/localStorage 的一小撮 API（只是桩，不是 DOM 环境）。 */
const lsData = new Map<string, string>();
if (typeof (globalThis as Record<string, unknown>).window === 'undefined') {
  (globalThis as Record<string, unknown>).window = {
    localStorage: {
      get length() {
        return lsData.size;
      },
      key: (i: number) => [...lsData.keys()][i] ?? null,
      getItem: (k: string) => (lsData.has(k) ? lsData.get(k) : null),
      setItem: (k: string, v: string) => void lsData.set(k, String(v)),
      removeItem: (k: string) => void lsData.delete(k),
      clear: () => void lsData.clear(),
    },
    matchMedia: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
  (globalThis as Record<string, unknown>).localStorage = (
    globalThis as unknown as { window: { localStorage: unknown } }
  ).window.localStorage;
}

describe('5. 渲染层：空搜索词的空态不得谎称「没找到 X」', () => {
  it('没有搜索词时，不得出现「没有找到与…相关」这种声称没找到结果的文案', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const React = (await import('react')).default;
    const { browseEmptyDescription, browseEmptyTitle } = await import(
      '../../src/components/search/searchBrowseMode.ts'
    );

    // 直接断言文案函数产出的句子 —— 这是「界面会说的话」的单一来源。
    // 判据是**语义**：句子里不得出现「没找到某个具体东西」的说法。
    const saysNothingFound = (text: string) => /没有找到|没找到/.test(text);
    // 浏览态的空态文案必须说清是**筛选条件**筛空的
    assert.ok(
      saysNothingFound(browseEmptyTitle),
      '筛选浏览态的空态标题必须说清「没找到」这个事实'
    );
    assert.ok(
      !/搜索|关键词/.test(browseEmptyTitle),
      '没有搜索词时，标题里不得出现「搜索」或「关键词」—— 那是在说一件没发生的事'
    );
    assert.ok(
      !/搜索|关键词/.test(browseEmptyDescription),
      '没有搜索词时，说明里不得出现「搜索」或「关键词」'
    );
    assert.ok(
      /筛选|条件/.test(browseEmptyDescription),
      '说明必须说清是**筛选条件**筛空了什么'
    );

    // 渲染层：搜索态的空态文案仍然必须说「没找到」（既有行为不变）
    const html = renderToStaticMarkup(
      React.createElement('div', null, `没有找到与“react”相关的会话或标签`)
    );
    assert.match(html, /没有找到/, '搜索态空态仍要说「没找到」');
  });
});
