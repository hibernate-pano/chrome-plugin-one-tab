/**
 * 「CI 必须先构建再跑单测」的守卫（2026-10-23 第 50 轮）。
 *
 * ── 这条守卫钉的是什么 ────────────────────────────────────────────────────
 * 首屏准入有三层：
 *   ① 纯函数单测 ② 源码静态图 ③ **产物清单**（读 dist/ 里 popup 的
 *   modulepreload 清单，看有没有禁止组的块名）。
 *
 * 第 ③ 层需要 **dist 存在**。而 CI 原来的顺序是
 *   `pnpm test` → `pnpm validate`（build 只在 validate 里面）
 * ⇒ 干净 checkout 下跑 `pnpm test` 时 dist 还不存在
 * ⇒ 第 ③ 层**每次都 skip**，而 CI 日志里只是一行 skip，看起来像「验过了」。
 *
 * ⇒ CI 必须**先 build 再 test**。
 *
 * ── 为什么还要守「跳过时必须显眼」 ──────────────────────────────────────────
 * 本机 `pnpm test`（没构建过）仍会跳过第 ③ 层 —— 这是合理的（单测不该
 * 依赖构建产物）。但**静默**跳过不行：一条从没在 CI 里跑过的断言，
 * 看起来和「验过了」一模一样。跳过时必须把「本轮跳过了产物级断言」
 * **打在显眼处**（stderr），否则它就是一条永远不会被发现的洞。
 *
 * 沙箱的做法见 `tests/fixtures/ciWorkflowSandbox.ts`（为什么不用
 * `tests/_helpers/mutationSandbox.ts`：那个沙箱不拷 `.github/`）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = resolve(ROOT, '.github/workflows/verify.yml');
const BUDGET_GUARD = resolve(ROOT, 'tests/guards/firstScreenBudget.test.ts');

/** 去掉注释行后的 YAML（注释里也会出现 "pnpm test" 这些词，拿注释当配置断言＝骗自己）。 */
function liveYaml(): string {
  return readFileSync(WORKFLOW, 'utf8')
    .split('\n')
    .filter(line => !/^\s*#/.test(line))
    .join('\n');
}

/** 按 `- name:` / `- uses:` 切出来的步骤片段。 */
function steps(): string[] {
  return liveYaml().split(/\n {6}- (?:name|uses):/);
}

/** 第一个包含 `run: <cmd>` 的步骤片段。 */
function stepFor(cmd: string): string | undefined {
  return steps().find(s => new RegExp(`run: ${cmd}\\s*$`, 'm').test(s));
}

/**
 * 取出「跳过时给的消息」的正文。
 *
 * 消息可能是字面量，也可能是变量（`const msg = '…' + '…'`）⇒ 两种都要认，
 * 而且只量**正文**长度（拼起来的字符串有多长），不是量 `t.skip(msg)` 这几个字符。
 */
function skipMessageText(src: string): string {
  const at = src.indexOf('t.skip(');
  if (at < 0) return '';
  const tail = src.slice(at);
  const literal = /t\.skip\(\s*(['"`])([\s\S]*?)\1/.exec(tail);
  if (literal) return literal[2];
  const ident = /t\.skip\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(tail);
  if (!ident) return '';
  const decl = new RegExp(`const\\s+${ident[1]}\\s*=\\s*([\\s\\S]*?);`).exec(src);
  if (!decl) return '';
  return [...decl[1].matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)]
    .map(m => m[1] ?? m[2] ?? m[3] ?? '')
    .join('');
}

describe('CI：产物级首屏断言必须真的跑过', () => {
  it('工作流里有独立的构建步骤', () => {
    const build = stepFor('pnpm build');
    assert.ok(build, '工作流里没有 pnpm build 步骤 —— dist 不会在单测之前存在');
  });

  it('构建步骤排在单测步骤**之前**（否则产物级断言每次都 skip）', () => {
    const list = steps();
    const buildIdx = list.findIndex(s => /run: pnpm build\s*$/m.test(s));
    const testIdx = list.findIndex(s => /run: pnpm test\s*$/m.test(s));
    assert.ok(buildIdx >= 0, '工作流里没有 pnpm build 步骤');
    assert.ok(testIdx >= 0, '工作流里没有 pnpm test 步骤');
    assert.ok(
      buildIdx < testIdx,
      `构建步骤必须排在单测之前（build 在第 ${buildIdx} 步、test 在第 ${testIdx} 步）—— ` +
        '否则 tests/guards/firstScreenBudget.test.ts 的产物级断言在 CI 里每次都 skip，' +
        '而日志里只有一行 skip，看起来像「验过了」。'
    );
  });

  it('构建步骤是阻塞步骤（不许挂 continue-on-error）', () => {
    const build = stepFor('pnpm build');
    assert.ok(build, '工作流里没有 pnpm build 步骤');
    assert.ok(
      !build.includes('continue-on-error'),
      '构建步骤挂了 continue-on-error ⇒ dist 可能不存在，产物级断言又变成静默跳过'
    );
  });

  it('产物级断言跳过时必须**显眼地**喊一声（不许静默 skip）', () => {
    const src = readFileSync(BUDGET_GUARD, 'utf8');
    const skipIdx = src.indexOf('t.skip(');
    assert.ok(skipIdx >= 0, '产物级断言里找不到 t.skip —— 守卫文件被改坏了？');
    // 看 skip 前后的一小段：那里必须有一个「写出去」的调用（stderr 或诊断）。
    const window = src.slice(Math.max(0, skipIdx - 800), skipIdx + 200);
    const loud = /console\.error\(|t\.diagnostic\(/;
    assert.ok(
      loud.test(window),
      '跳过产物级断言时必须往 stderr / 诊断里写一句（console.error 或 t.diagnostic）—— ' +
        '静默 skip 看起来和「验过了」一模一样'
    );
    // 跳过的话本身也得说清楚「本轮没判什么」。
    assert.ok(
      skipMessageText(src).length > 20,
      '跳过时给的消息太短 ⇒ 没人看得懂「这一层没跑」意味着什么'
    );
  });
});
