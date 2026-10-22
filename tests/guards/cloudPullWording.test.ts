/**
 * 「从云端拉回会话」这个动作在界面上**不许**用「恢复」这个词（2026-10-22 审计 WC-13）。
 *
 * ── 缺陷本体 ──────────────────────────────────────────────────────────────
 *
 * 本产品里「**恢复**」已经有明确且唯一的含义：
 * **打开某个会话的标签，并把那条记录消费掉**（列表页的「恢复整个会话」、
 * `restoreOutcomePhrase` 的「从列表移除」）。
 *
 * 而空态那个出口原先叫「**从云端恢复会话**」—— 它做的是**另一件事**：
 * 把云端的会话列表拉到本机（一次 download + merge），**不打开任何标签**、
 * **不消费任何记录**。
 *
 * ⇒ 学过「恢复 = 打开并消费」的用户点它，期待的是「打开」，而它只是下载了一份
 * 列表。两个不同的动作用同一个动词 = 承诺与事实不符。
 *
 * ── 这条守卫钉的是**不变量** ──────────────────────────────────────────────
 *
 *   ① 这个动作的**每一句**用户可见文案都用同一个动词（「拉回」）；
 *   ② 这个动作的**每一句**用户可见文案都**不含**「恢复」；
 *   ③ 同一个动作在不同出口（按钮标签 / 悬停说明 / 回执 / 登录后的 toast）
 *      **同源** —— 措辞只有一处出处（domain/tabGroup/cloudPullCopy.ts）。
 *
 * ── 判据为什么落在**纯函数**上，而不是钉某句中文 ──────────────────────────
 *
 * 判据钉的是「都含同一个动词 / 都不含另一个动词 / 都从同一个常量派生」，
 * 不是「某一句必须长这样」。⇒ 换一种**等价的**写法（换个同义词、调换语序）
 * 不会让守卫变红；把「恢复」放回来会让它变红。
 *
 * ⚠️ **覆盖范围**：这条守卫盯的是**本轮改动到的那几个出口**
 * （列表页空态 + 登录/注册后的 toast）。搜索页那个出口由**另一条线**在改
 * （`components/search/**`），它当时还在用旧说法 —— 见交付报告里的
 * 「需要人决策」一节。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTabList } from '../_helpers/tabListHarness.ts';
import { findAll } from '../_helpers/htmlTree.ts';
import {
  CLOUD_PULL_ACTION_HINT,
  CLOUD_PULL_ACTION_LABEL,
  CLOUD_PULL_BUSY_LABEL,
  CLOUD_PULL_VERB,
  cloudPullEmptyMessage,
  cloudPullFailureMessage,
  cloudPullSuccessMessage,
} from '@/domain/tabGroup/cloudPullCopy';
import {
  EMPTY_STATE_ACTION_HINT,
  EMPTY_STATE_ACTION_LABEL,
  EMPTY_STATE_EXIT_UNAVAILABLE,
} from '@/components/tabs/emptyStateActions';
import { loginRestoreFeedback } from '@/components/auth/restoreFeedbackCopy';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

/** 读源码并剥注释（注释里的措辞不算界面文案）。 */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 这个动作在界面上的**全部**用户可见文案（判据一次看全）。 */
function cloudPullUserFacingStrings(): string[] {
  return [
    CLOUD_PULL_ACTION_LABEL,
    CLOUD_PULL_ACTION_HINT,
    CLOUD_PULL_BUSY_LABEL,
    cloudPullSuccessMessage(3),
    cloudPullEmptyMessage(),
    cloudPullFailureMessage(),
    EMPTY_STATE_ACTION_LABEL.download,
    EMPTY_STATE_ACTION_HINT.download,
    EMPTY_STATE_EXIT_UNAVAILABLE.download,
    loginRestoreFeedback({ kind: 'pulled', count: 3 }).text,
    loginRestoreFeedback({ kind: 'empty' }).text,
    loginRestoreFeedback({ kind: 'failed' }).text,
  ];
}

describe('WC-13 措辞：这个动作不许用「恢复」', () => {
  it('它的每一句用户可见文案都不含「恢复」', () => {
    for (const text of cloudPullUserFacingStrings()) {
      assert.ok(
        !text.includes('恢复'),
        `「恢复」在本产品里专指「打开并消费会话」⇒ 这个动作不许用它。 offending: ${text}`
      );
    }
  });

  it('它的每一句用户可见文案都用同一个动词', () => {
    for (const text of cloudPullUserFacingStrings()) {
      assert.ok(
        text.includes(CLOUD_PULL_VERB),
        `同一个动作在不同出口必须是**同一个说法**（都含「${CLOUD_PULL_VERB}」），offending: ${text}`
      );
    }
  });
});

describe('WC-13 同源：出口标签 / 说明 / 回执都从同一处派生', () => {
  it('空态出口的标签与说明就是 domain 层那一份', () => {
    assert.equal(
      EMPTY_STATE_ACTION_LABEL.download,
      CLOUD_PULL_ACTION_LABEL,
      '出口标签必须直接引用 domain 层那一份（不许各写一遍）'
    );
    assert.equal(
      EMPTY_STATE_ACTION_HINT.download,
      CLOUD_PULL_ACTION_HINT,
      '出口说明必须直接引用 domain 层那一份'
    );
  });

  it('界面里不许出现第二份「从云端拉回会话」的字面量', () => {
    for (const rel of [
      'src/components/tabs/TabList.tsx',
      'src/components/tabs/emptyStateActions.ts',
      'src/components/auth/LoginForm.tsx',
      'src/components/auth/RegisterForm.tsx',
    ]) {
      const src = code(rel);
      assert.ok(
        !src.includes(CLOUD_PULL_ACTION_LABEL),
        `${rel} 里出现了第二份「${CLOUD_PULL_ACTION_LABEL}」的字面量 ⇒ ` +
          '措辞会漂（必须从 domain/tabGroup/cloudPullCopy.ts 派生）'
      );
      assert.ok(
        !src.includes(CLOUD_PULL_ACTION_HINT),
        `${rel} 里出现了第二份出口说明的字面量 ⇒ 措辞会漂`
      );
    }
  });

  it('这些文件里不许再有「从云端恢复」的字符串字面量（旧说法不许复活）', () => {
    for (const rel of [
      'src/components/tabs/TabList.tsx',
      'src/components/tabs/emptyStateActions.ts',
      'src/components/auth/LoginForm.tsx',
      'src/components/auth/RegisterForm.tsx',
      'src/components/auth/restoreFeedbackCopy.ts',
      'src/core/emptyStateExits.ts',
    ]) {
      const literals = code(rel).match(/'[^'\n]*'|"[^"\n]*"/g) ?? [];
      const offending = literals.filter(literal => literal.includes('从云端恢复'));
      assert.deepEqual(
        offending,
        [],
        `${rel} 里还有「从云端恢复」的字符串字面量（${offending.join('、')}）—— ` +
          '那是与「恢复＝打开并消费」撞车的旧说法'
      );
    }
  });
});

describe('WC-13 渲染层：用户真的看到的那个按钮长什么样', () => {
  it('空态里那个出口的按钮文字不含「恢复」，且用的是同一个动词', async () => {
    const rendered = await renderTabList({
      groups: [],
      syncBackend: 'supabase',
      isAuthenticated: true,
    });
    const buttons = findAll(rendered.tree, element => element.tag === 'button');
    const exit = buttons.find(button =>
      (button.attrs['data-testid'] ?? '').startsWith('empty-state-action-')
    );
    assert.ok(exit, '已登录的云端用户必须能看到「从云端拉回」那个出口');
    const label = (exit.text ?? '').trim();
    assert.ok(!label.includes('恢复'), `出口按钮不许用「恢复」：${label}`);
    assert.ok(label.includes(CLOUD_PULL_VERB), `出口按钮必须用同一个动词：${label}`);
  });

  it('右上角菜单的「从云端刷新数据」是**另一个界面**的入口，不许被这次改名波及', () => {
    const dropdown = code('src/components/layout/HeaderDropdown.tsx');
    assert.ok(
      dropdown.includes('从云端刷新数据'),
      '⋯ 菜单里的「从云端刷新数据」必须原样保留（那是维护入口，不是空态那个出口）'
    );
  });
});
