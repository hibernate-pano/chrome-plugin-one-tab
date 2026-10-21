// 「恢复必须有成功反馈」——2026-10-20 审计 A-1 / A-2 的行为级回归。
//
// 两个真实缺陷（主审在真实 popup 上点出来的，非推测）：
//
//   A-1  列表页整组恢复**零反馈**：窗口开了、会话卡从列表消失、屏幕上什么都不动。
//        「我的卡片怎么没了？」是用户看到卡片凭空消失时的第一反应，而它其实是成功。
//        搜索页同一动作早就有 showRestoreSuccess —— 同一产品两个界面两种反馈，
//        而列表页才是主界面。
//
//   A-2  点开单个标签也是零反馈，而它是一次**不可撤销的删除**（无回收站）：
//        标签行消失、页面打开，用户无法区分「已打开」与「被删了」。
//        这是本产品最高频的动作。
//
// 断言方式与本仓既有约定一致（见 destructiveActionHonesty.test.ts）：
//   · 文案部分直接调用**已发布的**文案函数，断言它说了该说的；
//   · 接线部分读源码，确认调用真的接上了 —— 只测文案函数的话，
//     把调用删掉测试照样绿，那正是这个缺陷当初能活下来的原因。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  openSingleTabSuccessMessage,
  restoreAllSearchSuccessMessage,
  restoreGroupSuccessMessage,
} from '../src/components/tabs/restoreFeedbackCopy.ts';

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

// ─────────────────────────────────────────────────────────────────────────
// 1. 文案本身：必须说清「发生了什么」与「为什么卡片不见了」
// ─────────────────────────────────────────────────────────────────────────

describe('恢复成功文案：说清两件事（打开了什么 / 记录去哪了）', () => {
  it('整组恢复（未锁定）必须说「已打开」与「已从列表移除」', () => {
    const msg = restoreGroupSuccessMessage(5, false);
    assert.match(msg, /已在新窗口打开 5 个标签页/, '必须说清打开了几个');
    assert.match(msg, /已从列表移除/, '必须解释卡片为什么不见了');
  });

  it('整组恢复（锁定）必须说「仍保留在列表中」—— 锁定组不被消费', () => {
    const msg = restoreGroupSuccessMessage(3, true);
    assert.match(msg, /已在新窗口打开 3 个标签页/);
    assert.match(msg, /仍保留在列表中/);
    assert.doesNotMatch(msg, /已从列表移除/, '锁定组不被消费，不能说移除');
  });

  it('点开单标签（未锁定）必须说「已打开」与「从会话中移除」', () => {
    const msg = openSingleTabSuccessMessage(false);
    assert.match(msg, /已打开该标签页/);
    assert.match(msg, /从会话中移除/);
  });

  it('点开单标签（锁定）必须说「仍保留在会话中」', () => {
    const msg = openSingleTabSuccessMessage(true);
    assert.match(msg, /已打开该标签页/);
    assert.match(msg, /仍保留在会话中/);
    assert.doesNotMatch(msg, /从会话中移除/);
  });

  it('批量恢复（搜索页）必须说「命中的标签被移除、其余保留」', () => {
    const msg = restoreAllSearchSuccessMessage(8);
    assert.match(msg, /已恢复 8 个标签/);
    assert.match(msg, /命中的标签已从所属会话移除/);
    assert.match(msg, /会话内其余标签保留/);
  });

  it('文案不得出现内部实现词（op 名、SW、协议）', () => {
    const all = [
      restoreGroupSuccessMessage(1, false),
      restoreGroupSuccessMessage(1, true),
      openSingleTabSuccessMessage(false),
      openSingleTabSuccessMessage(true),
      restoreAllSearchSuccessMessage(1),
    ].join('\n');
    for (const forbidden of ['OPEN_TABS', 'OPEN_TAB', 'deleteGroup', 'SW', 'mutation']) {
      assert.doesNotMatch(all, new RegExp(forbidden), `文案不应出现「${forbidden}」`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 接线：调用真的接上了吗
// ─────────────────────────────────────────────────────────────────────────

describe('恢复成功反馈真的接到了两个界面', () => {
  it('列表页（TabGroup）：整组恢复与点开单标签都要出声', () => {
    const src = read('src/components/tabs/TabGroup.tsx');
    // 两个动作各一次成功反馈
    const groupRestore = src.match(/showRestoreSuccessMessage\(\s*restoreGroupSuccessMessage\(/g) ?? [];
    const singleOpen = src.match(/showRestoreSuccessMessage\(\s*openSingleTabSuccessMessage\(/g) ?? [];
    assert.equal(groupRestore.length, 1, '列表页整组恢复必须有一次成功反馈');
    assert.ok(
      singleOpen.length >= 2,
      '列表页点开单标签（锁定 / 未锁定两条路径）都必须有成功反馈'
    );
  });

  it('列表页必须从共享模块取文案，不能自己拼字符串', () => {
    const src = read('src/components/tabs/TabGroup.tsx');
    assert.match(
      src,
      /import\s*\{[^}]*restoreGroupSuccessMessage[^}]*\}\s*from\s*'@\/components\/tabs\/restoreFeedbackCopy'/,
      '列表页必须引用共享文案模块（两处各写一遍文案迟早漂移）'
    );
  });

  it('搜索页（SearchResultList）也用同一份共享文案', () => {
    const src = read('src/components/search/SearchResultList.tsx');
    assert.match(
      src,
      /restoreAllSearchSuccessMessage/,
      '搜索页必须引用共享文案模块'
    );
    assert.doesNotMatch(
      src,
      /showRestoreSuccess\(\s*matchingTabs\.length\s*\)/,
      '旧的固定模板调用应已换成共享文案（否则两处措辞会漂移）'
    );
  });

  it('toastHelper 暴露了自定义成功文案的通道', () => {
    const src = read('src/utils/toastHelper.ts');
    assert.match(src, /showRestoreSuccessMessage/, '必须提供自定义文案的出口');
    // noop 分支也要有，否则 useEnhancedToast 在无 Provider 时会崩
    const noopBranch = src.slice(src.indexOf('return {', src.indexOf('logError')));
    assert.match(noopBranch, /showRestoreSuccessMessage:\s*noop/, 'noop 分支也必须导出它');
  });
});
