/**
 * 变异沙箱（对外文案专用，2026-10-23 第 50 轮）。
 *
 * ── 为什么不用 `tests/_helpers/mutationSandbox.ts` ────────────────────────
 *
 * 那个助手拷的是：`src` / `tests` / `package.json` / `README.md` /
 * `CHROMEWEBSTORE.md` / `docs`。
 *
 * 而这一轮要证的判据里有三条读的是**不在那张单子上**的文件：
 *   · `promo-site/index.html`（官网文案：锁定 / 撤销 / 商店链接）
 *   · `manifest.json`（短描述）
 *   · `scripts/store-listing-judge.mjs`（扩展 id 的**真相源**）
 *
 * 用那个助手跑它们 ⇒ 守卫在沙箱里读文件时 ENOENT ⇒ **对照组直接失败**
 * ⇒ 每条变异用例都「红」—— 看起来像守卫有检测力，其实是沙箱坏了（假红）。
 * 仓库记忆里那条「假服务器的自证式盲区」说的就是这一类：**判据失声 ≠ 判据有检测力**。
 *
 * ⇒ 这里另起一个**只是多拷几处**的沙箱，其余纪律（变异只发生在副本里、
 * 跑的是守卫自己、必须去掉 NODE_TEST_CONTEXT）与那个助手完全一致。
 *
 * ── 为什么不直接把断言逻辑也复制一份 ──────────────────────────────────────
 *
 * 断言（「对照组必须绿」「变异后必须红」「红在**目标断言**上」）直接**复用**
 * `tests/_helpers/mutationSandbox.ts` 导出的 `assertMutationOutcome` ——
 * 那套语义是仓库定的，两处各写一份迟早漂。
 */
import { execFileSync } from 'node:child_process';
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

/** 一次变异的结果（与 `_helpers/mutationSandbox.ts` 同形，便于复用断言）。 */
export interface MutationOutcome {
  controlPassed: boolean;
  mutatedFailed: boolean;
  mutatedPassed: boolean;
  reasonMatched: boolean;
  output: string;
  controlOutput: string;
}

/** 沙箱里必须存在的目录 / 文件（守卫在沙箱里要读它们）。 */
const SANDBOX_CONTENT = [
  'src',
  'tests',
  'docs',
  'scripts',
  'promo-site',
  'README.md',
  'CHROMEWEBSTORE.md',
  'manifest.json',
  'package.json',
];

/**
 * 在沙箱里跑一批变异用例。
 *
 * 同一个守卫文件的多个用例共用**一次**对照运行（变异前后源码是同一份）。
 */
export function runOutwardMutationCases(cases: MutationCase[]): MutationOutcome[] {
  if (cases.length === 0) return [];
  const workDir = mkdtempSync(join(tmpdir(), 'tapstack-outward-mutation-'));
  try {
    for (const item of SANDBOX_CONTENT) {
      const from = resolve(REPO_ROOT, item);
      if (!existsSync(from)) continue;
      const to = join(workDir, item);
      if (item.endsWith('.json') || item.endsWith('.md')) {
        copyFileSync(from, to);
      } else {
        cpSync(from, to, { recursive: true });
      }
    }
    // 别名解析器要 import 'typescript' ⇒ 让沙箱能解析到 node_modules。
    symlinkSync(resolve(REPO_ROOT, 'node_modules'), join(workDir, 'node_modules'), 'dir');

    const runGuard = (testFile: string): { ok: boolean; output: string } => {
      // ⚠️ 必须把 NODE_TEST_CONTEXT 从子进程环境里去掉（原因同
      // `_helpers/mutationSandbox.ts`）：留着它，子进程里的 `node --test`
      // 进入「测试子进程」模式，不跑测试、退出码 0 —— 症状是「什么都没发生」。
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
