/**
 * 变异自证：「弹窗打开时不许加载 Supabase SDK」这条守卫必须真的看得见破口。
 *
 * ── 为什么必须自证 ────────────────────────────────────────────────────────
 * 这条守卫是**结构**的（看源码的调用图），而这类守卫最容易**恒绿**：
 * 算法算错一步（危险集算空了、闭包算漏了、挂载根识别错了），
 * 它照样一片绿 —— 而缺陷已经回来了。
 *
 * ⇒ 这里用四个方向证明它有检测力：
 *   ① **把缺陷放回去**（弹窗挂载时核登录态）⇒ 必须变红；
 *   ② **换个写法把缺陷放回去**（不写 `getCurrentUser`，直接调门面）⇒ 必须变红；
 *   ③ **改判据的算法**（让危险集算不出 `getCurrentUser`）⇒ 必须变红
 *      （这一条最要紧：它证明守卫抓的确实是「算出来的危险集」，
 *      而不是碰巧撞上了某个字面量）；
 *   ④ **等价的正确改写**（换个变量名 / 换个 hook 顺序）⇒ 必须**仍然绿**
 *      （证明它判的是行为，不是长相）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/popupDoesNotLoadSupabaseSdk.test.ts';

/** 变异一：把「弹窗挂载时核登录态」放回去（旧行为）。 */
const MUTATION_BACK_OLD_BEHAVIOR = `
  // 旧行为：挂载时自己联网核登录态（把整条 Supabase SDK 拉下来）。
  useEffect(() => {
    void (async () => {
      const { getCurrentUser } = await import('@/store/slices/authSlice');
      try {
        const user = await store.dispatch(getCurrentUser()).unwrap();
        if (user) {
          dispatch(setFromCache({ user, isAuthenticated: true }));
        }
      } catch (err) {
        logWarn('[auth] 核登录态失败:', err);
      }
    })();
  }, [dispatch]);
`;

/** 变异二：不写 `getCurrentUser`，直接调门面（绕过 thunk）。 */
const MUTATION_DIRECT_FACADE = `
  // 变异：直接调门面（一样会拉下来整条 SDK）。
  useEffect(() => {
    void (async () => {
      const { loadSupabaseFacade } = await import('@/utils/supabaseRuntime');
      const { auth } = await loadSupabaseFacade();
      const { data } = await auth.getSession();
      if (data.session?.user) {
        dispatch(setFromCache({ user: data.session.user, isAuthenticated: true }));
      }
    })();
  }, [dispatch]);
`;

describe('变异自证：弹窗不许加载 SDK 这条守卫必须看得见破口', () => {
  it('变异一：把「挂载时自己核登录态」放回去 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '弹窗挂载时自己核登录态',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/app/AuthProvider.tsx',
            mutate: source => {
              const anchor = '    initializeAuth();';
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到 initializeAuth 的调用点');
              }
              return source.replace(anchor, anchor + MUTATION_BACK_OLD_BEHAVIOR);
            },
          },
        ],
        expectRed: true,
        expectedFailure: '挂载路径',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让弹窗挂载时自己联网核登录态（拉下整条 SDK）');
  });

  it('变异二：不走 thunk，直接调门面 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '弹窗挂载时直接调门面',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/app/AuthProvider.tsx',
            mutate: source => {
              const anchor = '    initializeAuth();';
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到 initializeAuth 的调用点');
              }
              return source.replace(anchor, anchor + MUTATION_DIRECT_FACADE);
            },
          },
        ],
        expectRed: true,
        expectedFailure: '挂载路径',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让弹窗挂载时直接调 Supabase 门面');
  });

  it('变异三：把判据的算法改坏（危险集算不出 getCurrentUser）⇒ 守卫必须变红', () => {
    // ⚠️ 这一条最要紧：它证明守卫抓的是「**算出来的**危险集」，
    // 而不是碰巧撞上了某个字面量。
    // 如果危险集算空了，守卫会「全绿」——那正是「永远绿的守卫」，
    // 比没有守卫更坏。
    const [outcome] = runMutationCases([
      {
        name: '危险集算法坏了',
        testFile: GUARD,
        targets: [
          {
            path: 'tests/_helpers/facadeLoading.ts',
            mutate: source => {
              // 把「沿调用往外推」那一段掐断 ⇒ 危险集只剩那个根。
              const anchor = '        if (hit) {\n          addDanger(f, name);\n          changed = true;\n        }';
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到闭包推进的代码');
              }
              return source.replace(anchor, '        if (hit) {\n          /* 变异：不再传播 */\n        }');
            },
          },
        ],
        expectRed: true,
        // 红在「危险集推得够远」那条上（它断言 `getCurrentUser` 必须在危险集里）。
        expectedFailure: '危险集推得够远',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把危险集的闭包推进掐断（只留根）');
  });

  it('等价改写：换个变量名、换个顺序 ⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '等价改写',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/app/AuthProvider.tsx',
            mutate: source => {
              // 把 initializeAuth 改名、把 requestAuthStatus 换成别名 import ——
              // 行为一模一样，危险集与挂载路径也一模一样。
              const renamed = source
                .replace(/initializeAuth/g, 'bootstrapAuth')
                .replace(
                  "import { requestAuthStatus } from '@/utils/authStatusChannel';",
                  "import { requestAuthStatus as askSwForAuth } from '@/utils/authStatusChannel';",
                )
                .replace(/requestAuthStatus\(\)/g, 'askSwForAuth()');
              if (renamed === source) {
                throw new Error('变异没生效：源码没变');
              }
              return renamed;
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把弹窗里的函数与 import 改个名（行为一模一样）');
  });
});
