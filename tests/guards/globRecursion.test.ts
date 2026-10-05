// 门禁自检：单测 glob 必须递归（2026-10-05）。
//
// 为什么需要这条：package.json 的 test 脚本曾是 `tests/*.test.ts` —— **只覆盖
// 顶层**。往 tests/ 子目录里放测试文件会被**静默跳过**，没有任何报警。
// tests/_helpers/ 与本文件所在的 tests/guards/ 都已存在，说明子目录化是现实
// 中的趋势；而一个「写了没人跑」的测试比没有测试更危险：它看起来在保护什么，
// 实际什么都没做。
//
// 本文件自己就住在子目录里 —— 它既是断言也是自证：如果哪天 glob 又退回
// 顶层-only，本文件会第一个被静默跳过（而 CI 仍然变绿）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

describe('门禁：单测 glob 覆盖子目录', () => {
  it('package.json 的 test 脚本用的是递归 glob', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    const script: string = pkg.scripts.test;
    // 断言字面量存在 'tests/**/*.test.ts'（含双星号）。不写正则：转义容易出错，
    // 而这里要的就是「字面上是递归」这一件事。
    assert.ok(
      script.includes('tests/**/*.test.ts'),
      `test 脚本必须用 tests/**/*.test.ts（递归），当前是：${script}`
    );
    // 反向：不能是只覆盖顶层的 tests/*.test.ts
    assert.ok(
      !script.includes('tests/*.test.ts'),
      `tests/*.test.ts 只覆盖顶层，子目录里的测试会被静默跳过且无任何报警，当前是：${script}`
    );
  });

  it('本文件确实住在子目录里（否则上面那条断言是自欺）', () => {
    const rel = relative(ROOT, HERE).replace(/\\/g, '/');
    assert.equal(rel, 'tests/guards', `本文件应在 tests/guards/ 下，实际相对路径是 ${rel}`);
  });

  it('lint:tests 走 eslint 自己的递归（不共用 glob，不会有一半文件漏掉）', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    assert.ok(
      pkg.scripts['lint:tests'].includes('eslint tests'),
      `lint:tests 应交给 eslint 自行递归，当前是：${pkg.scripts['lint:tests']}`
    );
  });
});
