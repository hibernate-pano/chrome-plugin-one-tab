// 商店版本历史表的**结构**必须成立（2026-10-20 L-17 收尾）。
//
// ── 这个文件要防的具体事故 ────────────────────────────────────────────────
//
// ① **「用户视角」这条守卫只查了表格格，表格外的不查。**
//    `tests/docsAlignment.test.ts` 的「版本历史里最新一版必须是给用户看的摘要」
//    读的是 `newest[0].split('|')` —— 即**表格那一行**。
//    而 1.25.0 / 1.25.1 的详细清单是**放在表格外**的（跨行段落）。
//    ⇒ 表格外那几千字**从来没有被任何守卫看过**。
//    实测：1.25.0 的表格外清单里就躺着「回归测试」「有头浏览器」——
//    正是那条守卫明令禁止的工程复盘语域。**漏洞是继承的，不是新引入的。**
//
// ② **段落里挂着表格尾巴**：1.25.0 的详细清单末尾有一句
//    「…结果逐条一致。 | 未提审 |」—— 那串 `| 未提审 |` 是从表格行
//    拆出来时残留的。Markdown 渲染时它会**字面显示**成「| 未提审 |」，
//    出现在提交给审核员的商店页正文里。
//
// ── 这个文件守什么 ────────────────────────────────────────────────────────
//
// ① 版本历史**表格外**的正文也不得出现工程复盘语域（与表格格同一把尺子）。
// ② 表格外的正文不得挂着 `| 未提审 |` 这类**表格行的残留尾巴**。
// ③ 版本历史表格的**结构**本身要成立：表头、列数、每行四格、状态列非空。
//
// 【为什么第 ③ 条要单独守】表格行被拆开重组（把长清单挪到表格外）时，
// 最容易出的错就是**某一行的列数变了**（比如把「变更」和「状态」粘成一格，
// 或状态列跑到了变更格中间）。而这类错误 Markdown 渲染**不报错** ——
// 它只是安静地把表格画歪。审核员看到的是一张少了一列的表。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const STORE = read('CHROMEWEBSTORE.md');

/** 版本历史那一节。 */
const versionSection = (): string => {
  const section = STORE.split('## Version History')[1]?.split('\n## ')[0];
  assert.ok(section, 'CHROMEWEBSTORE.md 里找不到「## Version History」一节 —— 判据锚点丢了');
  return section;
};

/**
 * 版本历史表里的**表格行**（不含表格外的段落）。
 */
const tableRows = (): string[] =>
  versionSection()
    .split('\n')
    .filter(l => l.trimStart().startsWith('|'));

/**
 * 版本历史表**外**的正文段落（表格外的一切文字）。
 *
 * 【为什么要单独把它切出来】`docsAlignment.test.ts` 那条守卫读的是
 * 表格行的单元格 —— 表格外的文字它一个字都看不到。
 * 而「用户视角」这条要求对两者是**同一把尺子**。
 */
const proseOutsideTable = (): string =>
  versionSection()
    .split('\n')
    .filter(l => l.trim() && !l.trimStart().startsWith('|'))
    .join('\n');

/** 工程复盘语域的词表 —— 与 docsAlignment.test.ts 保持同一把尺子。 */
const ENGINEERING_REGISTER = [
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
  '全量测试',
  '类型检查',
  '代码规范检查',
  '真实浏览器',
  '有头浏览器',
];

describe('商店版本历史 ① 表格外的正文同样是给用户看的', () => {
  it('表格外不得出现工程复盘语域', () => {
    const prose = proseOutsideTable();
    assert.ok(
      prose.trim().length > 0,
      '版本历史表外没有任何正文 —— 若详细清单被误删，这条会红（说明内容丢了）'
    );
    const hits = ENGINEERING_REGISTER.filter(w => prose.includes(w));
    assert.deepEqual(
      hits,
      [],
      `表格外的版本说明里出现了工程复盘语域的词：${hits.join('、')}—— ` +
        '用户读到的是「这版怎么修的」，不是「这版对我有什么用」。' +
        '把工程细节留在 docs/RELEASE-NOTES.md。' +
        '（注：表格格的那一栏由 docsAlignment.test.ts 守着，' +
        '但它读不到表格外 —— 这里的漏洞是继承的：1.25.0 的清单里' +
        '本来就躺着「回归测试」「有头浏览器」。）'
    );
  });

  it('表格外不得挂着表格行的残留尾巴（如「| 未提审 |」）', () => {
    for (const line of proseOutsideTable().split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // 段落末尾不该有 `| xxx |` 这种表格单元格形状
      assert.doesNotMatch(
        trimmed,
        /\|\s*(未提审|已发布|已上线|待提审|未发布|本次提交审核)\s*\|\s*$/,
        `表格外的一段正文末尾挂着表格行的残留尾巴：${trimmed.slice(-60)} —— ` +
          'Markdown 会把它**字面显示**出来，出现在提交给审核员的商店页里。' +
          '（1.25.0 的清单末尾就有一处这样的残留。）'
      );
    }
  });
});

/**
 * 把一个表格行按**Markdown 的规则**切成格子。
 *
 * 【为什么不能用 `split('|')`】表格单元格里**可以**出现竖线 ——
 * 只要写成转义形式 `\|`（比如在描述「标题里含竖线（如「A \| B」）」这类
 * 内容时）。Markdown 渲染器**认**这个转义，它不会切列。
 * 而 `split('|')` **不认** ⇒ 它会把一个合法的四格行数成五格。
 *
 * ⇒ 数格必须**跳过被转义的竖线**，否则守卫会把**正确的**写法判成违规
 * （本仓反复吃的亏：守卫钉错了值，挡住了正确的改动）。
 */
const splitTableRow = (row: string): string[] => {
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < row.length; i += 1) {
    const ch = row[i];
    if (ch === '\\' && row[i + 1] === '|') {
      // 转义竖线：属于内容，不是分隔符
      current += '|';
      i += 1;
      continue;
    }
    if (ch === '|') {
      cells.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current);
  return cells;
};

/** 表格行去掉首尾两个空壳后的**内��格**。 */
const innerCells = (row: string): string[] => {
  const cells = splitTableRow(row).map(c => c.trim());
  return cells.slice(1, -1);
};

describe('商店版本历史 ② 表格结构本身要成立', () => {
  it('表头是四列（版本 / 日期 / 变更 / 状态）', () => {
    const rows = tableRows();
    assert.ok(rows.length >= 2, '版本历史表至少要有表头 + 一行');
    const header = innerCells(rows[0]).filter(Boolean);
    assert.equal(
      header.length,
      4,
      `版本历史表头应是四列（版本/日期/变更/状态），实际是 ${header.length} 列：${rows[0]}`
    );
  });

  it('每一行都是四格，且状态列非空', () => {
    for (const row of tableRows().slice(1)) {
      if (!/^\|\s*\d+\.\d+\.\d+\s*\|/.test(row)) continue; // 跳过分隔行
      const inner = innerCells(row);
      assert.equal(
        inner.length,
        4,
        `版本历史行不是四格（拆出 ${inner.length} 格）：${row.slice(0, 80)} —— ` +
          'Markdown 不会报错，只会安静地把表画歪。' +
          '（若这一格的内容里本来就有竖线，请写成转义形式 \\|）'
      );
      assert.ok(
        inner[3].length > 0,
        `版本历史行的状态列是空的：${row.slice(0, 80)} —— 提交状态必须写明`
      );
    }
  });

  it('表格里没有超长单元格（详细清单应当放在表格外）', () => {
    /**
     * 【为什么钉这个上限】1.25.1 那一行曾经是 **2928 字符**，
     * 塞在一个表格单元格里 —— 1.25.0 的详细清单（同类内容）只有 82 字符。
     * 一行 2928 字符的表格单元，审核员根本读不下去。
     *
     * 【为什么是 1200 而不是更小】详细清单**可能**合法地写在表格格里
     * （1.22.13 是 1042 字符、1.22.16 是 980 字符，都在表内且被接受）。
     * ⇒ 上限取一个「明显失控」的值，而不是「最优」值 ——
     * 守卫要拦的是**事故**，不是**品味**。
     */
    for (const row of tableRows().slice(1)) {
      if (!/^\|\s*\d+\.\d+\.\d+\s*\|/.test(row)) continue;
      const inner = innerCells(row);
      const changes = inner[2] ?? '';
      assert.ok(
        changes.length <= 1200,
        `版本 ${inner[0]} 的变更格有 ${changes.length} 字符 —— ` +
          '过长的一格没法读（1.25.1 曾是 2928 字符）。' +
          '详细清单请放到表格外的段落里，表格格只留摘要。'
      );
    }
  });

  it('表格外的详细清单按版本**倒序**排列（最新版在前）', () => {
    /**
     * 【为什么钉顺序】详细清单放表格外时，Markdown 表格会被段落**打断** ⇒
     * 所有版本的详细清单只能堆在表格**下面**一块。
     * 于是它们的**先后顺序**不再由表格决定 —— 1.25.1 的清单一度排在
     * 1.25.0 的**后面**（因为它是后加的），而版本历史是**倒序**的
     * （最新在上）⇒ 读者看到的是「新版本在下面」，与表格相反。
     *
     * ⇒ 判据：详细清单块里出现的版本号必须**单调不增**。
     */
    const prose = proseOutsideTable();
    // 只认明确点名版本的标题行（如「**1.25.1 的详细清单**」）
    const seen: number[] = [];
    for (const m of prose.matchAll(/\*\*(\d+\.\d+\.\d+)\s*的详细清单\*\*/g)) {
      seen.push(
        m[1].split('.').reduce((acc, part, i) => acc + Number(part) * Math.pow(1000, 2 - i), 0)
      );
    }
    if (seen.length < 2) return; // 只有一个版本有详细清单 ⇒ 无顺序问题
    for (let i = 1; i < seen.length; i += 1) {
      assert.ok(
        seen[i] <= seen[i - 1],
        `详细清单的版本顺序不是倒序：第 ${i} 个是 ${seen[i]}，第 ${i - 1} 个是 ${seen[i - 1]} —— ` +
          '版本历史是「最新在上」，详细清单必须与表格同向'
      );
    }
  });
});
