/**
 * 归属账本与本机会话**同生共死**（2026-10-24 · 数据安全审计 **DS-43-20** 收口）。
 *
 * ── 这个文件防的具体事故 ──────────────────────────────────────────────────
 *
 * DS-43-20 抓到一条**条件性 P0**：跨账号泄露的原始后果被完整重开。
 *
 * 事实链（本机的三个事实，缺一不可）：
 *
 * 1. **本机会话的归属账本**（记着「这台机器上的每个会话归哪个账号」）
 *    落在 `chrome.storage.local` 的独立键 `local_account_scope` 里
 *    （当时的 `src/utils/authCache.ts`）；
 * 2. **会话本体在 IndexedDB**（KV 层）—— 与 (1) **各活各的**，两个库的生命周期
 *    彼此独立；
 * 3. `decideAccountBind` 的 **first-bind** 分支（账本里没有归属账号）会把
 *    **本机现有会话直接认领给新登录的账号**（`src/core/accountScope.ts`）。
 *
 * ⇒ 只要有人整片清空 `chrome.storage.local`：
 *   归属账本没了（ownerUserId 变 null），会话还在（IndexedDB 没动）
 *   ⇒ 下一次登录走 first-bind ⇒ **这台机器上残留的会话被静默认领给新账号**
 *   ⇒ 上一账号的会话被上传到新账号的云端 ⇒ **跨账号泄露**。
 *
 * ── 修法（结构性，不是打补丁）────────────────────────────────────────────
 *
 * **把归属账本搬进 KV 层，与本机会话存在同一个库里** ⇒ 「会话还在 ⇒ 账本还在」
 * 成为**结构事实**，那个窗口就不存在了：
 *
 *   · 清 `chrome.storage.local`（浏览器清扩展数据、或任何新增的「重置一切」
 *     路径）**动不了它** —— 登录态与云盘凭据还在那儿，会话也就还在；
 *   · 「清除本地数据」（`storage.clear()`，键清单由 `Object.values(STORAGE_KEYS)`
 *     派生）会把两者**一起**清掉 —— 那时会话也没了，无可归属，不亏。
 *
 * 另外补上**证据判据**（第二道防线）：账本**万一**不在（存储事故、迁移没搬
 * 过来）而本机还有会话时，用「这台机器上次登录的是谁」（登录缓存）这条外部
 * 证据区分「第一次绑定」与「账本丢了」—— 前者才认领，后者按「换账号」处理
 * （旧会话认账给上一个账号 + 明确告知用户），**绝不静默认领**。
 *
 * ── 为什么钉的是**行为**，不是字面量 ─────────────────────────────────────
 *
 * 钉「源码里出现过某个键名」这种字面量，等价于钉「今天的实现长这样」：
 * 把账本搬去第三个地方，它照样绿，而事故照旧。本文件钉的是三条**可观察的
 * 事实**：
 *
 *   ① 整片清掉 `chrome.storage.local` 之后，**归属账本还在**（读得到、
 *      内容不变）；
 *   ② 「清除本地数据」之后，**账本与会话一起没了**（不是各活各的）；
 *   ③ 升级前的旧形态（账本在 chrome.storage.local）会被**一次性搬进 KV**，
 *      搬完把旧键删掉（否则「清除本地数据」之后它会复活）。
 *
 * ── 自证检测力（每条都实测过：改坏实现 ⇒ 对应用例变红）────────────────
 *
 *   M1 把账本写回 chrome.storage.local（旧位置）⇒ ① 变红
 *   M2 「清除本地数据」只清会话、不清账本 ⇒ ② 变红
 *   M3 不做升级前的一次性搬运（旧键原样留着）⇒ ③ 变红
 *   M4 搬进 KV 之后不删旧键 ⇒ ③ 变红（旧键会把账本复活）
 *   M5 认账时不带证据 ⇒ first-bind 静默认领那条变红
 *   M6 把证据当权威（忽略账本里的 ownerUserId）⇒ 换账号那条变红
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { decideAccountBind, type AccountScopeRecord } from '@/core/accountScope';
import { installKvEnv } from '../_helpers/kvEnv.ts';

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '../_alias-loader.mjs')
).href;


/** 归属账本的键名（KV 层与旧位置同名 ⇒ 升级前后的数据可以直接对上位）。 */
const LEDGER_KEY = 'local_account_scope';

describe('DS-43-20：归属账本与本机会话同生共死（行为）', () => {
  let kv: ReturnType<typeof installKvEnv>;
  let chromeData: Map<string, unknown>;

  before(() => {
    register(LOADER_PATH);
  });

  beforeEach(() => {
    kv = installKvEnv();
    kv.reset();
    chromeData = new Map<string, unknown>();
    (globalThis as Record<string, unknown>).chrome = {
      storage: {
        local: {
          get: async (k: string | string[]) => {
            const keys = Array.isArray(k) ? k : [k];
            const out: Record<string, unknown> = {};
            for (const key of keys) if (chromeData.has(key)) out[key] = chromeData.get(key);
            return out;
          },
          set: async (obj: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(obj)) chromeData.set(k, v);
          },
          remove: async (k: string | string[]) => {
            for (const key of Array.isArray(k) ? k : [k]) chromeData.delete(key);
          },
          clear: async () => {
            chromeData.clear();
          },
        },
        onChanged: { addListener: () => undefined, removeListener: () => undefined },
      },
      runtime: { getManifest: () => ({ version: 'test' }) },
    };
  });

  it('① 整片清掉 chrome.storage.local 之后，归属账本还在（内容不变）', async () => {
    const { accountScopeStore } = await import('@/utils/authCache');
    await accountScopeStore.write({
      ownerUserId: 'user-A',
      foreignOwners: { 'g-a1': 'user-A' },
      pendingNotice: null,
    });

    // 触发 DS-43-20 的那个动作：整片清空 chrome.storage.local。
    const chromeStub = (globalThis as Record<string, unknown>).chrome as {
      storage: { local: { clear: () => Promise<void> } };
    };
    await chromeStub.storage.local.clear();
    assert.equal(chromeData.size, 0, '前提：chrome.storage.local 真的被清空了');

    const record = await accountScopeStore.read();
    assert.ok(record, '归属账本必须活过 chrome.storage.local 的清空 —— 账本没了而会话还在 ⇒ 下一次登录静默认领 ⇒ 跨账号泄露');
    assert.equal(record?.ownerUserId, 'user-A');
    assert.deepEqual(record?.foreignOwners, { 'g-a1': 'user-A' });
  });

  it('② 「清除本地数据」把账本与会话一起清掉（两者不是各活各的）', async () => {
    const { accountScopeStore } = await import('@/utils/authCache');
    const { storage } = await import('@/utils/storage');
    await accountScopeStore.write({
      ownerUserId: 'user-A',
      foreignOwners: {},
      pendingNotice: null,
    });
    await storage.setGroupsImmediate([
      { id: 'g-a1', name: '会话 1', tabs: [], createdAt: '', updatedAt: '', isLocked: false },
    ] as never);

    await storage.clear();

    assert.equal(await accountScopeStore.read(), null, '账本必须跟会话一起没（不是各活各的）');
    const groups = await storage.getGroups();
    assert.equal(groups.length, 0, '会话必须被清掉');
  });

  it('③ 升级前的旧形态（账本在 chrome.storage.local）会被一次性搬进 KV，旧键被删掉', async () => {
    // 升级前的老用户：账本在 chrome.storage.local 的独立键里。
    chromeData.set(LEDGER_KEY, {
      ownerUserId: 'user-A',
      foreignOwners: { 'g-a1': 'user-A' },
      pendingNotice: null,
    });

    const { accountScopeStore } = await import('@/utils/authCache');
    const record = await accountScopeStore.read();

    assert.equal(record?.ownerUserId, 'user-A', '旧账本必须被搬到新位置（否则老用户的归属事实全丢 ⇒ 全被当成本机无主）');
    const stored = kv.read(LEDGER_KEY) as { ownerUserId?: string } | undefined;
    assert.equal(
      stored?.ownerUserId,
      'user-A',
      '搬完之后账本必须真的在 KV 层'
    );
    assert.equal(
      chromeData.has(LEDGER_KEY),
      false,
      '旧键必须被删掉 —— 留着它，「清除本地数据」之后它会把账本复活（会话已经没了，账本还在）'
    );
  });
});

describe('DS-43-20：认账判据（账本不在时的证据）', () => {
  it('账本有主人时，账本说了算（证据不得盖过权威）', () => {
    const scope: AccountScopeRecord = {
      ownerUserId: 'user-A',
      foreignOwners: {},
      pendingNotice: null,
    };
    const d = decideAccountBind(scope, 'user-B', ['g1', 'g2'], Date.now(), [], {
      lastKnownUserId: 'user-C',
    });
    assert.equal(d.kind, 'account-switch');
    assert.equal(d.previousUserId, 'user-A', '账本里的主人是权威 —— 证据只是账本缺位时的兜底');
    assert.equal(d.residualCount, 2);
    assert.ok(d.notice, '换账号且本机有旧会话时必须给用户提示（静默认领是跨账号泄露）');
  });

  it('账本没有主人、但这台机器明明登录过别的账号 ⇒ 按「换账号」处理，不静默认领', () => {
    // 这就是 DS-43-20 的现场：账本没了，会话还在，而这台机器上次登录的是 A。
    const scope: AccountScopeRecord = {
      ownerUserId: null,
      foreignOwners: {},
      pendingNotice: null,
    };
    const d = decideAccountBind(scope, 'user-B', ['g1', 'g2'], Date.now(), [], {
      lastKnownUserId: 'user-A',
    });
    assert.equal(d.kind, 'account-switch', '有证据 ⇒ 不是第一次绑定');
    assert.equal(d.previousUserId, 'user-A');
    assert.equal(d.residualCount, 2, '两条会话都属于上一个账号 ⇒ 它们不会被新账号带走');
    assert.ok(d.notice, '必须明确告诉用户：本机还有 N 个会话不会上传到当前账号');
    assert.deepEqual(
      d.nextScope.foreignOwners,
      { g1: 'user-A', g2: 'user-A' },
      '旧会话必须认账给上一个账号（否则下一次上传会把它们写进新账号的云端）'
    );
  });

  it('账本没有主人、这台机器**从没有过**被记下的账号 ⇒ 就是第一次绑定，照常认领', () => {
    // 「没用账号用过扩展、后来才注册」的正常路径：不能被这条守卫误伤。
    const scope: AccountScopeRecord = {
      ownerUserId: null,
      foreignOwners: {},
      pendingNotice: null,
    };
    const d = decideAccountBind(scope, 'user-B', ['g1', 'g2'], Date.now(), [], {
      lastKnownUserId: null,
    });
    assert.equal(d.kind, 'first-bind');
    assert.equal(d.residualCount, 0, '没有上一个账号 ⇒ 不得报出残留会话数');
    assert.equal(d.previousOwnedCount, 0);
    assert.equal(d.notice, null, '没有上一个账号 ⇒ 不得弹出「上一个账号还剩 N 个」');
    assert.equal(d.nextScope.ownerUserId, 'user-B');
  });

  it('自证检测力：把「带证据的认账」退化成「无证据的认账」，上面那条必须变红', () => {
    const scope: AccountScopeRecord = {
      ownerUserId: null,
      foreignOwners: {},
      pendingNotice: null,
    };
    // 破口替身：证据被忽略 ⇒ 一律走 first-bind ⇒ 静默认领。
    const broken = decideAccountBind(scope, 'user-B', ['g1'], Date.now(), []);
    assert.equal(broken.kind, 'first-bind', '破口成立：不带证据就没有换账号判定');
    assert.equal(
      broken.residualCount,
      0,
      '破口成立：本机会话被静默认领给新账号（DS-1 的跨账号泄露原样复发）'
    );

    // 正控：带上证据 ⇒ 必须走换账号口径。
    const fixed = decideAccountBind(scope, 'user-B', ['g1'], Date.now(), [], {
      lastKnownUserId: 'user-A',
    });
    assert.equal(fixed.kind, 'account-switch', '正控：带证据就必须按换账号处理');
  });
});
