/**
 * 变异自证：归属账本与本机会话「同生共死」的守卫
 * （tests/guards/accountScopeLedgerNotWipeable.test.ts）必须**看得见破口**。
 *
 * 沙箱的做法见 `tests/_helpers/mutationSandbox.ts`（复制一份仓库 → 在副本上变异
 * → 跑守卫本身 ⇒ 「守卫变红」由守卫自己给出，不需要第二份实现）。
 *
 * ── 这几条分别证明什么 ────────────────────────────────────────────────────
 *
 *   M1 **账本写回 chrome.storage.local**（回到 DS-43-20 的老位置）
 *      ⇒ 守卫必须变红：证明「整片清空 chrome.storage.local 之后账本还在」
 *      这条性质有检测力（老位置 = 那个 P0 的本体）。
 *
 *   M2 **「清除本地数据」只清会话、不清账本**（两者又变成各活各的）
 *      ⇒ 守卫必须变红：证明「账本与会话一起没」这条不变量有检测力。
 *
 *   M3 **不做升级前的一次性搬运**（旧键原样留着，不进 KV）
 *      ⇒ 守卫必须变红：证明「老用户的归属事实被搬进新位置」有检测力
 *      （不搬 ⇒ 老用户的账本读不到 ⇒ 全被当成本机无主 ⇒ 又是一次认领）。
 *
 *   M4 **搬进 KV 之后不删旧键**
 *      ⇒ 守卫必须变红：证明「旧键必须删掉」有检测力（留着它 ⇒
 *      「清除本地数据」之后账本被复活，而会话已经没了）。
 *
 *   M5 **认账时忽略外部证据**（只用账本里的 ownerUserId）
 *      ⇒ 守卫必须变红：证明「账本不在时用『这台机器上次登录的是谁』这条
 *      证据区分『第一次绑定』与『账本丢了』」有检测力。
 *
 *   M6 **把证据当权威**（忽略账本里的 ownerUserId）
 *      ⇒ 守卫必须变红：证明「账本优先于证据」这条不变量有检测力。
 *
 *   M7 **等价改写**（认账时把「读证据」写成内联对象，而不是调那个helper）
 *      ⇒ 守卫必须**仍然绿**。这一条决定守卫能不能长期活着：判据钉的是
 *      **行为**（判定的结果），不是「源码长什么样」⇒ 等价写法不该误报。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/accountScopeLedgerNotWipeable.test.ts';
const AUTH_CACHE = 'src/utils/authCache.ts';
const STORAGE = 'src/utils/storage.ts';
const SCOPE = 'src/core/accountScope.ts';
const AUTH_SLICE = 'src/store/slices/authSlice.ts';

describe('变异自证：归属账本与本机会话同生共死（DS-43-20）', () => {
  it('破口一：账本写回 chrome.storage.local（回到老位置）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '账本回到 chrome.storage.local',
        testFile: GUARD,
        targets: [
          {
            path: AUTH_CACHE,
            mutate: source => {
              const readOld =
                '    const raw = await kvGet<unknown>(STORAGE_KEYS.ACCOUNT_SCOPE);';
              if (!source.includes(readOld)) {
                throw new Error('变异前提没成立：找不到账本的 KV 读');
              }
              const writeOld = `  async write(record: AccountScopeRecord): Promise<void> {
    await kvSet(STORAGE_KEYS.ACCOUNT_SCOPE, record);
  },`;
              if (!source.includes(writeOld)) {
                throw new Error('变异前提没成立：找不到账本的 KV 写');
              }
              return source
                .replace(
                  readOld,
                  '    const raw = (await chrome.storage.local.get(LEGACY_ACCOUNT_SCOPE_KEY))[LEGACY_ACCOUNT_SCOPE_KEY] ?? null;',
                )
                .replace(
                  writeOld,
                  `  async write(record: AccountScopeRecord): Promise<void> {
    await chrome.storage.local.set({ [LEGACY_ACCOUNT_SCOPE_KEY]: record });
  },`,
                );
            },
          },
        ],
        expectRed: true,
        expectedFailure: '归属账本必须活过 chrome.storage.local 的清空',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把账本写回 chrome.storage.local（回到 DS-43-20 的老位置）');
  });

  it('破口二：「清除本地数据」只清会话、不清账本 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'clear() 不清归属账本',
        testFile: GUARD,
        targets: [
          {
            path: STORAGE,
            mutate: source => {
              const old = '      const keys = Object.values(STORAGE_KEYS);';
              if (!source.includes(old)) {
                throw new Error('变异前提没成立：找不到 clear() 的键清单');
              }
              return source.replace(
                old,
                "      const keys = Object.values(STORAGE_KEYS).filter(k => k !== 'local_account_scope');",
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: '账本必须跟会话一起没',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让「清除本地数据」只清会话、不清账本');
  });

  it('破口三：不做升级前的一次性搬运 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '旧键不再搬进 KV',
        testFile: GUARD,
        targets: [
          {
            path: AUTH_CACHE,
            mutate: source => {
              const old = `    const legacy = await readLegacyAccountScope();
    if (legacy === null) return null;`;
              if (!source.includes(old)) {
                throw new Error('变异前提没成立：找不到升级前的一次性搬运');
              }
              return source.replace(
                old,
                `    const legacy: unknown | null = null;
    if (legacy === null) return null;`,
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: '旧账本必须被搬到新位置',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '去掉升级前的一次性搬运');
  });

  it('破口四：搬进 KV 之后不删旧键 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '旧键留着不删',
        testFile: GUARD,
        targets: [
          {
            path: AUTH_CACHE,
            mutate: source => {
              const old = '    await removeLegacyAccountScope();';
              if (!source.includes(old)) {
                throw new Error('变异前提没成立：找不到删旧键的那一行');
              }
              return source.replace(old, '    // 变异：故意不删旧键');
            },
          },
        ],
        expectRed: true,
        expectedFailure: '旧键必须被删掉',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '搬进 KV 之后不删旧键（账本会被复活）');
  });

  it('破口五：认账时忽略外部证据 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '认账不看证据',
        testFile: GUARD,
        targets: [
          {
            path: SCOPE,
            mutate: source => {
              const old =
                '  const previousUserId = scope.ownerUserId ?? evidence?.lastKnownUserId ?? null;';
              if (!source.includes(old)) {
                throw new Error('变异前提没成立：找不到「上一个账号」的判定');
              }
              return source.replace(old, '  const previousUserId = scope.ownerUserId;');
            },
          },
        ],
        expectRed: true,
        expectedFailure: '有证据 ⇒ 不是第一次绑定',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让认账忽略「这台机器上次登录的是谁」这条证据');
  });

  it('破口六：把证据当权威（忽略账本里的主人）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '证据盖过账本',
        testFile: GUARD,
        targets: [
          {
            path: SCOPE,
            mutate: source => {
              const old =
                '  const previousUserId = scope.ownerUserId ?? evidence?.lastKnownUserId ?? null;';
              if (!source.includes(old)) {
                throw new Error('变异前提没成立：找不到「上一个账号」的判定');
              }
              return source.replace(
                old,
                '  const previousUserId = evidence?.lastKnownUserId ?? scope.ownerUserId ?? null;',
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: '账本里的主人是权威',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让证据盖过账本里的主人');
  });

  it('等价改写：把「读证据」写成内联对象 ⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '内联读证据',
        testFile: GUARD,
        targets: [
          {
            path: AUTH_SLICE,
            mutate: source => {
              const old = '    const evidence = await readAccountBindEvidence();';
              if (!source.includes(old)) {
                throw new Error('变异前提没成立：找不到读证据的那一行');
              }
              return source.replace(
                old,
                '    const evidence = { lastKnownUserId: await readLastAuthCacheUserId() };',
              );
            },
          },
          {
            path: AUTH_SLICE,
            mutate: source => {
              const old =
                "import { accountScopeStore, authCache, readAccountBindEvidence } from '@/utils/authCache';";
              if (!source.includes(old)) {
                throw new Error('变异前提没成立：找不到 authCache 的 import');
              }
              return source.replace(
                old,
                "import {\n  accountScopeStore,\n  authCache,\n  readAccountBindEvidence,\n  readLastAuthCacheUserId,\n} from '@/utils/authCache';",
              );
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把读证据换成等价的内联写法');
  });
});
