// 失败通知不能被「显示通知提醒」开关吞掉（2026-10-18 round 24）。
//
// 【要防的回归类别】`showNotification` 按 kind 分流：'error' 永远发，'success' / 'info'
// 受设置控制（默认关）。这个分流的**不变式**是「失败不能静默」—— 本节开头就写着它。
// 但同一段注释又把「快捷键失败、页面无法保存」举成 'info' 的例子，于是两处真失败
// 被归到了受控那一侧：
//   · `TabManager` 「当前窗口里没有可保存的标签页」⇒ 在只有内部页的窗口按 Alt+Shift+S：
//     标签没保存、标签没关、屏幕上一个像素都不动；
//   · `service-worker` 「没有其他标签页需要保存」⇒ 右键菜单点了没反应。
// 而设置页写着「失败提示不受此开关影响，始终会通知」—— 声明与行为分歧。
//
// 判据只有一条：**用户要求的动作没发生 ⇒ 'error'**。
// 本守卫钉三件事：① 分流规则本身（真跑 TabManager.showNotification）；
// ② 真实路径（saveAllTabs 在「一个都存不下」时确实发得出来）；③ 仓里不再有失败通知写成 'info'。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

type NotificationCall = { options: { title?: string; message?: string } };

/** chrome.* 最小 mock（抄自 tests/backgroundSyncLockedBackendOutcome.test.ts 的纪律）。 */
function installChromeMock() {
  const notificationCalls: NotificationCall[] = [];
  const lsData = new Map<string, string>();
  const localStorageStub = {
    get length() { return lsData.size; },
    key: (i: number) => [...lsData.keys()][i] ?? null,
    getItem: (k: string) => (lsData.has(k) ? (lsData.get(k) as string) : null),
    setItem: (k: string, v: string) => { lsData.set(k, String(v)); },
    removeItem: (k: string) => { lsData.delete(k); },
    clear: () => lsData.clear(),
  };
  (globalThis as Record<string, unknown>).window = { localStorage: localStorageStub };
  (globalThis as Record<string, unknown>).localStorage = localStorageStub;
  // 「显示通知提醒」默认就是关的 —— 正是这个默认值让被误标成 info 的失败消失
  lsData.set('user_settings', JSON.stringify({ showNotifications: false }));
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      getManifest: () => ({ version: 'test' }),
      getURL: (p: string) => `chrome-extension://test/${p}`,
    },
    storage: {
      local: {
        async get(keys: string | string[]) {
          const out: Record<string, unknown> = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) out[k] = undefined;
          return out;
        },
        async set() { /* noop */ },
        async remove() { /* noop */ },
      },
    },
    notifications: {
      create(idOrOptions: string | NotificationCall['options'], maybeOptions?: NotificationCall['options']) {
        notificationCalls.push({ options: (typeof idOrOptions === 'string' ? maybeOptions : idOrOptions) ?? {} });
        return Promise.resolve('generated-id');
      },
    },
    tabs: { async query() { return []; }, async remove() { /* noop */ } },
  };
  return { notificationCalls, lsData };
}

describe('分流规则：error 永远发，success / info 受设置控制', () => {
  it('开关关掉时，只有 error 发得出去', async () => {
    const handles = installChromeMock();
    const { tabManager } = await import('@/background/TabManager');
    const base = { type: 'basic' as const, iconUrl: 'icons/icon128.png', title: 'TapStack', message: 'x' };

    await tabManager.showNotification({ ...base, kind: 'success' });
    assert.equal(handles.notificationCalls.length, 0, 'success 受设置控制，开关关掉时不该发');

    await tabManager.showNotification({ ...base, kind: 'info' });
    assert.equal(handles.notificationCalls.length, 0, 'info 受设置控制（但它不该被用来装失败）');

    await tabManager.showNotification({ ...base, kind: 'error' });
    assert.equal(handles.notificationCalls.length, 1, 'error 必须永远发 —— 这是「失败不能静默」的唯一出口');
  });

  it('真实路径：一个标签都存不下时，开关关掉也发得出解释', async () => {
    const handles = installChromeMock();
    const { tabManager } = await import('@/background/TabManager');
    const iso = new Date().toISOString();
    // 只有内部页的窗口：清洗后一个标签都不剩（这是真实的失败路径，不是构造出来的边角）
    const tabs = [
      { id: 1, url: 'chrome://newtab/', title: '新标签页', pinned: false, windowId: 1, index: 0, active: true,
        highlighted: false, incognito: false, selected: true, discarded: false, autoDiscardable: true,
        groupId: -1, lastAccessed: Date.parse(iso) } as unknown as chrome.tabs.Tab,
    ];

    const saved = await tabManager.saveAllTabs(tabs);

    // 2026-10-20 审计 A-4：saveAllTabs 的返回类型从 boolean 改成了
    // `SaveAllSummary | null` —— 为了把「丢了几个固定标签」带回 popup
    // （boolean 表达不了这个信息）。
    //
    // 但**不变量没变**：失败时必须返回「没有摘要」，绝不能返回一个
    // 看起来像成功的对象。断言因此改成「必须是 null / falsy」而不是
    // 「必须等于 false」—— 后者会把返回值钉死在一个具体字面量上，
    // 任何合法的重构（比如改成 {ok:false}）都会变成红灯。
    assert.ok(!saved, '一个标签都没存下 ⇒ 不得报成功（round 5 的不变式）');
    assert.equal(handles.notificationCalls.length, 1, '这条失败解释必须发得出来，否则用户按了没反应');
    assert.match(
      handles.notificationCalls[0].options.message ?? '',
      /没有可保存的标签页/,
      '发的应当是「没有可保存的标签页」这条解释'
    );
  });
});

describe('仓里不得再把失败通知写成 info', () => {
  const files = ['src/background/TabManager.ts', 'src/service-worker.ts'] as const;
  /** 注释里会出现 `kind: 'info'` 这种字样（就是在讲这个坑），只数代码 */
  const stripComments = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

  for (const file of files) {
    it(`${file} 没有 kind: 'info' 的调用点`, () => {
      const calls = [...stripComments(read(file)).matchAll(/kind: 'info'/g)];
      assert.equal(
        calls.length,
        0,
        `${file} 里还有 ${calls.length} 处 kind: 'info' —— info 受「显示通知提醒」控制，` +
          '装失败会让用户在默认设置下完全看不到原因'
      );
    });
  }

  it('两条「没保存成功」的解释都显式标了 error', () => {
    assert.match(
      read('src/background/TabManager.ts'),
      /message: '当前窗口里没有可保存的标签页',\s*\/\/[\s\S]*?kind: 'error',/,
      '「当前窗口里没有可保存的标签页」必须标 error'
    );
    assert.match(
      read('src/service-worker.ts'),
      /showNotification\('没有其他标签页需要保存', 'TapStack', 'error'\)/,
      '「没有其他标签页需要保存」必须标 error'
    );
  });
});
