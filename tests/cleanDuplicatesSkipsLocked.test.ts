// 「清理重复标签」不得动锁定会话（2026-10-18 round 27）。
//
// 口径（主 agent 已定，勿再交回用户）：判据取**实现服从文案**（锁定豁免）。
// 确认文案自己写着「（锁定的会话除外）」，而 `planCleanDuplicates` 原先的
// `groups.forEach` 不判 `isLocked` ⇒ 实现会在锁定会话里删标签，两套口径打架。
// 锁定在本产品里已经统一意味着「会话内的删除一律不发生」（r4 不渲染逐条删除、
// r22 删最后一条要确认）；去重就是一次会话内删除、一次点击且不可撤销。
//
// 锁定会话里留着重复标签是可接受的残局，解锁后随时可以清理。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Tab, TabGroup } from '@/types/tab';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};
const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

before(async () => {
  register(LOADER_PATH);
});

const NOW = '2026-09-28T10:00:00.000Z';
const OLD = '2026-01-01T00:00:00.000Z';
const STAMP = { d: 'devTest', s: 1 };
const DUP = 'https://dup.com';

function mkTab(id: string, over: Partial<Tab> = {}): Tab {
  return {
    id,
    url: `https://e.com/${id}`,
    title: id,
    favicon: '',
    createdAt: OLD,
    lastAccessed: OLD,
    pinned: false,
    ...over,
  };
}

function mkGroup(id: string, tabs: Tab[], over: Partial<TabGroup> = {}): TabGroup {
  return {
    id,
    name: `g-${id}`,
    tabs,
    createdAt: OLD,
    updatedAt: OLD,
    version: 1,
    isLocked: false,
    ...over,
  };
}

const removedIds = (
  plan: { removedTabsByGroup: Array<{ groupId: string; tabIds: string[] }> },
  groupId: string
): string[] => plan.removedTabsByGroup.find(e => e.groupId === groupId)?.tabIds ?? [];

describe('planCleanDuplicates：锁定会话整组不参与去重', () => {
  it('跨组：锁定组手里是败者（更旧）时，它的标签不许进删除计划', async () => {
    const { planCleanDuplicates } = await import('@/core/mutationOps');
    const fresh = mkTab('fresh', { url: DUP, lastAccessed: NOW });
    const stale = mkTab('stale', { url: DUP, lastAccessed: OLD });
    const plan = planCleanDuplicates([
      mkGroup('g1', [fresh]),
      mkGroup('gLocked', [stale], { isLocked: true }),
    ]);

    assert.deepEqual(removedIds(plan, 'gLocked'), [], '锁定组一个标签都不许删');
    assert.equal(plan.removedTabsCount, 0, '败者在锁定组里 ⇒ 本次没有可删的重复');
    assert.equal(plan.removedGroupsCount, 0);
  });

  it('组内：锁定组自己的两条同 URL 重复也不许清理', async () => {
    const { planCleanDuplicates } = await import('@/core/mutationOps');
    const plan = planCleanDuplicates([
      mkGroup(
        'gLocked',
        [
          mkTab('newer', { url: DUP, lastAccessed: NOW }),
          mkTab('older', { url: DUP, lastAccessed: OLD }),
        ],
        { isLocked: true }
      ),
    ]);

    assert.deepEqual(removedIds(plan, 'gLocked'), []);
    assert.equal(plan.removedTabsCount, 0);
  });

  it('锁定组永不进 removedGroupIds（即便它会被清空）', async () => {
    const { planCleanDuplicates } = await import('@/core/mutationOps');
    const plan = planCleanDuplicates([
      mkGroup('g1', [mkTab('fresh', { url: DUP, lastAccessed: NOW })]),
      mkGroup('gLocked', [mkTab('stale', { url: DUP, lastAccessed: OLD })], { isLocked: true }),
    ]);

    assert.deepEqual(plan.removedGroupIds, []);
  });

  it('对照组：同一场景去掉 isLocked，败者照旧被物理移除（豁免不是把去重整个关掉）', async () => {
    const { planCleanDuplicates } = await import('@/core/mutationOps');
    const plan = planCleanDuplicates([
      mkGroup('g1', [mkTab('fresh', { url: DUP, lastAccessed: NOW })]),
      mkGroup('g2', [mkTab('stale', { url: DUP, lastAccessed: OLD })]),
    ]);

    assert.deepEqual(removedIds(plan, 'g2'), ['stale']);
    assert.equal(plan.removedTabsCount, 1);
    assert.deepEqual(plan.removedGroupIds, ['g2'], '未锁定且被清空 ⇒ 整组物理移除');
  });

  it('同一批里锁定与未锁定混排：只有未锁定那侧被清（豁免按组生效，不误伤）', async () => {
    const { planCleanDuplicates } = await import('@/core/mutationOps');
    const plan = planCleanDuplicates([
      mkGroup('gOpen', [
        mkTab('o-new', { url: DUP, lastAccessed: NOW }),
        mkTab('o-old', { url: DUP, lastAccessed: OLD }),
      ]),
      mkGroup('gLocked', [mkTab('l-old', { url: DUP, lastAccessed: OLD })], { isLocked: true }),
    ]);

    assert.deepEqual(removedIds(plan, 'gOpen'), ['o-old']);
    assert.deepEqual(removedIds(plan, 'gLocked'), []);
    assert.equal(plan.removedTabsCount, 1);
  });
});

describe('applyCleanDuplicates：落地后锁定组连标签带组都在', () => {
  it('锁定组保留标签（不是只保留空壳），且整组未被移除', async () => {
    const { applyCleanDuplicates } = await import('@/core/mutationOps');
    const { groups, plan } = applyCleanDuplicates(
      [
        mkGroup('g1', [mkTab('fresh', { url: DUP, lastAccessed: NOW })]),
        mkGroup('gLocked', [mkTab('stale', { url: DUP, lastAccessed: OLD })], { isLocked: true }),
      ],
      NOW,
      STAMP
    );

    assert.equal(plan.removedTabsCount, 0);
    assert.equal(plan.removedGroupsCount, 0);
    const locked = groups.find(g => g.id === 'gLocked');
    assert.ok(locked, '锁定组必须仍在');
    assert.deepEqual(locked!.tabs.map(t => t.id), ['stale'], '锁定组里的标签必须原样保留');
    assert.equal(locked!.isLocked, true);
  });

  it('SW 与 popup 跑的是同一个纯函数（单一口径，不许各写一份）', async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const sw = await readFile(resolve(root, 'src/background/mutationHandlers.ts'), 'utf8');
    const popup = await readFile(resolve(root, 'src/store/slices/tabSliceHelpers.ts'), 'utf8');
    assert.match(sw, /applyCleanDuplicates\(/, 'SW 侧必须用 applyCleanDuplicates');
    assert.match(popup, /planCleanDuplicates\(/, 'popup 侧必须用 planCleanDuplicates');
  });

  it('豁免落在 planCleanDuplicates 里（唯一真相处），且只有一处', async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const src = await readFile(resolve(root, 'src/core/mutationOps.ts'), 'utf8');
    const body = src.slice(
      src.indexOf('export function planCleanDuplicates'),
      src.indexOf('export function applyCleanDuplicatesPlan')
    );
    assert.match(body, /if \(group\.isLocked\) return;/, '构造 urlMap 时必须先跳过锁定组');
    assert.equal(
      (body.match(/isLocked/g) ?? []).length,
      1,
      '判据只许有一处（多写一处就是两套口径的开始）'
    );
  });
});
