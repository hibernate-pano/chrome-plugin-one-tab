// 文档 ↔ 代码一致性回归（v1.22.0 废除墓碑体系之后的文档批）。
//
// 为什么要有这层测试：v1.22.0 把删除语义从「进回收站、7 天可恢复」改成「删除即物理移除」，
// 而 README / 商店文案 / 隐私政策 / 两份计划文档是在那之前写的。结果是同一份商店文案的中英
// 双语对同一功能给出互相矛盾、且与代码相反的描述——对海外用户是虚假承诺；隐私政策还向用户
// 承诺了「本地与云端同步清除」，而 markCloudGroupsAsDeleted 只是把 is_deleted 置 true 并保留
// 行，物理清除要等 purgeExpiredCloudTombstones 的 30 天 TTL。这类漂移不会让任何测试变红，
// 所以这里把它钉死。
//
// 形状统一为「改坏一个文档文件就必须被列成错误」：每条断言都从代码或 manifest 反推事实，
// 再拿文档去对，而不是把期望字符串硬编码在测试里。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const STORE = read('CHROMEWEBSTORE.md');
const README = read('README.md');
const PRIVACY = read('src/legal/privacy.html');
const V2_PLAN = read('docs/v2-plan.md');
const DEV_PLAN = read('docs/dev-plan-2026-09-27.md');
const Y_SHADOW = read('docs/y-shadow-v2.md');
const ONBOARDING = read('src/components/onboarding/OnboardingSteps.tsx');

/** 剥掉注释再断言：注释里提到旧文案不算「界面还这么写」。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** 取出 `> Last Updated: YYYY-MM-DD` 的日期。 */
function lastUpdatedDate(md: string): string {
  const m = md.match(/^> Last Updated:\s*(\d{4}-\d{2}-\d{2})/m);
  assert.ok(m, 'CHROMEWEBSTORE.md 顶部必须有 `> Last Updated: YYYY-MM-DD`');
  return m[1];
}

/** 版本历史表第一列（版本号）后面那一格的日期，取最大值。 */
function newestHistoryDate(md: string): string {
  const dates = [...md.matchAll(/^\|\s*\d+\.\d+\.\d+\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|/gm)].map(m => m[1]);
  assert.ok(dates.length > 0, 'CHROMEWEBSTORE.md 版本历史表必须能被解析');
  return dates.sort().at(-1)!;
}

/** 取以 prefix 开头的那一行（列表项 / 表格行都适用）。 */
function lineStartingWith(md: string, prefix: string): string {
  const line = md.split('\n').find(l => l.trimStart().startsWith(prefix));
  assert.ok(line, `找不到以「${prefix}」开头的行`);
  return line;
}

// ── 测试基线的「事实来源」：从 tests/ 目录现场数出来 ────────────────────────
//
// 为什么不能把「当前基线」写死成一个数字（原来写死 695）：
//   每加一个用例，真实基线就变一次。写死的数字只有两种下场：
//     · 数字不变 → 下一个加用例的人 CI 变红，他要么改文档（改数字）
//       要么改测试（改期望）—— 两者都是「为了变绿而改」，不是「为了正确而改」；
//     · 数字改新 → 本次「文档改成真实值」这一**正确的修正**当场把守卫打红，
//       守卫从「保护事实」退化成「保护现状」。
//   根因：守卫断言的是**具体数值**，而它真正要保护的是**语义**
//   （「提到旧基线 N 的地方必须同时给出一个 ≥ N 的当前基线」）。
//   所以：旧基线 N 仍然是写死的（那是文档里的历史事实，改它要改文档），
//   「当前基线」则从代码现场推导，并把「≥ N」作为不变式。
function collectTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) collectTestFiles(p, out);
    else if (entry.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/**
 * 现场统计测试规模。
 *
 * 口径说明：node:test 的 `it` 是**语句**，而 `it`/`test` 也可能作为对象方法出现
 * （如 `suite.it(...)`）。这里区分两个口径：
 *   · ACTUAL_IT_BLOCKS —— 只数「前面不是 . 也不是标识符字符」的 it(/test( 调用，
 *     即真正的顶层用例声明（实测 173 个文件 / 1856 个 it / 73 个 test）；
 *   · ACTUAL_MAX_BLOCKS —— 连对象方法一起数的上界（用于「文档不许吹大规模」，
 *     取上界是为了**宁可漏判也不误判**：合法的文档数字不会被这条误伤）。
 * 绝对值本身不是断言对象 —— 断言对象是「文档给的当前基线 ≥ 文档提到的旧基线」。
 */
const TEST_FILES = collectTestFiles(resolve(ROOT, 'tests'));
const ACTUAL_IT_BLOCKS = TEST_FILES.reduce((sum, f) => {
  const src = readFileSync(f, 'utf8');
  const its = src.match(/(^|[^.\w$])it\s*\(/g)?.length ?? 0;
  const tests = src.match(/(^|[^.\w$])test\s*\(/g)?.length ?? 0;
  return sum + its + tests;
}, 0);
const ACTUAL_MAX_BLOCKS = TEST_FILES.reduce((sum, f) => {
  const src = readFileSync(f, 'utf8');
  return sum + (src.match(/\b(?:it|test)\s*\(/g)?.length ?? 0);
}, 0);
const ACTUAL_TEST_FILES = TEST_FILES.length;

/**
 * 「当前基线」的标注词 —— 后面必须紧跟数字才算数。
 *
 * 刻意**不**把裸「实测」列为标注词：文档里出现过「（2026-10-02 实测；「368」为 …）」这种写法，
 * 裸「实测」会把后面引号里的 368 误当成当前基线。
 */
const CURRENT_BASELINE_RE =
  /(?:当前基线|基线为|实测为|改正为|更正为|现为|当前为)\s*[*「（(\s]*(\d+)/g;

/** 带单位词的测试数：N 单测 / N 个单测 / N+ 单测 / N 用例。 */
const TEST_COUNT_RE = /(?<![\d.])(\d+)\s*\+?\s*(?:个)?\s*(单测|用例)/g;

/**
 * 引号里**只**有一个数字（可带 + 与单位词）：「334 单测」「356+」「368」。
 * 这是历史基线在文档里的另一种写法。
 * 刻意要求引号内容「只有数字」：否则「墓碑 7 天生命周期」这种
 * 带说明文字的引号也会被当成基线数字。
 */
const QUOTED_NUMBER_RE = /[「『]\s*(\d+)\s*\+?\s*(?:单测|用例)?\s*[」』]/g;

/** 历史措辞：跟在引号数字后面，把「引号里的数字」认定为历史快照。 */
const HISTORICAL_MARKER_RE = /快照|当时|原写|原文|原称|已失效/;

/** 文件路径：用于区分「整套基线」与「某个文件的用例数」。 */
const FILE_PATH_RE = /[\w./-]*\.(?:ts|tsx|sql|md|mjs)\b/;

interface BaselineFacts {
  /** 这一行自称的「当前基线」数字（可能没有）。 */
  current: number[];
  /** 这一行提到的「整套基线」数字（可能没有）。 */
  suiteCounts: number[];
}

/**
 * 解析一行里「当前基线」与「整套基线」两个数字集合。
 *
 * 关键区分：
 *   1. **「整套基线」vs「某个文件的用例数」**：
 *      「334 单测」/「695 个单测」= 整套仓库的用例数 → 基线；
 *      「（12 用例）」紧跟在 `tests/tombstone.test.ts` 后面 = 那个文件的用例数，
 *      跟基线无关（而且它描述的文件压根不存在）。
 *      判据：行里出现文件路径时，「用例」计数的单位词一律不算整套基线；
 *      「单测」计数的单位词在任何情况下都算（文档里「单测」只用于整套基线）。
 *   2. **「当前基线」本身不算历史基线**：同一行里给出的当前值（如 695）
 *      就是「现在的基线」，不能同时被当成「必须 ≥ 的历史数字」——
 *      否则「当前基线 695 < 695」这种自相矛盾会被误报。
 *      历史基线指的是**另一个**（更旧的）数字。
 */
function parseBaselineFacts(line: string): BaselineFacts {
  const current = [...line.matchAll(CURRENT_BASELINE_RE)].map(m => Number(m[1]));
  const currentSet = new Set(current);
  const hasFilePath = FILE_PATH_RE.test(line);
  const suiteCounts: number[] = [];
  const push = (n: number) => {
    if (currentSet.has(n)) return; // 当前基线自己不是「历史基线」
    if (!suiteCounts.includes(n)) suiteCounts.push(n);
  };
  for (const m of line.matchAll(TEST_COUNT_RE)) {
    const unit = m[2];
    if (unit === '用例' && hasFilePath) continue;
    push(Number(m[1]));
  }
  for (const m of line.matchAll(QUOTED_NUMBER_RE)) {
    // 引号数字必须紧跟历史措辞才算历史基线（「368」为 2026-09-29 快照）。
    const after = line.slice(m.index + m[0].length, m.index + m[0].length + 24);
    if (!HISTORICAL_MARKER_RE.test(after)) continue;
    push(Number(m[1]));
  }
  return { current, suiteCounts };
}

/**
 * 断言：凡是提到整套基线 N 的行，必须同时给出一个**不小于 N** 的当前基线。
 *
 * 这条不变式的方向性很重要：
 *   · 当前基线 ≥ N ⇒ 文档没有把现状说得比历史还小（把 695 改成实测 1831 依然成立）；
 *   · 当前基线 < N ⇒ 文档把现状说得比历史还小（把 695 改成 10 立刻判红）。
 * 用「语义」而不是「具体数字」，测试数量增长时永远不需要改这条断言。
 */
function assertBaselineSemantics(md: string, relPath: string): void {
  const lines = md.split('\n');
  for (const [i, line] of lines.entries()) {
    const { current, suiteCounts } = parseBaselineFacts(line);
    if (suiteCounts.length === 0) continue;
    if (current.length === 0) {
      assert.fail(
        `${relPath}:${i + 1} 提到整套基线 ${suiteCounts.join('/')} 却没给当前基线：` +
          `读者会把它当成现状。当前基线必须以「当前基线 N」这类明确措辞给出。\n  ${line.trim()}`
      );
    }
    const maxCurrent = Math.max(...current);
    for (const n of suiteCounts) {
      assert.ok(
        maxCurrent >= n,
        `${relPath}:${i + 1} 的当前基线 ${maxCurrent} 小于文中提到的整套基线 ${n}：` +
          `这是把现状说得比历史还小（数字不成立）。\n  ${line.trim()}`
      );
    }
  }
}

/**
 * 这一行是不是在**回溯地断言**「某个文件曾经存在过」。
 *
 * 只有这种句子才需要「该文件不存在」的撤回声明 —— 读者会被误导成「它还在」。
 * 向前指路的句子（见 §3 / 待实现 / 计划新增）不需要：它本来就在说「还没有」。
 *
 * 判据：句子里出现**回溯措辞**（曾经/原来/原写/原称/原文/历史/当年的/当时的）
 * 且没有出现**前向措辞**（尚未实现/待实现/计划/将要/未来）时才算历史性断言。
 * 「原称」是本仓库文档里实际使用的措辞（v2-plan 的 §5 状态栏一条）。
 */
function isHistoricalClaim(line: string): boolean {
  const BACKWARD = /曾经|原来|原写|原称|原文|历史|当年的|当时的|已删除|已废弃/;
  const FORWARD = /尚未实现|待实现|计划|将要|未来|拟新增|待新增/;
  if (FORWARD.test(line)) return false;
  return BACKWARD.test(line);
}

/**
 * 逐行检查「提到幽灵文件（从未落地的源文件）的地方是否给出了撤回声明」。
 *
 * 返回违规行（空数组 = 全部合规）。抽成纯函数是为了能**直接测**：
 * 光靠「当前文档恰好合规」测不出规则退化 —— 规则一旦退回过宽形态，
 * 只要文档里没有前向引用就依然全绿（这正是 2026-10-20 之前的情况）。
 */
function findGhostFileViolations(md: string, ghosts: string[]): { line: number; ghost: string; text: string }[] {
  const violations: { line: number; ghost: string; text: string }[] = [];
  const lines = md.split('\n');
  for (const ghost of ghosts) {
    for (const [i, line] of lines.entries()) {
      if (!line.includes(ghost)) continue;
      if (!isHistoricalClaim(line)) continue; // 前向引用 → 不要求撤回声明
      const retracted = line.includes('~~');
      const corrected = [line, lines[i + 1] ?? '', lines[i - 1] ?? ''].join('\n');
      const ok = retracted || /不存在|作废|事实改正/.test(corrected);
      if (!ok) violations.push({ line: i + 1, ghost, text: line.trim() });
    }
  }
  return violations;
}

describe('CHROMEWEBSTORE.md：中英双语对删除语义的描述必须一致且不承诺回收站', () => {
  it('英文版不承诺「回收站 + 随时恢复」', () => {
    const en = lineStartingWith(STORE, '· Deletion protection:');
    assert.doesNotMatch(
      en,
      /can be restored|restored anytime/i,
      '英文版仍在承诺删除后可恢复——v1.22.0 起删除即物理移除、不可恢复'
    );
  });

  it('英文版明说没有回收站与撤销', () => {
    const en = lineStartingWith(STORE, '· Deletion protection:');
    assert.match(en, /no recycle bin/i, '英文版必须明说不存在回收站');
    assert.match(en, /no undo/i, '英文版必须明说没有撤销');
  });

  it('英文版与中文版对「删除后会发生什么」的结论一致', () => {
    const en = lineStartingWith(STORE, '· Deletion protection:');
    const zh = lineStartingWith(STORE, '· 误删保护：');
    // 中文版说「彻底清除」，英文版必须表达同一个结论（permanently removed）。
    assert.match(zh, /彻底清除/, '中文版基准：删除后彻底清除');
    assert.match(en, /permanently removed/i, '英文版必须与中文版「彻底清除」结论一致');
  });
});

/**
 * 版本历史的**语域**守卫：商店那栏必须是给用户看的摘要，不是工程复盘。
 *
 * ── 为什么要有这一条 ────────────────────────────────────────────────────
 * CHROMEWEBSTORE.md 与 docs/RELEASE-NOTES.md 的分工，是本仓自己写在
 * RELEASE-NOTES.md 顶部的约定：
 *   · 商店那份 = **提交商店的文案源**（用户视角）
 *   · 台账那份 = **工程视角的长期台账**（含根因、踩坑、修复顺序、验证过程）
 * 「两边都会写『本版改了什么』，但只有台账那份会记住『为什么』和『后来怎么验证的』。」
 *
 * 现实里这两份会长成同一份东西：台账写得顺手，顺手把根因分析和「15 个变异点验证」
 * 一起复制进商店那栏。于是用户在商店页读到的是一则**工程复盘** ——
 * 既不是「我自豪地展示给别人的东西」，也让「我为什么该升级」变得难以下咽。
 * 而且**没有任何测试会变红**：文档不会自己告警（这正是本文件存在的理由）。
 *
 * ── 判据 ────────────────────────────────────────────────────────────────
 * 钉**语域**（engineering-register 词汇），不钉具体文案。
 * 这些词只可能出现在「解释这版是怎么修的」的行文里 —— 一条面向用户的更新说明
 * 讲的是「你的数据会不会没了」「设置页现在能不能出去」，不需要它们。
 */
describe('CHROMEWEBSTORE.md：版本历史里最新一版必须是给用户看的摘要', () => {
  /** 版本历史表里版本号最大的那一行的「Changes」整格。 */
  const newestChangelog = (() => {
    const section = STORE.split('## Version History')[1]?.split('\n## ')[0] ?? '';
    const rows = [...section.matchAll(/^\|\s*(\d+\.\d+\.\d+)\s*\|\s*[\d-]+\s*\|(.*)$/gm)];
    assert.ok(rows.length > 0, 'CHROMEWEBSTORE.md 的版本历史表必须能解析出行');
    const newest = rows.reduce((a, b) => {
      const pa = a[1].split('.').map(Number);
      const pb = b[1].split('.').map(Number);
      const cmp = pb[0] - pa[0] || pb[1] - pa[1] || pb[2] - pa[2];
      return cmp > 0 ? b : a;
    });
    // 表格是 `| 版本 | 日期 | 变更 | 状态 |`；变更格内部若含 `|` 也要保得住，
    // 所以取「倒数第二段之前」的全部片段，而不是固定下标。
    const cells = newest[0].split('|');
    return cells.slice(3, -2).join('|').trim();
  })();

  it('变更说明里不得出现「解释怎么修的」那套工程词汇', () => {
    // 这些词是**工程复盘语域**的指纹。用户在商店页要读的是「这版对我有什么用」，
    // 不是「我们怎么定位和验证的」—— 后者属于 docs/RELEASE-NOTES.md。
    const engineeringRegister = [
      '变异点',
      '变红',
      '回归测试',
      '自动化测试',
      '根因',
      '守卫',
      '幂等',
      '断言',
      '静默吞写',
      '真机实测',
      // 「验证」一族：讲「我们怎么证明它是对的」而不是「它对你意味着什么」。
      // 例外：不是所有「验证」都不该出现 —— 「已修复」这类**结论**要留，
      // 剔的是**过程**（跑了几条测试、在什么浏览器里跑的、跑了什么检查）。
      '全量测试',
      '类型检查',
      '代码规范检查',
      '真实浏览器',
      '有头浏览器',
    ];
    const hits = engineeringRegister.filter(w => newestChangelog.includes(w));
    assert.deepEqual(
      hits,
      [],
      `商店版本说明里出现了工程复盘语域的词：${hits.join('、')}—— ` +
        '用户读到的是「这版怎么修的」，不是「这版对我有什么用」。' +
        '把工程细节留在 docs/RELEASE-NOTES.md，商店这栏只留用户视角的结论。'
    );
  });

  it('变更说明不得为空（摘要也要说清楚这版改了什么）', () => {
    assert.ok(
      newestChangelog.length >= 20,
      `最新一版的商店变更说明只有 ${newestChangelog.length} 个字 —— 太短等于没写`
    );
  });
});

describe('src/web/public/privacy.html：不得夸大云端删除时效', () => {
  it('不再声称删除后本地与云端同步清除', () => {
    assert.doesNotMatch(
      PRIVACY,
      /本地与云端数据同步清除/,
      'markCloudGroupsAsDeleted 只置 is_deleted=true 并保留行，物理清除要等 30 天 TTL'
    );
  });

  it('如实披露 30 天云端延迟物理清除', () => {
    assert.match(PRIVACY, /30\s*天/, '必须写明云端标记行的保留时长');
    assert.match(PRIVACY, /不可恢复/, '必须写明本地删除后不可恢复');
    assert.match(PRIVACY, /没有撤销入口|无撤销/, '必须写明没有回收站/撤销');
  });

  it('如实披露云端加密不是端到端加密', () => {
    // 密钥由 userId 派生（src/utils/encryptionUtils.ts:18-25），userId 是公开标识，
    // 所以 README 明确声明这不是 E2E；隐私政策不能读起来像 E2E。
    assert.match(PRIVACY, /并非端到端加密|不是端到端加密/, '必须澄清不是端到端加密');
  });

  it('权限披露覆盖 manifest 声明的每一个权限', () => {
    const manifest = JSON.parse(read('manifest.json')) as {
      permissions: string[];
      host_permissions: string[];
    };
    for (const perm of [...manifest.permissions, ...manifest.host_permissions]) {
      assert.ok(
        PRIVACY.includes(perm),
        `隐私政策未披露 manifest 里的权限「${perm}」——商店「权限说明」要求逐项披露`
      );
    }
  });

  it('最后更新日期不是过期的 2026-02-13', () => {
    assert.doesNotMatch(PRIVACY, /2026-02-13/, '隐私政策本轮已实质修改，最后更新日期必须同步');
    assert.match(PRIVACY, /最后更新：\d{4}-\d{2}-\d{2}/);
  });
});

/**
 * 从 ThemeStyleSelector.tsx 里解析出主题 id 列表。
 *
 * 主题 id 允许数字与连字符（solarized-light、nord2 这类名字是合法的）：
 * 只允许纯小写字母的写法会**静默漏掉**带数字/连字符的主题 → 计数偏小 →
 * README 写对了也会被误判成写错。这类漏检比误报更危险，所以口径放宽。
 */
function parseThemeIds(selectorSrc: string): string[] {
  return [...selectorSrc.matchAll(/^\s*value:\s*'([a-z0-9-]+)',/gm)].map(m => m[1]);
}

describe('README.md：主题数量必须与选择器实际选项一致', () => {
  it('声明的套数 == ThemeStyleSelector 实际渲染的套数', () => {
    // 2026-09-28 提交 8d38b55 把 8 套收敛成 4 套（9→8→4），README 却一直写「9 套」。
    const selector = read('src/components/layout/ThemeStyleSelector.tsx');
    const themes = parseThemeIds(selector);
    assert.ok(themes.length > 0, '必须能从 ThemeStyleSelector 解析出主题列表');
    const claim = README.match(/(\d+)\s*套主题风格/);
    assert.ok(claim, 'README 必须声明主题套数');
    assert.equal(
      Number(claim[1]),
      themes.length,
      `README 写 ${claim[1]} 套，实际选择器只有 ${themes.length} 套（${themes.join(' / ')}）`
    );
  });

  it('（规则自测）主题解析不得漏掉带数字或连字符的主题 id', () => {
    // 这条把「口径放宽」钉死：仓库现在恰好没有带连字符的主题，
    // 光靠上一条断言**测不出**口径退化（旧正则同样能数出 6 套）。
    // 加一条合成输入，口径一旦退回只允许纯小写字母就会立刻变红。
    const synthetic = [
      "    value: 'legacy',",
      "    value: 'solarized-light',",
      "    value: 'nord2',",
    ].join('\n');
    assert.deepEqual(
      parseThemeIds(synthetic),
      ['legacy', 'solarized-light', 'nord2'],
      '主题解析漏掉了带连字符/数字的 id：口径退回 [a-z]+ 了'
    );
  });

  it('README 的删除描述与无墓碑模型一致', () => {
    assert.match(README, /删除即物理清除|不进回收站/, 'README 必须明说删除即物理清除、无回收站');
  });
});

describe('docs/v2-plan.md：作废声明 + 不引用不存在的文件', () => {
  it('文件顶部有指向 v1.22.0 的作废声明', () => {
    const head = V2_PLAN.split('\n').slice(0, 8).join('\n');
    assert.match(head, /作废声明/, '顶部必须有显式作废声明');
    assert.match(head, /v1\.22\.0/, '作废声明必须点明是 v1.22.0 推翻了哪些章节');
  });

  it('断言「该文件不存在」的历史性提及必须同时声明它不存在', () => {
    // 原文声称「新建 src/core/tombstone.ts + tests/tombstone.test.ts」——两个文件从未落地。
    // 判定接受两种撤回写法：整句被 `~~` 划掉，或同句/紧邻行给出「不存在」的事实改正。
    //
    // 2026-10-20 收窄：原实现要求「**任何**提到这两个文件的地方」都要带撤回声明，
    // 于是正常的前向引用（"见 §3 `src/core/tombstone.ts`（尚未实现）"）被判红 ——
    // 守卫惩罚了正确的写法。现在只对**断言性历史声明**生效：
    //   · 句子在陈述「曾经/原来/原写/原称/历史上存在过这个文件」→ 必须撤回；
    //   · 句子是在**向前指路**（"见 §3"、"待实现"、"计划新增"）→ 豁免。
    const violations = findGhostFileViolations(V2_PLAN, [
      'src/core/tombstone.ts',
      'tests/tombstone.test.ts',
    ]);
    assert.deepEqual(
      violations,
      [],
      violations
        .map(
          v =>
            `docs/v2-plan.md:${v.line} 断言性地提到 ${v.ghost} 却没说它不存在——读者会以为该文件可用：${v.text}`
        )
        .join('\n')
    );
  });

  it('（规则自测）历史性提及必须被要求撤回，前向引用必须被豁免', () => {
    // 这条把「收窄后的规则」本身钉死：否则有人把 isHistoricalClaim 改回
    // 「凡提到文件名就要撤回」，假阳性会立刻回来，而且没人会发现
    //（仓库当前的 v2-plan 恰好没有前向引用 ⇒ 光看文档测不出规则退化）。
    const GHOSTS = ['src/core/tombstone.ts', 'tests/tombstone.test.ts'];

    // 1) 历史性提及且**没有**撤回声明 → 必须被报成违规
    const bad = ['- §5 状态栏原称「新建 `src/core/tombstone.ts`（7 天常量 + sweep 纯函数)」'];
    assert.equal(
      findGhostFileViolations(bad.join('\n'), GHOSTS).length,
      1,
      '历史性提及没有撤回声明时必须被报成违规'
    );

    // 2) 同样的历史性提及 + 撤回声明 → 合规
    const good = ['- §5 状态栏原称「新建 `src/core/tombstone.ts`」——**该文件在当前代码树中不存在**'];
    assert.deepEqual(findGhostFileViolations(good.join('\n'), GHOSTS), [], '带撤回声明的历史性提及应合规');

    // 3) 前向引用 → 豁免（**不得**报违规）—— 这就是 2026-10-20 修掉的假阳性
    const forward = ['- 见 §3 `src/core/tombstone.ts`（尚未实现，规划中）', '- 计划新增 `tests/tombstone.test.ts`'];
    assert.deepEqual(
      findGhostFileViolations(forward.join('\n'), GHOSTS),
      [],
      '前向引用必须被豁免：把守卫套在「凡提到文件名」上会惩罚正确的写法'
    );

    // 4) 判据本身
    assert.equal(
      isHistoricalClaim('- §5 状态栏原称「新建 `src/core/tombstone.ts`」'),
      true,
      '带「原称」的历史性提及必须被识别为历史声明'
    );
    assert.equal(
      isHistoricalClaim('- 见 §3 `src/core/tombstone.ts`（尚未实现，规划中）'),
      false,
      '向前指路的引用不该被当成历史声明'
    );
  });

  it('提到旧测试数的地方必须同时给出当前基线（钉语义，不钉数字）', () => {
    assertBaselineSemantics(V2_PLAN, 'docs/v2-plan.md');
  });

  it('文档自称的当前基线不得大于仓库实测规模（不许谎报，也不因加用例而变红）', () => {
    // 上限方向：文档可以落后于实际（写了个保守数字不算错），但不能吹大。
    // 取「连对象方法一起数」的上界做比较：宁可漏判也不误判合法的文档数字。
    // 下限方向：文档给的「当前基线」至少要达到当初那份历史基线 N —— 已由上一条断言保证。
    const lines = V2_PLAN.split('\n');
    for (const [i, line] of lines.entries()) {
      const { current } = parseBaselineFacts(line);
      for (const n of current) {
        assert.ok(
          n <= ACTUAL_MAX_BLOCKS,
          `docs/v2-plan.md:${i + 1} 自称当前基线 ${n}，但仓库实测最多只有 ${ACTUAL_MAX_BLOCKS} 个用例：` +
            `文档吹大了规模。\n  ${line.trim()}`
        );
      }
    }
  });

  it('（规则自测）基线解析：整套基线 vs 单文件用例数 vs 普通数字', () => {
    // 把「什么算整套基线」钉死，否则解析口径一改，下面几条会静默失效。
    const whole = parseBaselineFacts('- §6 P0 验证行与验收行原写「334 单测」——当前基线为 **695 个单测**（2026-10-02 实测）。');
    assert.deepEqual(whole.suiteCounts, [334], '「334 单测」是整套基线');
    assert.deepEqual(whole.current, [695], '「当前基线为 695」被识别为当前基线');

    const perFile = parseBaselineFacts(
      '- §5 状态栏原称「新建 `src/core/tombstone.ts`（7 天常量 + sweep 纯函数）+ `tests/tombstone.test.ts`（12 用例）」'
    );
    assert.deepEqual(perFile.suiteCounts, [], '「（12 用例）」跟着文件路径走 = 单文件用例数，不是整套基线');

    const unrelated = parseBaselineFacts('> 本文成文于「墓碑 7 天生命周期 / 回收站」模型之下。');
    assert.deepEqual(unrelated.suiteCounts, [], '「7 天生命周期」不是测试数');
    assert.deepEqual(unrelated.current, [], '「7 天」不是当前基线');

    const noBaseline = parseBaselineFacts('- 验证：type-check ✓ / lint ✓ / 334 单测 ✓（该数字为 2026-09-26 当时快照）');
    assert.deepEqual(noBaseline.current, [], '没有「当前基线 N」标注时不算给了当前基线');
    assert.deepEqual(noBaseline.suiteCounts, [334]);
  });

  it('（事实来源）实测规模是现场数出来的，且不低于文档里自称的基线', () => {
    // 这条把「当前基线从代码现场推导」这件事本身钉住：
    //   · TEST_FILES 非空、ACTUAL_MAX_BLOCKS ≥ ACTUAL_IT_BLOCKS（口径关系正确）；
    //   · 文档自称的基线不得大于实测上界（不允许吹大），也不必等于实测
    //     （文档可以保守 —— 这正是「不因加用例而变红」的关键）。
    assert.ok(ACTUAL_TEST_FILES > 0, '必须能扫到测试文件');
    assert.ok(
      ACTUAL_MAX_BLOCKS >= ACTUAL_IT_BLOCKS,
      `计数口径关系反了：上界 ${ACTUAL_MAX_BLOCKS} < 严格口径 ${ACTUAL_IT_BLOCKS}`
    );
    const docClaims: number[] = [];
    for (const md of [V2_PLAN, DEV_PLAN]) {
      for (const line of md.split('\n')) {
        docClaims.push(...parseBaselineFacts(line).current);
      }
    }
    assert.ok(docClaims.length > 0, '两份计划文档里必须至少有一处「当前基线 N」');
    for (const n of docClaims) {
      assert.ok(
        n <= ACTUAL_MAX_BLOCKS,
        `文档自称当前基线 ${n} > 实测上界 ${ACTUAL_MAX_BLOCKS}：文档吹大了规模`
      );
    }
  });

  it('里程碑 M1 不得再把 v1.22.0 说成 P1 转正', () => {
    for (const [i, line] of V2_PLAN.split('\n').entries()) {
      if (!/M1/.test(line) || !/v1\.22\.0/.test(line)) continue;
      assert.match(
        line,
        /~~|作废|事实改正|原写|实际/,
        `docs/v2-plan.md:${i + 1} 仍把 M1 说成 v1.22.0，但 1.22.0 实际发的是废除墓碑体系`
      );
    }
  });
});

describe('docs/dev-plan-2026-09-27.md：顶部状态声明 + 版本/测试数已就地改正', () => {
  it('顶部有指向 v1.22.0 的状态声明', () => {
    const head = DEV_PLAN.split('\n').slice(0, 10).join('\n');
    assert.match(head, /状态声明/, '顶部必须有显式状态声明');
    assert.match(head, /v1\.22\.0/, '状态声明必须点明 v1.22.0 改变了删除语义');
  });

  it('提到旧测试数的地方必须同时给出当前基线（钉语义，不钉数字）', () => {
    assertBaselineSemantics(DEV_PLAN, 'docs/dev-plan-2026-09-27.md');
  });

  it('文档自称的当前基线不得大于仓库实测规模（不许谎报，也不因加用例而变红）', () => {
    const lines = DEV_PLAN.split('\n');
    for (const [i, line] of lines.entries()) {
      const { current } = parseBaselineFacts(line);
      for (const n of current) {
        assert.ok(
          n <= ACTUAL_MAX_BLOCKS,
          `docs/dev-plan-2026-09-27.md:${i + 1} 自称当前基线 ${n}，但仓库实测最多只有 ${ACTUAL_MAX_BLOCKS} 个用例：` +
            `文档吹大了规模。\n  ${line.trim()}`
        );
      }
    }
  });

  it('「1.21.1 在 Google 审核中」的旧事实必须被划掉', () => {
    for (const [i, line] of DEV_PLAN.split('\n').entries()) {
      if (!line.includes('1.21.1 在 Google 审核中')) continue;
      assert.match(line, /事实已变|作废/, `docs/dev-plan-2026-09-27.md:${i + 1} 仍在拿 1.21.1 当现状`);
    }
  });
});

describe('docs/y-shadow-v2.md：翻译表不得无声地列已删除的 MutationOp', () => {
  it('顶部声明 restoreGroup / purgeGroup 已被 v1.22.0 删除', () => {
    // v1.22.0 随墓碑体系一起删掉了 restoreGroup / purgeGroup（tabSlice.ts 头注释），
    // 但本文 §3 的翻译表还在按它们推导 Y 计划。修法同 v2-plan：顶部划掉失效部分，
    // 不重写正文——§3 的推导逻辑对仍然存在的 op 依然有效。
    const head = Y_SHADOW.split('\n').slice(0, 12).join('\n');
    assert.match(head, /v1\.22\.0/, '顶部必须点明是 v1.22.0 删掉了这些 op');
    for (const op of ['restoreGroup', 'purgeGroup']) {
      assert.ok(head.includes(op), `顶部必须点名 ${op} 已不存在`);
    }
    assert.match(head, /已不存在|不再成立|过时/, '顶部必须给出明确的作废措辞');
  });

  it('翻译表以 src/core/yTranslate.ts 的头注释为准', () => {
    const head = Y_SHADOW.split('\n').slice(0, 12).join('\n');
    assert.match(head, /yTranslate\.ts/, '必须指向代码里那份已随 1.22.0 更新的翻译表');
  });
});

describe('CHROMEWEBSTORE.md：自身不矛盾', () => {
  it('Last Updated 不早于版本历史里最新的日期', () => {
    // 曾经出现过 :3 写 2026-09-26、:152 记着 2026-09-29 的自相矛盾。
    const updated = lastUpdatedDate(STORE);
    const newest = newestHistoryDate(STORE);
    assert.ok(
      updated >= newest,
      `Last Updated（${updated}）早于版本历史最新条目（${newest}）——文档自己跟自己矛盾`
    );
  });

  it('隐私政策源码注释里的日期与 privacy.html 实际日期一致', () => {
    const m = STORE.match(/privacy\.html（最后更新 (\d{4}-\d{2}-\d{2})）/);
    assert.ok(m, 'CHROMEWEBSTORE.md 必须标注 privacy.html 的最后更新日期');
    const actual = PRIVACY.match(/最后更新：(\d{4}-\d{2}-\d{2})/);
    assert.ok(actual, 'privacy.html 必须标注最后更新日期');
    assert.equal(m[1], actual[1], 'CHROMEWEBSTORE.md 与 privacy.html 对「最后更新」的日期不一致');
  });

  it('对 1.21.1 发布状态不作断言（未知就是未知）', () => {
    const row = STORE.split('\n').find(l => l.startsWith('| 1.21.1 |'));
    assert.ok(row, '版本历史表必须有 1.21.1 行');
    assert.doesNotMatch(
      row,
      /\| (Published|待上传) \|/,
      '1.21.1 是否发布过尚未澄清，行内不得断言具体状态'
    );
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2026-10-20 文档诚实度批次（C-01 … C-19）
 *
 * 本批的共同形状：**文档写的承诺比代码做的事宽**（或反过来说，代码做的事
 * 比文档写的多）。每一类都会让用户按「文档说的」去预期，然后被现实打脸：
 *   · 以为「关掉自动同步 = 扩展不再出站」，实际每次本地改动照样上传；
 *   · 以为「任何删除前都会问我」，实际两条高频路径直接删；
 *   · 以为「保存是存一份副本」，实际标签被关掉；
 *   · 以为「加密了」，实际可以选「不加密」而商店文案没提。
 *
 * 断言纪律（与本文件既有形状一致）：
 *   · 钉**性质**，不钉字面量 —— 例如「文案必须提到延迟上传」而不是
 *     「文案必须恰好等于某一句」；
 *   · 事实来源一律从**代码 / manifest**现场推导，再拿文档去对；
 *   · 中英双语必须同口径（商店文案是中英双语的，英文版漏改同样是谎话）。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 文档里是否提到了「延迟上传」这件事（一次性延迟上传 alarm）。 */
const mentionsDelayedUpload = (text: string): boolean =>
  /延迟上传|延迟上传 alarm|一次性延迟上传|上传定时任务|延迟上传定时任务/.test(text);

describe('C-01 自动同步开关的真实语义：关掉的是后台轮询，不是「不再出站」', () => {
  it('三份文档都不得声称「关闭自动同步后不会创建任何定时任务」', () => {
    // syncEngine.scheduleUpload() 无条件 chrome.alarms.create(SYNC_UPLOAD_ALARM)，
    // 且 upload() 的闸门不看 syncEnabled ⇒ 每次本地写操作后仍会出站上传。
    for (const [name, text] of [
      ['CHROMEWEBSTORE.md', STORE],
      ['README.md', README],
      ['src/legal/privacy.html', PRIVACY],
    ] as const) {
      assert.doesNotMatch(
        text,
        /不会创建任何定时任务/,
        `${name} 仍承诺「关掉自动同步 = 不再创建任何定时任务」——` +
          '但每次本地保存/重命名/删除都会创建一次性延迟上传 alarm，且与该开关无关'
      );
    }
  });

  it('三份文档都必须点明「本地改动仍会延迟上传」', () => {
    for (const [name, text] of [
      ['CHROMEWEBSTORE.md', STORE],
      ['README.md', README],
      ['src/legal/privacy.html', PRIVACY],
    ] as const) {
      assert.ok(
        mentionsDelayedUpload(text),
        `${name} 必须说明「每次本地保存/重命名/删除仍会延迟上传」——` +
          '否则读者会以为关掉自动同步 = 扩展不再出站'
      );
    }
  });

  it('「仅在开启自动同步后才建 alarm」这句话只许修饰**后台轮询**', () => {
    // 既有守卫（audit20261019ThemeAndPromise）钉着「仅当你开启自动同步时」/
    // 「仅在您开启「自动同步」后」这两个字面量；这里补上「另一半」：
    // 同一格里必须同时出现延迟上传的说明，否则两句会互相矛盾。
    assert.match(
      STORE,
      /仅当你开启自动同步时[\s\S]{0,200}延迟上传/,
      '商店的 alarms 权限说明必须把「仅在开启时创建」限定在后台轮询上，并补上延迟上传'
    );
    assert.match(
      PRIVACY,
      /仅在您开启「自动同步」后[\s\S]{0,200}延迟上传/,
      '隐私政策的 alarms 披露必须把「仅在开启时创建」限定在后台轮询上，并补上延迟上传'
    );
  });

  it('（事实来源）scheduleUpload 的确无条件创建 alarm —— 文档必须承认这一点', () => {
    // 这条把「事实来源」钉在代码上：将来有人给 scheduleUpload 加了
    // syncEnabled 判断，本批的文档口径就该跟着改（而不是继续说谎）。
    //
    // 取实现体的方式必须精确：从**方法定义**起算（`scheduleUpload(` 后面紧跟
    // 参数列表与 `): Promise<void> {`），而不是撞上任意一个 `scheduleUpload(...)`
    // 调用点 —— 调用点很多，撞错了就断言了一个不相干的片段。
    const engine = read('src/services/syncEngine.ts');
    const def = engine.match(
      /\n {2}scheduleUpload\([\s\S]{0,200}?\): Promise<void> \{/
    );
    assert.ok(def, '找不到 scheduleUpload 的方法定义');
    const body = engine.slice(def.index!, def.index! + 4000);
    assert.match(
      body,
      /chrome\.alarms\.create\(SYNC_UPLOAD_ALARM/,
      'scheduleUpload 仍在无条件创建延迟上传 alarm（若将来加了开关判断，本批文档口径要重审）'
    );
    assert.doesNotMatch(
      body,
      /syncEnabled/,
      'scheduleUpload 里出现了 syncEnabled 判断 —— 文档口径必须重新核对'
    );
  });
});

describe('C-02 删除前确认：不得承诺「任何删除前都会问我」', () => {
  const ZH_STORE = lineStartingWith(STORE, '· 误删保护：');
  const EN_STORE = lineStartingWith(STORE, '· Deletion protection:');
  const README_LINES = README.split('\n');

  it('中英商店文案都不得做绝对化承诺', () => {
    assert.doesNotMatch(
      EN_STORE,
      /you confirm before anything is deleted/i,
      '英文版承诺「任何东西被删之前你都会确认」——实际有两条高频路径不确认'
    );
    assert.doesNotMatch(
      ZH_STORE,
      /删除前二次确认(?!（|，)/,
      '中文版仍在做绝对化的「删除前二次确认」承诺'
    );
  });

  it('中英商店文案都必须说清「单条删除 / 拖走最后一条不确认」', () => {
    /**
     * 【为什么这里改成「不确认」而不是「立即生效」（2026-10-20 L-16）】
     *
     * 原来钉的是字面量「立即生效」。而 L-16 发现**这两条路径行为相反**：
     *   · 单条标签删除 —— 会让整个会话消失时**会先确认**；
     *   · 拖走最后一条标签 —— **不确认**（1.24.3 定案：拖拽即剪切，不许拦截）。
     * 原来那句「单条标签删除、以及把最后一条标签拖到别的会话，会立即生效」
     * 把两条**相反**的行为写成了一条 —— 守卫当时是绿的，因为它只查
     * 「有没有『立即生效』这几个字」，**不查这句话说的是哪条路径**。
     *
     * 修正后的文案用了「**直接生效、不多问一句**」而不是「立即生效」——
     * 语义完全一样，但**字面量不同** ⇒ 老守卫变红。
     *
     * ⇒ 判据改成**不变量**：「这条路径不确认」这**件事**必须被说出来，
     * 至于用「立即生效」「直接生效」「right away」「no extra question」
     * 哪种说法，是**写法**不是**事实** —— 钉写法会挡住正确的改动。
     */
    assert.match(
      ZH_STORE,
      /单条标签删除[\s\S]{0,80}(立即生效|直接生效)/,
      '中文版必须点明单条标签删除立即生效、不弹确认'
    );
    assert.match(
      ZH_STORE,
      /拖[\s\S]{0,60}(立即生效|直接生效|不多问)/,
      '中文版必须点明拖走最后一条标签直接生效、不弹确认'
    );
    assert.match(
      EN_STORE,
      /deleting a single tab[\s\S]{0,160}(takes effect immediately|immediately|right away)/i,
      '英文版必须点明单条标签删除立即生效、不弹确认'
    );
    assert.match(
      EN_STORE,
      /dragging the last tab[\s\S]{0,200}(takes effect immediately|immediately|right away|no extra question)/i,
      '英文版必须点明拖走最后一条标签会立即生效、不弹确认'
    );
  });

  it('README 两处「误删保护」都不得做绝对化承诺', () => {
    for (const line of README_LINES) {
      if (!/误删保护/.test(line)) continue;
      assert.doesNotMatch(
        line,
        /误删保护：删除前二次确认(?!（)/,
        `README 仍在做绝对化承诺：${line.trim()}`
      );
      assert.match(
        line,
        /单条标签删除[\s\S]{0,80}(立即生效|直接生效)/,
        `README 必须点明单条标签删除立即生效：${line.trim()}`
      );
    }
  });

  it('（保留）英文版仍须明说没有回收站与撤销 —— 那是另一个真承诺', () => {
    assert.match(EN_STORE, /no recycle bin/i);
    assert.match(EN_STORE, /no undo/i);
  });

  it('（事实来源）单条 ✕ 删除与拖走最后一条的确认行为（两条相反）', () => {
    const tabGroup = stripComments(read('src/components/tabs/TabGroup.tsx'));
    // 单条 ✕：**非最后一条**时恒成立 ⇒ 直接删；
    // **最后一条**时 ⇒ 弹确认框（后果等同删除整个会话）。
    // （2026-10-20 L-16 更正：这条路径**不是**「一律不确认」。）
    assert.match(
      tabGroup,
      /if \(!confirmBeforeDelete \|\| !shouldAutoDeleteAfterTabRemoval\(group, tabId\)\) \{\s*runDelete\(\);/,
      '单条标签删除的实现形态变了 —— 文档口径必须重新核对'
    );
    assert.match(
      tabGroup,
      /shouldAutoDeleteAfterTabRemoval\(group, tabId\)[\s\S]{0,400}showConfirm\(/,
      '单条标签删除「会让整个会话消失」时必须走确认框 —— ' +
        '文档必须说清这一点（它与拖拽路径相反）'
    );
    // 拖走最后一条：产品负责人 2026-10-19 明确要求「直接删除，不加确认」
    assert.match(
      read('src/components/tabs/TabGroup.tsx'),
      /直接删除，不加确认/,
      '拖拽路径的「直接删除，不加确认」决定变了 —— 文档口径必须重新核对'
    );
  });
});

describe('C-03 / C-13 / C-14 「保存会关闭标签」必须在每个入口上说清', () => {
  it('商店文案四个保存入口都要标出「关闭」', () => {
    // 逐个入口断言：把整行按分隔符切开再查，避免「别处的『关闭』被算到
    // 另一个入口头上」这种假绿（例如 Alt+Shift+S 漏了「并关闭」，
    // 却因为同一行里 Alt+S 写了「并关闭」而蒙混过关）。
    const zh = lineStartingWith(STORE, '· 一键保存：');
    const zhSegments = zh.split(/[、；;]/);
    const seg = (pattern: RegExp) =>
      zhSegments.find(s => pattern.test(s)) ?? '';
    assert.match(seg(/Ctrl\+Shift\+S/), /关闭/, 'Ctrl+Shift+S 必须说「保存整窗并关闭」');
    assert.match(seg(/Alt\+Shift\+S/), /关闭/, 'Alt+Shift+S 必须说会关闭');
    assert.match(seg(/Alt\+S/), /关闭/, 'Alt+S 必须说会关闭');

    const en = lineStartingWith(STORE, '· One-click save:');
    const enSegments = en.split(/[.;,]/);
    const enSeg = (pattern: RegExp) =>
      enSegments.find(s => pattern.test(s)) ?? '';
    assert.match(enSeg(/Ctrl\+Shift\+S/), /closes/i, 'Ctrl+Shift+S must say it closes the window');
    assert.match(enSeg(/Alt\+Shift\+S/), /closes/i, 'Alt+Shift+S must say it closes them');
    assert.match(enSeg(/Alt\+S/), /closes/i, 'Alt+S must say it closes it');
  });

  it('README 两处保存说明都要说清「保存会关标签」', () => {
    // C-13 指的是两个位置：能力清单里那条，以及「使用方式 → 保存会话」小节。
    // 只查全文任意一处会出现假绿（改掉一处，另一处还在 ⇒ 断言照样通过）。
    const capability = README.split('\n').find(l =>
      l.trimStart().startsWith('- 保存当前窗口中的标签页为一个工作会话')
    );
    assert.ok(capability, 'README 能力清单里找不到「保存当前窗口中的标签页…」那条');
    assert.match(
      capability,
      /保存\s*=\s*剪切|会被关闭|随即被关闭/,
      `README 能力清单那条没说保存会关标签：${capability.trim()}`
    );

    const usageStart = README.indexOf('### 保存会话');
    assert.ok(usageStart > 0, 'README 缺少「### 保存会话」小节');
    const usage = README.slice(usageStart, README.indexOf('### ', usageStart + 5));
    assert.match(
      usage,
      /会被关闭|随即被关闭|保存\s*=\s*剪切/,
      'README「使用方式 → 保存会话」小节没说保存会关标签'
    );
  });

  it('README 不得引用已过时的按钮名「保存会话」', () => {
    // 实际可见文字是 src/components/layout/saveActionCopy.ts 的 saveAndCloseLabel
    assert.doesNotMatch(
      README,
      /点击“保存会话”|点击"保存会话"/,
      'README 仍写「保存会话」，而按钮上写的是「保存并关闭」'
    );
    assert.match(README, /保存并关闭/, 'README 必须用按钮上真实可见的文字');
  });

  it('（事实来源）按钮上的可见文字确实是「保存并关闭」', () => {
    const copy = read('src/components/layout/saveActionCopy.ts');
    assert.match(copy, /saveAndCloseLabel = '保存并关闭'/);
  });
});

describe('C-04 引导页的会话命名必须与实现一致（默认保存时间，**没有例外**）', () => {
  it('引导页必须说清「默认是保存时间」', () => {
    const steps = stripComments(ONBOARDING);
    assert.match(
      steps,
      /保存时间命名/,
      '引导页必须说清默认名是**保存时刻** —— 实现的默认名就是时间戳'
    );
    assert.match(
      steps,
      /2026-10-25 14:30/,
      '引导页应举例说明默认名长什么样（零填充的 `YYYY-MM-DD HH:mm`）'
    );
  });

  it('引导页不得再说「全都来自同一个网站时才用网站名」（那条例外已被推翻）', () => {
    // 2026-10-25 产品负责人推翻了「全都同站 ⇒ 网站名」这条例外
    // ⇒ 引导页若还在教它，就是在教一条**已经作废**的规则。
    const steps = stripComments(ONBOARDING);
    assert.doesNotMatch(
      steps,
      /全都来自同一个网站|同一个网站时才用网站名/,
      '引导页仍在教一条已经作废的例外 —— 默认名一律是保存时刻'
    );
  });

  it('（事实来源）默认名确实**只有**保存时刻这一档', () => {
    // 判据读的是**工厂里真正起名的那个表达式**（不是「源码里出现了某个
    // 函数名」—— 那种断言在被绕开时仍然是绿的）。
    const factory = read('src/domain/tabGroup/factory.ts');
    const nameLine = factory.match(/const name = options\.name \?\? ([^;]+);/);
    assert.ok(nameLine, 'factory 里给会话起名的那一行不见了 —— 文案必须重新核对');
    assert.match(
      nameLine[1],
      /buildTimestampSessionName/,
      '默认名不是保存时刻 —— 文案与实现对不上'
    );
    assert.doesNotMatch(
      nameLine[1],
      /deriveDominantHost|deriveSingleSiteHost|extractNamingHost|\.title\b/,
      '默认名的表达式里又出现了按内容命名的分支 —— 「没有例外」被破了'
    );
    // 那个「全都同站」的判据必须已经从判据层删干净
    assert.doesNotMatch(
      read('src/domain/tabGroup/sessionName.ts'),
      /deriveSingleSiteHost/,
      '「全都同站 ⇒ 用网站名」这条例外已经被推翻，判据不该还留在代码里'
    );
  });
});

describe('C-05 引导页的「误删保护」必须覆盖拖拽路径', () => {
  it('引导页必须点明拖走最后一条标签会立即生效', () => {
    const steps = stripComments(ONBOARDING);
    assert.match(
      steps,
      /把最后一条标签拖到别的会话[\s\S]{0,60}立即生效/,
      '引导页的误删保护说明漏掉了拖拽路径（该路径会让整个会话当场消失且不确认）'
    );
  });

  it('引导页必须说清整组确认受设置开关控制', () => {
    const steps = stripComments(ONBOARDING);
    assert.match(
      steps,
      /删除整个会话会先确认[\s\S]{0,80}可在设置里关闭/,
      '引导页必须说清「删除前确认」可以在设置里关掉'
    );
  });
});

describe('C-11 隐私政策：主机权限不得写成「申请整个 https 域」', () => {
  it('不得声称申请整个 https 域', () => {
    assert.doesNotMatch(
      PRIVACY,
      /申请整个\s*<code>https<\/code>\s*域/,
      '权限.ts 的 originPatternFor() 只按用户填的那一个 origin 申请，不是整个 https 域'
    );
  });

  it('必须说清只请求用户自己填写的那个地址', () => {
    assert.match(
      PRIVACY,
      /您自己填写的那个地址/,
      '隐私政策必须说清权限范围是单一来源'
    );
    assert.match(
      PRIVACY,
      /不会获取整个/,
      '隐私政策必须明说不会获取整个 https / http 域'
    );
  });

  it('（事实来源）运行时只按单一 origin 申请', () => {
    const perm = read('src/sync-backend/webdav/permission.ts');
    const fn = perm.match(/export function originPatternFor[\s\S]{0,300}?\n}/);
    assert.ok(fn, '找不到 originPatternFor');
    assert.match(fn[0], /`\$\{url\.protocol\}\/\/\$\{url\.host\}\/\*`/);
  });
});

describe('C-12 数据使用表与隐私政策对「第三方」的表述必须一致', () => {
  it('隐私政策不得声称「唯一的数据托管方」而同时商店表说 No', () => {
    // 选的是方案 (a)：如实披露接收方（Supabase），所以隐私政策里
    // 「唯一的数据托管方是 Supabase」这种措辞必须改成「由……托管」。
    assert.doesNotMatch(
      PRIVACY,
      /唯一的数据托管方/,
      '隐私政策仍写「唯一的数据托管方」——商店数据表已如实披露 Supabase 为接收方，两处口径必须一致'
    );
    assert.match(PRIVACY, /Supabase/);
  });

  it('商店数据表里「分享给第三方」必须与隐私政策一致（选 a：写明 Supabase）', () => {
    const rows = STORE.split('\n').filter(l => /^\|\s*(Authentication info|Website content)\s*\|/.test(l));
    assert.equal(rows.length, 2, '数据使用表里必须正好有 Authentication info 与 Website content 两行');
    for (const row of rows) {
      const cells = row.split('|').map(c => c.trim());
      // 末列 = Shared with Third Parties?
      const shared = cells[cells.length - 2];
      assert.match(
        shared,
        /^Yes/,
        `该行「Shared with Third Parties?」仍是 ${shared} —— 隐私政策已披露数据由 Supabase 托管，两处必须一致`
      );
      assert.match(shared, /Supabase/, '必须写明接收方是谁');
    }
  });

  it('「不出售」这一条仍必须保留（与「有接收方」不矛盾）', () => {
    assert.match(STORE, /Data is NOT sold to third parties/);
  });
});

describe('C-18 manifest 的可选主机权限必须覆盖得住运行时可能生成的 origin', () => {
  it('manifest 声明了 http 通配（局域网自建 WebDAV 才拿得到权限）', () => {
    const manifest = JSON.parse(read('manifest.json')) as {
      optional_host_permissions?: string[];
    };
    const optional = manifest.optional_host_permissions ?? [];
    assert.ok(
      optional.includes('http://*/*'),
      'optional_host_permissions 少了 http://*/* —— 局域网自建 WebDAV（如 http://192.168.1.5:8080）' +
        '生成的 origin 不在声明范围内，chrome.permissions.request 会被 Chrome 拒绝'
    );
  });

  it('（事实来源）运行时确实可能生成非 https、非 localhost 的 origin', async () => {
    const perm = read('src/sync-backend/webdav/permission.ts');
    assert.match(
      perm,
      /`\$\{url\.protocol\}\/\/\$\{url\.host\}\/\*`/,
      'originPatternFor 变了 —— 本条的「覆盖不住」前提要重新核对'
    );
    const { originPatternFor } = await import('@/sync-backend/webdav/permission');
    const lan = originPatternFor('http://192.168.1.5:8080/dav');
    assert.equal(lan, 'http://192.168.1.5:8080/*', '局域网地址生成的 origin 形态变了');
    assert.ok(
      !/^https:\/\/\*\/\*$/.test(lan),
      '局域网 origin 落在 http 通配域上 —— manifest 必须声明 http://*/*'
    );
  });
});

describe('C-19 隐私政策的云端墓碑说明必须覆盖两种后端', () => {
  it('不得只描述 Supabase 一行（自带存储的墓碑在云盘清单里）', () => {
    const line = PRIVACY.split('\n').find(l => l.includes('30') && l.includes('删除'));
    assert.ok(line, '找不到云端清理的说明行');
    assert.doesNotMatch(
      line,
      /该行仍保存在 Supabase 上/,
      '墓碑载体描述只覆盖了 TapStack 云端（自带存储的墓碑是云盘清单里的一条）'
    );
    assert.match(line, /自带存储/);
  });
});

describe('C-06 删除熔断的文案必须被登记（不能退化成「下载失败，请重试」）', () => {
  it('SYNC_REASON_COPY 必须登记 failsafe_triggered，且文案自足', async () => {
    const { SYNC_REASON_COPY, resolveSyncFailureCopy } = await import(
      '@/components/sync/syncPreviewView'
    );
    const copy = SYNC_REASON_COPY.failsafe_triggered;
    assert.ok(typeof copy === 'string' && copy.length > 0, '熔断原因没有登记 → 用户看到的是裸枚举');
    assert.doesNotMatch(copy, /^[a-z_]+$/, '不得是裸枚举');
    // 自足性：SW 那条下载分支只回传 r.reason（丢了 r.error），
    // 所以文案必须自己说清「本地数据没动」+ 下一步动作。
    assert.match(copy, /本地数据没有变化|本地数据没被动过/, '必须说清本地数据没有被改动');
    assert.match(copy, /中止/, '必须说清同步已被中止');
    assert.match(copy, /重试|确认/, '必须给出下一步动作');

    const shown = resolveSyncFailureCopy({
      reason: 'failsafe_triggered',
      fallbackMessage: '下载失败，请重试',
    });
    assert.notEqual(shown, '下载失败，请重试', '熔断不能退化成普通失败文案');
    assert.match(shown, /本地数据没有变化/);
  });

  it('（事实来源）熔断确实返回 reason=failsafe_triggered 且发生在写入之前', () => {
    const engine = read('src/services/syncEngine.ts');
    assert.match(engine, /reason: 'failsafe_triggered'/);
    // 熔断必须在 setGroupsImmediate 之前
    const failsafeIdx = engine.indexOf("reason: 'failsafe_triggered'");
    const writeIdx = engine.indexOf('await storage.setGroupsImmediate(finalGroups);');
    assert.ok(failsafeIdx > 0 && writeIdx > 0);
    assert.ok(failsafeIdx < writeIdx, '熔断必须在写入之前发生（本地数据没被动过）');
  });
});

describe('C-07 认证错误必须中文化（英文原文只进 console，不进 UI）', () => {
  it('已知的 Supabase 英文错误必须映射成中文', async () => {
    const { authErrorCopy } = await import('@/store/slices/authSlice');
    const cases: Array<[string, RegExp]> = [
      ['Invalid login credentials', /密码/],
      ['User already registered', /已注册/],
      ['Email not confirmed', /验证/],
    ];
    for (const [raw, pattern] of cases) {
      const shown = authErrorCopy(raw);
      assert.match(shown, pattern, `「${raw}」没有映射成中文`);
      assert.doesNotMatch(
        shown,
        /[A-Za-z]{4,}/,
        `「${raw}」的英文原文漏进了 UI：${shown}`
      );
    }
  });

  it('未识别的英文错误不得原样透出（必须落中文兜底）', async () => {
    const { authErrorCopy } = await import('@/store/slices/authSlice');
    const shown = authErrorCopy('Some Unexpected Internal Failure');
    assert.doesNotMatch(shown, /[A-Za-z]{4,}/, `英文原文漏进了 UI：${shown}`);
    assert.ok(shown.length > 0, '必须有中文兜底文案');
  });

  it('已是中文的错误原样透传（不得二次翻译）', async () => {
    const { authErrorCopy } = await import('@/store/slices/authSlice');
    const zh = '邮箱已被注册';
    assert.equal(authErrorCopy(zh), zh);
  });

  it('reducer 层必须把英文原文换成中文（UI 读的就是这个字段）', async () => {
    // 纯函数测试证明「映射表是对的」，这条证明「**真的接上了**」——
    // 只测纯函数的话，把 reducer 里的 authErrorCopy 调用改回 action.error.message
    // 一样全绿（UI 照样弹英文）。
    const { default: reducer, signIn, signUp } = await import('@/store/slices/authSlice');
    const initial = reducer(undefined, { type: '@@init' });
    for (const [thunk, raw] of [
      [signIn, 'Invalid login credentials'],
      [signUp, 'User already registered'],
    ] as const) {
      const next = reducer(initial, {
        type: thunk.rejected.type,
        error: { message: raw },
      });
      assert.ok(next.error, 'rejected 后必须有错误文案');
      assert.doesNotMatch(
        next.error,
        /[A-Za-z]{4,}/,
        `英文原文漏进了 UI（UI 读的就是 state.error）：${next.error}`
      );
      assert.match(next.error, /[一-鿿]/, '必须是中文');
    }
  });

  it('（事实来源）UI 组件只展示 store 里的 error，不自己拼英文', () => {
    const login = stripComments(read('src/components/auth/LoginForm.tsx'));
    const register = stripComments(read('src/components/auth/RegisterForm.tsx'));
    for (const [name, src] of [
      ['LoginForm.tsx', login],
      ['RegisterForm.tsx', register],
    ] as const) {
      assert.doesNotMatch(
        src,
        /Invalid login credentials|User already registered|Email not confirmed/,
        `${name} 自己在拼 Supabase 英文错误 —— 翻译必须收敛在 authSlice`
      );
    }
  });
});

describe('C-08 同步失败原因不得把机器串原样透出', () => {
  it('机器前缀必须剥掉，中文原因保留', async () => {
    const { resolveSyncFailureCopy } = await import('@/components/sync/syncPreviewView');
    const shown = resolveSyncFailureCopy({
      reason: 'validation_failed: 会话名称过长',
      fallbackMessage: '上传失败，请重试',
    });
    assert.doesNotMatch(shown, /validation_failed/, '英文机器前缀不得进 UI');
    assert.match(shown, /会话名称过长/, '中文原因必须保留');
  });

  it('数据库 / 网络类的英文报错必须落中文兜底', async () => {
    const { resolveSyncFailureCopy } = await import('@/components/sync/syncPreviewView');
    const machineStrings = [
      'duplicate key value violates unique constraint "tab_groups_pkey"',
      'Failed to fetch',
      'NetworkError when attempting to fetch resource.',
    ];
    for (const raw of machineStrings) {
      const shown = resolveSyncFailureCopy({ reason: raw, fallbackMessage: '上传失败，请重试' });
      assert.doesNotMatch(
        shown,
        /duplicate key|constraint|Failed to fetch|NetworkError/i,
        `机器串漏进了 UI：${shown}（原文 ${raw}）`
      );
      assert.match(shown, /失败|重试/, `必须落中文兜底：${shown}`);
    }
  });

  it('（不得改坏）已登记 reason 优先、中文原因原样显示', async () => {
    const { resolveSyncFailureCopy, SYNC_REASON_COPY } = await import(
      '@/components/sync/syncPreviewView'
    );
    assert.equal(
      resolveSyncFailureCopy({ reason: 'backend_unknown', fallbackMessage: '兜底' }),
      SYNC_REASON_COPY.backend_unknown
    );
    const human = '本地存储读取失败';
    assert.equal(
      resolveSyncFailureCopy({ reason: human, fallbackMessage: '兜底' }),
      human,
      '纯中文原因必须原样显示'
    );
  });
});

describe('C-09 商店英文版必须有「智能命名」这条（与中文版同一功能）', () => {
  it('英文版功能列表里必须有「按保存那一刻命名」这一条', () => {
    const en = STORE.split('\n').find(l => l.trimStart().startsWith('· Smart naming:'));
    assert.ok(en, '英文版功能列表缺少「智能命名」这一条 —— Chrome 商店要求同一功能两边都有');
    assert.match(
      en,
      /moment you saved|saved them/i,
      '必须点明默认名是「保存的那一刻」—— 实现的默认名就是时间戳'
    );
    assert.match(en, /2026-10-25 14:30/, '应举例说明默认名长什么样');
  });

  it('英文版不得再说「全都来自同一个网站时才用网站名」（那条例外已被推翻）', () => {
    const en = STORE.split('\n').find(l => l.trimStart().startsWith('· Smart naming:'));
    assert.ok(en, '英文版功能列表缺少「智能命名」这一条');
    assert.doesNotMatch(
      en,
      /same site/i,
      '英文版仍在教一条已经作废的例外 —— 默认名一律是保存时刻'
    );
  });

  it('（事实来源）默认名确实**只有**保存时刻这一档', () => {
    const factory = read('src/domain/tabGroup/factory.ts');
    const nameLine = factory.match(/const name = options\.name \?\? ([^;]+);/);
    assert.ok(nameLine, 'factory 里给会话起名的那一行不见了');
    assert.match(nameLine[1], /buildTimestampSessionName/);
    assert.doesNotMatch(
      nameLine[1],
      /deriveDominantHost|deriveSingleSiteHost|extractNamingHost|\.title\b/
    );
  });
});

describe('C-10 商店文案的 WebDAV 加密必须写成有条件的', () => {
  it('中文版必须说清「默认加密」且披露「不加密」选项与明文清单', () => {
    const zh = lineStartingWith(STORE, '· 自带存储：');
    assert.match(zh, /默认/, '必须说清加密是默认行为、不是无条件');
    assert.match(zh, /不加密/, '必须披露「不加密」选项 —— 那是用户真实可选的');
    assert.match(zh, /明文/, '必须披露目录清单始终是明文');
  });

  it('英文版必须与中文版同口径', () => {
    const en = lineStartingWith(STORE, '· Own-cloud sync (optional):');
    assert.match(en, /by default/i, '必须说清加密是默认行为');
    assert.match(en, /turn encryption off|without encryption/i, '必须披露「不加密」选项');
    assert.match(en, /plaintext/i, '必须披露目录清单始终是明文');
  });
});

describe('C-15 / C-16 README 的保存路径与「未登录」表述必须与实现一致', () => {
  it('README 不得把管理界面说成 popup（manifest 无 default_popup）', () => {
    const manifest = JSON.parse(read('manifest.json')) as { action?: { default_popup?: string } };
    assert.equal(
      manifest.action?.default_popup,
      undefined,
      'manifest 出现 default_popup —— README 的「popup 按钮」说法要重新核对'
    );
    assert.doesNotMatch(
      README,
      /popup 按钮/,
      'README 仍写「popup 按钮」，但扩展没有 popup，管理界面是整页标签'
    );
  });

  it('README 必须写对保存路径（setGroupsImmediate / saveCurrentTab）', () => {
    const line = README.split('\n').find(l => l.includes('保存路径'));
    assert.ok(line, 'README 缺少「保存路径」说明');
    assert.match(line, /setGroupsImmediate/, '实际写盘用的是 setGroupsImmediate');
    assert.doesNotMatch(
      line,
      /storage\.setGroups\(\)/,
      '实际写盘用的是 setGroupsImmediate，不是 setGroups'
    );
    assert.match(line, /saveCurrentTab/, '右键菜单/Alt+S 走的是 saveCurrentTab，不是 saveAllTabs');
  });

  it('README 的「未登录」必须限定在 TapStack 云端（自带存储用口令）', () => {
    // 逐行看：**任何**一处说「未登录 → 不触发同步」的地方，都必须同时说清
    // 自带存储那侧不受这条约束。只查「第一处匹配」会出现假绿
    // （把第一处改对/改坏，其余处照旧，断言照样通过）。
    const claims = README.split('\n').filter(
      l => /(未登录|没有登录)/.test(l) && /不触发|不.*同步/.test(l)
    );
    assert.ok(claims.length > 0, 'README 缺少「未登录」的说明');
    for (const line of claims) {
      assert.match(
        line,
        /云端/,
        `「未登录」只对 TapStack 云端成立，必须写明：${line.trim()}`
      );
      assert.match(
        line,
        /口令/,
        `自带存储用口令解锁、不涉及登录，必须写明（否则「未登录不触发」被读成全局）：${line.trim()}`
      );
    }
  });
});

describe('C-17 商店文案的右键菜单范围必须与注册上下文一致', () => {
  it('不得把「保存其他标签」说成网页右键也可用', () => {
    const zh = lineStartingWith(STORE, '· 右键菜单：');
    // 「保存其他标签」只在扩展图标上下文注册（contexts: ['action']）
    const webPart = zh.split(/[；;]/).filter(s => /网页|标签标题/.test(s));
    for (const part of webPart) {
      assert.doesNotMatch(
        part,
        /其他标签|别的标签/,
        `网页右键被说成能「保存其他标签」：${part.trim()}`
      );
    }
    assert.match(zh, /扩展图标/, '必须说清「保存其他标签」在扩展图标右键上');
  });

  it('（事实来源）「保存其他标签」只注册在 action 上下文', () => {
    const sw = read('src/service-worker.ts');
    const block = sw.match(/id: CONTEXT_MENU_IDS\.saveOtherTabs[\s\S]{0,400}?contexts: \[[^\]]*\]/);
    assert.ok(block, '找不到 saveOtherTabs 的注册块');
    assert.match(
      block[0],
      /contexts: \[[^\]]*'action'[^\]]*\]/,
      'saveOtherTabs 的 contexts 变了 —— 商店文案的右键范围要重新核对'
    );
    assert.doesNotMatch(
      block[0],
      /'page'/,
      'saveOtherTabs 现在也注册在 page 上下文 —— 商店文案的右键范围要重新核对'
    );
  });
});
