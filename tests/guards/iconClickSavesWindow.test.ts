/**
 * 点扩展图标 = **保存当前窗口并关闭这些标签**（2026-10-24 恢复旧交互的回归钉）。
 *
 * ── 为什么要有这个守卫 ──────────────────────────────────────────────────
 *
 * 2026-10-22 审计 P0-1 把图标点击改成了「只打开会话管理器」；产品负责人
 * 2026-10-24 要求**恢复旧交互** —— 理由是多 Chrome 实例并存时，
 * 「点图标 = 把这一窗收起来」才是对的那一个：动作发生在点的那一边，
 * 结果当场可见；改成「只打开管理器」反而变成「点了像没点」
 * （管理器可能被激活在**另一个窗口**）。
 *
 * ⇒ 被推翻的只有「图标点击不许保存」这一条约定；审计里的其它安全策略
 *   （删除确认、锁定豁免、可撤销回执…）一条都没动。
 *
 * ── 这个守卫钉的是**行为**，不是源码长相 ─────────────────────────────────
 *
 * 判据落在 `src/background/iconClickAction.ts` 的 `runIconClick` 上：
 * chrome API 全部注入 ⇒ 守卫能**真的调用那条路径**，把每个分支都走一遍
 * （存成了 / 一个都没存下 / 管理器打不开 / 整条路径挂掉）。
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

/** 一次点击的**可观测痕迹**（守卫只看这些，不看实现）。 */
interface Trace {
  queries: chrome.tabs.QueryInfo[];
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
  } = {}
): { deps: IconClickDeps; trace: Trace } {
  const trace: Trace = {
    queries: [],
    savedTabIds: [],
    managerCalls: [],
    notifications: [],
    outcome: { kind: 'saved', savedCount: 0 },
  };
  const deps: IconClickDeps = {
    queryTabs: async query => {
      trace.queries.push(query);
      if (overrides.queryThrows) throw new Error('query failed');
      return [TAB_A, TAB_B];
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

describe('点扩展图标：把点到的那个窗口存成会话并关掉', () => {
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
    assert.deepEqual(trace.savedTabIds, [1, 2], '查到的那批标签必须被真的存下来');
  });

  it('① 拿不到点击的标签时退回 currentWindow（而不是查空）', async () => {
    const { deps, trace } = makeDeps();
    await runIconClick(undefined, deps);
    assert.deepEqual(trace.queries[0], { currentWindow: true });
    assert.equal(resolveIconClickWindowId(undefined), undefined);
    assert.equal(resolveIconClickWindowId({}), undefined);
    assert.equal(resolveIconClickWindowId({ windowId: 7 }), 7);
  });

  it('② 存成之后打开管理器，且开在**同一个窗口**里', async () => {
    const { deps, trace } = makeDeps();
    await runIconClick({ windowId: 100 }, deps);

    assert.equal(trace.managerCalls.length, 1, '存成之后必须打开管理器');
    assert.equal(
      trace.managerCalls[0].windowId,
      100,
      '管理器必须开在点图标那一个窗口 —— 否则多实例时用户在自己这边看不到任何变化'
    );
  });

  it('③ 一个都没存下 ⇒ 不开管理器、也不谎报「无法保存」', async () => {
    const { deps, trace } = makeDeps({ saveResult: null });
    const outcome = await runIconClick({ windowId: 100 }, deps);

    assert.equal(outcome.kind, 'nothing-saved');
    assert.equal(trace.managerCalls.length, 0, '没存成就不许打开管理器（那会让用户以为存成了）');
    assert.ok(
      !trace.notifications.some(n => n.message.includes('无法保存当前窗口')),
      '保存方自己已经报过原因，不许再报一次「无法保存」'
    );
  });

  it('④ 管理器打不开 ⇒ 说的是「已保存」，不是「无法保存」', async () => {
    const { deps, trace } = makeDeps({ managerThrows: true });
    const outcome = await runIconClick({ windowId: 100 }, deps);

    assert.equal(outcome.kind, 'saved-but-manager-failed');
    const failure = trace.notifications.find(n => n.kind === 'error');
    assert.ok(failure, '管理器打不开必须有一条 error 通知');
    assert.match(
      failure.message,
      /已保存当前窗口/,
      '保存已经成功了 —— 报错必须说清「已保存」，说成「无法保存」会让用户以为数据没存下、重复操作'
    );
    assert.doesNotMatch(failure.message, /无法保存当前窗口/);
  });

  it('⑤ 整条路径挂掉（连标签都没查到手）⇒ 报「无法保存当前窗口」', async () => {
    const { deps, trace } = makeDeps({ queryThrows: true });
    const outcome = await runIconClick({ windowId: 100 }, deps);

    assert.equal(outcome.kind, 'failed');
    assert.ok(
      trace.notifications.some(n => n.message.includes('无法保存当前窗口')),
      '这条路径必须给用户一句话（按了键没反应必须有一句话解释）'
    );
    assert.equal(trace.managerCalls.length, 0);
  });

  it('⑥ 保存方抛错 ⇒ 不再补第二条错误提示（它自己已经报过原因）', async () => {
    const { deps, trace } = makeDeps({ saveThrows: true });
    const outcome = await runIconClick({ windowId: 100 }, deps);

    assert.equal(outcome.kind, 'failed');
    assert.equal(
      trace.notifications.filter(n => n.kind === 'error').length,
      0,
      '`TabManager.saveAllTabs` 抛出前自己报过「保存标签页时发生错误，请重试」——' +
        '这里再报一条 ⇒ 用户以为是两个故障'
    );
    assert.equal(trace.managerCalls.length, 0, '没存成就不许打开管理器');
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

  it('manifest 的图标提示必须说清「保存并关闭」（悬停提示是用户的第一眼说明）', () => {
    const manifest = JSON.parse(read('manifest.json')) as {
      action?: { default_title?: string };
    };
    const title = manifest.action?.default_title ?? '';
    assert.match(title, /保存/, '图标提示必须说它会保存');
    assert.match(title, /关闭/, '图标提示必须说它会关闭这些标签');
    assert.doesNotMatch(
      title,
      /只打开|仅打开/,
      '提示不得说「只打开」—— 那个行为在 1.27.0 已经改回保存并关闭'
    );
  });

  it('对外文案不得再说「点扩展图标只会打开会话管理器」', () => {
    for (const rel of ['README.md', 'CHROMEWEBSTORE.md', 'promo-site/index.html']) {
      const src = read(rel);
      assert.doesNotMatch(
        src,
        /点扩展图标只会打开会话管理器|点扩展图标只打开会话管理器|Clicking the extension icon only opens the session manager/,
        `${rel} 还在说「点图标只打开管理器」—— 那是 1.26.0 的行为，1.27.0 已改回`
      );
    }
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
