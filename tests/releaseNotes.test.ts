// 发版记录台账与代码的一致性回归。
//
// 为什么要有这份文件：docs/RELEASE-NOTES.md 是长期台账（每版做了什么、为什么），
// 但它和 CHROMEWEBSTORE.md 一样是纯文档——文档不会自己变红。历史上已经出现过
// 「版本号升了、文档没记」的情况：v1.22.9 提审后迟迟没打 tag，直到 1.22.10 发版
// 才补上；1.21.1 那一行至今是版本史里唯一的空洞（是否真的发布过尚未核实）。
// 台账一旦开始漏记，它就退化成「看起来很全、实际缺几版」的假安全感。
//
// 形状与 docsAlignment.test.ts 一致：不硬编码期望字符串，而是从 package.json /
// CHROMEWEBSTORE.md 反推事实，再拿文档去对——改坏代码或改坏文档都应转红。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const NOTES = read('docs/RELEASE-NOTES.md');
const STORE = read('CHROMEWEBSTORE.md');
const PKG = JSON.parse(read('package.json')) as { version: string };

/** 取 `## vX.Y.Z（…）` 小节标题里的版本号，按出现顺序。 */
function noteSections(md: string): string[] {
  return [...md.matchAll(/^##\s+v(\d+\.\d+\.\d+)\s*（/gm)].map(m => m[1]);
}

/**
 * 台账里出现过的所有版本号 = 正式小节 + 早期索引表的行首（`| v1.19.3 |`）。
 * 早期版本只给索引不给小节，所以交叉核对要认两种形状。
 */
function noteVersions(md: string): string[] {
  const table = [...md.matchAll(/^\|\s*v(\d+\.\d+\.\d+)\s*\|/gm)].map(m => m[1]);
  return [...noteSections(md), ...table];
}

/** 取 CHROMEWEBSTORE 版本历史表第一列的版本号。 */
function storeVersions(md: string): string[] {
  return [...md.matchAll(/^\|\s*(\d+\.\d+\.\d+)\s*\|/gm)].map(m => m[1]);
}

/** 语义化版本降序比较（注意 1.22.10 > 1.22.9，必须按数字比不能按字符串比）。 */
function desc(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  return pb[0] - pa[0] || pb[1] - pa[1] || pb[2] - pa[2];
}

describe('发版记录台账：docs/RELEASE-NOTES.md 必须跟得上版本号', () => {
  const notes = noteSections(NOTES);

  it('文件存在且有可解析的版本小节', () => {
    assert.ok(notes.length > 0, 'RELEASE-NOTES.md 里必须有 `## vX.Y.Z（…）` 形式的小节');
    assert.ok(
      NOTES.includes('如何追加一版'),
      '文件必须自带追加约定（版本号五处同步 / 打 tag 时机），否则下次发版只能靠回忆'
    );
  });

  it('最新一节的版本号 == package.json 版本号（发版忘了写台账就红）', () => {
    assert.equal(
      notes[0],
      PKG.version,
      `台账最新记的是 v${notes[0]}，而 package.json 已是 ${PKG.version}——` +
      '发版后请在 docs/RELEASE-NOTES.md 顶部补一节'
    );
  });

  it('小节倒序排列（最新在上），无重复版本', () => {
    assert.deepEqual(
      notes,
      [...notes].sort(desc),
      '版本小节必须倒序（最新在上），追加时插到顶部'
    );
    assert.equal(new Set(notes).size, notes.length, '同一版本不应出现两节');
  });

  it('商店版本史里的每个版本，台账里也有一节或一条索引（提审过就必须留痕）', () => {
    const recorded = noteVersions(NOTES);
    const missing = storeVersions(STORE).filter(v => !recorded.includes(v));
    assert.deepEqual(
      missing,
      [],
      `这些版本进了商店提交文案却没进发版台账：${missing.join(', ')}`
    );
  });
});

/**
 * 「显式检查项」的守卫。
 *
 * ── 为什么要有这一条 ────────────────────────────────────────────────────
 * 2026-10-20 修 WebDAV「列目录 fail-open」时发现：那条链路的**失败模式是
 * 静默的** —— 读不出目录若被当成「目录是空的」，云端明明有的会话会被本机
 * 子集覆盖，对所有设备隐形且不可恢复。
 * 而「三家 WebDAV 各跑一次列目录实测」是**真机**项，脚本替不了
 * （`scripts/webdav-capability-matrix.mjs` / `scripts/e2e-webdav-local.mjs`
 * 目前只测 Depth:0，不覆盖 Depth:1）。
 *
 * 台账里写一条「记得做」是**靠不住的** —— 文档不会自己变红，几轮重构之后
 * 它会被当成「已验证的代码」而失去复核。所以这里把它钉成**会变红**的东西：
 * 只要台账里删掉这条未完成项、或者把它勾成已完成，测试就红。
 *
 * ── 判据 ────────────────────────────────────────────────────────────────
 * 不硬编码段落文字，而是钉**语义**：
 *   1. 台账里存在一条**未勾选**的「三家 WebDAV 列目录实测」待办；
 *   2. 它必须挂在**当前最新版本**的小节里（不能躺在历史版本里装完成）；
 *   3. 待办必须写明 Depth:1 PROPFIND 的检查点（不然「列目录实测」是空话）。
 */
describe('显式检查项：三家 WebDAV 的列目录实测不许被静默丢掉', () => {
  const latestSection = (() => {
    const start = NOTES.indexOf('## v');
    if (start < 0) return '';
    const next = NOTES.indexOf('\n## v', start + 1);
    return NOTES.slice(start, next < 0 ? NOTES.length : next);
  })();

  /** 待办里那条「三家 WebDAV 列目录实测」的**整块**（含其缩进续行）。 */
  const todoBlock = (() => {
    const lines = latestSection.split('\n');
    const i = lines.findIndex(l => /^\s*-\s*\[.\]\s*.*三家\s*WebDAV.*列目录/.test(l));
    if (i < 0) return '';
    const out: string[] = [lines[i]];
    for (let j = i + 1; j < lines.length; j++) {
      if (!/^\s{2,}\S/.test(lines[j])) break; // 续行必须缩进
      out.push(lines[j]);
    }
    return out.join('\n');
  })();

  it('最新一节里必须有「三家 WebDAV 各跑一次列目录实测」这条未完成的待办', () => {
    const pending = [...latestSection.matchAll(/^\s*-\s*\[( |x)\]\s*(.+)$/gm)];
    assert.ok(pending.length > 0, '最新一节里必须有勾选框形式的待办');
    const target = pending.find(m => /三家\s*WebDAV/.test(m[2]) && /列目录/.test(m[2]));
    assert.ok(
      target,
      '最新一节里必须有一条「三家 WebDAV 各跑一次列目录实测」的待办 —— ' +
        '它是**真机**项，脚本与单测都替不了（Depth:1 PROPFIND 目前没有任何自动化覆盖）'
    );
    assert.notEqual(
      target?.[1],
      'x',
      '这条待办还是**未完成**状态；若已真机验完，请把勾选证据与结论一并写进台账再勾'
    );
  });

  it('这条待办必须写明 Depth:1 PROPFIND 的检查点（否则「列目录实测」是空话）', () => {
    assert.ok(todoBlock, '必须先找到那条待办（否则下面两条是空断言）');
    // 盯住「Depth:1 PROPFIND」这个**具体请求形态**（要记它的状态码），
    // 而不是只盯 "Depth:1" 四个字 —— 待办末尾那句「不覆盖 Depth:1」里
    // 也有这四个字，盯它就抓不到「检查点被抹掉」。
    assert.match(
      todoBlock,
      /Depth:1\s*PROPFIND/,
      '待办**本体**必须点名 Depth:1 PROPFIND —— 现有脚本只测 Depth:0，这正是缺口所在'
    );
    assert.match(
      todoBlock,
      /状态码/,
      '待办**本体**必须要求记录**状态码** —— 「列出来了」与「列不出来」的区别就在状态码与正文'
    );
    assert.match(
      todoBlock,
      /multistatus/,
      '待办**本体**必须点名「正文里有没有 multistatus」—— 这正是本轮 fail-open 的判据'
    );
    assert.match(
      todoBlock,
      /<response>/,
      '待办**本体**必须点名「有没有 <response> 块」—— 本轮的第二条闸就是它'
    );
  });

  it('台账必须同时记下「本轮把读不懂的 207 从空库改成 fail-closed」这个代价', () => {
    // 判据盯「已知边界」那一段（本轮的代价），而不是整节 ——
    // 整节里引言也会出现 fail-closed，盯整节就抓不到「代价被抹掉」。
    const boundary = (() => {
      const m = latestSection.match(/\*\*已知的[^\n]*\n([\s\S]*)$/);
      return m ? m[1] : '';
    })();
    assert.ok(boundary, '最新一节里必须有「已知的边界」小节');
    assert.match(
      boundary,
      /fail-closed/,
      '收紧 listed 的判据是有代价的（真机上若某家形态特殊，用户会看到中止报错）—— ' +
        '这个代价必须留在「已知的边界」里，不能只写「已修复」'
    );
    assert.match(
      boundary,
      /中止/,
      '代价必须写明用户会看到什么（同步中止报错），否则没人能判断这个取舍能不能接受'
    );
  });
});
