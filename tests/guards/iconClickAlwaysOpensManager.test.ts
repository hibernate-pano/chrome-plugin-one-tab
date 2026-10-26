/**
 * 点扩展图标 = **一定会打开标签管理器**（有能收集的标签就先收集，没有就直接打开）
 * —— 2026-10-26 产品定案的回归钉。
 *
 * ── 契约（产品负责人 2026-10-26 原话）───────────────────────────────────
 *
 *   「当当前没有可收取的标签页时，点击图标会默认打开标签管理器页面。
 *     换言之，无论何种情况，点击图标均会打开标签管理器页面。区别在于：
 *     若有可收集的标签，则先收集；若无，则直接打开。」
 *
 * ── 为什么要有这个守卫 ──────────────────────────────────────────────────
 *
 * 2026-10-24 恢复旧交互时，「一个都没存下」这条分支是**什么都不做**：
 * 只弹一条错误通知，屏幕上没有任何变化 ⇒ 用户点了图标，像是没点。
 * 2026-10-26 定的契约把那个兜底换掉：**点图标一定要落到管理器上**。
 *
 * ⚠️ 它**不是**回到 2026-10-22 审计 P0-1 的「只打开管理器」：
 *   · 「收集在前、管理器在后」的顺序保留（多 Chrome 实例并存时，
 *     动作必须发生在点的那一边、结果当场可见 —— 2026-10-24 恢复旧交互
 *     的核心理由依旧成立）；
 *   · 变的是**兜底**：以前「一个都没存下」就什么都不做。
 *
 * ── 这个守卫钉的是**行为**，不是源码长相 ─────────────────────────────────
 *
 * 判据落在 `src/background/iconClickAction.ts` 的 `runIconClick` 上：
 * chrome API 全部注入 ⇒ 守卫能**真的调用那条路径**，把每个分支都走一遍。
 * 「源码里出现了某个函数名」= 零检测力，本文件不做那种检查。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runIconClick,
  resolveIconClickWindowId,
  type IconClickDeps,
  type IconClickOutcome,
} from '../../src/background/iconClickAction.ts';
import {
  collectableTabs,
  resolveStorableUrl,
} from '../../src/domain/tabGroup/filters.ts';
import { createTabGroupFromChromeTabs } from '../../src/domain/tabGroup/factory.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

/** 一次点击的**可观测痕迹**（守卫只看这些，不看实现）。 */
interface Trace {
  queries: chrome.tabs.QueryInfo[];
  countedBatches: number[][];
  savedTabIds: number[];
  managerCalls: Array<{ shouldRefresh: boolean; windowId?: number }>;
  notifications: Array<{ message: string; kind: string }>;
  outcome: IconClickOutcome;
}

const TAB_A = { id: 1, windowId: 100 } as chrome.tabs.Tab;
const TAB_B = { id: 2, windowId: 100 } as chrome.tabs.Tab;

/** 造一套注入的假能力，并记录调用痕迹。 */
function makeDeps(
  overrides: Partial<IconClickDeps> & {
    saveResult?: { savedCount: number } | null;
    managerThrows?: boolean;
    saveThrows?: boolean;
    queryThrows?: boolean;
    countThrows?: boolean;
    /** 这一窗里有几个「可收集」的标签（默认 2 = 都能收集）。 */
    collectableCount?: number;
  } = {}
): { deps: IconClickDeps; trace: Trace } {
  const trace: Trace = {
    queries: [],
    countedBatches: [],
    savedTabIds: [],
    managerCalls: [],
    notifications: [],
    outcome: { kind: 'saved', savedCount: 0, managerOpened: true },
  };
  const deps: IconClickDeps = {
    queryTabs: async query => {
      trace.queries.push(query);
      if (overrides.queryThrows) throw new Error('query failed');
      return [TAB_A, TAB_B];
    },
    countCollectableTabs: async tabs => {
      trace.countedBatches.push(tabs.map(tab => tab.id ?? -1));
      if (overrides.countThrows) throw new Error('count failed');
      return overrides.collectableCount ?? tabs.length;
    },
    saveAllTabs: async tabs => {
      trace.savedTabIds = tabs.map(tab => tab.id ?? -1);
      if (overrides.saveThrows) throw new Error('save failed');
      return overrides.saveResult === undefined ? { savedCount: tabs.length } : overrides.saveResult;
    },
    openTabManager: async (shouldRefresh, windowId) => {
      trace.managerCalls.push({ shouldRefresh, windowId });
      if (overrides.managerThrows) throw new Error('manager failed');
    },
    notify: async (message, kind) => {
      trace.notifications.push({ message, kind });
    },
  };
  return { deps, trace };
}

describe('点扩展图标：一定会落到标签管理器上', () => {
  it('① 有可收集的标签 ⇒ 先收集（存下并关掉），再打开管理器', async () => {
    const { deps, trace } = makeDeps();
    const outcome = await runIconClick({ windowId: 100 }, deps);

    assert.equal(outcome.kind, 'saved', '有能收集的标签就必须真的收集');
    assert.deepEqual(
      trace.countedBatches,
      [[1, 2]],
      '必须先判断「有没有可收集的标签」（判据与保存路径同源）'
    );
    assert.deepEqual(trace.savedTabIds, [1, 2], '查到的那批标签必须被真的存下来');
    assert.equal(trace.managerCalls.length, 1, '收集完必须打开管理器');
  });

  it('① 存的是「点图标那一个窗口」的标签，不是 currentWindow', async () => {
    const { deps, trace } = makeDeps();
    await runIconClick({ windowId: 100 }, deps);

    assert.equal(trace.queries.length, 1, '必须查一次标签');
    assert.deepEqual(
      trace.queries[0],
      { windowId: 100 },
      '必须按「点图标那一个窗口」查 —— currentWindow 是「最后被聚焦的窗口」，' +
        '多窗口/多实例时会指向别处 ⇒ 存错 + 关错'
    );
  });

  it('① 拿不到点击的标签时退回 currentWindow（而不是查空）', async () => {
    const { deps, trace } = makeDeps();
    await runIconClick(undefined, deps);
    assert.deepEqual(trace.queries[0], { currentWindow: true });
    assert.equal(resolveIconClickWindowId(undefined), undefined);
    assert.equal(resolveIconClickWindowId({}), undefined);
    assert.equal(resolveIconClickWindowId({ windowId: 7 }), 7);
  });

  it('① 管理器开在**点的那一个窗口**里（多实例并存的命门）', async () => {
    const { deps, trace } = makeDeps();
    await runIconClick({ windowId: 100 }, deps);

    assert.equal(trace.managerCalls.length, 1, '点图标必须落到管理器上');
    assert.equal(
      trace.managerCalls[0].windowId,
      100,
      '管理器必须开在点图标那一个窗口 —— 否则多实例时用户在自己这边看不到任何变化'
    );
  });

  it('② 没有可收集的标签 ⇒ 不进保存，直接打开管理器，也不报错', async () => {
    const { deps, trace } = makeDeps({ collectableCount: 0 });
    const outcome = await runIconClick({ windowId: 100 }, deps);

    // ⚠️ 顺序有讲究：先钉「没进保存」，再钉 outcome ——「没进保存」才是这条
    //   契约的**因**（不进保存 ⇒ 才不会弹「没有可保存的标签页」那条错误）。
    assert.deepEqual(
      trace.savedTabIds,
      [],
      '一个都收集不到时**不许**进保存 —— 保存方会弹「当前窗口里没有可保存的标签页」' +
        '那条错误，而这一次用户**确实**得到了东西（管理器打开了）⇒ 对着成功报错'
    );
    assert.equal(outcome.kind, 'nothing-to-collect');
    assert.equal(trace.managerCalls.length, 1, '没有可收集的标签也必须打开管理器');
    assert.equal(
      trace.notifications.filter(n => n.kind === 'error').length,
      0,
      '「没有可保存的标签页」那条错误是给「按了快捷键什么也没发生」准备的；' +
        '点图标这条路上用户得到了管理器 ⇒ 不得报错'
    );
  });

  it('② 没有可收集的标签时，管理器仍然开在点的那一个窗口', async () => {
    const { deps, trace } = makeDeps({ collectableCount: 0 });
    await runIconClick({ windowId: 100 }, deps);
    assert.equal(trace.managerCalls[0].windowId, 100);
  });

  it('③ 判「有没有可收集的标签」抛错 ⇒ 照常尝试收集（判不出来 ≠ 没有）', async () => {
    const { deps, trace } = makeDeps({ countThrows: true });
    const outcome = await runIconClick({ windowId: 100 }, deps);

    assert.deepEqual(
      trace.savedTabIds,
      [1, 2],
      '判断失败不等于没有可收集的标签 —— 宁可多存一次（存了是用户想要的），' +
        '也不要因为一次判断失败就跳过收集'
    );
    assert.equal(outcome.kind, 'saved');
    assert.equal(trace.managerCalls.length, 1);
  });

  it('④ 收集失败（保存方抛错）⇒ 不补第二条错误，但管理器仍然打开', async () => {
    const { deps, trace } = makeDeps({ saveThrows: true });
    const outcome = await runIconClick({ windowId: 100 }, deps);

    assert.equal(outcome.kind, 'collect-failed');
    assert.equal(
      trace.notifications.filter(n => n.kind === 'error').length,
      0,
      '`TabManager.saveAllTabs` 抛出前自己报过「保存标签页时发生错误，请重试」——' +
        '这里再报一条 ⇒ 用户以为是两个故障'
    );
    assert.equal(trace.managerCalls.length, 1, '收集失败也要落到管理器上');
  });

  it('④ 收集失败（一个都没存下）⇒ 不补第二条错误，但管理器仍然打开', async () => {
    const { deps, trace } = makeDeps({ saveResult: null });
    const outcome = await runIconClick({ windowId: 100 }, deps);

    assert.equal(outcome.kind, 'collect-failed');
    assert.equal(
      trace.notifications.filter(n => n.kind === 'error').length,
      0,
      '保存方自己已经报过原因（一个都没存下），不许再报一次「无法保存」'
    );
    assert.equal(trace.managerCalls.length, 1, '一个都没存下也要落到管理器上');
  });

  it('⑤ 连标签都没查到手 ⇒ 报「无法保存当前窗口」，但管理器仍然打开', async () => {
    const { deps, trace } = makeDeps({ queryThrows: true });
    const outcome = await runIconClick({ windowId: 100 }, deps);

    assert.equal(outcome.kind, 'collect-failed');
    assert.ok(
      trace.notifications.some(n => n.message.includes('无法保存当前窗口')),
      '这条路径必须给用户一句话（点了图标却零反馈必须有一句话解释）'
    );
    assert.equal(trace.managerCalls.length, 1, '「无论何种情况」都包括查不到标签这一种');
  });

  it('⑥ 管理器打不开 ⇒ 收集成功时说「已保存」，不是「无法保存」', async () => {
    const { deps, trace } = makeDeps({ managerThrows: true });
    const outcome = await runIconClick({ windowId: 100 }, deps);

    assert.equal(outcome.kind, 'saved');
    assert.equal(outcome.managerOpened, false);
    const failure = trace.notifications.find(n => n.kind === 'error');
    assert.ok(failure, '管理器打不开必须有一条 error 通知');
    assert.match(
      failure.message,
      /已保存当前窗口/,
      '保存已经成功了 —— 报错必须说清「已保存」，说成「无法保存」会让用户以为数据没存下、重复操作'
    );
    assert.doesNotMatch(failure.message, /无法保存当前窗口/);
  });

  it('⑥ 管理器打不开且没收集成功 ⇒ 不许说「已保存」', async () => {
    const { deps, trace } = makeDeps({ managerThrows: true, collectableCount: 0 });
    const outcome = await runIconClick({ windowId: 100 }, deps);

    assert.equal(outcome.managerOpened, false);
    const failure = trace.notifications.find(n => n.kind === 'error');
    assert.ok(failure, '管理器打不开必须有一条 error 通知');
    assert.doesNotMatch(
      failure.message,
      /已保存/,
      '根本没收集成功却说「已保存」＝ 骗用户（他会以为数据存下了，其实没有）'
    );
  });
});

describe('判据同源：图标那条路与保存那条路说的是同一批标签', () => {
  const chromeTab = (
    id: number,
    url: string,
    extra: Partial<chrome.tabs.Tab> = {}
  ): chrome.tabs.Tab =>
    ({ id, url, pinned: false, index: id, windowId: 1, ...extra }) as chrome.tabs.Tab;

  it('factory 落盘的标签集合 === collectableTabs（图标说有，就必须真存得下）', () => {
    const tabs = [
      chromeTab(1, 'https://example.com/a'),
      chromeTab(2, 'chrome://settings'),
      chromeTab(3, 'https://example.com/pinned', { pinned: true }),
      chromeTab(4, 'javascript:alert(1)'),
      chromeTab(5, '', { pendingUrl: 'https://example.com/loading' }),
      chromeTab(6, 'file:///tmp/report.pdf'),
    ];

    const group = createTabGroupFromChromeTabs(tabs, { includePinned: false });
    const collectable = collectableTabs(tabs, { includePinned: false });

    assert.deepEqual(
      group.tabs.map(t => t.url),
      collectable.map(t => resolveStorableUrl(t)),
      '图标那条路数的「可收集」必须与保存那条路落盘的**完全同一批** —— ' +
        '否则会出现「图标说有、实际存不下」'
    );
    assert.equal(group.tabs.length, 3, '内部页 / 危险 schema / 固定标签（开关关）都要被剔掉');
  });

  it('TabManager.countCollectableTabs 用的就是 domain 的 collectableTabs', () => {
    const src = read('src/background/TabManager.ts');
    assert.match(
      src,
      /collectableTabs\(tabs,\s*\{\s*includePinned\s*\}\)\.length/,
      '可收集条数必须由 domain 的 collectableTabs 算 —— 另写一套判据就会漂移'
    );
  });
});

describe('接线：service worker 必须真的走这条路径', () => {
  it('图标点击把 Chrome 传进来的 tab 交给 runIconClick', () => {
    const src = read('src/service-worker.ts');
    assert.match(
      src,
      /chrome\.action\.onClicked\.addListener\(async clickedTab =>/,
      '必须接住 Chrome 传进来的 tab —— 它的 windowId 才是「点的那一个窗口」'
    );
    assert.match(
      src,
      /runIconClick\(clickedTab,/,
      '图标点击必须调用 runIconClick（决策与副作用分开的那条路径）'
    );
  });

  it('图标点击必须把「判有没有可收集的标签」的能力注入进去', () => {
    const src = read('src/service-worker.ts');
    assert.match(
      src,
      /countCollectableTabs:\s*tabs\s*=>\s*tabManager\.countCollectableTabs\(tabs\)/,
      '不注入这个能力 ⇒ 决策模块判不出「有没有可收集的标签」⇒ 契约落空'
    );
  });

  it('manifest 的图标提示必须说清「打开标签管理器」和「会保存并关掉」', () => {
    const manifest = JSON.parse(read('manifest.json')) as {
      action?: { default_title?: string };
    };
    const title = manifest.action?.default_title ?? '';
    assert.match(title, /标签管理器/, '悬停提示必须说点图标会打开标签管理器');
    assert.match(title, /保存/, '悬停提示必须说它会保存');
    assert.match(title, /关闭/, '悬停提示必须说它会关掉这些标签 —— 破坏性动作不许藏着');
    assert.doesNotMatch(
      title,
      /只打开|仅打开/,
      '提示不得说「只打开」—— 它不只打开，还会收集'
    );
  });
});

describe('对外文案必须与新契约一致', () => {
  /**
   * 去掉标记再匹配：
   *   · markdown 强调（README / 商店页写的是「点扩展图标**一定**会…」）；
   *   · HTML 标签（promo-site 是网页，用的是 `<strong>`，不是 `**`）。
   */
  const plain = (rel: string): string =>
    read(rel).replace(/\*\*/g, '').replace(/<[^>]+>/g, '');

  it('三处文案都必须说「点图标一定打开标签管理器」', () => {
    for (const rel of ['README.md', 'CHROMEWEBSTORE.md', 'promo-site/index.html']) {
      assert.match(
        plain(rel),
        /点(?:扩展)?图标[^。\n]{0,30}打开(?:标签|会话)管理器/,
        `${rel} 还没说「点图标会打开标签管理器」—— 那是 1.29.0 的契约`
      );
    }
  });

  it('对外文案不得说「点图标只打开会话管理器」', () => {
    for (const rel of ['README.md', 'CHROMEWEBSTORE.md', 'promo-site/index.html']) {
      assert.doesNotMatch(
        plain(rel),
        /点(?:扩展)?图标(?:只|仅)打开(?:标签|会话)管理器/,
        `${rel} 还在说「点图标只打开管理器」—— 1.29.0 起它还会先收集`
      );
    }
  });

  it('商店页的**英文**那一半也要说「点图标一定打开标签管理器」', () => {
    // 商店文案是中英双语、两段各自自洽 ⇒ 只改中文那一半 ⇒ 英文读者拿到的是
    // 另一个说明书（判据 `store-listing-judge` 也是**分段判**的）。
    assert.match(
      plain('CHROMEWEBSTORE.md'),
      /clicking the extension icon[^.\n]{0,80}always opens the tab manager/i,
      '英文那一半还在说「点图标 = 把标签存成会话」⇒ 少了「一定打开标签管理器」这一半'
    );
  });
});

describe('其它保存入口必须都还在（不许把功能一起删掉）', () => {
  it('快捷键、右键菜单、页面按钮', () => {
    const manifest = JSON.parse(read('manifest.json')) as {
      commands: Record<string, unknown>;
    };
    const saveCommands = Object.keys(manifest.commands).filter(id => id.startsWith('save_'));
    assert.ok(
      saveCommands.length >= 2,
      `manifest 必须保留至少两个保存快捷键（实际 ${saveCommands.length}）`
    );

    const sw = read('src/service-worker.ts');
    assert.match(
      sw,
      /CONTEXT_MENU_IDS\.saveOtherTabs/,
      '右键菜单的「保存其他标签并关闭」必须还在'
    );

    const header = read('src/components/layout/Header.tsx');
    assert.match(header, /handleSaveAllTabs/, '管理页顶栏的「保存并关闭」按钮必须还在');
  });
});
