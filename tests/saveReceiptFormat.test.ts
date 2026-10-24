// 徽标回执的**纯函数**单测：截断规则 + 生命周期（注入时钟，不真等 60 秒）。
//
// ── 为什么单测这些 ───────────────────────────────────────────────────────
//
// ① 截断规则是**产品口径**（「1200 个标签怎么显示」）—— 口径漂了没人会发现，
//    除非把它钉下来。钉的是**性质**（恒 ≤ 4 字符 / 不夸大 / 不谎报），
//    不是某一个具体字符串。
// ② 生命周期必须**注入时钟**：真等 60 秒会让整个测试套件慢一分钟，
//    而且在 CI 上不可靠。本仓同款做法见 `src/background/syncBackoff.ts`
//    （纯函数 + 注入时钟）。
//
// ⚠️ 这两条守卫是**行为**守卫的补充，不是替代：
//    `tests/guards/saveReceiptVisible.test.ts` 守的是「保存成功 ⇒ 有不依赖
//    开关的可见回执」这条**端到端**性质；这里守的是回执**长什么样**。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BADGE_MAX_CHARS,
  RECEIPT_TTL_MS,
  badgeTextForSave,
  clearSaveReceipt,
  formatBadgeText,
  isReceiptExpired,
  issueSaveReceipt,
  paintSaveReceipt,
  receiptTooltip,
  RECEIPT_CLEAR_ALARM,
} from '@/background/saveReceipt';

describe('徽标文案：必须放得下，且不夸大批数', () => {
  it('任何数量都恒 ≤ 4 个字符（Chrome 只放得下约 4 个）', () => {
    const counts = [
      0, 1, 7, 9, 10, 99, 100, 999, 1000, 1001, 1234, 1999, 2000, 9999,
      10000, 12345, 99999, 100000, 123456, 999999, 1_000_000,
    ];
    for (const n of counts) {
      const text = formatBadgeText(n);
      assert.ok(
        text.length <= BADGE_MAX_CHARS,
        `formatBadgeText(${n}) = '${text}'（${text.length} 字符）` +
          `超了 ${BADGE_MAX_CHARS} 字符 —— Chrome 会自己裁掉尾部，` +
          `用户会把被裁过的数字误读成另一个数（比说谎更糟）。`
      );
    }
  });

  it('小数量原样显示（用户最常见的情况不该被加工）', () => {
    assert.equal(formatBadgeText(1), '1');
    assert.equal(formatBadgeText(7), '7');
    assert.equal(formatBadgeText(42), '42');
    assert.equal(formatBadgeText(999), '999');
  });

  it('四位数用 k 表示，且**向下**取整（宁可少说，不夸大）', () => {
    assert.equal(formatBadgeText(1000), '1.0k');
    assert.equal(formatBadgeText(1234), '1.2k');
    assert.equal(formatBadgeText(1999), '1.9k');
    assert.equal(formatBadgeText(9999), '9.9k');
  });

  it('五位数以上用「k+」表示「至少」—— 不假装精确', () => {
    assert.equal(formatBadgeText(10000), '10k+');
    assert.equal(formatBadgeText(12345), '12k+');
    assert.equal(formatBadgeText(99999), '99k+');
  });

  it('十万以上封顶（边际信息量为零，但必须仍在 4 字符内）', () => {
    assert.equal(formatBadgeText(100000), '99k+');
    assert.equal(formatBadgeText(999999), '99k+');
  });

  it('徽标显示的数**不得大于**真实数（不许夸大用户存下的量）', () => {
    for (const n of [1, 12, 999, 1000, 1234, 9999, 10000, 12345, 99999, 100000, 500000]) {
      const text = formatBadgeText(n);
      // 解析出徽标代表的下界（k+ / 小数都向下取）
      let lowerBound: number;
      if (text.endsWith('k+')) {
        lowerBound = parseInt(text, 10) * 1000;
      } else if (text.endsWith('k')) {
        lowerBound = parseFloat(text) * 1000;
      } else {
        lowerBound = parseInt(text, 10);
      }
      assert.ok(
        lowerBound <= n,
        `徽标 '${text}' 代表 ${lowerBound}，大于真实数 ${n} —— 徽标在夸大` +
          '（用户会以为存下的比实际多）'
      );
    }
  });

  it('0 个标签不显示徽标（那会变成「存了，但存了 0 个」的谎话）', () => {
    assert.equal(formatBadgeText(0), '');
    assert.equal(badgeTextForSave(0), '');
    assert.equal(formatBadgeText(-5), '', '负数没有意义 ⇒ 不显示');
  });

  it('非数字输入不显示徽标（而不是显示 NaN）', () => {
    assert.equal(formatBadgeText(Number.NaN), '');
    assert.equal(formatBadgeText(Number.POSITIVE_INFINITY), '');
  });
});

describe('回执生命周期：注入时钟，不真等', () => {
  it('到期前不算过期，到期那一刻就算过期', () => {
    const now = 1_000_000;
    const state = issueSaveReceipt(12, now);

    assert.equal(state.expiresAt, now + RECEIPT_TTL_MS, '到期时间 = 签发时间 + TTL');
    assert.equal(isReceiptExpired(state, now), false, '刚签发时不该算过期');
    assert.equal(isReceiptExpired(state, now + RECEIPT_TTL_MS - 1), false, '差 1ms 还没到期');
    assert.equal(
      isReceiptExpired(state, now + RECEIPT_TTL_MS),
      true,
      '到期的**那一刻**就该清（用 > 会多留一毫秒，且让边界依赖时钟精度）'
    );
    assert.equal(isReceiptExpired(state, now + RECEIPT_TTL_MS + 1), true);
  });

  it('TTL 必须大于 Chrome alarm 的 30 秒下限（否则会被 clamp，行为不可预期）', () => {
    assert.ok(
      RECEIPT_TTL_MS >= 60_000,
      `TTL = ${RECEIPT_TTL_MS}ms。Chrome 文档：「Chrome limits alarms to at most ` +
        'once every 30 seconds」—— TTL 必须远大于 30s，否则清空时机不可预期。'
    );
  });

  it('状态带着会话名与真实个数（tooltip 要用真话）', () => {
    const state = issueSaveReceipt(1234, 1000, 'github.com');
    assert.equal(state.savedCount, 1234, 'tooltip 要用原始个数，不是徽标的近似值');
    assert.equal(state.sessionName, 'github.com');
    assert.equal(state.badgeText, '1.2k');
  });
});

describe('tooltip：答「存了多少」与「叫什么名字」', () => {
  it('带会话名时两个问题都答了', () => {
    const tip = receiptTooltip(20, 'github.com');
    assert.match(tip, /20/, '必须说出存了多少个');
    assert.match(tip, /github\.com/, '必须说出叫什么名字（用户此刻问的就是这个）');
  });

  it('没有会话名时也能说清存了多少', () => {
    const tip = receiptTooltip(20);
    assert.match(tip, /20/);
    assert.doesNotMatch(tip, /（\s*）/, '空名字不该留下一个空括号');
  });

  it('空白会话名当作没有（不留下空括号）', () => {
    assert.doesNotMatch(receiptTooltip(20, '   '), /（\s*）/);
  });
});

describe('chrome.* 薄壳：回执失败绝不能把「保存成功」变成「保存失败」', () => {
  /** 记录 chrome.action 的历次调用。 */
  function makeBadgeSpy() {
    const calls = {
      texts: [] as string[],
      colors: [] as string[],
      titles: [] as string[],
    };
    return {
      calls,
      api: {
        setBadgeText: (d: { text: string }) => { calls.texts.push(d.text); },
        setBadgeBackgroundColor: (d: { color: string }) => { calls.colors.push(d.color); },
        setTitle: (d: { title: string }) => { calls.titles.push(d.title); },
      },
    };
  }

  it('画徽标：设文本、设底色、设标题，并排好清空 alarm', async () => {
    const badge = makeBadgeSpy();
    const alarms: Array<{ name: string; when: number }> = [];
    const state = issueSaveReceipt(12, 5_000, 'github.com');

    await paintSaveReceipt(
      badge.api,
      { create: (name, info) => { alarms.push({ name, when: info.when }); }, clear: () => true },
      state
    );

    assert.deepEqual(badge.calls.texts, ['12'], '徽标文本应当是存的个数');
    assert.equal(badge.calls.colors.length, 1, '底色必须设一次');
    assert.match(badge.calls.titles[0], /12/, '标题要带个数');
    assert.equal(alarms.length, 1, '必须排一个清空 alarm');
    assert.equal(alarms[0].name, RECEIPT_CLEAR_ALARM);
    assert.equal(alarms[0].when, state.expiresAt, 'alarm 必须在到期那一刻响');
  });

  it('action 全炸时**不抛错**（一次成功的保存不能被回执失败拖成失败）', async () => {
    const state = issueSaveReceipt(12, 5_000);
    const exploding = {
      setBadgeText: () => { throw new Error('no action permission'); },
      setBadgeBackgroundColor: () => { throw new Error('nope'); },
      setTitle: () => { throw new Error('nope'); },
    };
    await assert.doesNotReject(async () => {
      await paintSaveReceipt(
        exploding,
        { create: () => {}, clear: () => true },
        state
      );
    });
  });

  it('alarms 建失败时**不抛错**', async () => {
    const badge = makeBadgeSpy();
    const state = issueSaveReceipt(12, 5_000);
    await assert.doesNotReject(async () => {
      await paintSaveReceipt(
        badge.api,
        {
          create: () => { throw new Error('alarms unavailable'); },
          clear: () => true,
        },
        state
      );
    });
  });

  it('清空：清徽标 + 还原标题 + 清 alarm', async () => {
    const badge = makeBadgeSpy();
    const cleared: string[] = [];
    await clearSaveReceipt(
      badge.api,
      { create: () => {}, clear: (n) => { cleared.push(n); return true; } },
      'TapStack - 保存当前窗口并关闭这些标签'
    );
    assert.deepEqual(badge.calls.texts, [''], '徽标必须被清空');
    assert.deepEqual(badge.calls.titles, ['TapStack - 保存当前窗口并关闭这些标签'], '标题必须还原');
    assert.deepEqual(cleared, [RECEIPT_CLEAR_ALARM], 'alarm 必须被清掉');
  });

  it('清空时 action 炸了也**不抛错**', async () => {
    await assert.doesNotReject(async () => {
      await clearSaveReceipt(
        {
          setBadgeText: () => { throw new Error('x'); },
          setBadgeBackgroundColor: () => { throw new Error('x'); },
          setTitle: () => { throw new Error('x'); },
        },
        { create: () => {}, clear: () => true },
        'TapStack'
      );
    });
  });
});
