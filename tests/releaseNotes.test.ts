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
