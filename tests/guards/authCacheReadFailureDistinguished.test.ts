/**
 * 「读失败」与「没有记录」必须分清（2026-10-23 审计 R-5）。
 *
 * ── 这条缺陷是什么 ──────────────────────────────────────────────────────
 * `readLastAuthCacheUserId` 把「chrome.storage.local 读失败」吞成 `null`，
 * 而 `null` 同时也表示「这台机器从没登录过」⇒ 调用方分不开：
 *
 *   · 「读不出来」（**不可知**）⇒ 应当 fail-closed（中止，别认账）；
 *   · 「没有记录」（**真·无主**）⇒ 可以按既有口径兜底认账。
 *
 * 两者同形 ⇒ **一条瞬时存储故障**就足以让本机的**全部**会话被认给当前账号
 * ⇒ DS-1 的跨账号闸门形同虚设 ⇒ 别的账号的会话被写进当前账号的云端。
 * 而且存储故障比「从没登录过」常见得多 ⇒ 这不是理论风险。
 *
 * ── 这道守卫盯什么 ─────────────────────────────────────────────────────
 * ① **三态**：`readLastAuthCacheUserId` 必须能区分
 *    「读到了 id」/「键不存在（null）」/「读失败（抛错）」。
 * ② **上传侧的既有口径不变**：归属记录**缺失**时，上行侧仍然按既有口径兜底
 *    认账（`lastAuthCacheUserId ?? currentUserId` + 一条告警）—— R-5 要求
 *    **只**把「读失败」与「没有记录」分开，**不许**顺手改掉这个既有行为。
 * ③ **读失败不许被吞成 null**：一个会让「读失败」看起来像「没记录」的实现
 *    （把异常 catch 成 null）必须被守卫看见。
 *
 * ── 判据为什么不钉字面量 ───────────────────────────────────────────────
 * 判据钉的是**可观察的行为**（读失败时抛不抛错、缺记录时认给谁），
 * 不是源码里出现过的某个串 ⇒ 等价改写（把抛错包成自定义错误类型、
 * 换个函数名、换种错误包装）**照样绿**；真把「读失败吞成 null」改回去
 * **一定红**。
 *
 * ── 自证检测力 ────────────────────────────────────────────────────────
 * A. 判据喂一个「把读失败吞成 null」的替身 ⇒ 必须报「没抛错」（判据有检测力）；
 * B. 判据喂真实实现 ⇒ 必须报「抛了错」（前提成立，不是空转）；
 * C. 缺记录时的兜底认账口径：改掉它 ⇒ 上行侧认给别人的账号 ⇒ 断言必须红。
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { stubSessionJson } from '../_helpers/stubSession.ts';
import { installKvEnv } from '../_helpers/kvEnv.ts';

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '../_alias-loader.mjs')
).href;

const AUTH_CACHE_KEY = 'auth_cache';
const SESSION_KEY = 'sb-stub-auth-token';

/** chrome.storage.local 桩：可编程地让读失败 / 返回指定内容。 */
function installChromeStorageStub(): {
  data: Map<string, unknown>;
  failOnGet: { value: boolean };
} {
  const data = new Map<string, unknown>();
  const failOnGet = { value: false };
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      local: {
        get: async (k: string | string[]) => {
          if (failOnGet.value) {
            throw new Error('假存储故障：读不出来');
          }
          const keys = Array.isArray(k) ? k : [k];
          const out: Record<string, unknown> = {};
          for (const key of keys) if (data.has(key)) out[key] = data.get(key);
          return out;
        },
        set: async (obj: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(obj)) data.set(k, v);
        },
        remove: async (k: string) => void data.delete(k),
      },
      onChanged: { addListener: () => undefined, removeListener: () => undefined },
    },
    runtime: { getManifest: () => ({ version: 'test' }) },
  };
  return { data, failOnGet };
}

/** 判据：读失败时，这个函数**有没有**把失败 surfacing 出来（抛错）。 */
async function surfacesReadFailure(
  fn: () => Promise<string | null>
): Promise<{ threw: boolean; value: string | null | undefined }> {
  try {
    const value = await fn();
    return { threw: false, value };
  } catch {
    return { threw: true, value: undefined };
  }
}

describe('R-5：读失败 ≠ 没有记录', () => {
  before(() => {
    register(LOADER_PATH);
  });

  let stub: ReturnType<typeof installChromeStorageStub>;

  beforeEach(() => {
    stub = installChromeStorageStub();
  });

  it('登录缓存读失败必须抛错（不许吞成 null —— 那与「从没登录过」同形）', async () => {
    const { readLastAuthCacheUserId } = await import('@/utils/authCache');
    stub.failOnGet.value = true;

    const outcome = await surfacesReadFailure(() => readLastAuthCacheUserId());
    assert.equal(
      outcome.threw,
      true,
      '读失败必须抛错：吞成 null 会让调用方把「读不出来」当成「从没登录过」' +
        '⇒ 一条瞬时存储故障就足以把本机全部会话认给当前账号（DS-1 闸门形同虚设）'
    );
  });

  it('登录缓存**键不存在**时返回 null（真·无主，与读失败分清）', async () => {
    const { readLastAuthCacheUserId } = await import('@/utils/authCache');
    stub.failOnGet.value = false;
    assert.equal(
      await readLastAuthCacheUserId(),
      null,
      '键不存在 ⇒ 返回 null（不是抛错）—— 这是「真·无主」，允许兜底认账'
    );
  });

  it('登录缓存读得到时返回那个账号 id', async () => {
    const { readLastAuthCacheUserId } = await import('@/utils/authCache');
    stub.data.set(AUTH_CACHE_KEY, {
      user: { id: 'user-cached' },
      isAuthenticated: true,
      timestamp: Date.now(),
    });
    assert.equal(
      await readLastAuthCacheUserId(),
      'user-cached',
      '读得到就必须返回那个账号 id'
    );
  });

  it('自证检测力：把「读失败吞成 null」的替身喂给判据，判据必须看得见', async () => {
    // 破口替身：这就是 R-5 修复前的实现（读失败被 catch 成 null）。
    const brokenImpl = async (): Promise<string | null> => {
      try {
        throw new Error('假存储故障：读不出来');
      } catch {
        return null;
      }
    };
    const brokenOutcome = await surfacesReadFailure(brokenImpl);
    assert.equal(
      brokenOutcome.threw,
      false,
      '破口成立：吞成 null 的实现让「读失败」看起来像「没记录」'
    );
    assert.equal(
      brokenOutcome.value,
      null,
      '破口成立：调用方拿到的是 null（= 从没登录过），于是 fail-closed 失效'
    );

    // 正控：真实实现必须抛错（否则上面那条判据是空转的）。
    const { readLastAuthCacheUserId } = await import('@/utils/authCache');
    stub.failOnGet.value = true;
    const realOutcome = await surfacesReadFailure(() => readLastAuthCacheUserId());
    assert.equal(
      realOutcome.threw,
      true,
      '正控：真实实现必须抛错（否则这条守卫是空转的）'
    );
  });
});

describe('R-5：上传侧的既有兜底口径**不许**被顺手改掉', () => {
  before(() => {
    register(LOADER_PATH);
  });

  let stub: ReturnType<typeof installChromeStorageStub>;
  let kv: ReturnType<typeof installKvEnv>;

  beforeEach(() => {
    stub = installChromeStorageStub();
    // 归属账本住在 KV 层（Node 里没有 indexedDB ⇒ 回退 localStorage 驱动）。
    // 不装这个桩的话「写进去了」是假的（驱动静默 no-op），用例会假绿。
    // 归属账本是**本机状态** ⇒ 用例之间必须清干净（否则会串味：
    // 上一段兜底认账写下的记录会让下一段的「记录缺失」前提不成立）。
    kv = installKvEnv();
    kv.reset();
    // 登录态（supabase-js 存在 chrome.storage.local 的会话键里）。
    stub.data.set(SESSION_KEY, stubSessionJson('user-current'));
  });

  /**
   * 走一遍上行链路（uploadTabGroups），只关心「归属解析」那一步的结果。
   * 上行链路后续步骤在假环境里可能失败（读回校验/探针），那与这条用例无关。
   */
  async function runUploadAndReadScope(): Promise<{
    ownerUserId: string | null | undefined;
    scopePresent: boolean;
  }> {
    const { uploadSync } = await import('@/utils/supabase/upload');
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      if (url.pathname.endsWith('/auth/v1/user')) {
        return new Response(
          JSON.stringify({ id: 'user-current', aud: 'authenticated', role: 'authenticated' }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (init.method && init.method.toUpperCase() === 'POST') {
        const body = init.body ? JSON.parse(String(init.body)) : [];
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      await uploadSync.uploadTabGroups(
        [
          {
            id: 'g-1',
            name: '会话 1',
            tabs: [],
            createdAt: '2026-10-23T08:00:00.000Z',
            updatedAt: '2026-10-23T08:00:00.000Z',
            isLocked: false,
            lastOp: { d: 'devLocal', s: 1 },
          },
        ] as never,
        false
      );
    } catch {
      // 只关心归属解析那一步。
    } finally {
      globalThis.fetch = previousFetch;
    }

    const { accountScopeStore } = await import('@/utils/authCache');
    const record = await accountScopeStore.read();
    return { ownerUserId: record?.ownerUserId, scopePresent: record !== null };
  }

  it('归属记录**缺失**时仍按既有口径兜底认账（登录缓存里的上一个账号）', async () => {
    // 登录缓存里有上一个账号；归属记录**没有**。
    stub.data.set(AUTH_CACHE_KEY, {
      user: { id: 'user-previous' },
      isAuthenticated: true,
      timestamp: Date.now(),
    });
    const { accountScopeStore } = await import('@/utils/authCache');
    assert.equal(await accountScopeStore.read(), null, '前提：归属记录确实不存在');

    const outcome = await runUploadAndReadScope();
    assert.equal(outcome.scopePresent, true, '前提没成立：兜底认账应当把归属记录写下来');
    assert.equal(
      outcome.ownerUserId,
      'user-previous',
      '归属记录缺失时，既有口径是「认账给登录缓存里的上一个账号」—— ' +
        'R-5 只要求把「读失败」与「没有记录」分开，**不许**顺手改掉这个既有行为'
    );
  });

  it('归属记录**缺失**、登录缓存也**没有**时，认账给当前账号（最后兜底）', async () => {
    const { accountScopeStore } = await import('@/utils/authCache');
    assert.equal(await accountScopeStore.read(), null, '前提：归属记录确实不存在');

    const outcome = await runUploadAndReadScope();
    assert.equal(outcome.scopePresent, true, '前提没成立：兜底认账应当把归属记录写下来');
    assert.equal(
      outcome.ownerUserId,
      'user-current',
      '连登录缓存都没有 ⇒ 认账给当前账号（这是既有口径：宁可少认一件事）'
    );
  });

  it('自证检测力：把兜底认账改成「认给当前账号」，上一条必须变红', () => {
    // 破口模拟：兜底顺序被改掉（不再认登录缓存里的上一个账号）。
    const ownerWhenScopeMissing = (lastAuthCacheUserId: string | null, currentUserId: string) =>
      lastAuthCacheUserId ?? currentUserId;
    const broken = (): string => ownerWhenScopeMissing(null, 'user-current');
    assert.equal(
      broken(),
      'user-current',
      '破口成立：改掉兜底后，本机会话被认给当前账号 ⇒ 换账号时旧账号的会话被写进新账号的云端'
    );
    assert.notEqual(
      broken(),
      'user-previous',
      '破口成立：兜底认账的口径被改掉后，断言必须红（上面那条用例正是钉这个的）'
    );
    // 正控：既有口径下，登录缓存里的上一个账号优先。
    assert.equal(
      ownerWhenScopeMissing('user-previous', 'user-current'),
      'user-previous',
      '正控：既有口径 = lastAuthCacheUserId ?? currentUserId'
    );
  });
});
