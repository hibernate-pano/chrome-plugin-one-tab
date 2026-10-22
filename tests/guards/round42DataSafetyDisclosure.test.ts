// 破坏性路径上的读失败必须 **fail-closed**，退出登录必须说清「本机数据还在」
// （2026-10-22 数据安全审计 DS-7 / DS-8）。
//
// ── DS-7 · 「清理重复标签」的确认数字来自可能陈旧的快照 ────────────────────
//
// 修复前：读 `getGroupsForWrite()` 失败 ⇒ 退回 Redux 快照 ⇒ 确认框里的数字
// 与**实际删除量**可能对不上（执行侧读的是真值）。
// 更糟的变体：读失败**且**快照为空 ⇒ 「本次预计清除 0 个」⇒ 连确认框都不弹，
// 只说一句「无需清理」—— 用户以为无事发生，而真值里其实有 12 个重复标签页。
//
// 破坏性路径上的读路径必须 fail-closed：读不到真值就不动手。
//
// ── DS-8 · 退出登录不清本地数据、且零提示 ────────────────────────────────
//
// 修复前只有一句「已退出登录」。用户合理地以为「退出 = 这个账号的数据不在
// 本机了」—— 而实际上一个会话都没删。接着登录**另一个**账号时，本机旧账号的
// 会话会混进新账号的列表（见 DS-1）。所以必须说清：数据仍在本机、且不会
// 上传到新账号。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const HEADER = read('src/components/layout/Header.tsx');
const DROPDOWN = read('src/components/layout/HeaderDropdown.tsx');

/** 去注释后的源码：注释里会引用旧写法，不能参与断言。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('DS-7 清理重复标签：读不到真值就不动手', () => {
  const src = stripComments(HEADER);

  it('读真值失败时必须中止，不得退回界面快照', () => {
    const fn = src.match(/const handleCleanDuplicateTabs[\s\S]*?\n {2}\};/);
    assert.ok(fn, '应能找到 handleCleanDuplicateTabs');
    // 不得再有「catch 里退回快照」的写法（`localGroups = groups`）。
    assert.doesNotMatch(
      fn[0],
      /=\s*groups\s*;/,
      '读失败时退回 Redux 快照 ⇒ 确认框的数字与实际删除量可能对不上'
    );
  });

  it('读失败必须出声（用户按了键不能只得到沉默）', () => {
    const fn = stripComments(HEADER).match(
      /const handleCleanDuplicateTabs[\s\S]*?\n {2}\};/,
    );
    assert.ok(fn, '应能找到 handleCleanDuplicateTabs');
    const catchBlock = fn[0].match(/catch\s*\([^)]*\)\s*\{[\s\S]*?\}/);
    assert.ok(catchBlock, '应能找到读真值的 catch 分支');
    assert.match(
      catchBlock[0],
      /showToast|showAlert/,
      '读失败必须给用户一句话（不能只在 console 里记一行）'
    );
    assert.match(catchBlock[0], /return/, '读失败必须中止，不得继续执行清理');
  });

  it('（事实来源）执行侧读的是真值', () => {
    const service = read('src/background/mutationService.ts');
    assert.match(
      service,
      /getGroupsForWrite/,
      '执行侧必须读真值 —— 否则确认框与实际删除量对不上'
    );
  });
});

describe('DS-8 退出登录：必须说清本机数据还在', () => {
  const src = stripComments(DROPDOWN);

  it('登出成功的提示里必须有「本机 N 个会话仍保留」', () => {
    const fn = src.match(/const handleSignOut[\s\S]*?\n {2}\};/);
    assert.ok(fn, '应能找到 handleSignOut');
    assert.match(
      fn[0],
      /仍保留/,
      '「已退出登录」不足以说明本机数据还在 —— 用户会以为数据已被清掉'
    );
    assert.match(
      fn[0],
      /不会上传|不会传到/,
      '必须说清这些会话不会被带到下一个账号'
    );
  });

  it('会话数必须取自真值（读不到时不得显示 0）', () => {
    const fn = src.match(/const handleSignOut[\s\S]*?\n {2}\};/);
    assert.ok(fn, '应能找到 handleSignOut');
    assert.match(fn[0], /storage\.getGroups\(/, '本机会话数必须读真值');
    assert.match(
      fn[0],
      /localCount\s*=\s*groups\.length/,
      '读失败时退回界面现值（可以是偏旧的数，但不能是 0）'
    );
  });

  it('登出失败仍然必须出声（这条不能被 DS-8 的改动带坏）', () => {
    const fn = src.match(/const handleSignOut[\s\S]*?\n {2}\};/);
    assert.ok(fn, '应能找到 handleSignOut');
    assert.match(
      fn[0],
      /showToast\(\s*['"`]退出登录失败/,
      '登出失败必须出声 —— 界面无变化时用户无法区分「没点上」与「坏了」'
    );
  });
});
