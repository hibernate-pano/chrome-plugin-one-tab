import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTimestampSessionName, deriveSessionNameFromChromeTabs } from '../src/domain/tabGroup/sessionName.ts';

test('buildTimestampSessionName uses the legacy timestamp format', () => {
  const now = '2026-05-11T08:09:10.000Z';
  assert.equal(
    buildTimestampSessionName(now),
    `标签组 ${new Date(now).toLocaleString()}`
  );
});

test('deriveSessionNameFromChromeTabs falls back to the timestamp format', () => {
  const now = '2026-05-11T08:09:10.000Z';
  assert.equal(
    deriveSessionNameFromChromeTabs(
      [{ url: 'https://example.com', title: 'Example', pinned: false } as chrome.tabs.Tab],
      now
    ),
    `标签组 ${new Date(now).toLocaleString()}`
  );
});
