import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTimestampSessionName, deriveSessionNameFromChromeTabs } from '../src/domain/tabGroup/sessionName.ts';

// 用本地时区构造固定时间，断言与机器时区无关
const now = new Date(2026, 4, 11, 8, 9).toISOString();

test('buildTimestampSessionName uses the short timestamp format without seconds', () => {
  assert.equal(buildTimestampSessionName(now), '标签组 5月11日 08:09');
});

test('buildTimestampSessionName pads minutes and handles invalid dates', () => {
  assert.equal(buildTimestampSessionName(new Date(2026, 0, 2, 3, 5).toISOString()), '标签组 1月2日 03:05');
  assert.equal(buildTimestampSessionName('not-a-date'), '标签组');
});

test('deriveSessionNameFromChromeTabs falls back to the timestamp format', () => {
  assert.equal(
    deriveSessionNameFromChromeTabs(
      [{ url: 'https://example.com', title: 'Example', pinned: false } as chrome.tabs.Tab],
      now
    ),
    '标签组 5月11日 08:09'
  );
});
