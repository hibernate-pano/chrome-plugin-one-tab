// 锁定会话不得逐条删除（2026-10-18 round 4）。
//
// 【本文件要防的回归类别】「锁定防误删」是本产品在商店页与引导页上的明确承诺
// （CHROMEWEBSTORE.md「每个会话可重命名、锁定防误删」、OnboardingSteps「重要会话
// 可锁定，避免误删」），而删除自 v1.22.0 起是**物理清除、无回收站、无撤销**。
// 修复前会话卡片头部把「重命名 / 删除整组」在锁定时隐藏了，却把每条标签的 X
// 留着：锁定的会话照样能被逐条删空，删空后还会因为视图层 isEmptyGroup 不豁免
// 锁定而整张卡片消失 —— 与「锁定防误删」正好相反，且不可恢复。
//
// 修法口径：锁定时**不渲染**删除按钮（与同卡片的重命名 / 删除整组一致），
// 而不是渲染出来再拦住 —— 后者是「按了没反应」，用户会重复点。
// 两处入口（会话卡片 / 搜索结果）必须同一口径，否则同一个产品两种行为。
//
// 为什么用源码结构断言：两个入口都是 .tsx 组件内的渲染分支，node 单测加载不了
// JSX；本仓已有同惯例（a11yLists / restoreOpenBeforeConsume / p0DataSafetyGuards）。
// 断言只钉「删除按钮被 locked 条件包住」这一条不变式，不绑定具体文案。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function code(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('会话卡片：锁定组不渲染逐条删除按钮', () => {
  const row = code('src/components/dnd/DraggableTab.tsx');
  const group = code('src/components/tabs/TabGroup.tsx');

  it('DraggableTab 声明 locked 属性并把删除按钮包在 !locked 分支里', () => {
    assert.match(row, /locked:\s*boolean/, 'DraggableTab 必须显式接收锁定态');
    const gateAt = row.indexOf('{!locked && (');
    assert.ok(gateAt !== -1, '删除按钮必须被 `{!locked && (` 包住，而不是渲染后拦截');
    const deleteBtnAt = row.indexOf('tab-item-delete-btn', gateAt);
    assert.ok(deleteBtnAt !== -1, '!locked 分支里应渲染删除按钮本身');
    assert.ok(
      row.indexOf('tab-item-delete-btn') > gateAt,
      '删除按钮只允许出现在 !locked 分支内（分支外渲染 = 锁定组仍可逐条删）'
    );
  });

  it('TabGroup 把 group.isLocked 传给 DraggableTab', () => {
    assert.match(
      group,
      /<DraggableTab[\s\S]{0,400}?locked=\{group\.isLocked\}/,
      'TabGroup 必须把锁定态传下去，否则行组件永远以为未锁定'
    );
  });

  it('TabGroup 的删除回调自身也拦锁定态（绕过 UI 的兵底）', () => {
    const start = group.indexOf('const handleDeleteTab = useCallback(');
    assert.ok(start !== -1);
    const body = group.slice(start, group.indexOf('\n  };', start));
    const lockAt = body.indexOf('if (group.isLocked)');
    const dispatchAt = body.indexOf('dispatch(deleteTabAndSync(');
    assert.ok(lockAt !== -1, '删除回调必须先判断锁定态');
    assert.ok(dispatchAt !== -1 && lockAt < dispatchAt, '锁定判断必须排在真正删除之前');
  });
});

describe('搜索结果：锁定会话不渲染逐条删除，且删除回调同口径', () => {
  const src = code('src/components/search/SearchResultList.tsx');

  it('renderTabItem 的删除按钮被 !group.isLocked 包住', () => {
    const renderStart = src.indexOf('const renderTabItem = (');
    assert.ok(renderStart !== -1);
    const body = src.slice(renderStart, src.indexOf('\n  };', renderStart));
    const gateAt = body.indexOf('{!group.isLocked && (');
    const deleteBtnAt = body.indexOf('tab-item-delete-btn');
    assert.ok(gateAt !== -1, '搜索结果行的删除按钮必须被锁定判断包住');
    assert.ok(deleteBtnAt > gateAt, '删除按钮只允许出现在未锁定分支内');
  });

  it('handleDeleteTab 在派发前拦锁定态，且给出可执行的解释', () => {
    const start = src.indexOf('const handleDeleteTab = (');
    assert.ok(start !== -1);
    const body = src.slice(start, src.indexOf('\n  };', start));
    const lockAt = body.indexOf('if (group.isLocked)');
    const dispatchAt = body.indexOf('dispatch(deleteTabAndSync(');
    assert.ok(lockAt !== -1, '搜索页单条删除必须先判断锁定态');
    assert.ok(dispatchAt !== -1 && lockAt < dispatchAt, '锁定判断必须排在真正删除之前');
    assert.match(body.slice(lockAt, dispatchAt), /showDeleteError\(/, '拦住之后必须出声，不能静默返回');
  });

  it('锁定会话在搜索结果卡片上有可见锁标记', () => {
    assert.match(
      src,
      /\{session\.group\.isLocked && \(/,
      '没有删除按钮时必须给出可见解释，否则「少了一个 X」看起来像渲染残缺'
    );
  });
});
