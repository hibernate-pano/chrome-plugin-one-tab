// 标签重排（拖拽 + 键盘）的纯逻辑单测。
//
// 【为什么现在补这层测试】拖拽功能**一直都在**（2026-10-05 瘦身只是把 react-dnd
// 换成原生 HTML5 drag events，行为一致），但全仓**零测试覆盖**：
//   grep 'DraggableTab|moveTab|keyboardReorder' tests/ → 无结果。
// 被测对象是三块纯逻辑，全部无 DOM 依赖，可以直接钉死：
//   1. keyboardReorder —— 键盘重排的决策表（纯函数）；
//   2. applyMoveTab —— 跨进程共用的重排核心语义（SW 与 popup 必须一致）；
//   3. 接线守卫 —— 组件别被改到「文件还在、实际不调用」的死代码状态。
//
// 第 3 条尤其重要：本次核查发现 DraggableTabGroup 是个**只包一层、不做拖拽**
// 的空壳（内部注释「禁用标签组拖拽功能 - 标签组应该保持固定位置」），
// 而 grep 极易只看它就误判「拖拽已下线」。真正生效的是 TabGroup.tsx 里直接渲染的
// <DraggableTab>。一旦哪天有人把 TabGroup 的 import 删了，仓库里仍然留着一个
// 叫 DraggableTabGroup 的文件，非常容易误判成「功能还在」。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { nextReorderIndex, isReorderKey } from '../src/components/dnd/keyboardReorder.ts';
import { applyMoveTab } from '../src/core/mutationOps.ts';
import type { TabGroup, Tab } from '../src/types/tab.ts';

const READ = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const STAMP = { s: 1, d: 'device-1' };

const tab = (id: string): Tab => ({
  id,
  title: id,
  url: `https://${id}.example.com`,
  favicon: '',
  pinned: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastAccessed: '2026-01-01T00:00:00.000Z',
} as Tab);

const group = (id: string, tabIds: string[]): TabGroup => ({
  id,
  name: id,
  tabs: tabIds.map(tab),
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  isLocked: false,
  version: 1,
} as unknown as TabGroup);

const ids = (g: TabGroup) => g.tabs.map(t => t.id);

describe('键盘重排：nextReorderIndex 决策表', () => {
  it('方向键移动一格，Home/End 跳到两端', () => {
    assert.equal(nextReorderIndex('ArrowUp', 2, 5), 1);
    assert.equal(nextReorderIndex('ArrowDown', 2, 5), 3);
    assert.equal(nextReorderIndex('Home', 3, 5), 0);
    assert.equal(nextReorderIndex('End', 1, 5), 4);
  });

  it('已在边界时返回 null（让调用方跳过 preventDefault，不吞键）', () => {
    // 边界必须返回 null 而不是「原地不动」：否则页面滚动等默认行为会被吞掉。
    assert.equal(nextReorderIndex('ArrowUp', 0, 5), null);
    assert.equal(nextReorderIndex('ArrowDown', 4, 5), null);
    assert.equal(nextReorderIndex('Home', 0, 5), null);
    assert.equal(nextReorderIndex('End', 4, 5), null);
  });

  it('非重排键与异常入参都返回 null', () => {
    assert.equal(nextReorderIndex('Enter', 1, 5), null);
    assert.equal(nextReorderIndex('a', 1, 5), null);
    assert.equal(nextReorderIndex('ArrowDown', 1, 1), null, '单项列表不可动');
    assert.equal(nextReorderIndex('ArrowDown', 1, 0), null, '空列表');
    assert.equal(nextReorderIndex('ArrowDown', 9, 5), null, '下标越界');
    assert.equal(nextReorderIndex('ArrowDown', -1, 5), null, '负下标');
    assert.equal(nextReorderIndex('ArrowDown', 1.5, 5), null, '非整数');
    assert.equal(nextReorderIndex('ArrowDown', 1, 5.5), null, '非整数长度');
  });

  it('isReorderKey 只认四个键', () => {
    for (const k of ['ArrowUp', 'ArrowDown', 'Home', 'End']) {
      assert.equal(isReorderKey(k), true, k);
    }
    for (const k of ['Enter', ' ', 'Escape', 'PageUp', 'ArrowLeft']) {
      assert.equal(isReorderKey(k), false, k);
    }
  });
});

describe('重排核心：applyMoveTab 语义', () => {
  const NOW = '2026-06-01T00:00:00.000Z';

  it('同组内前移：取出再插入到目标下标', () => {
    const gs = [group('g1', ['a', 'b', 'c', 'd'])];
    const r = applyMoveTab(gs, {
      sourceGroupId: 'g1', sourceIndex: 0, targetGroupId: 'g1', targetIndex: 2,
    }, NOW, STAMP);
    assert.deepEqual(ids(r.groups[0]), ['b', 'c', 'a', 'd']);
    assert.equal(r.removedGroupId, null);
  });

  it('同组内后移：顺序正确且不丢项', () => {
    const gs = [group('g1', ['a', 'b', 'c', 'd'])];
    const r = applyMoveTab(gs, {
      sourceGroupId: 'g1', sourceIndex: 3, targetGroupId: 'g1', targetIndex: 0,
    }, NOW, STAMP);
    assert.deepEqual(ids(r.groups[0]), ['d', 'a', 'b', 'c']);
  });

  it('目标下标越界时被夹到合法区间（不抛错、不丢项）', () => {
    const gs = [group('g1', ['a', 'b', 'c'])];
    const r = applyMoveTab(gs, {
      sourceGroupId: 'g1', sourceIndex: 0, targetGroupId: 'g1', targetIndex: 99,
    }, NOW, STAMP);
    assert.deepEqual(ids(r.groups[0]), ['b', 'c', 'a'], '应落到末尾');
  });

  it('跨组移动：源组移除该项、目标组插入该项', () => {
    const gs = [group('g1', ['a', 'b']), group('g2', ['c', 'd'])];
    const r = applyMoveTab(gs, {
      sourceGroupId: 'g1', sourceIndex: 0, targetGroupId: 'g2', targetIndex: 1,
    }, NOW, STAMP);
    assert.equal(r.groups.length, 2);
    assert.deepEqual(ids(r.groups[0]), ['b']);
    assert.deepEqual(ids(r.groups[1]), ['c', 'a', 'd']);
    assert.equal(r.removedGroupId, null);
  });

  it('拖走源组最后一个标签 → 源组被物理移除（这是最容易漏的语义）', () => {
    const gs = [group('g1', ['a']), group('g2', ['c'])];
    const r = applyMoveTab(gs, {
      sourceGroupId: 'g1', sourceIndex: 0, targetGroupId: 'g2', targetIndex: 0,
    }, NOW, STAMP);
    assert.equal(r.groups.length, 1);
    assert.equal(r.groups[0].id, 'g2');
    assert.equal(r.removedGroupId, 'g1');
  });

  it('锁定组被搬空也必须存活（锁定白锁 = 功能失效）', () => {
    const src = { ...group('g1', ['a']), isLocked: true };
    const gs = [src, group('g2', ['c'])];
    const r = applyMoveTab(gs, {
      sourceGroupId: 'g1', sourceIndex: 0, targetGroupId: 'g2', targetIndex: 0,
    }, NOW, STAMP);
    assert.equal(r.removedGroupId, null, '锁定组不允许因搬空被移除');
    assert.equal(r.groups.length, 2);
    assert.deepEqual(ids(r.groups[0]), []);
  });

  it('源组或下标不存在时原样返回（不抛错、不产生半成品）', () => {
    const gs = [group('g1', ['a', 'b'])];
    const noGroup = applyMoveTab(gs, {
      sourceGroupId: 'nope', sourceIndex: 0, targetGroupId: 'g1', targetIndex: 0,
    }, NOW, STAMP);
    assert.equal(noGroup.groups, gs, '应原样返回同一引用');
    assert.equal(noGroup.removedGroupId, null);

    const badIndex = applyMoveTab(gs, {
      sourceGroupId: 'g1', sourceIndex: 99, targetGroupId: 'g1', targetIndex: 0,
    }, NOW, STAMP);
    assert.equal(badIndex.groups, gs);
  });

  it('重排会推进 version / updatedAt / 印记（同步与守卫依赖它）', () => {
    const gs = [group('g1', ['a', 'b'])];
    const r = applyMoveTab(gs, {
      sourceGroupId: 'g1', sourceIndex: 0, targetGroupId: 'g1', targetIndex: 1,
    }, NOW, STAMP);
    const g = r.groups[0];
    assert.equal(g.updatedAt, NOW);
    assert.equal(g.version, 2, 'version 必须 +1，否则云端版本守卫不会接受这次重排');
    assert.deepEqual(g.lastOp, STAMP);
  });

  it('目标组返回新对象（bump 会推进 version/印记，不能沿用旧引用）', () => {
    // 反过来钉：目标组内容变了，必须是新对象，否则 React.memo 会跳过重渲染、
    // 界面停在旧顺序。这也是 applyMoveTab 里 bump() 用 `{...g}` 而非改原对象的原因。
    // 源组留两个标签，否则搬空会被物理移除、数组下标错位（测的就不是这件事了）。
    const gs = [group('g1', ['a', 'z']), group('g2', ['c', 'd'])];
    const r = applyMoveTab(gs, {
      sourceGroupId: 'g1', sourceIndex: 0, targetGroupId: 'g2', targetIndex: 0,
    }, NOW, STAMP);
    assert.equal(r.groups.length, 2, '源组仍有一个标签，不该被移除');
    assert.notEqual(r.groups[1], gs[1], '目标组应返回新对象');
    assert.deepEqual(ids(r.groups[0]), ['z']);
    assert.deepEqual(ids(r.groups[1]), ['a', 'c', 'd']);
  });
});

describe('拖拽接线守卫：别让「文件还在」被误判成「功能还在」', () => {
  it('TabGroup.tsx 真的渲染 <DraggableTab>（真正生效的拖拽入口）', () => {
    const src = READ('../src/components/tabs/TabGroup.tsx');
    assert.match(src, /import \{ DraggableTab \}/, 'TabGroup 必须 import DraggableTab');
    assert.match(src, /<DraggableTab\b/, 'TabGroup 必须真的渲染它');
    // moveTab 回调是把拖拽接到 Redux 的唯一桥。
    assert.match(src, /moveTab=\{handleMoveTab\}/, '必须把 moveTab 传下去，否则拖了没反应');
  });

  it('DraggableTab 挂的是原生 HTML5 drag 事件且可拖（不是残留的 react-dnd）', () => {
    const raw = READ('../src/components/dnd/DraggableTab.tsx');
    assert.match(raw, /draggable/, '行本身必须可拖');
    assert.match(raw, /onDragStart=/, '必须有 dragstart');
    assert.match(raw, /onDragOver=/, '必须有 dragover 才能 preventDefault 允许落下');
    // 必须剥掉注释再查：文件头有一段记录瘦身历史的注释，里面**合法地**
    // 提到了 react-dnd（「原实现用 react-dnd + HTML5Backend」）。
    // 直接对全文断言会永远失败，而把注释删掉又等于放弃这项检查。
    const code = raw
      .split('\n')
      .filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('/*') && !l.trim().startsWith('//'))
      .join('\n');
    assert.doesNotMatch(code, /react-dnd|DndProvider|useDrag\b|useDrop\b/, 'react-dnd 已移除，代码里不得回潮');
  });

  it('键盘重排可达：标题链接挂 onKeyDown 且声明 aria-keyshortcuts', () => {
    // 纯键盘用户改顺序的唯一路径。缺了它，拖拽就是唯一入口 = 无障碍缺口。
    const src = READ('../src/components/dnd/DraggableTab.tsx');
    assert.match(src, /onKeyDown=\{handleTitleKeyDown\}/, '标题链接必须挂键盘处理');
    assert.match(src, /aria-keyshortcuts="ArrowUp ArrowDown Home End"/, '须向辅助技术声明快捷键');
    assert.match(src, /role="listitem"/, '父容器是 role=list，行必须是 listitem');
  });

  it('键盘重排在重排后补焦点（否则连按方向键会中断）', () => {
    // DOM 里换了位置后浏览器可能丢焦点，源码里有 requestAnimationFrame 补焦点。
    // 这条钉住它不被优化掉 —— 丢了的话体验是「按一次就再也调不动了」。
    const src = READ('../src/components/dnd/DraggableTab.tsx');
    assert.match(src, /requestAnimationFrame/, '重排后必须补一次焦点');
  });

  it('DraggableTabGroup 是「明确不做拖拽」的空壳（避免被当成拖拽入口）', () => {
    // 它的存在极具误导性：名字里有 Draggable，实际只做 containIntrinsicSize
    // 之类的包装。删掉它或改回真拖拽时，这条会提醒同步更新上面的接线守卫。
    const src = READ('../src/components/dnd/DraggableTabGroup.tsx');
    assert.doesNotMatch(src, /onDragStart|useDrag|DndProvider/, '它本来就不做拖拽');
  });
});
