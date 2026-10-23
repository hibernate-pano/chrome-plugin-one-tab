/**
 * 「改动 CI 工作流 / 守卫文件」的变异沙箱（2026-10-23 第 50 轮）。
 *
 * ── 为什么不用 `tests/_helpers/mutationSandbox.ts` ──────────────────────────
 * 它拷贝的是 src / tests / package.json / README.md / CHROMEWEBSTORE.md / docs ——
 * **不拷 `.github/`**。而「CI 顺序」这条判据读的就是
 * `.github/workflows/verify.yml` ⇒ 在那个沙箱里这份文件根本不存在 ⇒
 * 守卫会**假红**（读不到文件 ⇒ 判据崩了 ⇒ 看起来像「有检测力」，
 * 其实是沙箱坏了 —— 本仓吃过这种亏：假红会让「变异 ⇒ 变红」恒真）。
 *
 * 而 `tests/_helpers/**` 整个目录本轮不许改（别的 agent 在同时改里面的假服务器）
 * ⇒ 这里自己造一个只服务于「工作流 / 守卫文件」的小沙箱。
 *
 * ── 与既有沙箱的差别只有两处 ──────────────────────────────────────────────
 *   ① 多拷一份 `.github/`；
 *   ② stdout / stderr **分开**捕获（判据要看「跳过时有没有显眼地喊一声」，
 *      那句话是打到 stderr 的，合流就分不清是测试输出还是告警）。
 */
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { cpSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 仓库根目录。 */
export const REPO_ROOT = resolve(HERE, '../..');

/** 一处变异。 */
export interface WorkflowMutationTarget {
  /** 相对仓库根的文件路径（例如 `.github/workflows/verify.yml`）。 */
  path: string;
  /** 施加变异（吃源码，吐变异后的源码）。 */
  mutate: (source: string) => string;
}

/** 一条变异用例。 */
export interface WorkflowMutationCase {
  /** 用例名（报错时用）。 */
  name: string;
  /** 沙箱里要跑的守卫文件（相对仓库根）。 */
  testFile: string;
  /** 变异目标。 */
  targets: WorkflowMutationTarget[];
  /** 期望这条变异让守卫**变红**（true）还是**仍然绿**（false）。 */
  expectRed: boolean;
  /** 变红时，失败输出里必须出现的字样（证明红在**目标断言**上）。 */
  expectedFailure?: string;
}

/** 一次变异的结果。 */
export interface WorkflowMutationOutcome {
  controlPassed: boolean;
  mutatedFailed: boolean;
  mutatedPassed: boolean;
  reasonMatched: boolean;
  /** 变异后的完整输出（stdout + stderr）。 */
  output: string;
  /** 对照组的完整输出。 */
  controlOutput: string;
}

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * 在沙箱里跑一批变异用例（工作流 / 守卫文件专用）。
 *
 * 同一个守卫文件的多个用例共用**一次**对照运行（变异前后源码是同一份）。
 */
export function runWorkflowMutationCases(cases: WorkflowMutationCase[]): WorkflowMutationOutcome[] {
  if (cases.length === 0) return [];
  const workDir = mkdtempSync(join(tmpdir(), 'tapstack-ci-mutation-'));
  try {
    for (const dir of ['src', 'tests', '.github']) {
      const from = resolve(REPO_ROOT, dir);
      if (!existsSync(from)) continue;
      cpSync(from, join(workDir, dir), { recursive: true });
    }
    copyFileSync(resolve(REPO_ROOT, 'package.json'), join(workDir, 'package.json'));
    // 别名解析器要 import 'typescript' ⇒ 让沙箱能解析到 node_modules。
    symlinkSync(resolve(REPO_ROOT, 'node_modules'), join(workDir, 'node_modules'), 'dir');

    const runGuard = (testFile: string): RunResult => {
      // ⚠️ 必须把 NODE_TEST_CONTEXT 从子进程环境里去掉（与既有沙箱同一个坑）：
      //   node --test 派生的子进程带着它 ⇒ 子进程里的 node --test 不跑测试、退出码 0
      //   （症状：沙箱里「什么都没发生」还显示绿灯）。
      const childEnv: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '' };
      delete childEnv['NODE_TEST_CONTEXT'];
      const res = spawnSync(
        process.execPath,
        ['--test', '--import', './tests/_register-loader.mjs', '--experimental-strip-types', testFile],
        { cwd: workDir, encoding: 'utf8', env: childEnv }
      );
      return {
        ok: res.status === 0,
        stdout: res.stdout ?? '',
        stderr: res.stderr ?? '',
      };
    };

    const outcomes: WorkflowMutationOutcome[] = [];
    const controlCache = new Map<string, RunResult>();

    for (const testCase of cases) {
      let control = controlCache.get(testCase.testFile);
      if (!control) {
        control = runGuard(testCase.testFile);
        controlCache.set(testCase.testFile, control);
      }

      const originals: Array<{ file: string; source: string }> = [];
      for (const target of testCase.targets) {
        const file = join(workDir, target.path);
        const source = readFileSync(file, 'utf8');
        const mutated = target.mutate(source);
        if (mutated === source) {
          throw new Error(`变异没有生效（源码没变）：${target.path}`);
        }
        originals.push({ file, source });
        writeFileSync(file, mutated);
      }

      let mutatedRun: RunResult = { ok: true, stdout: '', stderr: '' };
      try {
        mutatedRun = runGuard(testCase.testFile);
      } finally {
        for (const original of originals) writeFileSync(original.file, original.source);
      }

      const output = `${mutatedRun.stdout}\n${mutatedRun.stderr}`;
      outcomes.push({
        controlPassed: control.ok,
        mutatedFailed: !mutatedRun.ok,
        mutatedPassed: mutatedRun.ok,
        reasonMatched: testCase.expectedFailure
          ? output.includes(testCase.expectedFailure)
          : true,
        output,
        controlOutput: `${control.stdout}\n${control.stderr}`,
      });
    }

    return outcomes;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * 断言一条变异的结果符合预期，并给出一条**能指路的**失败信息。
 *
 * @param outcome 变异结果
 * @param expectRed 期望变红（true）还是仍然绿（false）
 * @param what 这条变异做了什么（失败信息里要写清楚）
 */
export function assertWorkflowMutationOutcome(
  outcome: WorkflowMutationOutcome,
  expectRed: boolean,
  what: string
): void {
  assert.ok(
    outcome.controlPassed,
    `对照组必须通过（未变异的源码上守卫就该是绿的）—— ` +
      `否则后面「变异 ⇒ 变红」的断言毫无检测力（它们会恒真）。\n` +
      `对照组输出：\n${outcome.controlOutput.slice(-4000)}`
  );
  if (expectRed) {
    assert.ok(
      outcome.mutatedFailed,
      `${what} 之后守卫仍然全绿 ⇒ 这条守卫是空的（零检测力）。\n` +
        `变异后输出：\n${outcome.output.slice(-4000)}`
    );
    assert.ok(
      outcome.reasonMatched,
      `${what} 之后守卫确实红了，但红在**别的**断言上 ⇒ 那说明守卫抓错了地方。\n` +
        `变异后输出：\n${outcome.output.slice(-4000)}`
    );
  } else {
    assert.ok(
      outcome.mutatedPassed,
      `${what} 之后守卫变红了 ⇒ 这条守卫钉的是**长相**而不是**行为**：` +
        '换一种等价写法就误报，等于逼着实现不敢改。\n' +
        `变异后输出：\n${outcome.output.slice(-4000)}`
    );
  }
}
