import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isInternalUrl, isValidTab, filterValidTabs } from '../src/domain/tabGroup/filters.ts';

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
