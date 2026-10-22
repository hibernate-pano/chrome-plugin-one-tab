// 归属待决位的「作用域」在**页面与后台必须得出同一个答案」（2026-10-23 审计 P0-1）。
//
// ── 为什么这条不变量值得一条守卫 ──────────────────────────────────────────
//
// 归属待决位（「这些会话归不归这个库」）是**按库寻址**的：
// 记录里每一格是一个库的作用域键 ⇒ 要判断「当前这个库待不待决」，
// 就必须先知道「当前是哪个库」。
//
// 而「当前是哪个库」在**两个 realm** 里都要算：
//   · 页面（弹窗 / 设置页）—— 算得出（`await import()` 在页面里合法）；
//   · **Service Worker**（真正执行上传的那一侧）—— 过去算不出：
//     `import()` 被 Chrome 禁止 ⇒ SW 恒为「没有目标库」⇒ 落进
//     「只要有一格待决就算待决」的保守分支 ⇒ SW 永远以为归属决策没做完
//     ⇒ 自动上传被永久降级成「只传本次改动过的那几个」⇒
//     **历史会话再也传不上用户自己的云盘，而回包还报「成功」**。
//
// 症状是**静默**的：页面显示「决策已完成」，后台却按「还没决策」处理。
//
// ── 这条守卫钉的是**行为**，不是代码形状 ────────────────────────────────
//
//   ① 页面 realm 算出来的作用域 = 磁盘上那个库的真值（不是兜底的 no-library）；
//   ② **SW realm 里算作用域必须经由注册进来的加载器**
//      （SW 自己没法 import 模块 ⇒ 唯一出路就是入口注册进来的那个）；
//   ③ SW realm 与页面 realm 算出的作用域**必须相同**。
//
// ⚠️ ② 看着像「结构断言」，其实是这条不变量在 SW 侧唯一的**可观测形式**：
// Node 的 `import()` 是合法的 ⇒ 单测里「直接动态 import」也能算出真值
// ⇒ 只断言 ③ 的话，把实现改回旧写法（直接 `await import()`）守卫仍然全绿
// ⇒ 零检测力。② 用一个**哨兵加载器**把「走没走注册表」变成可观测的事实。
// 变异自证见 `tests/guards/libraryScopeResolutionMutation.test.ts`。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { installEngineStorageEnv } from '../_helpers/engineStorageEnv.ts';

// ⚠️ 必须在任何 `@/...` 的 import 之前装好环境桩：
// storage-kv 在**首次 import** 时决定用哪个驱动（没有 IndexedDB ⇒ 回落 localStorage）。
installEngineStorageEnv();

/** 探针用的库（假的域名，纯属占位）。 */
const PROBE = {
  baseUrl: 'https://dav.scope-probe.test/',
  username: 'scope-probe-user',
  rootPath: 'TapStack',
};

/**
 * 「当前这个库」的作用域键的**期望值**（按产品口径独立算一遍）。
 *
 * 口径见 `sync-backend/webdav/libraryIdentity.ts`：
 * 地址规范化后 + 账号 + 目录（三者任一变化 = 另一个库），用 JSON 数组序列化
 * （账号与路径里可能有分隔符 ⇒ 拼字符串会歧义 ⇒ 撞库 ⇒ 一个库的归属决定
 * 被另一个库继承 ⇒ 多传）。
 */
function expectedScopeKey(): string {
  const url = new URL(PROBE.baseUrl);
  let pathname = url.pathname || '/';
  if (!pathname.endsWith('/')) pathname += '/';
  const root = PROBE.rootPath.trim().replace(/^\/+|\/+$/g, '');
  return JSON.stringify([`${url.protocol}//${url.host}${pathname}`, PROBE.username, root]);
}

/** 装上「我跑在 service worker 里」的环境（Node 里没有 document，天然满足第二条）。 */
function enterServiceWorkerRealm(): void {
  (globalThis as Record<string, unknown>).ServiceWorkerGlobalScope = class FakeServiceWorkerGlobalScope {};
}

/** 装上「我是页面」的环境。 */
function leaveServiceWorkerRealm(): void {
  delete (globalThis as Record<string, unknown>).ServiceWorkerGlobalScope;
}

describe('待决位的作用域：页面与后台必须得出同一个答案', () => {
  let resolveCurrentLibraryScope: () => Promise<string>;
  let NO_LIBRARY_SCOPE: string;
  let setLibraryIdentityLoader: (loader: () => Promise<unknown>) => void;
  let currentLibraryScope: () => Promise<string>;
  let saveWebDavConfig: (cfg: {
    baseUrl: string;
    username: string;
    rootPath: string;
    encryption: 'plain';
  }) => Promise<void>;

  before(async () => {
    // 磁盘上摆好一个库（走产品自己的保存 API，不手抄键名）。
    const config = await import('@/sync-backend/webdav/config.ts');
    await config.saveWebDavConfig({
      baseUrl: PROBE.baseUrl,
      username: PROBE.username,
      rootPath: PROBE.rootPath,
      encryption: 'plain',
    });
    saveWebDavConfig = config.saveWebDavConfig as typeof saveWebDavConfig;

    const record = await import('@/storage-kv/firstSyncPendingRecord.ts');
    resolveCurrentLibraryScope = record.resolveCurrentLibraryScope;
    NO_LIBRARY_SCOPE = record.NO_LIBRARY_SCOPE;

    const identity = await import('@/sync-backend/webdav/libraryIdentity.ts');
    currentLibraryScope = identity.currentLibraryScope;

    const runtime = await import('@/sync-backend/webdav/libraryIdentityRuntime.ts');
    setLibraryIdentityLoader = runtime.setLibraryIdentityLoader as typeof setLibraryIdentityLoader;
  });

  it('页面 realm 算出来的作用域是磁盘上那个库的真值（不是兜底的 no-library）', async () => {
    leaveServiceWorkerRealm();
    const scope = await currentLibraryScope();
    assert.notEqual(
      scope,
      NO_LIBRARY_SCOPE,
      '页面 realm 算不出「本机当前指向哪个库」⇒ 现场不对，后面的判据会失真'
    );
    assert.equal(scope, expectedScopeKey());
  });

  it('SW realm 里算作用域必须经由注册进来的加载器（SW 自己 import 不了模块）', async () => {
    const sentinel = 'scope-from-registered-loader';
    let loaderCalls = 0;
    setLibraryIdentityLoader(async () => {
      loaderCalls += 1;
      // 只提供被用到的那一个函数（其余成员用不到）。
      return { currentLibraryScope: async () => sentinel } as unknown as Awaited<
        ReturnType<typeof import('@/sync-backend/webdav/libraryIdentityRuntime.ts')['loadLibraryIdentity']>
      >;
    });
    enterServiceWorkerRealm();
    try {
      const scope = await resolveCurrentLibraryScope();
      assert.equal(
        scope,
        sentinel,
        'SW realm 里的作用域不是注册进来的加载器给出的 ⇒ ' +
          '那条路径在真实 Chrome 里必然失败（service worker 里 import() 被禁止）⇒ ' +
          '后台永远算不出「本机在哪个库」⇒ 归属待决的判据整个换成分支。'
      );
      assert.ok(loaderCalls > 0, '注册进来的加载器一次都没被调用');
    } finally {
      leaveServiceWorkerRealm();
    }
  });

  it('SW realm 与页面 realm 算出的作用域必须相同', async () => {
    // 换成真模块（SW 入口注册的就是它）。
    const identity = await import('@/sync-backend/webdav/libraryIdentity.ts');
    setLibraryIdentityLoader(async () => identity);
    enterServiceWorkerRealm();
    let swScope: string;
    try {
      swScope = await resolveCurrentLibraryScope();
    } finally {
      leaveServiceWorkerRealm();
    }
    const pageScope = await currentLibraryScope();
    assert.equal(
      swScope,
      pageScope,
      '页面与后台对「本机当前在哪个库」给出了不同的答案 ⇒ ' +
        '同一份待决位在两边被读成两种意思 ⇒ 一边放行、一边拦住，' +
        '而用户看到的界面只反映其中一边。'
    );
    assert.notEqual(swScope, NO_LIBRARY_SCOPE);
  });
});
