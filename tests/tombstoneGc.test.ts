import { test } from 'node:test';
import assert from 'node:assert';
import { computeCutoff } from '../src/utils/tombstoneGcUtil.ts';

test('computeCutoff: 默认 30 天前的精确时间', () => {
  const now = new Date('2026-06-28T12:00:00.000Z');
  const cutoff = computeCutoff(30, now);
  // 30 天 = 30 * 86400 * 1000 ms
  const expected = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  assert.strictEqual(cutoff, expected);
});

test('computeCutoff: 7 天的窗口', () => {
  const now = new Date('2026-06-28T12:00:00.000Z');
  const cutoff = computeCutoff(7, now);
  const diff = now.getTime() - new Date(cutoff).getTime();
  // 允许 1 秒误差
  assert.ok(Math.abs(diff - 7 * 86400_000) < 1000, `expected ~7d, got ${diff}ms`);
});

test('computeCutoff: 返回 ISO 字符串格式', () => {
  const cutoff = computeCutoff(1);
  // ISO 8601 格式: YYYY-MM-DDTHH:mm:ss.sssZ
  assert.match(cutoff, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('computeCutoff: 0 天 = 当前时间', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const cutoff = computeCutoff(0, now);
  assert.strictEqual(cutoff, now.toISOString());
});

test('computeCutoff: 大窗口 (365 天)', () => {
  const now = new Date('2026-06-28T12:00:00.000Z');
  const cutoff = computeCutoff(365, now);
  const diff = now.getTime() - new Date(cutoff).getTime();
  assert.ok(Math.abs(diff - 365 * 86400_000) < 1000);
});
