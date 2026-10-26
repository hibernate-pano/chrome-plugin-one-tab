/**
 * 「恢复之后这个会话还在不在」—— 后果措辞必须**按锁定态分流**（2026-10-23 审计 WC-1）。
 *
 * ── 这个文件要防的回归类别 ───────────────────────────────────────────────
 *
 * WC-1：卡片头两个恢复按钮的 tooltip（以及 aria-label）**不看 isLocked**，
 * 两句都写着「恢复后该会话会从列表中移除」⇒ **锁定会话的按钮也在说「会被移除」**。
 *
 * 而锁定是本产品**唯一**能让恢复后不被消费的开关
 * （TabGroup.consumeSession：`if (group.isLocked) return;`）⇒
 * 用户刚锁定的会话，鼠标一悬停就被告知「会被移除」⇒ 反而不敢恢复它。
 * 这不是文案洁癖，是**锁定的说明书在劝退用户**。
 *
 * 同一件事，仓库里已经有一句**说对了**的话（锁定 ⇒「仍保留在列表中」）
 * ⇒ 同一个产品、同一个动作上给了两套互斥的说法。
 *
 * ── 2026-10-25「安静的成功」：锁定那条的**载体换了** ──────────────────────
 *
 * 锁定会话恢复后保留在列表里 ⇒ 那张卡还在 ⇒ 界面自明 ⇒ 锁定路径整条静默
 * ⇒「锁定版成功提示」随死分支一起删掉。
 * ⇒ 锁定的后果改由卡片上那行**常驻说明**承担（`lockDisclosureText`）：
 *   随时可查，而 toast 会消失。
 * ⇒ 不变式不变：**锁定不能说「移除」**，只是这句话现在住在卡片上。
 *
 * ── 判据钉的是**语义**，不是字面量 ──────────────────────────────────────
 *
 *   · 锁定 ⇒ 后果里必须有「保留」一族词，且**不得**出现「移除」一族词；
 *   · 未锁定 ⇒ 后果里必须有「移除」一族词，且**不得**出现「保留」一族词，
 *     并且必须说清这一步**不可恢复**（撤销机制已于 2026-10-26 下线）；
 *   · 两种输入必须给出**不同**的话（否则 = 压根没分流）；
 *   · 按钮提示与成功提示必须用**同一个短语**（同一个概念不许两种叫法）。
 *
 * 等价的改写（换个说法、调一下句子顺序）不该让这些守卫变红 ——
 * 所以这里不比对任何一段中文的**逐字相等**。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  restoreOutcomePhrase,
  restoreOutcomeSentence,
} from '../../src/components/tabs/restoreFeedbackCopy.ts';
import { lockDisclosureText } from '../../src/components/tabs/lockFeedbackCopy.ts';

const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

/** 「会话还在」一族词（锁定 ⇒ 恢复后它留在列表里）。 */
const KEPT = /保留|留下|留在|还在|仍在/;
/** 「会话被消费」一族词（未锁定 ⇒ 恢复后它离开列表）。 */
const CONSUMED = /移除|删除|消失/;
/**
 * 「这一步不可恢复」一族词。
 *
 * ⚠️ 2026-10-26：原来的规则是「必须说有退路（撤销）」—— 撤销机制下线后，
 *   那个方向**反过来了**：必须说「不可恢复」，且**不许**再承诺撤销。
 */
const IRREVERSIBLE = /不可恢复|不可撤销|无法恢复/;

// ─────────────────────────────────────────────────────────────────────────
// 1. 后果措辞本身：按锁定态分流
// ─────────────────────────────────────────────────────────────────────────

describe('恢复的后果措辞：按锁定态分流（WC-1）', () => {
  it('WC-1：锁定会话恢复后必须说「保留」且不得说「移除」', () => {
    const sentence = restoreOutcomeSentence(true);
    assert.match(sentence, KEPT, '锁定会话恢复后仍在列表里 —— 必须说出来');
    assert.doesNotMatch(
      sentence,
      CONSUMED,
      '锁定会话恢复后**不被消费** ⇒ 绝不能说「移除」（那正是本缺陷）'
    );
  });

  it('WC-1：未锁定会话恢复后必须说「移除」且不得说「保留」', () => {
    const sentence = restoreOutcomeSentence(false);
    assert.match(sentence, CONSUMED, '未锁定会话恢复后即被消费 —— 必须说出来');
    assert.doesNotMatch(sentence, KEPT, '未锁定会话会被移除，不能说「保留」');
  });

  it('WC-1：未锁定那一步必须说清「不可恢复」', () => {
    // 2026-10-26：撤销机制下线 ⇒ 这条按钮提示是**点开之前**唯一的告知。
    //   说不清楚 = 用户以为那条记录只是看不见了，迟早会去找。
    assert.match(
      restoreOutcomeSentence(false),
      IRREVERSIBLE,
      '移除不可恢复（无回收站）—— 按钮提示必须说清这件事'
    );
  });

  it('WC-1：未锁定那一步不许再承诺撤销（撤销已下线）', () => {
    assert.doesNotMatch(
      restoreOutcomeSentence(false),
      /可撤销|可以撤销|撤销按钮|有退路/,
      '撤销机制已于 2026-10-26 下线 —— 承诺它就是在骗人'
    );
  });

  it('WC-1：两种锁定态必须给出不同的话（否则 = 压根没分流）', () => {
    assert.notEqual(
      restoreOutcomeSentence(true),
      restoreOutcomeSentence(false),
      '锁定与未锁定必须说两套话 —— 一套话就是没看 isLocked'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 按钮提示与成功提示必须用同一个短语（同一个概念不许两种叫法）
// ─────────────────────────────────────────────────────────────────────────

describe('按钮提示与后果短语同源（WC-1）', () => {
  it('WC-1：未锁定那句必须由共享短语 + 「不可恢复」拼出来', () => {
    // ⚠️ 2026-10-26：整组恢复的**成功提示**已随静默一起消失（那条带「撤销」
    //   按钮的提示下线了）⇒ 现在「共享短语」唯一的消费者是**按钮提示**
    //   （tooltip / aria-label）⇒ 它必须仍然是那句话的出处。
    const sentence = restoreOutcomeSentence(false);
    assert.ok(
      sentence.includes(restoreOutcomePhrase(false)),
      '未锁定后果句必须用共享短语（否则两个界面会各说各话）'
    );
    assert.match(
      sentence,
      IRREVERSIBLE,
      '未锁定后果句必须说「不可恢复」'
    );
  });

  it('WC-1：后果整句必须由共享短语拼出来', () => {
    assert.ok(
      restoreOutcomeSentence(true).includes(restoreOutcomePhrase(true)),
      '锁定后果句必须用共享短语'
    );
    assert.ok(
      restoreOutcomeSentence(false).includes(restoreOutcomePhrase(false)),
      '未锁定后果句必须用共享短语'
    );
  });

  it('WC-1：锁定那条现在由**卡片常驻行**承担，同样不能说反', () => {
    // 2026-10-25「安静的成功」：锁定会话恢复后**保留在列表里** ⇒ 那张卡还在
    // ⇒ 界面自明 ⇒ 锁定路径整条静默 ⇒「锁定版成功提示」随死分支一起删掉。
    // ⇒ 锁定的后果改由卡片上那行**常驻说明**承担（lockDisclosureText）：
    //   随时可查，而 toast 会消失。
    // 载体换了，但「同一个概念不许两种叫法 / 不许说反」这条不变式**不变**。
    const disclosure = lockDisclosureText(true);
    assert.ok(disclosure, '锁定卡片上必须有那行常驻说明（否则锁定的后果没人说得清）');
    assert.match(disclosure, KEPT, '锁定 ⇒ 恢复后保留在列表，必须说出来');
    assert.doesNotMatch(
      disclosure,
      CONSUMED,
      '锁定会话恢复后**不被消费** ⇒ 绝不能说「移除」（那正是本缺陷）'
    );
  });

  it('WC-1：未锁定 ⇒ 那行常驻说明不出现（它说的是锁定的后果）', () => {
    assert.equal(
      lockDisclosureText(false),
      null,
      '未锁定不渲染那行（那行消失就是「已解锁」的反馈）'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. 接线：列表页那两个按钮真的按锁定态分流了吗
// ─────────────────────────────────────────────────────────────────────────

/**
 * 取出列表页里所有「整个会话」相关的**提示**与**可访问名**。
 *
 * 两个恢复按钮各有两处面向用户的文案：tooltip（鼠标）与 aria-label（读屏）。
 * 只看 tooltip 不够 —— 读屏用户看不到 tooltip。
 */
function restoreSurfaces(src: string): string[] {
  // `<Tooltip` 与 `content=` 之间允许换行（JSX 格式化会把长属性拆成多行）。
  const tooltipContents = [...src.matchAll(/<Tooltip\s+content=\{`([^`]*)`\}/g)].map(m => m[1]);
  const ariaLabels = [...src.matchAll(/aria-label=\{`([^`]*)`\}/g)].map(m => m[1]);
  return [...tooltipContents, ...ariaLabels].filter(s => s.includes('整个会话'));
}

describe('列表页接线（WC-1）', () => {
  const tabGroup = read('src/components/tabs/TabGroup.tsx');

  it('WC-1：列表页必须从共享模块取后果措辞', () => {
    assert.match(
      tabGroup,
      /import\s*\{[^}]*restoreOutcomeSentence[^}]*\}\s*from\s*'@\/components\/tabs\/restoreFeedbackCopy'/,
      '后果措辞必须来自共享模块（两处各写一遍迟早漂）'
    );
  });

  it('WC-1：两个恢复按钮的 tooltip 与 aria-label 都必须按锁定态分流', () => {
    const surfaces = restoreSurfaces(tabGroup);
    assert.ok(
      surfaces.length >= 4,
      `两个恢复按钮 × (tooltip + aria-label) = 至少 4 处，实得 ${surfaces.length} 处`
    );
    for (const surface of surfaces) {
      assert.match(
        surface,
        /group\.isLocked/,
        `WC-1：两个恢复按钮的 tooltip 与 aria-label 都必须按锁定态分流 —— 这处没有：${surface}`
      );
    }
  });

  it('WC-1：锁定会话**真的**不被消费（提示语不许比代码更乐观）', () => {
    // 提示说「锁定的仍保留在列表中」⇒ 代码里就必须真的不删。
    // 反过来（代码删了、提示说留着）同样是本类的缺陷。
    assert.match(
      tabGroup,
      /const consumeSession = \(\) => \{[\s\S]{0,200}?if \(group\.isLocked\)/,
      '锁定会话恢复后必须保留（提示语与代码必须一致）'
    );
    assert.match(
      tabGroup,
      /dispatch\(deleteGroup\(group\.id\)\)/,
      '未锁定会话恢复后仍被物理移除（消费语义是 1.24.1 定案，本轮只改描述、不许改行为）'
    );
  });
});
