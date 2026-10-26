import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isInternalUrl,
  isValidTab,
  filterValidTabs,
  collectableTabs,
  resolveStorableUrl,
} from '../src/domain/tabGroup/filters.ts';

describe('isInternalUrl', () => {
  it('detects chrome:// URLs', () => {
    assert.equal(isInternalUrl('chrome://newtab'), true);
    assert.equal(isInternalUrl('chrome://settings'), true);
  });

  it('detects chrome-extension:// URLs', () => {
    assert.equal(isInternalUrl('chrome-extension://abc123/popup.html'), true);
  });

  it('allows normal URLs', () => {
    assert.equal(isInternalUrl('https://example.com'), false);
    assert.equal(isInternalUrl('https://github.com'), false);
  });
});

// isValidTab / filterValidTabs 收的是 chrome.tabs.Tab（不是本仓库的 Tab 业务类型）：
// 业务 Tab 额外带 createdAt / lastAccessed，chrome.tabs.Tab 上没有这两个字段。
// 手搓半截字面量会让类型检查失效、也测不到真实形状，统一走这一个构造器。
// id 用递增计数器而不是 Math.random()：这是测试夹具，用随机数只会让失败不可复现。
let nextTabId = 1;
const createTab = (url: string, pinned = false): chrome.tabs.Tab => ({
  url,
  pinned,
  id: nextTabId++,
  index: 0,
  windowId: 1,
  highlighted: false,
  active: false,
  incognito: false,
  selected: false,
  discarded: false,
  autoDiscardable: true,
  groupId: -1,
});

describe('isValidTab', () => {
  it('validates a normal HTTP tab', () => {
    assert.equal(isValidTab(createTab('https://example.com')), true);
  });

  it('rejects chrome:// tabs', () => {
    assert.equal(isValidTab(createTab('chrome://newtab')), false);
  });
});

describe('filterValidTabs', () => {
  it('filters out internal URLs', () => {
    const tabs = [
      createTab('https://example.com'),
      createTab('chrome://newtab'),
      createTab('https://github.com'),
    ];
    assert.equal(filterValidTabs(tabs).length, 2);
  });

  it('excludes pinned tabs when includePinned is false', () => {
    const tabs = [
      createTab('https://example.com', true),
      createTab('https://github.com', false),
    ];
    const filtered = filterValidTabs(tabs, { includePinned: false });
    assert.equal(filtered.length, 1);
  });

  it('includes pinned tabs when includePinned is true', () => {
    const tabs = [
      createTab('https://example.com', true),
      createTab('https://github.com', false),
    ];
    const filtered = filterValidTabs(tabs, { includePinned: true });
    assert.equal(filtered.length, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// collectableTabs（2026-10-26 新增）
//
// ── 为什么需要它 ─────────────────────────────────────────────────────────
//
// 点扩展图标的契约是「**无论有没有可收集的标签，都打开标签管理器**」：
// 有 ⇒ 先收集再打开；没有 ⇒ 直接打开。
// ⇒ 调用方必须能**先判断**「有没有可收集的标签」，而这个判断必须与
//   **保存路径**同一套判据 —— 否则会出现「图标说有、实际存不下」。
// ⇒ `collectableTabs` 就是那套判据的**单源**（factory 落盘也用它）。
//
// 它比 `filterValidTabs` 多一道「URL 解析得出来」（`resolveStorableUrl` 非空）：
// 解析不出来的标签落盘就是一条空地址（`about:blank` 那种假记录）。
// ─────────────────────────────────────────────────────────────────────────
describe('collectableTabs', () => {
  it('drops internal pages, dangerous schemas and pinned tabs (switch off)', () => {
    const tabs = [
      createTab('https://example.com'),
      createTab('chrome://settings'),
      createTab('chrome-extension://abc123/manager.html'),
      createTab('javascript:alert(1)'),
      createTab('data:text/html,<h1>x</h1>'),
      createTab('https://example.com/pinned', true),
    ];
    const collectable = collectableTabs(tabs, { includePinned: false });
    assert.deepEqual(
      collectable.map(t => t.url),
      ['https://example.com']
    );
  });

  it('keeps pinned tabs when the switch is on', () => {
    const tabs = [createTab('https://example.com', true), createTab('https://github.com')];
    assert.equal(collectableTabs(tabs, { includePinned: true }).length, 2);
    assert.equal(collectableTabs(tabs, { includePinned: false }).length, 1);
  });

  it('keeps a loading tab by its pendingUrl (that is the address it is going to)', () => {
    const tab = {
      ...createTab(''),
      pendingUrl: 'https://example.com/loading',
    } as chrome.tabs.Tab;
    const collectable = collectableTabs([tab]);
    assert.equal(collectable.length, 1);
    assert.equal(resolveStorableUrl(collectable[0]), 'https://example.com/loading');
  });

  it('drops a tab whose address cannot be resolved (it would land as an empty row)', () => {
    // 既有 url 又有 pendingUrl，但两个都解析不出可存储的地址
    const tab = {
      ...createTab(''),
      pendingUrl: 'about:blank',
    } as chrome.tabs.Tab;
    assert.equal(resolveStorableUrl(tab), '');
    assert.equal(collectableTabs([tab]).length, 0);
  });

  it('is the same set the factory writes to disk (one source of truth)', () => {
    const tabs = [
      createTab('https://example.com/a'),
      createTab('chrome://settings'),
      createTab('file:///tmp/report.pdf'),
    ];
    assert.deepEqual(
      collectableTabs(tabs).map(t => resolveStorableUrl(t)),
      ['https://example.com/a', 'file:///tmp/report.pdf']
    );
  });
});
