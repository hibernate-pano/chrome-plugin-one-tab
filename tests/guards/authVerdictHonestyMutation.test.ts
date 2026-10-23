/**
 * 变异自证：**「核不到」永远不说「未登录」** 这条性质必须真的看得见破口
 * （2026-10-23，第 50 轮）。
 *
 * ⚠️ **为什么这个文件与守卫分开**（仓库既有约定，见
 *   `tests/guards/coreLayerPurityMutation.test.ts` 的头注释）：
 *   沙箱会把整个 `tests/` 目录拷一份再跑守卫 ——
 *   如果守卫自己调用 `runMutationCases`，沙箱里的那份会**再开一个沙箱**
 *   ⇒ 无限递归（实测：整个测试进程挂住，最后被 SIGKILL）。
 *   ⇒ 守卫只放**性质断言**，变异自证单独成文件。
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

import { runMutationCases, assertMutationOutcome } from '../_helpers/mutationSandbox.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LOADER_PATH = pathToFileURL(resolve(ROOT, 'tests/_alias-loader.mjs')).href;
before(async () => {
  register(LOADER_PATH);
});

describe('变异自证：这条性质必须真的看得见破口', () => {
  it('把「核不到」重新压成「没登录」（旧行为）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '闸门把所有失败压成「没登录」',
        testFile: 'tests/guards/authVerdictHonesty.test.ts',
        targets: [
          {
            path: 'src/core/authGuard.ts',
            mutate: source => {
              // 旧行为：`catch { return false; }` ⇒ 一切失败都读成「没登录」。
              const old = `    if (isBackendUnavailableError(err)) {
      return {
        allowed: false,
        kind: 'backend_unavailable',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    return {
      allowed: false,
      kind: 'unknown',
      detail: err instanceof Error ? err.message : String(err),
    };`;
              const replacement = `    if (isBackendUnavailableError(err)) {
      return {
        allowed: false,
        kind: 'backend_unavailable',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    return { allowed: false, kind: 'not_authenticated' };`;
              if (!source.includes(old)) {
                throw new Error('变异前提没成立：闸门的 catch 分支形状变了');
              }
              return source.replace(old, replacement);
            },
          },
        ],
        expectRed: true,
        expectedFailure: '不是「没登录」',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把「核不到」重新压成「没登录」');
  });

  it('把判据层的兜底改回「没登录」⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '判据层兜底改回 not_authenticated',
        testFile: 'tests/guards/authVerdictHonesty.test.ts',
        targets: [
          {
            path: 'src/core/authStatus.ts',
            mutate: source => {
              const old = "  return { kind: 'unknown', user: cached, detail: input.failureDetail };";
              const replacement = "  return { kind: 'not_authenticated', user: null };";
              if (!source.includes(old)) {
                throw new Error('变异前提没成立：判据层兜底那一行变了');
              }
              return source.replace(old, replacement);
            },
          },
        ],
        expectRed: true,
        expectedFailure: '绝不能被读成「没登录」',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把判据层的兜底改回「没登录」');
  });

  it('等价改写：把 `unknown` 写成常量别名 ⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '等价改写（常量别名）',
        testFile: 'tests/guards/authVerdictHonesty.test.ts',
        targets: [
          {
            path: 'src/core/authStatus.ts',
            mutate: source => {
              const old = "  return { kind: 'unknown', user: cached, detail: input.failureDetail };"
              const replacement =
                "  const UNKNOWN: 'unknown' = 'unknown';\n" +
                "  return { kind: UNKNOWN, user: cached, detail: input.failureDetail };";
              if (!source.includes(old)) {
                throw new Error('变异前提没成立：判据层兜底那一行变了');
              }
              return source.replace(old, replacement);
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '等价改写（行为一模一样）');
  });
});
