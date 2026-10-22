// 引导必须说清「锁定挡不住什么」与「删最后一条会先确认」（2026-10-23 审计 WC-6 / WC-9）。
//
// ── WC-6：锁定不阻止删除整个会话 ───────────────────────────────────────────
//
// 锁定的语义是「保护会话**内部**」：不可重命名、不可逐条删标签、
// 不可把标签拖到别的会话、不参与清理重复。
// 但它**不保护整张会话卡**：
//   · 删整个会话仍然可以 —— 只是会先提示「该会话已锁定」，而且**一定**要确认；
//   · 「删除所有会话」**照样会删掉**锁定会话（确认框会写明其中有几个）。
//
// 引导原来一个字没提 ⇒ 用户以为「锁了就删不掉」：
// 该删的没删（垃圾堆里躺着一堆锁定的会话），或者反过来，
// 以为锁了很安全，结果被「删除所有会话」一次性带走。
//
// ── WC-9：单条删除的那个括注 ──────────────────────────────────────────────
//
// 商店页与 README 都写着「**但如果这一删会让整个会话消失，就会先确认**」
// —— 默认设置下删掉会话里的最后一条**会**弹确认（后果等同删除整个会话）。
// 引导的删除卡片只说了「单条删除……会立即生效」，漏掉了这个例外。
//
// ⚠️ 而这个例外**只属于单条删除**，不属于拖拽：
//   · 单条 ✕ 删除 —— 会让整个会话消失时**会先确认**（`shouldAutoDeleteAfterTabRemoval`）；
//   · 拖走最后一条 —— **不确认，直接生效**（拖拽即剪切，1.24.3 定案）。
// 两条路径**行为相反** ⇒ 守卫分别断言，不许把两条并列成一条
// （详见 tests/guards/deleteConfirmationSemanticsMatchDocs.test.ts）。
//
// ── 判据钉什么 ────────────────────────────────────────────────────────────
//
// 钉**语义**（「这张卡有没有说到那件事」），不钉整段中文逐字相等：
//   · 锁定卡片与删除卡片都必须说清「仍可删除整个会话 / 会先提示已锁定 / 一定要确认」；
//   · 删除卡片必须说清「单条删除 + 整个会话消失 ⇒ 先确认」；
//   · 拖拽那一句**不得**带这个确认承诺（它是相反的行为）。
//
// 两张卡说的是同一件事 ⇒ 那个常量是**唯一出处**，守卫从常量本身读事实。
//
// ── 变异自证（每条都实测过：改坏实现 ⇒ 对应用例变红）────────────────────
//
//   M1 把 LOCK_DELETE_BOUNDARY 里的「仍可删除整个会话」删掉   ⇒ 锁定卡片那两条变红
//   M2 从删除卡片里去掉 {LOCK_DELETE_BOUNDARY}               ⇒ 接线那一条变红
//   M3 把「但如果这一删会让整个会话消失，就会先确认」删掉     ⇒ WC-9 那一条变红
//   M4 把那个括注挪到「拖走最后一条」那一句上                 ⇒ 拖拽那一条变红

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOCK_DELETE_BOUNDARY } from '@/components/onboarding/onboardingCopy';
import { deleteGroupRequiresConfirm } from '@/components/tabs/lockedDeleteCopy';
import { deleteAllLockedWarning } from '@/components/layout/deleteAllMessages';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const STEPS = read('src/components/onboarding/OnboardingSteps.tsx');
const LOCKED_DELETE = read('src/components/tabs/lockedDeleteCopy.ts');

/** 去掉注释 —— 只看**会被渲染出来**的东西。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

const STEPS_CODE = stripComments(STEPS);

/**
 * 取一张「特性卡片」里**用户真正看到的那段话**。
 *
 * 卡里的文案有一部分是常量引用（`{LOCK_DELETE_BOUNDARY}`）——
 * 源码里只有那个名字，用户看到的是它的值 ⇒ 这里把引用替换成值，
 * 判据才落在**用户读到的内容**上，而不是落在源码的字面量上。
 */
function cardText(title: string): string {
  const idx = STEPS_CODE.indexOf(`>${title}</div>`);
  assert.ok(idx > 0, `引导里找不到「${title}」这张卡 —— 守卫前提变了`);
  const start = STEPS_CODE.lastIndexOf('onboarding-feature-card', idx);
  assert.ok(start > 0, `找不到「${title}」那张卡的起点`);
  const next = STEPS_CODE.indexOf('onboarding-feature-card', idx);
  const block = STEPS_CODE.slice(start, next > 0 ? next : STEPS_CODE.length);
  return block.replace(/\{LOCK_DELETE_BOUNDARY\}/g, LOCK_DELETE_BOUNDARY);
}

/** 把一段话按「；」切成小句（引导的卡片文案就是用「；」并列的）。 */
const clauses = (text: string): string[] =>
  text
    .split(/[；;]/)
    .map(s => s.trim())
    .filter(Boolean);

describe('WC-6 · 事实来源：实现确实是「锁定不阻止删除整个会话」', () => {
  it('删除锁定会话的确认框会点名「该会话已锁定」', () => {
    assert.match(
      LOCKED_DELETE,
      /该会话已锁定/,
      '事实来源变了：删除锁定会话的提示不再点名「已锁定」'
    );
  });

  it('锁定会话的删除**一定**要确认（不受「删除前确认」开关影响）', () => {
    // 判**行为**，不判源码字面量：关掉「删除前确认」时，锁定会话仍要确认。
    assert.equal(
      deleteGroupRequiresConfirm({ isLocked: true, confirmBeforeDelete: false }),
      true,
      '事实来源变了：锁定会话不再强制确认 —— 引导里「一定要确认」就变成了假话'
    );
    assert.equal(
      deleteGroupRequiresConfirm({ isLocked: false, confirmBeforeDelete: true }),
      true,
      '事实来源变了：普通会话的删除也不再听「删除前确认」开关'
    );
    assert.equal(
      deleteGroupRequiresConfirm({ isLocked: false, confirmBeforeDelete: false }),
      false,
      '事实来源变了：普通会话的删除不再听「删除前确认」开关'
    );
  });

  it('「删除所有会话」会删掉锁定会话，且确认框会点名', () => {
    const warning = deleteAllLockedWarning({ lockedCount: 2 });
    assert.match(
      warning,
      /2/,
      `事实来源变了：确认框不再写明有几个锁定会话：${warning}`
    );
    assert.match(
      warning,
      /已锁定的会话.*也会被删除/,
      `事实来源变了：确认框不再说锁定会话也会被删 —— 引导里那句就变成了假话：${warning}`
    );
  });
});

describe('WC-6 · 那个共享常量本身必须把两件事说全', () => {
  it('必须说「仍可删除整个会话」', () => {
    assert.match(
      LOCK_DELETE_BOUNDARY,
      /仍可删除整个会话/,
      '必须说清锁定**不阻止**删除整个会话'
    );
  });

  it('必须说会先提示「该会话已锁定」而且一定要确认', () => {
    assert.match(LOCK_DELETE_BOUNDARY, /该会话已锁定/, '必须点名「该会话已锁定」');
    assert.match(LOCK_DELETE_BOUNDARY, /一定要确认/, '必须说这一步**一定**要确认');
  });

  it('必须说「删除所有会话」照样会删掉锁定会话', () => {
    assert.match(
      LOCK_DELETE_BOUNDARY,
      /「删除所有会话」同样会删掉锁定会话/,
      '必须说清「删除所有会话」照样会删掉锁定会话'
    );
  });
});

describe('WC-6 · 锁定卡片与删除卡片都要说清这件事', () => {
  for (const title of ['锁定保护', '误删保护']) {
    it(`「${title}」那张卡说到了「仍可删除整个会话」`, () => {
      const text = cardText(title);
      assert.match(text, /仍可删除整个会话/, `「${title}」那张卡没提「仍可删除整个会话」`);
      assert.match(text, /该会话已锁定/, `「${title}」那张卡没提「该会话已锁定」`);
      assert.match(text, /一定要确认/, `「${title}」那张卡没提「一定要确认」`);
      assert.match(
        text,
        /「删除所有会话」同样会删掉锁定会话/,
        `「${title}」那张卡没提「删除所有会话」照样会删掉锁定会话`
      );
    });
  }

  it('两张卡引用的是**同一个**常量（不是各写一遍中文）', () => {
    const usages = STEPS_CODE.match(/\{LOCK_DELETE_BOUNDARY\}/g) ?? [];
    assert.equal(
      usages.length,
      2,
      `引导里应当有两处引用 LOCK_DELETE_BOUNDARY（锁定卡片 + 删除卡片），实际 ${usages.length} 处`
    );
  });
});

describe('WC-9 · 单条删除的例外必须说清，且不得挪到拖拽那一句上', () => {
  const deleteCard = cardText('误删保护');

  it('「单条删除」那一句必须说「会让整个会话消失时先确认」', () => {
    const clause = clauses(deleteCard).find(c => /单条/.test(c));
    assert.ok(clause, `删除卡片里找不到讲「单条删除」的那一句：${deleteCard}`);
    assert.match(
      clause,
      /整个会话消失/,
      `这一句必须提到「整个会话消失」这个前提：${clause}`
    );
    assert.match(
      clause,
      /先确认/,
      `这一句必须说「会先确认」—— 默认设置下删最后一条**会**弹确认：${clause}`
    );
  });

  it('「拖走最后一条」那一句**不得**承诺确认（拖拽即剪切，不拦你）', () => {
    const clause = clauses(deleteCard).find(c => /拖到别的会话/.test(c));
    assert.ok(clause, `删除卡片里找不到讲「拖到别的会话」的那一句：${deleteCard}`);
    assert.doesNotMatch(
      clause,
      /先确认|会弹确认|需要确认/,
      `拖拽路径**不弹确认**（1.24.3 定案）—— 不得把单条删除的例外挪到它身上：${clause}`
    );
    assert.match(
      clause,
      /立即生效|直接生效|不多问/,
      `拖拽那一句必须点明它是直接生效的：${clause}`
    );
  });

  it('两条路径不得被写成同一条（它们行为相反）', () => {
    for (const clause of clauses(deleteCard)) {
      if (!/单条/.test(clause)) continue;
      assert.doesNotMatch(
        clause,
        /以及|拖到别的会话/,
        `这句把「单条删除」与「拖走最后一条」并列成了一条 —— ` +
          '但它们行为相反（单条删除会让整个会话消失时先确认，拖拽不确认）。' +
          `（ offending 句：${clause}）`
      );
    }
  });
});
