// 拖走会话里最后一条标签＝整组删除，必须先被拦下（2026-10-18 round 29）。
//
// 口径（「主 agent 已定的产品口味」#5）：`applyMoveTab` 在源组被搬空且未锁定时整组物理
// 删除（无回收站），而删除整组本来就有 `confirmBeforeDelete` 开关 ⇒ 拖动是连续手势，
// 判据取**拒绝这次拖拽 + 说出替代路径**（不在拖动中途弹确认框、也不做拖后回滚）。
// 判据复用 ✕ 那条路的同一份语义（`shouldAutoDeleteAfterTabRemoval`）。
//
// 真机复现见 /tmp/one-tab-loop/verify-round29.mjs。

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

const read = (rel: string) =>
  readFile(resolve(dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf8');

const ISO = '2026-10-18T00:00:00.000Z';
function mkTab(id: string): Tab {
  return {
    id, url: `https://e.com/${id}`, title: id, favicon: '',
    createdAt: ISO, lastAccessed: ISO, pinned: false,
  };
}
function mkGroup(id: string, tabs: Tab[], over: Partial<TabGroup> = {}): TabGroup {
  return {
    id, name: `g-${id}`, tabs, createdAt: ISO, updatedAt: ISO, version: 1, isLocked: false, ...over,
  };
}

describe('判据：哪些行「拖走就会删掉整个会话」', () => {
  it('未锁定 + 只有这一条活跃标签 ⇒ 会删组（拦）', async () => {
    const { shouldAutoDeleteAfterTabRemoval } = await import('@/core/tabGroupUtils');
    const g = mkGroup('g1', [mkTab('only')]);
    assert.equal(shouldAutoDeleteAfterTabRemoval(g, 'only'), true);
  });

  it('未锁定 + 还有别的活跃标签 ⇒ 不会删组（不拦）', async () => {
    const { shouldAutoDeleteAfterTabRemoval } = await import('@/core/tabGroupUtils');
    const g = mkGroup('g1', [mkTab('a'), mkTab('b')]);
    assert.equal(shouldAutoDeleteAfterTabRemoval(g, 'a'), false);
  });

  it('锁定 ⇒ 永不删组（不拦；锁定本就豁免）', async () => {
    const { shouldAutoDeleteAfterTabRemoval } = await import('@/core/tabGroupUtils');
    const g = mkGroup('g1', [mkTab('only')], { isLocked: true });
    assert.equal(shouldAutoDeleteAfterTabRemoval(g, 'only'), false);
  });
});

describe('DraggableTab：拦截排在开拖之前', () => {
  it('handleDragStart 先判 onDragBlocked 并 preventDefault，再 beginDragSession', async () => {
    const src = await read('src/components/dnd/DraggableTab.tsx');
    const start = src.indexOf('const handleDragStart = useCallback');
    const body = src.slice(start, src.indexOf('const handleDragEnd', start));
    const blockIdx = body.indexOf('if (onDragBlocked)');
    const beginIdx = body.indexOf('beginDragSession({');
    assert.ok(blockIdx > 0, '必须有 onDragBlocked 分支');
    assert.ok(beginIdx > blockIdx, '拦截必须排在 beginDragSession 之前（否则会留下没有 dragend 收尾的会话）');
    const branch = body.slice(blockIdx, beginIdx);
    assert.match(branch, /e\.preventDefault\(\)/, '必须 preventDefault 取消这次拖拽');
    assert.match(branch, /onDragBlocked\(\)/, '必须出声说明替代路径（静默 = 按了没反应）');
    assert.match(branch, /return;/, '拦截后不得继续走开拖流程');
  });

  it('memo 比较函数把 onDragBlocked 算进去（否则拦截开关变化不重渲染）', async () => {
    const src = await read('src/components/dnd/DraggableTab.tsx');
    const tail = src.slice(src.indexOf('}, (prevProps, nextProps) => {'));
    assert.match(tail, /prevProps\.onDragBlocked === nextProps\.onDragBlocked/);
  });
});

describe('TabGroup：拦截条件与文案接线', () => {
  it('条件 = confirmBeforeDelete && shouldAutoDeleteAfterTabRemoval（与 ✕ 同一份语义）', async () => {
    const src = await read('src/components/tabs/TabGroup.tsx');
    assert.match(
      src,
      /onDragBlocked=\{\s*confirmBeforeDelete && shouldAutoDeleteAfterTabRemoval\(group, tab\.id\)/,
      '判据必须复用 shouldAutoDeleteAfterTabRemoval，不许另写一套'
    );
  });

  it('提示说明后果与替代路径（指向会先确认的删除按钮）', async () => {
    const src = await read('src/components/tabs/TabGroup.tsx');
    const start = src.indexOf('const refuseDragDeleteGroup = useCallback');
    const body = src.slice(start, src.indexOf('}, [showDeleteError]);', start));
    assert.match(body, /showDeleteError\(/, '用删除口径的提示（与「会话已锁定…」同款）');
    assert.match(body, /最后一条标签/, '必须说清为什么拖不动');
    assert.match(body, /删除按钮/, '必须给出替代路径');
    assert.match(body, /会先确认/, '必须说明替代路径里有确认');
  });
});
