// 拖走会话里最后一条标签 = 整组删除，**这是核心规则，不许拦截**（2026-10-19）。
//
// ── 这个文件为什么被改写而不是删掉 ──────────────────────────────────────
// round 29（commit 4837492）曾在这里钉住相反的口径：「拖动会整组删除 ⇒ 拒绝这次拖拽，
// 提示改用右侧删除按钮」。判据本身算得对，但它**拦掉了产品最核心的一条交互**：
// 拖拽是连续手势，被拒绝后用户要做的是「换个入口重做同一个移动」。用了很多年的行为
// 被一轮评审收走，此后几轮都没人翻回来。
//
// 产品负责人 2026-10-19 明确要求恢复原规则：**直接删除，不加确认**。
//
// 所以这个文件不删——把它的断言反过来，继续守着「这条路必须走得通」。
// 若将来有人又想加拦截，这里会立刻变红，迫使他先回答产品负责人的那句话。
//
// 数据层从未变过：`applyMoveTab` 在源组被搬空且未锁定时整组物理移除；锁定组豁免。
// 被删掉的只是 UI 层那道墙。

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

// ─────────────────────────────────────────────────────────────────────────
// 第一部分：数据层语义（从未变过，这两条是回退的**依据**）
// ─────────────────────────────────────────────────────────────────────────

describe('判据：哪些行「拖走就会删掉整个会话」', () => {
  it('未锁定 + 只有这一条活跃标签 ⇒ 搬走即整组删除（核心规则）', async () => {
    const { shouldAutoDeleteAfterTabRemoval } = await import('@/core/tabGroupUtils');
    const g = mkGroup('g1', [mkTab('only')]);
    assert.equal(
      shouldAutoDeleteAfterTabRemoval(g, 'only'),
      true,
      '会话是容器：搬空最后一条内容，容器随之消失（这是被恢复的那条规则）',
    );
  });

  it('未锁定 + 还有别的活跃标签 ⇒ 不删组', async () => {
    const { shouldAutoDeleteAfterTabRemoval } = await import('@/core/tabGroupUtils');
    const g = mkGroup('g1', [mkTab('a'), mkTab('b')]);
    assert.equal(shouldAutoDeleteAfterTabRemoval(g, 'a'), false);
  });

  it('锁定 ⇒ 永不删组（锁定 = 组内不发生删除，与本次回退无关）', async () => {
    const { shouldAutoDeleteAfterTabRemoval } = await import('@/core/tabGroupUtils');
    const g = mkGroup('g1', [mkTab('only')], { isLocked: true });
    assert.equal(shouldAutoDeleteAfterTabRemoval(g, 'only'), false);
  });
});

describe('数据层：移走最后一条标签真的会整组物理移除', () => {
  it('applyMoveTab 把源组搬空 ⇒ 源组从结果里消失，目标组收到那条标签', async () => {
    const { applyMoveTab } = await import('@/core/mutationOps');
    const tab = mkTab('only');
    const groups = [mkGroup('src', [tab]), mkGroup('dst', [mkTab('d1')])];

    const r = applyMoveTab(
      groups,
      { sourceGroupId: 'src', sourceIndex: 0, targetGroupId: 'dst', targetIndex: 1 },
      ISO,
      { d: 'devTest', s: 9 },
    );

    assert.equal(
      r.groups.some(g => g.id === 'src'),
      false,
      '源组被搬空 ⇒ 必须整组物理移除（无回收站、不可逆）',
    );
    const dst = r.groups.find(g => g.id === 'dst');
    assert.ok(dst, '目标组必须保留');
    assert.deepEqual(dst!.tabs.map(t => t.id), ['d1', 'only'], '标签必须真的落到目标位置');
    assert.equal(
      r.removedGroupId,
      'src',
      '结果必须点名被删掉的源组（调用方据此决定是否提示广播失败）',
    );
  });

  it('锁定源组被搬空时保留（锁定豁免，不是本次回退带来的行为）', async () => {
    const { applyMoveTab } = await import('@/core/mutationOps');
    const groups = [mkGroup('locked', [mkTab('only')], { isLocked: true }), mkGroup('dst', [mkTab('d1')])];
    const r = applyMoveTab(
      groups,
      { sourceGroupId: 'locked', sourceIndex: 0, targetGroupId: 'dst', targetIndex: 1 },
      ISO,
      { d: 'devTest', s: 10 },
    );
    assert.ok(r.groups.some(g => g.id === 'locked'), '锁定会话不得被搬空删除');
    assert.equal(r.removedGroupId, null, '锁定组没有整组删除');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 第二部分：UI 层**不得**再拦这条路（这是 round 29 被回退掉的东西）
// ─────────────────────────────────────────────────────────────────────────

describe('TabGroup：不得再拦「拖走最后一条标签」', () => {
  it('不给 DraggableTab 传 onDragBlocked（传了就等于拒绝这次拖拽）', async () => {
    const src = await read('src/components/tabs/TabGroup.tsx');
    // 只允许注释里提到它；JSX 属性里出现就是拦截回来了
    const jsxUse = /onDragBlocked=\{/.test(src);
    assert.equal(
      jsxUse,
      false,
      'TabGroup 又给 DraggableTab 传了 onDragBlocked —— 这会禁止拖走会话的最后一条标签，' +
        '而那是产品负责人 2026-10-19 明确要求保留的核心规则。要做拦截请先回去问。',
    );
  });

  it('旧的拦截回调 refuseDragDeleteGroup 已移除', async () => {
    const src = await read('src/components/tabs/TabGroup.tsx');
    assert.doesNotMatch(
      src,
      /const refuseDragDeleteGroup = useCallback/,
      '拦截提示函数仍在 = 拦截逻辑还在（即使没接上也不该留死代码）',
    );
  });

  it('注释里写清了为什么允许这条路（防止下一次「改进」又把墙砌回去）', async () => {
    const src = await read('src/components/tabs/TabGroup.tsx');
    assert.match(src, /不拦|不再传 `onDragBlocked`/, '必须留下「为什么不拦」的说明');
    assert.match(src, /核心/, '必须点明这是核心规则，而不是一个可以再商量的偏好');
  });
});

describe('DraggableTab：机制保留，但默认不启用', () => {
  it('onDragBlocked 仍是可选 prop，且 onDragStart 里仍有分支（留着以便将来按需接）', async () => {
    const src = await read('src/components/dnd/DraggableTab.tsx');
    assert.match(src, /onDragBlocked\?:/, '机制本身保留（不删），只是没人传');
    const start = src.indexOf('const handleDragStart = useCallback');
    const body = src.slice(start, src.indexOf('const handleDragEnd', start));
    assert.match(body, /if \(onDragBlocked\)/, '分支保留：不传时自然跳过');
  });

  it('拦截分支仍排在 beginDragSession 之前（将来若启用，顺序必须正确）', async () => {
    const src = await read('src/components/dnd/DraggableTab.tsx');
    const start = src.indexOf('const handleDragStart = useCallback');
    const body = src.slice(start, src.indexOf('const handleDragEnd', start));
    const blockIdx = body.indexOf('if (onDragBlocked)');
    const beginIdx = body.indexOf('beginDragSession({');
    assert.ok(blockIdx > 0 && beginIdx > blockIdx, '拦截必须排在开拖之前，否则会留下没有 dragend 收尾的会话');
  });
});
