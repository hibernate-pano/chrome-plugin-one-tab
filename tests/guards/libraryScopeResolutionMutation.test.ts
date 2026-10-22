/**
 * 变异自证：P0-1 的守卫（页面与后台必须解析出同一个库作用域）必须看得见破口。
 *
 * 三个方向：
 *   ① 把作用域解析改回**直接动态 import**（旧行为）
 *      ⇒ 守卫必须变红（SW realm 里那条路径在真实 Chrome 里必然失败）；
 *   ② 让注册表在 SW realm 里**忽略**注册进来的加载器
 *      ⇒ 守卫必须变红（后台于是又算不出库）；
 *   ③ **等价的正确写法**（换个写法取同一个模块）⇒ 守卫必须**仍然绿**。
 *
 * 沙箱的做法见 `tests/_helpers/mutationSandbox.ts`。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/libraryScopeResolution.test.ts';

describe('变异自证：P0-1 的守卫必须看得见破口', () => {
  it('变异一：作用域解析改回直接动态 import（旧行为）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '作用域解析直接动态 import',
        testFile: GUARD,
        targets: [
          {
            path: 'src/storage-kv/firstSyncPendingRecord.ts',
            mutate: source => {
              // 不钉缩进：那条语句所在函数的缩进层级会变（守卫钉死缩进 ⇒
              // 改了正确的写法反而红）。
              const old = 'const { currentLibraryScope } = await loadLibraryIdentity();';
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到取模块的那一行');
              return source.replace(
                old,
                "const { currentLibraryScope } = await import('@/sync-backend/webdav/libraryIdentity');"
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: 'SW realm 里的作用域不是注册进来的加载器给出的',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把作用域解析改回直接动态 import');
  });

  it('变异二：注册表在 SW realm 里忽略注册进来的加载器 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'SW realm 里忽略注册进来的加载器',
        testFile: GUARD,
        targets: [
          {
            path: 'src/sync-backend/webdav/libraryIdentityRuntime.ts',
            mutate: source => {
              const old = '  if (registeredLoader) return registeredLoader();';
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到取加载器的那一行');
              return source.replace(
                old,
                '  if (registeredLoader && !isServiceWorkerRealm()) return registeredLoader();'
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: 'SW realm 里的作用域不是注册进来的加载器给出的',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让注册表在 SW realm 里忽略注册进来的加载器');
  });

  it('变异三：等价改写（换个写法取同一个模块）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '作用域解析换成等价写法',
        testFile: GUARD,
        targets: [
          {
            path: 'src/storage-kv/firstSyncPendingRecord.ts',
            mutate: source => {
              const old = 'const { currentLibraryScope } = await loadLibraryIdentity();';
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到取模块的那一行');
              const next = source
                .replace(old, 'const identity = await loadLibraryIdentity();')
                .replace(
                  'return await currentLibraryScope();',
                  'return await identity.currentLibraryScope();'
                );
              if (next === source) throw new Error('变异没有生效（源码没变）');
              return next;
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把作用域解析换成等价的写法');
  });
});
