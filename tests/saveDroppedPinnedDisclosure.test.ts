// 「保存」必须说出**没保存什么** —— 2026-10-20 审计 A-4 的行为级回归。
//
// 真实缺陷（主审在真机上确认，不是推测）：
//
//   默认配置 `collectPinnedTabs = false` ⇒ 用户 pin 在窗口里的标签
//   **既不会被保存、也不会被关闭** —— 它们就留在原处。
//   而成功通知只写「已将 12 个标签页保存为新会话」，一个字都没提那 3 个。
//
//   用户 pin 的通常正是最重要的工作台页面（「我 pin 了三个监控大盘」）。
//   丢弃数只进了 `logWarn` —— 日志是给开发者看的，用户看不到。
//
//   对照：`saveCurrentTab`（单标签路径）**有**明确提示
//   （「设置中未开启『保存固定标签页』」），整窗保存**没有**。
//   同一个设置，两条路径两种诚实度。
//
// 断言方式与本仓既有约定一致（见 destructiveActionHonesty.test.ts）：
//   · 文案部分直接调用**已发布的**文案函数，断言它说了该说的；
//   · 接线部分读源码，确认调用真的接上了 —— 只测文案函数的话，
//     把调用删掉测试照样绿，那正是这个缺陷当初能活下来的原因。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  saveAllSuccessMessage,
  saveAllSuccessShortMessage,
} from '../src/domain/tabGroup/saveFeedbackCopy.ts';

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

// ─────────────────────────────────────────────────────────────────────────
// 1. 文案本身：必须说出「存了多少」与「什么没存」
// ─────────────────────────────────────────────────────────────────────────

describe('保存成功文案：有丢弃时必须说出来', () => {
  it('没有丢弃时只说保存了多少', () => {
    const msg = saveAllSuccessMessage({ savedCount: 12, droppedPinnedCount: 0 });
    assert.match(msg, /已保存 12 个标签页/);
    assert.doesNotMatch(msg, /固定/, '没有丢弃就不该提固定标签（制造不必要的担心）');
  });

  it('有丢弃时必须说出丢弃了几个', () => {
    const msg = saveAllSuccessMessage({ savedCount: 12, droppedPinnedCount: 3 });
    assert.match(msg, /已保存 12 个标签页/);
    assert.match(msg, /3/, '必须说出丢了几个');
    assert.match(msg, /固定标签/, '必须说清丢的是什么');
  });

  it('有丢弃时必须说「它们还在原地」—— 否则用户以为被存进去了', () => {
    const msg = saveAllSuccessMessage({ savedCount: 12, droppedPinnedCount: 3 });
    assert.match(
      msg,
      /仍留在浏览器里|还在/,
      '没说清去向 = 用户回头找不到时反而困惑'
    );
  });

  it('有丢弃时必须给出下一步（去哪开启）', () => {
    const msg = saveAllSuccessMessage({ savedCount: 12, droppedPinnedCount: 3 });
    assert.match(msg, /设置/, '要告诉用户怎么才能存下这些标签');
  });

  it('紧凑版与完整版口径一致（短 ≠ 可以省略事实）', () => {
    const short = saveAllSuccessShortMessage({ savedCount: 12, droppedPinnedCount: 3 });
    const full = saveAllSuccessMessage({ savedCount: 12, droppedPinnedCount: 3 });
    assert.match(short, /12/, '紧凑版也要有保存数');
    assert.match(short, /3/, '紧凑版也要有丢弃数');
    assert.match(short, /固定/, '紧凑版也要说清丢的是什么');
    // 两版都必须提到固定标签 —— 紧凑版不能省掉这个事实
    assert.match(full, /固定标签/);
  });

  it('紧凑版在无丢弃时保持简短', () => {
    assert.equal(saveAllSuccessShortMessage({ savedCount: 5, droppedPinnedCount: 0 }), '已保存 5');
  });

  it('文案不得出现内部实现词（op 名、SW、协议）', () => {
    const all = [
      saveAllSuccessMessage({ savedCount: 1, droppedPinnedCount: 0 }),
      saveAllSuccessMessage({ savedCount: 1, droppedPinnedCount: 2 }),
      saveAllSuccessShortMessage({ savedCount: 1, droppedPinnedCount: 2 }),
    ].join('\n');
    for (const forbidden of ['SAVE_ALL_TABS', 'SW', 'mutation', 'pinnedCount']) {
      assert.doesNotMatch(all, new RegExp(forbidden), `文案不应出现「${forbidden}」`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 接线：三个入口真的都说了
// ─────────────────────────────────────────────────────────────────────────

describe('丢弃信息真的从 SW 一路传到了用户眼前', () => {
  it('TabManager 的系统通知用的是共享文案（不是自己拼字符串）', () => {
    const src = read('src/background/TabManager.ts');
    assert.match(
      src,
      /import\s*\{[^}]*saveAllSuccessMessage[^}]*\}\s*from\s*'@\/domain\/tabGroup\/saveFeedbackCopy'/,
      'SW 通知必须引用共享文案'
    );
    assert.match(src, /saveAllSuccessMessage\(\{/, '通知必须调用共享文案');
    // 旧的硬编码模板必须消失
    assert.doesNotMatch(
      src,
      /message:\s*`已将 \$\{safeGroup\.tabs\.length\} 个标签页保存为新会话`/,
      '旧的谎报模板还在：它不说丢了固定标签'
    );
  });

  it('saveAllTabs 统计被丢弃的固定标签数', () => {
    const src = read('src/background/TabManager.ts');
    assert.match(
      src,
      /droppedPinnedCount/,
      '必须统计丢弃数'
    );
    assert.match(
      src,
      /tabs\.filter\(tab => tab\.pinned === true\)\.length/,
      '丢弃数必须真的按 pinned 标签统计'
    );
  });

  it('saveAllTabs 返回摘要（而不是只有 boolean）—— 否则 popup 看不到丢弃数', () => {
    const src = read('src/background/TabManager.ts');
    assert.match(
      src,
      /async saveAllTabs\([^)]*\):\s*Promise<SaveAllSummary \| null>/,
      '返回类型必须带摘要，否则调用方拿不到丢弃数'
    );
  });

  it('SW 把摘要回传给 popup', () => {
    const src = read('src/service-worker.ts');
    assert.match(src, /savedCount:\s*summary\.savedCount/, '必须回传保存数');
    assert.match(src, /droppedPinnedCount:\s*summary\.droppedPinnedCount/, '必须回传丢弃数');
  });

  it('顶栏按钮的反馈用了共享文案', () => {
    const src = read('src/components/layout/Header.tsx');
    assert.match(src, /saveAllSuccessShortMessage\(/, '顶栏按钮必须用共享文案');
    assert.match(src, /saveAllSuccessMessage\(/, '顶栏按钮必须把完整说明带出来（悬停可见）');
    assert.doesNotMatch(
      src,
      /setSaveFeedback\(\{ kind: 'success', text: '已保存' \}\)/,
      '旧的「已保存」文案还在：它不说丢了固定标签'
    );
  });

  it('空态 CTA 与顶栏按钮同一口径（同一件事不能有两种说法）', () => {
    const src = read('src/components/tabs/TabList.tsx');
    assert.match(src, /saveAllSuccessShortMessage\(/, '空态 CTA 必须用同一份文案');
    assert.doesNotMatch(
      src,
      /setEmptySaveFeedback\(\{ kind: 'success', text: '已保存' \}\)/,
      '旧的「已保存」文案还在'
    );
  });
});
