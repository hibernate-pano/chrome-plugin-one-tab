// 骰子（随机打开一个标签）—— 行为级回归 + 接线守卫（2026-10-30）。
//
// 【本文件要防的回归类别】
//   ① 抽签池漂移：骰子必须只抽「用户此刻**看得见**的那一批」
//      （搜索词 + 生效筛选），而且池子里不许有本设备打不开的地址
//      与锁定会话的标签 —— 抽中前者只会「点了没反应」，
//      抽中后者会出现「开了，但记录还在」（同一次点按，两种后果）。
//   ② 打开路径丢掉成功门：SW 拒开是 `sendResponse({success:false})` ⇒ promise
//      **resolve**。不看回包就删 ⇒「开了没看到页面，记录也没了」。
//      与 TabGroup / SearchResultList 必须是同一道门。
//   ③ 「窄屏少个功能」的老毛病：顶栏那颗是 `hidden sm:block`，
//      ⋯ 菜单里必须有 `sm:hidden` 的补偿入口，且真的调用同一个回调。
//
// 断言方式与本仓约定一致：行为用纯函数直接跑（真值），
// 接线读源码（结构），并用 `code()` 剥掉注释 —— 注释里提到一个符号
// 不等于生产在用它。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildRandomPickPool, pickRandomCandidate } from '../../src/components/layout/randomPickPool.ts';
import type { Tab, TabGroup } from '../../src/types/tab.ts';

const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

/** 去注释：注释里提到 `deleteTabAndSync` 不能把断言喂饱。 */
const code = (rel: string): string =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const STAMP = '2026-01-01T00:00:00.000Z';

const tab = (id: string, url: string, title = id): Tab =>
  ({ id, url, title, pinned: false, createdAt: STAMP, lastAccessed: STAMP } as unknown as Tab);

const group = (id: string, tabs: Tab[], isLocked = false): TabGroup =>
  ({
    id,
    name: id,
    tabs,
    createdAt: STAMP,
    updatedAt: STAMP,
    isLocked,
    version: 1,
  } as unknown as TabGroup);

const idsOf = (pool: { tab: Tab }[]) => pool.map(c => c.tab.id).sort();

// ─────────────────────────────────────────────────────────────────────────
// 1. 抽签池 = 看得见的那一批
// ─────────────────────────────────────────────────────────────────────────

describe('骰子抽签池：范围跟着列表走', () => {
  const groups = [
    group('g1', [tab('a', 'https://github.com/a'), tab('b', 'https://news.ycombinator.com/b')]),
    group('g2', [tab('c', 'https://github.com/c')]),
  ];

  it('没有搜索词、没有筛选 ⇒ 全部可打开的标签', () => {
    const pool = buildRandomPickPool(groups, {
      query: '',
      filters: {},
      hasActiveFilters: false,
    });
    assert.deepEqual(idsOf(pool), ['a', 'b', 'c']);
  });

  it('有搜索词 ⇒ 只抽命中的（不抽出列表外的记录）', () => {
    const pool = buildRandomPickPool(groups, {
      query: 'github',
      filters: {},
      hasActiveFilters: false,
    });
    assert.deepEqual(idsOf(pool), ['a', 'c']);
  });

  it('有域名筛选（无搜索词）⇒ 只抽该域名下的标签', () => {
    const pool = buildRandomPickPool(groups, {
      query: '',
      filters: { domain: 'github.com' },
      hasActiveFilters: true,
    });
    assert.deepEqual(idsOf(pool), ['a', 'c']);
  });

  it('搜索词 + 筛选同时生效时两者都要满足', () => {
    const pool = buildRandomPickPool(groups, {
      query: 'github',
      filters: { domain: 'news.ycombinator.com' },
      hasActiveFilters: true,
    });
    assert.deepEqual(idsOf(pool), []);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 池子里必须剔掉「抽中也不会有好结果」的标签
// ─────────────────────────────────────────────────────────────────────────

describe('骰子抽签池：剔除项', () => {
  it('锁定会话的标签不参与（骰子的语义是「抽走」，锁定会话从不被消费）', () => {
    const groups = [
      group('locked', [tab('l', 'https://kept.example/l')], true),
      group('open', [tab('o', 'https://open.example/o')]),
    ];
    const pool = buildRandomPickPool(groups, { query: '', filters: {}, hasActiveFilters: false });
    assert.deepEqual(idsOf(pool), ['o']);
  });

  it('本设备打不开的地址不参与（file: 抽中只会弹「无法打开」）', () => {
    const groups = [
      group('g', [tab('f', 'file:///Users/me/paper.pdf'), tab('h', 'https://ok.example/h')]),
    ];
    const pool = buildRandomPickPool(groups, { query: '', filters: {}, hasActiveFilters: false });
    assert.deepEqual(idsOf(pool), ['h']);
  });

  it('全是锁定 / 不可开 ⇒ 空池（调用方据此出声，不许静默）', () => {
    const groups = [
      group('locked', [tab('l', 'https://kept.example/l')], true),
      group('g', [tab('f', 'file:///a.pdf')]),
    ];
    const pool = buildRandomPickPool(groups, { query: '', filters: {}, hasActiveFilters: false });
    assert.equal(pool.length, 0);
    assert.equal(pickRandomCandidate(pool), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. 抽取：等概率 + 一定落在池内
// ─────────────────────────────────────────────────────────────────────────

describe('骰子抽取', () => {
  const pool = ['a', 'b', 'c'];

  it('空池返回 null（不是 undefined、不是抛错）', () => {
    assert.equal(pickRandomCandidate([], () => 0.5), null);
  });

  it('random=0 取第一条，random→1 取最后一条（下标不越界）', () => {
    assert.equal(pickRandomCandidate(pool, () => 0), 'a');
    assert.equal(pickRandomCandidate(pool, () => 0.999999), 'c');
    // 注入一个越界的随机源也不许返回 undefined
    assert.equal(pickRandomCandidate(pool, () => 1), 'c');
  });

  it('抽到的恒是池里的元素', () => {
    for (let i = 0; i < 50; i++) {
      assert.ok(pool.includes(pickRandomCandidate(pool) as string));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. 接线：成功门、消费、以及两个宽度都摸得到
// ─────────────────────────────────────────────────────────────────────────

/** 某个元素**直接所在**的 <div> 的 className（同 headerActionBudget 的口径）。 */
function containerClassBefore(src: string, at: number): string {
  const region = src.slice(0, at);
  const open = region.lastIndexOf('<div className="');
  const close = region.lastIndexOf('</div>');
  assert.ok(open > close, '找不到该元素直接所在的 <div> 容器');
  const end = region.indexOf('"', open + 16);
  assert.ok(end > open, '找不到该 <div> 的 className 结束引号');
  return region.slice(open + 16, end);
}

describe('骰子的打开路径：与点开一行同一道成功门', () => {
  const HEADER = code('src/components/layout/Header.tsx');

  it('发的是 OPEN_TAB（不是自己再拼一套打开逻辑）', () => {
    assert.match(HEADER, /type: 'OPEN_TAB'/, '骰子必须走 SW 的 OPEN_TAB');
  });

  it('先看回包 success:true，才消费（拒开不删）', () => {
    const start = HEADER.indexOf('const handleRandomPick');
    assert.ok(start > -1, '应能找到 handleRandomPick');
    const body = HEADER.slice(start, HEADER.indexOf('\n  };', start));

    const guardAt = body.indexOf('r.success !== true');
    const deleteAt = body.indexOf('deleteTabAndSync');
    assert.ok(guardAt > -1, '回包必须显式判断 success !== true');
    assert.ok(deleteAt > -1, '成功后必须从会话里消费这条记录');
    assert.ok(
      guardAt < deleteAt,
      '消费必须排在 success:true 判断之后 —— 先删后开时拒开会「记录没了、页面也没开」'
    );
    assert.ok(
      !body.slice(0, body.indexOf('if (!r || r.success !== true)')).includes('deleteTabAndSync'),
      '失败分支不得删除记录'
    );
  });

  it('失败要出声（静默的是成功，不是失败）', () => {
    const start = HEADER.indexOf('const handleRandomPick');
    const body = HEADER.slice(start, HEADER.indexOf('\n  };', start));
    assert.match(body, /showRestoreError\(/, '拒开 / 消息失败必须告诉用户');
  });

  it('空池必须出声（按了键没反应 = 界面坏了）', () => {
    const start = HEADER.indexOf('const handleRandomPick');
    const body = HEADER.slice(start, HEADER.indexOf('\n  };', start));
    assert.match(body, /if \(!pick\)/, '空池分支必须存在');
    assert.match(body, /showToast\(/, '空池必须说一句话');
  });
});

describe('骰子入口：任何宽度都摸得到', () => {
  const HEADER = code('src/components/layout/Header.tsx');
  const DROPDOWN = code('src/components/layout/HeaderDropdown.tsx');

  it('顶栏有这颗按钮（sm 以上可见）且有无障碍名', () => {
    const at = HEADER.indexOf('onClick={handleRandomPick}');
    assert.ok(at > -1, '顶栏必须有骰子按钮');
    assert.match(HEADER, /aria-label="随机打开一个标签页"/, '骰子必须有无障碍名');
    assert.equal(
      containerClassBefore(HEADER, at),
      'hidden sm:block',
      '顶栏的骰子只在 sm 以上出现（窄屏由 ⋯ 菜单提供）'
    );
  });

  it('⋯ 菜单里有窄屏补偿入口，且真的调用同一个回调', () => {
    const at = DROPDOWN.indexOf('onRequestRandomPick?.()');
    assert.ok(at > -1, '菜单里必须有「随机打开一个标签」入口，且真的调用了回调');
    assert.equal(
      containerClassBefore(DROPDOWN, at),
      'sm:hidden',
      '菜单里的骰子是窄屏补偿：sm 以下可见（sm 以上顶栏已经有那颗按钮了）'
    );
  });

  it('抽签依据由 MainApp 下发（与列表页同一份搜索词 / 筛选）', () => {
    const app = code('src/components/app/MainApp.tsx');
    assert.match(app, /searchQuery=\{deferredSearchQuery\}/, '顶栏要拿到列表页用的同一份搜索词');
    assert.match(
      app,
      /effectiveFilters=\{filterControls\.effectiveFilters\}/,
      '顶栏要拿到列表页用的同一份生效筛选'
    );
  });
});
