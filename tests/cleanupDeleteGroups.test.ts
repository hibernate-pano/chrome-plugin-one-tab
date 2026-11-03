import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyDeleteGroups } from '@/core/mutationOps';

const g = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: id, tabs: [], createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z', isLocked: false, ...over,
}) as any;

describe('applyDeleteGroups', () => {
  const stamp = { s: 1, c: 'test' } as any;
  it('只删列表里还在的，别的原样留着', () => {
    const r = applyDeleteGroups([g('a'), g('b'), g('c')], ['a', 'zzz'], 'now', stamp);
    assert.deepEqual(r.groups.map(x => x.id), ['b', 'c']);
    assert.deepEqual(r.removedGroupIds, ['a']);
  });
  it('此刻已锁定的跳过并单列，不进 removedGroupIds', () => {
    const r = applyDeleteGroups([g('a'), g('b', { isLocked: true })], ['a', 'b'], 'now', stamp);
    assert.deepEqual(r.removedGroupIds, ['a']);
    assert.deepEqual(r.skippedLocked, ['b']);
    assert.deepEqual(r.groups.map(x => x.id), ['b']);
  });
  it('空列表原样返回', () => {
    const r = applyDeleteGroups([g('a')], [], 'now', stamp);
    assert.deepEqual(r.groups.map(x => x.id), ['a']);
    assert.deepEqual(r.removedGroupIds, []);
  });
});
