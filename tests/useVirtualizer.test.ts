import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeVirtualWindow } from '@/hooks/useVirtualizer';

test('computeVirtualWindow: returns full window when items < threshold (30)', () => {
  const items = Array.from({ length: 20 });
  const window = computeVirtualWindow({ items, threshold: 30, overscan: 5 });
  assert.equal(window.virtual, false);
  assert.equal(window.startIndex, 0);
  assert.equal(window.endIndex, 20);
});

test('computeVirtualWindow: enables virtual at threshold', () => {
  const items = Array.from({ length: 100 });
  const window = computeVirtualWindow({
    items,
    threshold: 30,
    overscan: 5,
    viewportHeight: 600,
    itemHeight: 80,
  });
  assert.equal(window.virtual, true);
  assert.ok(window.endIndex > 0);
});

test('computeVirtualWindow: respects overscan', () => {
  const items = Array.from({ length: 100 });
  const window = computeVirtualWindow({
    items,
    threshold: 30,
    overscan: 5,
    viewportHeight: 600,
    itemHeight: 80,
    scrollOffset: 400,
  });
  assert.ok(window.startIndex >= 0);
  assert.ok(window.endIndex > window.startIndex);
});
