// 同一个动作只能有一个叫法：「删除所有会话」（2026-10-23 审计 WC-8）。
//
// ── 这个文件防的具体事故 ──────────────────────────────────────────────────
//
// 同一个动作（清空本机全部会话）在两处用了两个词：
//   · 菜单里（`HeaderDropdown.tsx`）叫「删除所有会话（N）」—— 这是**界面上的**叫法；
//   · README / 引导 / 隐私政策 / 商店页叫「删除全部会话」。
//
// 后果不是「措辞不统一」这么轻：用户读的是商店页（「删除全部会话」），
// 打开菜单找「删除全部会话」**找不到**（那儿写的是「删除所有会话」）⇒
// 他要么以为功能不存在，要么乱点一个看起来差不多的按钮。
// 同一个动作两个名字 = 一次「按文档找功能」的失败。
//
// ── 判据钉什么 ────────────────────────────────────────────────────────────
//
// **不钉字面量**：叫法从**界面**（菜单那一行）现场读出来 ——
// 界面是这套产品自己的基准，改界面的人自然会看到守卫变红。
// 然后要求所有文档用**同一个**词，且**不许**出现另一个词。
//
// ⚠️ CHROMEWEBSTORE.md 的**正文（Store Listing 段）**已在本守卫覆盖内；
//    只剩「Review Notes / Known Issues」段还有一处待改（同一批里由主控代改，
//    见下面那条「≤ 1」的断言）。主控改完后可以把那条上限收紧成 0。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const DROPDOWN = read('src/components/layout/HeaderDropdown.tsx');
const README = read('README.md');
const PRIVACY = read('src/legal/privacy.html');
const STEPS = read('src/components/onboarding/OnboardingSteps.tsx');
const STORE = read('CHROMEWEBSTORE.md');

/** 去掉注释 —— 只看**会被渲染出来**的东西。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * 界面上那个叫法（从菜单那一行现场读）。
 *
 * 菜单行长这样：`删除所有会话（{menuGroupCount}）` ⇒ 去掉计数括号就是叫法。
 * 这样改名的人（无论是改菜单还是改文档）都会撞到守卫。
 *
 * ⚠️ 计数那一段**故意不钉成 `groups.length`**（2026-10-23 DS-43-15）：
 * 菜单行的计数已改成取磁盘真值（表达式名会变），而这个守卫要守的是
 * **叫法**，不是计数怎么来的。钉死计数表达式 ⇒ 换一种正确的写法就误报。
 */
function uiDeleteAllTerm(): string {
  const m = DROPDOWN.match(/删除[^，。；「」（）]{0,8}会话（\{[^}]+\}）/);
  assert.ok(
    m,
    '菜单里找不到「删除…会话（{…}）」那一行 —— 守卫的前提变了'
  );
  return m[0].replace(/（\{[^}]+\}）$/, '');
}

/** 另一个（历史遗留的）叫法。 */
const OTHER_TERM = '删除全部会话';

/** 必须与界面同名的那些出口。 */
const FILES: ReadonlyArray<{ rel: string; text: string; label: string }> = [
  { rel: 'README.md', text: README, label: 'README' },
  { rel: 'src/legal/privacy.html', text: PRIVACY, label: '隐私政策' },
  {
    rel: 'src/components/onboarding/OnboardingSteps.tsx',
    text: stripComments(STEPS),
    label: '新手引导',
  },
];

describe('WC-8 · 界面上那个叫法是基准', () => {
  it('菜单里能读出「删除…会话（N）」这个叫法', () => {
    const term = uiDeleteAllTerm();
    assert.ok(term.length > 0, '读不出菜单里的叫法');
    assert.ok(
      term.endsWith('会话'),
      `菜单里的叫法读出来是「${term}」—— 守卫的取法需要重新核对`
    );
  });

  it('界面与文档之间没有第二个叫法', () => {
    const term = uiDeleteAllTerm();
    assert.notEqual(
      term,
      OTHER_TERM,
      `界面上现在叫「${term}」，而本守卫认为基准是「删除所有会话」—— ` +
        '若确实要改界面的叫法，请连本守卫一起改（并同步所有文档）。'
    );
  });
});

describe('WC-8 · 商店页（同一批里由主控代改）', () => {
  it('商店页的正文（Store Listing 段）必须已经用界面上的叫法', () => {
    const body = STORE.split('## Version History')[0];
    assert.ok(
      !body.includes(OTHER_TERM),
      `商店页正文里还有「${OTHER_TERM}」—— 审核员读的就是这一段`
    );
  });

  it('商店页里不许再有「删除全部会话」（主控已代改完最后那一处）', () => {
    // 已知待改的那一处（Review Notes / Known Issues）主控已改完 ⇒ 上限收紧成 **0**。
    // 用「= 0」而不是「≤ 1」：上限一松，「又漂回来一处」就抓不到了 ——
    // 棘轮只能往紧里收，不能往松里退。
    const n = (STORE.match(new RegExp(OTHER_TERM, 'g')) ?? []).length;
    assert.equal(
      n,
      0,
      `商店页里有 ${n} 处「${OTHER_TERM}」—— 全店统一叫「删除所有会话」` +
        `（叫法从界面现场读，改界面就要连本守卫一起改）`
    );
  });
});

describe('WC-8 · 所有出口必须用界面上那个叫法', () => {
  for (const file of FILES) {
    it(`${file.label}（${file.rel}）必须用界面上的叫法`, () => {
      const term = uiDeleteAllTerm();
      assert.ok(
        file.text.includes(term),
        `${file.label} 里找不到「${term}」—— 同一个动作必须只有一个叫法`
      );
    });

    it(`${file.label}（${file.rel}）不得出现另一个叫法`, () => {
      assert.ok(
        !file.text.includes(OTHER_TERM),
        `${file.label} 还在用「${OTHER_TERM}」，而界面上叫「${uiDeleteAllTerm()}」—— ` +
          '用户按文档找菜单项会找不到'
      );
    });
  }
});
