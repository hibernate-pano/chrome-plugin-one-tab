// 「恢复即消费」的退路必须**真的在用户眼前**（2026-10-23 审计 §2.5 P0）
// ＋ 队列不得静默挤掉退路（DS-43-12）。
//
// ── 这个文件要防的回归类别 ───────────────────────────────────────────────
//
// **类别 A：退路存在，但用户看不见。**
//
// 「恢复整个会话」的撤销提示是**页面内 toast**，它挂在管理页那个标签页的
// DOM 上。而整组恢复的两条路径都会**把管理页从用户眼前拿走**：
//   · 当前窗口路径：新标签 `active: true` ⇒ 管理页退为**后台标签**；
//   · 新窗口路径：  新窗口 `focused: true` ⇒ 管理页所在窗口变**后台窗口**。
//
// ⇒ 提示在 DOM 里（`isVisible()` 为真）但用户**看不见** ⇒ 那次消费事实上
//   没有退路 ⇒ 点错组且过了窗口期，这一组**永久没了**（删除即物理清除、
//   无回收站），而他连「这里原本可以撤销」都不知道。
//
// **本仓已有的假绿**：`scripts/lead-verify-undo.mjs` 断言的是
// `locator('button', {hasText:'撤销'}).isVisible()` ——
// `isVisible()` 问的是「这个元素在页面上有没有盒子」，**不关心这个页面是不是
// 用户正在看的那个** ⇒ 探针的判据比要验的判据**弱** ⇒ 上一轮它是假绿。
//
// **类别 B：退路出现过，但被静默挤掉。**
//
// 队列原本是 `prev.slice(-2)` ⇒ 超过 3 条时**最老的那条被直接丢掉**，
// 没有任何提示。而带动作的提示（「撤销」= 不可逆删除的唯一退路）与错误提示
// （「失败始终会通知」是本仓既有承诺）**都不该被静默挤掉**。
//
// **类别 C：退路本来能看见，却被人「抢回去」。**
//
// Chrome 的**标签激活是异步落地**的：新标签 `active:true` 的激活事件要等它
// **开始加载**才触发（实测：热缓存 6–20ms，冷加载 500ms+，慢站点可能好几秒）
// ⇒ 它可能**晚于**我们把管理页切回前台 ⇒ 管理页被顶回后台 ⇒ 撤销提示又看不见。
//
// 真机上量到过这个竞态：同一段代码跑 5 次有 1 次结局相反 ⇒ 靠「先激活、
// 再切回」是**赌**出来的，不可靠。
//
// ⇒ 确定性做法：**恢复出来的标签根本不抢活动位**
//   （有管理页可切回前台时用 `active:false` 打开）⇒ 活动位始终是管理页。

// ── 2026-10-26：撤销机制下线 ⇒ 这个文件守的东西**换了一件** ─────────────
//
// 原来守的是「**撤销提示**必须真的在用户眼前」：恢复整组会把管理页从用户
// 眼前拿走（新标签 active:true ⇒ 管理页退为后台标签；新窗口 focused:true ⇒
// 管理页所在窗口变后台窗口）⇒ 提示在 DOM 里（isVisible() 为真）但用户
// **看不见** ⇒ 那次消费事实上没有退路。
//
// 撤销机制下线后，**提示没了** ⇒ 「提示要看得见」这个理由也没了。
// ⇒ 但它留下的**行为**还在：恢复出来的标签**故意不抢活动位**，管理页留在眼前。
//   这现在是一条**产品选择**（恢复是列表页的动作，列表页留在眼前；恢复出来的
//   标签在同一窗口的标签栏里等着），不是一条「退路承诺」。
//   ⇒ 本文件继续钉它，但**理由**换了 —— 钉住它是为了「不许它悄悄变」，
//     不是为了「守住一条承诺」。
//
// ⚠️ 若产品负责人认定「在新窗口恢复」应该把新窗口直接顶到眼前，
//   改这里（连带 `src/background/TabManager.ts` 的三处 focus 逻辑）即可 ——
//   这不是一条有承诺在身的规则。
//
// ── 判据钉的是**性质**，不是字面量 ──────────────────────────────────────
//
//   · 「队列最多几条」是**可以调的** ⇒ 守卫不钉长度。
//   · 「管理页必须被切回前台」的实现方式（tabs.update / windows.update 的
//     组合、先后顺序）也是**可以调的** ⇒ 守卫钉**结果状态**
//     （「管理页所在窗口 focused 且管理页是活动标签」），不钉调用形状。
//   · 「恢复即消费」的语义（消费掉那条记录、锁定组不消费）**不许变** ——
//     守卫顺带钉住它，防止有人为了「修退路」把消费改回复制。
//
// ── 变异自证（实测）────────────────────────────────────────────────────
//
// 本文件的三类断言各自做过**把实现改坏**的实测，全部变红：
//
//   ① 把 `openTabsInNewWindow` 里的 `bringManagerPageToFront()` 调用删掉
//      → 「新窗口路径必须把管理页带回前台」变红。
//   ② 把 `openTabsInCurrentWindow` 里的 `bringManagerPageToFront()` 调用删掉
//      → 「当前窗口路径必须把管理页带回前台」变红。
//   ③ 把 `bringManagerPageToFront` 里的 `chrome.windows.update(...)` 删掉
//      → 「新窗口路径必须把**管理页所在窗口**也带到前台」变红
//      （只 tabs.update 不足以把后台窗口里的管理页带到用户眼前）。
//   ④ 把 `admitToast` 换回 `slice(-2)` 语义
//      → 「带动作的提示不被静默挤掉」变红。
//   ⑤ 把 `isEvictable` 改成「一律可挤掉」
//      → 「错误提示不被静默挤掉」变红。
//   ⑥ 把 `openTabsInNewWindow` 里的 `bringManagerPageToFront` 改成
//      **抛错**（而不是吞掉）→ 「焦点切换失败不许把恢复判成失败」变红。
//   ⑦ 把「找管理页失败」的 catch 改成 `throw`
//      → 「找管理页失败不许把恢复判成失败」变红（且既有测试 newFeatures 也变红）。
//   ⑧ 把 `openTabsInCurrentWindow` 里第一个标签的 `active` 改回**写死 true**
//      → 「恢复出来的标签不许和管理页抢活动位」变红。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  admitToast,
  isEvictable,
  TOAST_QUEUE_MAX,
  type ToastQueueEntry,
} from '../../src/components/common/toastQueuePolicy.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

/** 去注释后的源码：注释里提到一个符号不等于生产在用它。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** 从 `startAnchor` 起截到下一个 `\n  }`（方法体的收尾）。 */
function methodBody(src: string, startAnchor: string): string {
  const start = src.indexOf(startAnchor);
  assert.ok(start >= 0, `应能找到 ${startAnchor}`);
  const end = src.indexOf('\n  }', start);
  return src.slice(start, end === -1 ? src.length : end);
}

// ─────────────────────────────────────────────────────────────────────────
// 1. 焦点这一半：整组恢复后，管理页必须回到用户眼前
// ─────────────────────────────────────────────────────────────────────────

describe('整组恢复后：恢复出来的标签不抢活动位（管理页留在眼前）', () => {
  const src = stripComments(read('src/background/TabManager.ts'));

  it('新窗口路径：恢复完成后必须把管理页带回前台', () => {
    const body = methodBody(src, 'async openTabsInNewWindow(');
    assert.match(
      body,
      /bringManagerPageToFront\(/,
      '新窗口恢复之后必须把管理页切回前台 —— 否则管理页留在后台窗口里，' +
        '撤销提示用户看不见，那次消费事实上没有退路'
    );
  });

  it('当前窗口路径：恢复完成后必须把管理页带回前台', () => {
    const body = methodBody(src, 'async openTabsInCurrentWindow(');
    assert.match(
      body,
      /bringManagerPageToFront\(/,
      '当前窗口恢复之后必须把管理页切回前台 —— 否则新标签 active:true ' +
        '把管理页顶成后台标签，撤销提示用户看不见'
    );
  });

  it('「带回前台」必须同时做两件事：把管理页切成活动标签 + 点亮它所在的窗口', () => {
    const body = methodBody(src, 'private async bringManagerPageToFront(');
    // ① 管理页成为活动标签
    assert.match(
      body,
      /chrome\.tabs\.update\([^)]*active:\s*true/,
      '必须把管理页切成活动标签（否则它在窗口里排第二，用户看到的是恢复出来的那个标签）'
    );
    // ② 它所在的窗口被点亮
    //
    // ⚠️ 这一步在**新窗口路径**上是必需的：恢复出来的新窗口抢走了前台焦点，
    // 管理页所在窗口因此变成**后台窗口**。而 `chrome.tabs.update` **不会**
    // 把后台窗口带到前台 ⇒ 只做 ① 的话，在新窗口路径上整个动作是空操作。
    assert.match(
      body,
      /chrome\.windows\.update\([^)]*focused:\s*true/,
      '必须把管理页所在的**窗口**也带到前台 —— 只 tabs.update 不会把后台窗口点亮'
    );
  });

  it('焦点切换失败不许把「恢复」判成失败（失败必须 fail-closed 到「已恢复」）', () => {
    const body = methodBody(src, 'private async bringManagerPageToFront(');
    // 走到这一步时标签**已经开好了**（恢复已成功且不可撤销地发生）。
    // 若这里抛错 ⇒ SW 回 success:false ⇒ UI 播「恢复失败」⇒ 而标签明明开好了、
    // 记录也已被消费 ⇒ 界面在撒谎，且用户会以为会话还在列表里 ⇒ 比不做更糟。
    assert.match(
      body,
      /catch\s*\([^)]*\)\s*\{[\s\S]*?logWarn/,
      '焦点切换失败必须被吞掉并记一行警告，不许抛出去'
    );
    assert.doesNotMatch(
      body,
      /catch\s*\([^)]*\)\s*\{\s*throw/,
      '焦点切换失败**不许**抛错 —— 恢复已经成功了，不能把它判成失败'
    );
  });

  it('「找管理页」失败也不许把「恢复」判成失败（它是可选动作，不是恢复的一部分）', () => {
    // ── 这条是被既有测试逼出来的真 bug（不是假想）──────────────────────
    // 「找管理页」要问 chrome.tabs.query / chrome.runtime.getURL。
    // 它一旦抛错 ⇒ 恢复整条被判失败 ⇒ UI 说「恢复失败、原会话还留着」，
    // 而标签明明开好了、记录明明被消费了 ⇒ **界面在撒谎**。
    // 退化方式必须是「找不到 ⇒ 没有管理页可切」（把这一层降级为可选动作）。
    const body = methodBody(src, 'private async findManagerTabToReturnTo(');
    assert.match(
      body,
      /catch\s*\([^)]*\)\s*\{[\s\S]*?return null/,
      '找管理页失败必须降级成 null（= 没有管理页可切），不许把恢复判成失败'
    );
    assert.doesNotMatch(
      body,
      /catch\s*\([^)]*\)\s*\{[\s\S]*?throw/,
      '找管理页失败**不许**抛错 —— 它只服务于「把提示带回眼前」这一层'
    );
  });

  it('恢复出来的标签不许和管理页抢活动位（激活落地是异步的，晚落地会反咬一口）', () => {
    // ── 实测出来的竞态（不是假想）─────────────────────────────────────
    // Chrome 的标签激活**异步落地**：新标签 `active:true` 的激活事件要等它
    // **开始加载**才触发（实测热缓存 6–20ms、冷加载 500ms+、慢站点几秒）
    // ⇒ 它可能**晚于**我们把管理页切回前台 ⇒ 管理页被顶回后台
    // ⇒ 撤销提示又看不见（要修的 P0 复发）。
    //
    // 真机上量到过：同一段代码跑 5 次有 1 次结局相反 ⇒ 靠「先激活再切回」
    // 是赌出来的。⇒ 确定性做法：**有管理页可切回前台时，恢复出来的标签
    // 根本不抢活动位**（用 active:false 打开）。
    const body = methodBody(src, 'async openTabsInCurrentWindow(');

    // ① 「要不要把管理页切回前台」必须由「有没有管理页」决定
    assert.match(
      body,
      /const managerTarget = await this\.findManagerTabToReturnTo\(\)/,
      '必须在抢活动位之前先问出「用户刚才看的是哪个管理页」'
    );
    assert.match(
      body,
      /willFrontManager\s*=\s*managerTarget\s*!==\s*null/,
      '「要不要把管理页切回前台」这个事实必须由「有没有管理页」推导出来 —— ' +
        '恢复出来的标签抢不抢活动位，取决于同一个事实'
    );
    // ② 第一个恢复出来的标签的活动位归属，必须由同一个事实决定
    assert.match(
      body,
      /active:\s*!\s*willFrontManager/,
      '有管理页可切回前台时，恢复出来的标签**不许**抢活动位 —— ' +
        '它的激活落地时机随网络而变，晚落地会把管理页顶回后台，撤销提示又看不见'
    );
  });

  it('新窗口路径同理：管理页要切回前台时，新窗口不许抢焦点', () => {
    // 新窗口 `focused:true` 与「把管理页切回前台」是**同一个决定**的两面：
    // 两边各行其是 ⇒ 焦点被抢来抢去 ⇒ 结局不确定 ⇒ 撤销提示可能看不见。
    const body = methodBody(src, 'async openTabsInNewWindow(');
    assert.match(
      body,
      /willFrontManager\s*=\s*managerTarget\s*!==\s*null/,
      '「要不要把管理页切回前台」必须由「有没有管理页」推导出来'
    );
    assert.match(
      body,
      /focused:\s*!\s*willFrontManager/,
      '管理页要切回前台时，新窗口不许抢焦点 —— 抢了也白抢，' +
        '只会把用户带离挂着撤销提示的管理页'
    );
  });

  it('「切回前台」只看传进来的那一个管理页（不许自己再找一个，否则两个决定会打架）', () => {
    const body = methodBody(src, 'private async bringManagerPageToFront(');
    assert.doesNotMatch(
      body,
      /getExistingTabManagerTabs\(/,
      '切回前台必须只认调用方给的那个管理页 —— ' +
        '若它自己再找一个，「要不要切」与「抢不抢活动位」就可能基于两个不同的事实，' +
        '结局重新变成不确定的'
    );
  });

  it('「恢复即消费」的语义不许被这次修复动过（消费仍然是消费，锁定仍然不消费）', () => {
    // 这里守的是**消费语义**：恢复整组 = 消费掉那条记录；锁定组不消费。
    // 若有人为了「让退路更好用」把消费改回复制，这条会变红。
    //
    // ⚠️ 2026-10-26：撤销机制下线后，这里原来那条断言（「撤销凭据里带不带
    //   这条会话」）连同它守的东西一起没了 —— 撤销凭据不存在了。
    //   ⇒ 换成**锁定守卫**那条：锁定组不许被消费（它是产品唯一的退路）。
    const tabGroup = read('src/components/tabs/TabGroup.tsx');
    assert.match(
      tabGroup,
      /dispatch\(deleteGroup\(group\.id\)\)/,
      '未锁定会话恢复后仍必须被物理移除（消费语义是 1.24.1 定案，不许反悔）'
    );
    assert.match(
      tabGroup,
      /const consumeSession = \(\) => \{[\s\S]{0,200}?if \(group\.isLocked\)/,
      '锁定组恢复后必须**跳过**消费（锁定是唯一的「恢复后还在不在」开关）'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 队列这一半：带动作的提示 / 错误提示不被静默挤掉（DS-43-12）
// ─────────────────────────────────────────────────────────────────────────

describe('Toast 队列：承载退路的提示不被静默挤掉', () => {
  const entry = (
    value: string,
    kind: { hasAction?: boolean; isError?: boolean } = {},
  ): ToastQueueEntry<string> => ({
    value,
    hasAction: kind.hasAction ?? false,
    isError: kind.isError ?? false,
  });

  it('带动作的提示（撤销退路）不可被挤掉', () => {
    assert.equal(
      isEvictable(entry('undo', { hasAction: true })),
      false,
      '带动作的提示承载「恢复即消费」的唯一退路 ⇒ 不许被自动挤掉'
    );
  });

  it('错误提示不可被挤掉（失败不许因拥挤而消失）', () => {
    assert.equal(
      isEvictable(entry('boom', { isError: true })),
      false,
      '错误提示被静默挤掉 ⇒ 用户以为操作成功了 ⇒ 与「失败始终会通知」冲突'
    );
  });

  it('普通信息类提示可被挤掉（队列上限还有意义）', () => {
    assert.equal(
      isEvictable(entry('saved')),
      true,
      '普通成功提示自带倒计时，被下一条顶掉没有损失'
    );
  });

  it('队列超限时，被挤掉的是**可挤掉**的那条，退路与错误提示都还在', () => {
    const queue = [
      entry('undo', { hasAction: true }),
      entry('boom', { isError: true }),
      entry('plain-1'),
    ];
    const result = admitToast(queue, entry('plain-2'), TOAST_QUEUE_MAX);
    assert.ok(
      result.includes('undo'),
      '撤销退路不许被挤掉'
    );
    assert.ok(
      result.includes('boom'),
      '错误提示不许被挤掉'
    );
    assert.ok(
      result.length <= TOAST_QUEUE_MAX,
      '可挤掉时队列仍应回到上限'
    );
  });

  it('全是不可挤掉的（退路 + 错误）时，允许队列超限而不是丢掉其中一条', () => {
    // 这是本条守卫的核心不变式：**宁可多堆几条，也不许静默丢掉退路**。
    const queue = [
      entry('undo-1', { hasAction: true }),
      entry('undo-2', { hasAction: true }),
      entry('boom', { isError: true }),
    ];
    const result = admitToast(queue, entry('undo-3', { hasAction: true }), TOAST_QUEUE_MAX);
    assert.equal(
      result.length,
      4,
      '一条都挤不掉时必须允许超限 —— 静默丢掉一条「退路」比屏幕多堆一条严重得多'
    );
    for (const v of ['undo-1', 'undo-2', 'boom', 'undo-3']) {
      assert.ok(result.includes(v), `${v} 不许被静默丢掉`);
    }
  });

  it('没超限时队列原样保留（准入不改变正常路径的行为）', () => {
    const queue = [entry('a'), entry('b')];
    const result = admitToast(queue, entry('c'), TOAST_QUEUE_MAX);
    assert.deepEqual(result, ['a', 'b', 'c'], '未超限时不该丢任何东西，也不该改顺序');
  });
});

describe('ToastContext 真的用上了队列准入策略（接线守卫）', () => {
  const src = stripComments(read('src/contexts/ToastContext.tsx'));

  it('showToast 走的是 admitToast，而不是 slice(-2)', () => {
    assert.match(src, /admitToast\(/, 'showToast 必须走队列准入策略');
    assert.doesNotMatch(
      src,
      /slice\(\s*-2\s*\)/,
      '`slice(-2)` 会静默丢掉最老的那条 ⇒ 退路与错误提示会因此消失'
    );
  });

  it('「有没有动作」「是不是错误」这两个性质被如实传给了策略', () => {
    assert.match(
      src,
      /hasAction:\s*action\s*!==\s*undefined/,
      '必须如实告诉策略「这条带动作」—— 漏了它，退路就会被当成可挤掉的'
    );
    assert.match(
      src,
      /isError:\s*type\s*===\s*'error'/,
      '必须如实告诉策略「这条是错误」—— 漏了它，失败提示就会被当成可挤掉的'
    );
  });
});
