// 门禁外部锚点：单测 glob 必须递归（2026-10-09 专家团体检 P0-1）。
//
// 【为什么已有 tests/guards/globRecursion.test.ts 还不够】
// 那条守卫**自己就住在 tests/guards/ 子目录里**。于是它防的正是让它失效的那件事：
// glob 一旦退回 `tests/*.test.ts`，守卫文件本身先被静默跳过，剩下 930 个测试
// 全绿、零 skip、零信号 —— 自我指涉，没有外部锚点。
// 实测证据（2026-10-09）：`node --test "tests/*.test.ts"` → 930 pass / 0 fail /
// 0 skipped；65 个子目录测试凭空消失，而 CI 与本地都看不出来。
//
// 【本文件为什么放在顶层】
// 顶层文件在两种 glob 形态下都会被收集。glob 退化 ⇒ 本文件照跑 ⇒ 断言变红。
// 这是「外部锚点」的全部含义：把守卫放到退化路径之外。
//
// 【为什么不直接搬走 guards/globRecursion.test.ts】
// 那份仍要留在原地当自证（它同时断言「本文件确实住在子目录里」）。
// 两处重复断言同一个事实是有意为之：一个防退化、一个防「有人把子目录拍平」。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = join(ROOT, 'tests');

function readTestScript(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const script = pkg.scripts?.test;
  assert.equal(typeof script, 'string', 'package.json 的 scripts.test 必须是字符串');
  return script;
}

/** 递归列出 tests/ 下所有 *.test.ts，返回相对 tests/ 的路径。 */
function allTestFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.test.ts')) {
        out.push(full.slice(TESTS.length + 1).replace(/\\/g, '/'));
      }
    }
  };
  walk(TESTS);
  return out.sort();
}

describe('外部锚点：单测 glob 必须递归（本文件住在顶层，退化时仍会跑）', () => {
  it('package.json 的 test 脚本用的是递归 glob', () => {
    const script = readTestScript();
    assert.ok(
      script.includes('tests/**/*.test.ts'),
      `test 脚本必须用 tests/**/*.test.ts（递归），当前是：${script}\n` +
        '退回顶层-only 会让 tests/guards/ 等子目录里的测试被静默跳过、' +
        '全绿零 skip，没有任何报警。'
    );
    assert.ok(
      !script.includes('tests/*.test.ts'),
      `tests/*.test.ts 只覆盖顶层，当前是：${script}`
    );
  });

  it('磁盘上确实存在子目录测试（否则上面那条断言是空断言）', () => {
    const nested = allTestFiles().filter(f => f.includes('/'));
    assert.ok(
      nested.length > 0,
      'tests/ 下已无子目录测试文件 —— 递归 glob 的守卫失去意义。' +
        '若确实拍平了目录结构，请连同本断言一起更新并说明理由。'
    );
    // guards 子目录是这条锚点的直接受益者（globRecursion / migrationReplay.pg /
    // gateWiring 全在里面）。点名断言，避免「子目录还在但 guards 被挪走」。
    const guards = nested.filter(f => f.startsWith('guards/'));
    assert.ok(
      guards.length >= 5,
      `tests/guards/ 下应至少有 5 个测试文件，实到 ${guards.length}：${guards.join('、')}`
    );
  });

  it('顶层与递归收集的文件数不同 —— 退化必然丢测试', () => {
    const all = allTestFiles();
    const topLevel = all.filter(f => !f.includes('/'));
    assert.ok(
      all.length > topLevel.length,
      `递归收集 ${all.length} 个、顶层 ${topLevel.length} 个：两者相等意味着` +
        '不存在会被退化丢掉的测试，本锚点形同虚设'
    );
  });
});
