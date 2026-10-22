// 变异自证：把「撤销退路」的实现改坏，守卫必须变红（2026-10-22 审计 P0-5
// + 主审追加的「看不见时暂停」那一半）。
//
// 用法：node scripts/mutation-proof-toast-undo.mjs
//
// ⚠️ 这个脚本会**就地改** src/ 与 tests/ 下的源文件（每个变异改完立刻还原，
//    还原写在 finally 里）⇒ **不要在别的测试正在并行跑的时候执行它**
//    （node --test 会并行加载各测试文件 ⇒ 会加载到变异后的实现 ⇒ 假红）。
//
// 做法：每个变异 = 一处文本替换 ⇒ 跑一遍守卫 ⇒ 必须出现失败 ⇒ 还原。
// 跑完打印一张表：变异名 / 失败数 / 第一个失败用例名。

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const GUARD = 'tests/guards/toastUndoReachability.test.ts';
const GUARD_A11Y = 'tests/a11yDialogs.test.ts';

const POLICY = 'src/components/common/toastPolicy.ts';
const TOAST = 'src/components/common/Toast.tsx';

const MUTATIONS = [
  {
    name: '① 删掉 countdown.pause()（悬停/看不见都不再暂停）',
    file: TOAST,
    from: 'countdownRef.current?.pause();',
    to: '/* mutated */',
  },
  {
    name: '② 恢复时从头计时（不是从暂停处续走）',
    file: POLICY,
    from: 'deadlineAt: now + state.remainingMs,',
    to: 'deadlineAt: now + state.durationMs,',
  },
  {
    name: '③ 暂停上限不强制收起（提示永远赖着）',
    file: POLICY,
    from: `    capTimer = clock.setTimeout(() => {
      capTimer = null;
      fire();
    }, budget);`,
    to: `    capTimer = clock.setTimeout(() => {
      capTimer = null;
    }, budget);`,
  },
  {
    name: '④ 删掉「带动作 ⇒ 延长时长」的分支',
    file: POLICY,
    from: '  if (hasAction) return Math.max(requested, TOAST_ACTION_DURATION_MS);',
    to: '  // mutated: hasAction 分支没了',
  },
  {
    name: '⑤ 删掉「正在打字时不抢焦点」的判据',
    file: POLICY,
    from: '  if (inputs.userIsTyping) return false;',
    to: '  // mutated',
  },
  {
    name: '⑥ 删掉「用户看不见时暂停」这一支',
    file: POLICY,
    from: 'inputs.hovered || inputs.focused || (inputs.hasDecision && !inputs.pageSeen);',
    to: 'inputs.hovered || inputs.focused;',
  },
  {
    name: '⑦ 三个触发条件从「或」改成「与」',
    file: POLICY,
    from: 'inputs.hovered || inputs.focused || (inputs.hasDecision && !inputs.pageSeen);',
    to: 'inputs.hovered && inputs.focused && inputs.hasDecision && !inputs.pageSeen;',
  },
  {
    name: "⑧ 删掉 window 的 blur 监听（切走标签时不再暂停）",
    file: TOAST,
    from: "    window.addEventListener('blur', update);",
    to: '    // mutated',
  },
  {
    name: '⑨ 把撤销窗口改回 3 秒',
    file: POLICY,
    from: 'export const TOAST_ACTION_DURATION_MS = 8000;',
    to: 'export const TOAST_ACTION_DURATION_MS = 3000;',
  },
  {
    name: '⑩ 焦点接管不看「页面看不看得见」（看不见也抢焦点）',
    file: TOAST,
    from: "      pageSeen: detectPageAttention() === 'visible',",
    to: '      pageSeen: true,',
  },
];

const run = (file) => {
  try {
    execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--import',
        './tests/_register-loader.mjs',
        '--test',
        file,
      ],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
    );
    return { ok: true, output: '' };
  } catch (err) {
    return {
      ok: false,
      output: `${err.stdout ?? ''}\n${err.stderr ?? ''}`,
    };
  }
};

/** 从 node:test 的输出里抠出失败用例名。 */
const failedNames = (output) => {
  const names = [];
  const re = /^not ok \d+ - (.+)$/gm;
  let m;
  while ((m = re.exec(output)) !== null) names.push(m[1].trim());
  return names;
};

const rows = [];
let allGood = true;

for (const mutation of MUTATIONS) {
  const path = resolve(ROOT, mutation.file);
  const original = readFileSync(path, 'utf8');
  if (!original.includes(mutation.from)) {
    rows.push({ name: mutation.name, result: '❌ 变异没生效（源文件里找不到那段文字，可能代码已经变了）' });
    allGood = false;
    continue;
  }
  writeFileSync(path, original.replace(mutation.from, mutation.to));
  try {
    const r1 = run(GUARD);
    const r2 = run(GUARD_A11Y);
    const output = `${r1.output}\n${r2.output}`;
    const failures = failedNames(output);
    const caught = !r1.ok || !r2.ok;
    if (!caught) allGood = false;
    rows.push({
      name: mutation.name,
      result: caught
        ? `✅ 变红（${failures.length} 条失败：${failures.slice(0, 2).join(' | ') || '见输出'}）`
        : '❌ 没变红 —— 这条守卫没有检测力',
    });
  } finally {
    writeFileSync(path, original);
  }
}

console.log('\n=== 变异自证结果 ===');
for (const row of rows) console.log(`${row.result}\n   ${row.name}`);
console.log(allGood ? '\n全部变异都被抓到了。' : '\n⚠️ 有变异没被抓到。');
process.exit(allGood ? 0 : 1);
