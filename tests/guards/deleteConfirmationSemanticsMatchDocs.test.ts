// 「删除要不要确认」必须与代码一致（2026-10-20 L-16）。
//
// ── 这个文件要防的具体事故 ────────────────────────────────────────────────
//
// 商店页与 README 此前把**两条不同的路径**写成了一句：
//
//   「单条标签删除、以及把最后一条标签拖到别的会话，会立即生效、不弹确认——
//     **但如果这一删会让整个会话消失，就会先确认**」
//
// 而代码的真实行为是**两条路径相反**：
//
//   ① 单条标签删除（× 按钮）—— 会让整个会话消失时**会先确认**
//      （`TabGroup.tsx`：判据 `confirmBeforeDelete && shouldAutoDeleteAfterTabRemoval`）
//   ② 拖走最后一条标签 —— **不确认，直接生效**，被搬空的会话随之消失
//      （1.24.3 明确回退了 round 29 的拦截：「拖拽即剪切，不许拦截」；
//        `handleMoveTab` 直接 dispatch，**没有** showConfirm）
//
// 所以那句文案是**两句话拼错了**：它把 ② 的行为（不确认）写在了前面，
// 又把 ① 的例外（会确认）套在了 ② 身上。
//
// 后果不是「文案啰嗦」：用户按那句承诺，会以为拖走最后一条标签会被拦一下
// （于是放心去拖），而实际上**整个会话当场消失、无回收站、不可恢复**。
// 审核员按承诺核对行为 ⇒ 描述与实现不符。
//
// ── 这个文件守什么 ────────────────────────────────────────────────────────
//
// 判据**从代码取事实**（不是从文档取）：
//   ① 代码里「单条标签删除会确认」⇒ 文档必须说它会确认；
//   ② 代码里「拖走最后一条不确认」⇒ 文档必须说它不确认；
//   ③ 两条路径**不得**被写成同一条（合并成一个「会立即生效」）。
//
// ── 事实来源（代码） ──────────────────────────────────────────────────────
//
//   ① `src/components/tabs/TabGroup.tsx` 的单条删除分支：出现
//      `shouldAutoDeleteAfterTabRemoval` + `showConfirm` ⇒ 会确认。
//   ② `src/components/tabs/TabGroup.tsx` 的 `handleMoveTab`：**没有**
//      `showConfirm` / `confirmBeforeDelete` ⇒ 不确认。
//      ③ `src/core/mutationOps.ts` 的 `applyMoveTab`：源组被搬空 ⇒
//      `removedGroupId` 整组物理移除（⇒「会话会随之消失」这件事是真的）。
//
// 【为什么 ② 用「没有 showConfirm」来判】这是**否定式**判据，
// 改起来脆（将来有人加一个 showConfirm 就该变）。但它是唯一能表达
// 「这条路径**不**弹确认」的方式 —— 断言「必须出现某个东西」
// 无法证明「另一样东西**不**在」。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const STORE = read('CHROMEWEBSTORE.md');
const README = read('README.md');
const TAB_GROUP = read('src/components/tabs/TabGroup.tsx');
const MUTATION_OPS = read('src/core/mutationOps.ts');

/** 商店文档的「正文」：排除版本历史表（历史条目描述的是**当时**的行为）。 */
const storeBody = (): string =>
  STORE.split('## Version History')[0].split('## Review Notes')[0];

/**
 * 从源码里切出某个函数的体（按大括号配平）。
 *
 * 【为什么不用正则去「找 handleMoveTab 到下一个 const」】函数体里
 * 嵌套着对象字面量与回调，正则会在嵌套的 `}` 处提前截断，
 * 判据就会落在错误的范围内。配平大括号是唯一稳的做法。
 */
const functionBody = (src: string, signature: string): string => {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `源码里找不到 ${signature}`);
  const open = src.indexOf('{', start);
  assert.notEqual(open, -1, `${signature} 后面没有 {`);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`${signature} 的大括号没有配平`);
};

/**
 * 「拖走最后一条标签」这件事在文案里的**各种说法**。
 *
 * 【为什么不用一个精确短语】第一版守卫只认「拖走最后一条标签」，
 * 而真实文案（也是缺陷原文）写的是「把最后一条标签**拖到**别的会话」——
 * 于是「把最后一条标签拖到别的会话」这种写法**完全不被判据覆盖**，
 * 变异验证 D1 实测：**把缺陷原文放回去，守卫全绿**。
 *
 * ⇒ 判据必须认「这件事」而不是「这句话」。
 * 三个核心信号（任一命中即认为提到了它）：
 *   · 提到了「最后一条标签」；
 *   · 提到了「拖到别的会话」/「dragging the last tab out」；
 *   · 同时提到了「拖」与「会话」。
 */
const MENTIONS_DRAG_LAST = /最后一条标签|拖到别的会话|dragging the last tab out|drag the last tab/i;

/** 「单条标签删除」这件事在文案里的各种说法。 */
const MENTIONS_SINGLE_DELETE = /单条标签|单个标签|single tab|one tab/i;

describe('L-16 ① 事实来源：两条删除路径的确认行为', () => {
  it('单条标签删除：会让整个会话消失时会先确认', () => {
    const body = functionBody(TAB_GROUP, 'const handleDeleteTab');
    assert.match(
      body,
      /shouldAutoDeleteAfterTabRemoval/,
      '单条删除的判据里应当有「删完会不会让整个会话消失」'
    );
    assert.match(
      body,
      /showConfirm\(/,
      '单条删除会让整个会话消失时**必须**先确认'
    );

    /**
     * 【为什么还要判「那个判据真的能拦住」】
     * 只断言「函数体里有 showConfirm」是不够的：只要有人把守卫条件
     * 改成 `if (true || ...)`，showConfirm 还在，但**永远走不到** ——
     * 行为已经变成「不确认」，文档却还在说「会先确认」。
     * 变异验证 D5 实测过这个洞。
     *
     * ⇒ 断言：那个早退条件里**不得**有无条件为真的短路项。
     *
     * 【为什么不用 `[^)]*` 抓条件】条件里有**嵌套的右括号**：
     * `shouldAutoDeleteAfterTabRemoval(group, tabId)` —— `[^)]*` 会在
     * 第一个 `)` 处截断，抓到的是半截条件，匹配必然失败
     * （第一版这么写 ⇒ **基线就是红的**，教训：正则要按括号配平抓，不能按字符类截）。
     */
    const guard = body.match(
      /if\s*\(([^;]*shouldAutoDeleteAfterTabRemoval[\s\S]*?)\)\s*\{/
    );
    assert.ok(
      guard,
      '单条删除里找不到「会让整个会话消失时先确认」那个判据 —— ' +
        '守卫条件应当形如 `if (!confirmBeforeDelete || !shouldAutoDeleteAfterTabRemoval(...))`'
    );
    assert.doesNotMatch(
      guard[1],
      /^\s*true\s*(\|\||&&)|\|\|\s*true\b|&&\s*true\b/,
      '那个判据里出现无条件为真的短路项 ⇒ 确认框永远走不到 —— ' +
        '行为已变成「不确认」，文档承诺的「会先确认」就是假的。' +
        `（ offending 判据：${guard[1]}）`
    );
  });

  it('拖走最后一条标签：不确认（拖拽即剪切，1.24.3 定案）', () => {
    const body = functionBody(TAB_GROUP, 'const handleMoveTab');
    assert.doesNotMatch(
      body,
      /showConfirm\(/,
      '拖拽路径**不弹确认**（1.24.3 明确回退了 round 29 的拦截）—— ' +
        '文档必须如实说明，不能承诺一个不存在的确认框。'
    );
    assert.doesNotMatch(
      body,
      /confirmBeforeDelete/,
      '拖拽路径不受「删除会话前确认」开关约束'
    );
  });

  it('拖走最后一条：源会话确实会随之消失（这是「后果等同删除整个会话」的依据）', () => {
    assert.match(
      MUTATION_OPS,
      /removedGroupId\s*=\s*args\.sourceGroupId/,
      'applyMoveTab 在源组被搬空时把整组标记为移除'
    );
    assert.match(
      MUTATION_OPS,
      /out\s*=\s*out\.filter\(\s*g\s*=>\s*g\.id\s*!==\s*args\.sourceGroupId\s*\)/,
      '被搬空的源会话被物理移除（无回收站）'
    );
  });
});

describe('L-16 ② 文档必须把这两条路径分开说', () => {
  it('商店页不得把「单条删除」与「拖走最后一条」写成同一条', () => {
    /**
     * 缺陷原文的形态是「A、以及 B，会立即生效」—— 用「以及」把两条
     * **行为相反**的路径并列。判据：句子里同时提到这两件事时，
     * 不得出现把它们并列起来的连接词。
     */
    for (const seg of storeBody().split(/[。；\n]/).map(s => s.trim()).filter(Boolean)) {
      if (!MENTIONS_DRAG_LAST.test(seg)) continue;
      if (!MENTIONS_SINGLE_DELETE.test(seg)) continue;
      // 出现并列连接词 ⇒ 两条被写成了一条
      assert.doesNotMatch(
        seg,
        /以及|、[^，。；]{0,12}(?:拖|drag)|or dragging|、[^，。；]{0,20}single tab/i,
        `这一句把「单条标签删除」与「拖走最后一条标签」并列成了一条 —— ` +
          '但它们**行为相反**：单条删除会让整个会话消失时**会先确认**，' +
          '拖走最后一条**不确认、直接生效**。' +
          `（ offending 片段：${seg.slice(0, 200)}）`
      );
    }
  });

  it('商店页必须说明「拖走最后一条」不确认', () => {
    /**
     * 【为什么用「就近窗口」而不是「紧跟在后面」】
     * 正确的中文写法是「……拖到别的会话**，则是**直接生效……」——
     * 中间隔着「，则是**」这几个字。若要求「拖走最后一条标签」后面
     * **紧跟**「直接生效」，这条断言会把**正确文案**判成红
     * （本仓反复吃过的亏：守卫钉错了值，挡住了正确的改动）。
     *
     * 【为什么必须限定在「误删保护」那一段】
     * 「拖到别的会话」这个词组在**锁定**那一条里也出现过
     * （「不可把标签拖到别的会话」—— 那是**锁定**的语义，与确认无关）。
     * 若全文扫「提到拖动的句子」，那条会被一并抓进来 ⇒ 判红 ⇒ 假红。
     * ⇒ 只看**讲删除保护**的那一段。
     */
    const body = storeBody();
    const protectionSection = (() => {
      const m = body.match(/[^\n]*误删保护[^\n]*|[^\n]*Deletion protection[^\n]*/i);
      assert.ok(m, '商店页里找不到「误删保护」那一行 —— 判据锚点丢了');
      return m[0];
    })();

    const dragSentences = protectionSection
      .split(/[。；\n]/)
      .map(s => s.trim())
      .filter(s => MENTIONS_DRAG_LAST.test(s));
    assert.ok(
      dragSentences.length > 0,
      '「误删保护」那一行里没有提到「拖走最后一条标签」—— ' +
        '那条路径的确认行为必须被说明（它与单条删除**行为相反**）。'
    );
    for (const s of dragSentences) {
      const m = s.match(MENTIONS_DRAG_LAST);
      const idx = m?.index ?? 0;
      const window = s.slice(idx, idx + 160);
      assert.match(
        window,
        /直接生效|不多问|不弹确认|不额外拦|随之消失|right away|no extra question|immediately/i,
        '谈「拖走最后一条标签」的那一句必须点明它是**直接生效、不多问一句** —— ' +
          '代码里这条路径**没有**确认框（1.24.3 定案）。' +
          `（ offending 句：${s.slice(0, 200)}）`
      );
    }
  });

  it('商店页必须说明「单条删除会让整个会话消失时」会先确认', () => {
    assert.match(
      storeBody(),
      /单条标签删除[^。；\n]{0,80}(会让整个会话消失|整个会话消失)[^。；\n]{0,40}(会先确认|先确认)/,
      '商店页必须说明「单条标签删除若会让整个会话消失 ⇒ 会先确认」'
    );
  });

  it('README 同样必须把两条路径分开说', () => {
    const readme = README;
    assert.doesNotMatch(
      readme,
      /单条标签删除、以及把最后一条标签拖到别的会话，会立即生效/,
      'README 把两条行为相反的路径写成了同一条 —— 必须分开。'
    );
    assert.match(
      readme,
      /拖到别的会话[^。；\n]{0,120}(直接生效|不多问|不弹确认)/,
      'README 必须说明「拖走最后一条标签」直接生效、不多问一句'
    );
    assert.match(
      readme,
      /单条标签删除[^。；\n]{0,80}(会让整个会话消失|整个会话消失)[^。；\n]{0,40}会先确认/,
      'README 必须说明「单条标签删除若会让整个会话消失 ⇒ 会先确认」'
    );
  });
});
