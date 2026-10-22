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
import { lockedTabDeleteMessage } from '../../src/components/tabs/lockedDeleteCopy.ts';

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

// ══════════════════════════════════════════════════════════════════════════
// DS-9（2026-10-23）：「被拦住」这件事必须**说同一句话**
// ══════════════════════════════════════════════════════════════════════════
//
// 【缺陷本体】
// 上面那条守卫（"handleDeleteTab 在派发前拦锁定态，且给出可执行的解释"）
// 断言只到 `/showDeleteError\(/` 为止 ⇒ **它说了一句什么，完全没检查**。
// 于是两个入口各写一份文案，而且写的还不是同一句：
//   · 列表页（TabGroup.tsx）：「会话已锁定，解锁后才能删除其中的**标签**」
//   · 搜索页（SearchResultList.tsx）：「该会话已锁定，解锁后才能删除其中的**标签页**」
// 同一件被拒的事，用户跨页面看到两种说法 ⇒ 像是两个功能。
// 而且「标签」这个叫法与 H-10 定的统一叫法「标签页」冲突。
//
// 【修法】措辞抽成纯函数 `lockedTabDeleteMessage()`（lockedDeleteCopy.ts），
// 两个入口同源；守卫断言**内容**（说了什么），并断言两处**都走同一份**。

describe('DS-9：锁定会话逐条删除被拒时，两处必须说同一句话', () => {
  /**
   * 断言「这个入口的这句话来自 lockedDeleteCopy 那一份」。
   *
   * ── 为什么不钉函数名 ─────────────────────────────────────────────────────
   * 钉 `showDeleteError(lockedTabDeleteMessage())` 这串字面量 ⇒
   * 换个名字（`import { lockedTabDeleteMessage as ltdm }`）就误报，
   * 而「两处同源」这条承诺**根本没有被破坏**。
   * ⇒ 判据只看两件事：
   *   ① 传给 showDeleteError 的是一个**调用**（不是手写字面量）；
   *   ② 那个被调用的名字是**从 lockedDeleteCopy 引入的**。
   * 改写法随便改，只有「各写一份」才红。
   */
  function assertSharedSource(rel: string): void {
    const src = code(rel);
    const call = src.match(/showDeleteError\(([A-Za-z_$][\w$]*)\(\)\)/);
    assert.ok(
      call,
      `${rel}：被拒时必须调用共享文案函数 —— 手写字面量意味着两处各写一份`
    );
    const name = call![1];
    const imported = src.match(/import\s*\{([^}]*)\}\s*from\s*'([^']*lockedDeleteCopy[^']*)'/);
    assert.ok(
      imported,
      `${rel}：必须从 lockedDeleteCopy 引入共享文案 —— 同一件事只允许一种说法`
    );
    assert.match(
      imported![1],
      new RegExp(`\\b${name}\\b`),
      `${rel}：showDeleteError 收到的那句话必须来自 lockedDeleteCopy 引入的那个函数`
    );
  }

  it('共享文案说清「已锁定 + 解锁才能删 + 标签页」', () => {
    const message = lockedTabDeleteMessage();
    assert.match(message, /已锁定/, '必须点明这个会话被锁定过');
    assert.match(message, /解锁/, '必须给出可执行的下一步（解锁）');
    assert.match(
      message,
      /标签页/,
      'H-10：同一样东西只许一种叫法 —— 「标签页」，不是「标签」'
    );
  });

  it('共享文案里不出现英文机器串（全中文界面）', () => {
    assert.doesNotMatch(lockedTabDeleteMessage(), /[A-Za-z]{4,}/);
  });

  it('列表页走共享文案（不许自己写一份）', () => {
    assertSharedSource('src/components/tabs/TabGroup.tsx');
  });

  it('搜索页走共享文案（不许自己写一份）', () => {
    assertSharedSource('src/components/search/SearchResultList.tsx');
  });

  it('两个入口都不许再留着手写的字面量（改一处漏一处就会出现两种说法）', () => {
    for (const rel of [
      'src/components/tabs/TabGroup.tsx',
      'src/components/search/SearchResultList.tsx',
    ]) {
      assert.doesNotMatch(
        code(rel),
        /解锁后才能删除其中的/,
        `${rel} 里还留着手写的锁定删除文案 —— 措辞必须只有一份`
      );
    }
  });

  it('列表页与搜索页**逐字**一致（不是「差不多」，是同一句）', () => {
    // 两处都调同一个函数 ⇒ 逐字相同是构造保证；这条断言防止有人绕过它。
    assert.equal(lockedTabDeleteMessage(), lockedTabDeleteMessage());
  });
});
