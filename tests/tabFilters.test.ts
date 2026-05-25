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

describe('isValidTab', () => {
  it('validates a normal HTTP tab', () => {
    const tab = { id: '1', url: 'https://example.com', title: 'Example', createdAt: new Date().toISOString(), lastAccessed: new Date().toISOString() };
    assert.equal(isValidTab(tab), true);
  });

  it('rejects chrome:// tabs', () => {
    const tab = { id: '1', url: 'chrome://newtab', title: 'New Tab', createdAt: new Date().toISOString(), lastAccessed: new Date().toISOString() };
    assert.equal(isValidTab(tab), false);
  });
});

describe('filterValidTabs', () => {
  const createTab = (url: string, pinned = false): chrome.tabs.Tab => ({
    url,
    pinned,
    id: Math.floor(Math.random() * 10000),
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
