/**
 * 变异自证的沙箱（2026-10-23 审计 R-6 / R-11 / R-12 收口）。
 *
 * ── 为什么要有它 ──────────────────────────────────────────────────────────
 * 本仓的硬要求：**每条新守卫都要证明它有检测力** ——
 *   · 把实现改回旧行为 ⇒ 守卫必须变红；
 *   · 把实现改成一个**等价的正确写法** ⇒ 守卫必须**仍然绿**。
 *
 * 一条从来没红过的守卫，可能一直是绿的而什么也没守住。
 *
 * ── 为什么必须复制一份沙箱，而不是就地改仓库里的文件 ──────────────────────
 * `node --test` **并行**跑各个测试文件。仓库里有别的测试文件会 import
 * `@/components/tabs/TabList`、`@/core/emptyStateExits` …—
 * 若在变异期间改了**共享的那份**，那些文件会在半路上加载到变异后的实现
 * ⇒ 假红（flaky），而且那个假红与本守卫要证明的事毫无关系。
 * ⇒ 复制一份沙箱，变异只发生在沙箱里。
 *
 * ── 沙箱里跑的是**守卫自己** ──────────────────────────────────────────────
 * 不另写探针：把守卫文件原样复制进沙箱、跑 `node --test` ——
 * 「守卫变红」这件事由守卫自己给出，不需要第二份实现（两份实现会漂移，
 * 漂移了就变成「探针坏了」而不是「守卫抓到了」）。
 */
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 仓库根目录。 */
export const REPO_ROOT = resolve(HERE, '../..');

/** 一处变异。 */
export interface MutationTarget {
  /** 相对仓库根的文件路径。 */
  path: string;
  /** 施加变异（吃源码，吐变异后的源码）。 */
  mutate: (source: string) => string;
}

/** 一条变异用例。 */
export interface MutationCase {
  /** 用例名（报错时用）。 */
  name: string;
  /** 沙箱里要跑的守卫文件（相对仓库根）。 */
  testFile: string;
  /** 变异目标。 */
  targets: MutationTarget[];
  /** 期望这条变异让守卫**变红**（true）还是**仍然绿**（false）。 */
  expectRed: boolean;
  /** 变红时，失败输出里必须出现的字样（证明红在**目标断言**上）。 */
  expectedFailure?: string;
}

/** 一次变异的结果。 */
export interface MutationOutcome {
  /** 对照组（未变异）是否通过。 */
  controlPassed: boolean;
  /** 变异后是否变红。 */
  mutatedFailed: boolean;
  /** 变异后是否仍然绿。 */
  mutatedPassed: boolean;
  /** 失败原因是否命中预期的那条断言。 */
  reasonMatched: boolean;
  /** 变异后的完整输出（排查用）。 */
  output: string;
  /** 对照组的完整输出。 */
  controlOutput: string;
}

/**
 * 在沙箱里跑一批变异用例。
 *
 * 同一个守卫文件的多个用例共用**一次**对照运行（变异前后源码是同一份）。
 */
export function runMutationCases(cases: MutationCase[]): MutationOutcome[] {
  if (cases.length === 0) return [];
  const workDir = mkdtempSync(join(tmpdir(), 'tapstack-mutation-'));
  try {
    // 沙箱内容：源码 + 测试 + package.json（决定 .ts 按 ESM 处理）+ node_modules。
    cpSync(resolve(REPO_ROOT, 'src'), join(workDir, 'src'), { recursive: true });
    cpSync(resolve(REPO_ROOT, 'tests'), join(workDir, 'tests'), { recursive: true });
    copyFileSync(resolve(REPO_ROOT, 'package.json'), join(workDir, 'package.json'));
    // 别名解析器要 import 'typescript' ⇒ 让沙箱能解析到 node_modules。
    symlinkSync(resolve(REPO_ROOT, 'node_modules'), join(workDir, 'node_modules'), 'dir');
    // ⚠️ **文档也要拷进来**：有些守卫判据读的是 README / 商店页 / 审计台账
    //（判据的一半是「文档不许撤回那句话说」）。不拷 ⇒ 守卫在沙箱里读文件时
    // ENOENT ⇒ **对照组直接失败** ⇒ 每条变异用例都会「红」，看起来像守卫有检测力，
    // 其实是沙箱坏了（假红）。宁可多拷几个文件，也不能让判据在沙箱里失声。
    for (const extra of ['README.md', 'CHROMEWEBSTORE.md', 'docs']) {
      const from = resolve(REPO_ROOT, extra);
      if (!existsSync(from)) continue;
      cpSync(from, join(workDir, extra), { recursive: true });
    }

    const runGuard = (testFile: string): { ok: boolean; output: string } => {
      // ⚠️ 必须把 NODE_TEST_CONTEXT 从子进程环境里**去掉**：
      //   本仓的测试跑在 `node --test` 里面，而 node 的测试运行器会给自己派生的
      //   子进程设 `NODE_TEST_CONTEXT=child-v8` ⇒ 那个环境里的 `node --test`
      //   进入「测试子进程」模式，**不跑测试、不出报告、退出码 0**
      //   （症状：沙箱里「什么都没发生」还显示绿灯）。
      const childEnv: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '' };
      delete childEnv['NODE_TEST_CONTEXT'];
      try {
        const stdout = execFileSync(
          process.execPath,
          [
            '--test',
            '--import',
            './tests/_register-loader.mjs',
            '--experimental-strip-types',
            testFile,
          ],
          {
            cwd: workDir,
            encoding: 'utf8',
            stdio: 'pipe',
            env: childEnv,
          }
        );
        return { ok: true, output: stdout };
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string };
        return { ok: false, output: `${failure.stdout ?? ''}\n${failure.stderr ?? ''}` };
      }
    };

    const outcomes: MutationOutcome[] = [];
    const controlCache = new Map<string, { ok: boolean; output: string }>();

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

      let mutatedRun: { ok: boolean; output: string } = { ok: true, output: '' };
      try {
        mutatedRun = runGuard(testCase.testFile);
      } finally {
        for (const original of originals) writeFileSync(original.file, original.source);
      }

      outcomes.push({
        controlPassed: control.ok,
        mutatedFailed: !mutatedRun.ok,
        mutatedPassed: mutatedRun.ok,
        reasonMatched: testCase.expectedFailure
          ? mutatedRun.output.includes(testCase.expectedFailure)
          : true,
        output: mutatedRun.output,
        controlOutput: control.output,
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
export function assertMutationOutcome(
  outcome: MutationOutcome,
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
