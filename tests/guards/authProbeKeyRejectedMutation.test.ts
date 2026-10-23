/**
 * 变异自证：「网关拒了我们的 apikey」这一族（2026-10-23，第 51 轮）。
 *
 * ── 为什么这一族必须单独自证 ──────────────────────────────────────────────
 * 这一族的判据有三处，**每一处都是「改对了反而红」的陷阱**：
 *   ① `core/cloudAvailability.ts`：探活拿到 401/403 ⇒ 判「云端不可用」；
 *   ② `core/authSdkStatus.ts`：刷新端点上的 401/403（**不是** GoTrue 自己的
 *      判决）⇒ 翻译成 SDK 眼里的「瞬时故障」；
 *   ③ `utils/supabase/client.ts`：客户端**惰性创建**（建客户端 = 一次刷新
 *      请求 ⇒ 它必须晚于探活闸门）。
 *
 * ⇒ 三条都要证明「改坏 ⇒ 红；等价改写 ⇒ 绿」，否则它们可能一直是绿的
 *   而什么也没守住。
 *
 * ── 仓库既有约定 ──────────────────────────────────────────────────────────
 * 守卫只放**性质断言**，变异自证单独成文件 ——
 * 沙箱会把整个 `tests/` 拷一份再跑守卫，若守卫自己调用 `runMutationCases`，
 * 沙箱里的那份会再开一个沙箱 ⇒ 无限递归。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

/** 被验的守卫（401/403 这一族的行为层）。 */
const GUARD_401 = 'tests/guards/authProbeKeyRejected.test.ts';
/** 被验的守卫（判据层：翻译规则）。 */
const GUARD_JUDGMENT = 'tests/guards/authSessionSurvivesOutage.test.ts';

/** 断言消息里的关键片段（守卫改了措辞时，这里要一起改）。 */
const NO_REFRESH_REQUEST = '云端的 key 被拒时**不许**让 SDK 去刷新会话';
const SESSION_MUST_SURVIVE = 'key 被拒时**不许**删掉用户的会话令牌';
const GOTRUE_VERDICT_KEEPS_401 = 'GoTrue 自己判的 401（body 里有 error 字段）不许被翻译';

describe('变异自证：「网关拒了我们的 apikey」这一族（守卫必须看得见破口）', () => {
  it('变异一：把探活的 401/403 规则拆掉 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '探活不再把 401/403 判成「云端不可用」',
        testFile: GUARD_401,
        targets: [
          {
            path: 'src/core/cloudAvailability.ts',
            mutate: source => {
              const anchor =
                '  UNAVAILABLE_STATUS_CODES.includes(status) || PROBE_KEY_REJECTED_STATUSES.includes(status)';
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到判据那一行');
              }
              // 变异：401/403 又被判成「在服务」⇒ 闸门放行 ⇒ SDK 被建出来
              // ⇒ 它自己去刷新 ⇒ 刷新撞上 401 ⇒ 会话被删。
              return source.replace(anchor, '  UNAVAILABLE_STATUS_CODES.includes(status)');
            },
          },
        ],
        expectRed: true,
        expectedFailure: NO_REFRESH_REQUEST,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      true,
      '把「探活拿到 401/403 ⇒ 云端不可用」的判据拆掉（于是闸门放行、SDK 去刷新、会话被删）',
    );
  });

  it('变异二：把「客户端惰性创建」拆掉（改回建好客户端）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '模块加载时就把客户端建出来',
        testFile: GUARD_401,
        targets: [
          {
            path: 'src/utils/supabase/client.ts',
            mutate: source => {
              const anchor = `    return typeof value === 'function' ? value.bind(client) : value;
  },
});`;
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到惰性创建那一段');
              }
              // 变异：模块一被加载就把客户端建出来 ⇒ auth-js 的 initialize()
              // ⇒ _recoverAndRefresh() ⇒ 本地会话过期就**立刻**发一次刷新请求
              // ⇒ 而那一次发生在探活闸门**之前** ⇒ 闸门再也拦不住它。
              //
              // ⚠️ 必须插在**模块最末尾**：插在中间会撞 TDZ
              // （`fetchWithTimeout` 等 const 还没初始化 ⇒ 模块一加载就抛
              // ⇒ 守卫红在「压根没跑到」上 ⇒ 那是**假红**，不是检测力）。
              return source.replace(anchor, `${anchor}
// 变异：模块一被加载就把客户端建出来（= 旧行为）
void getSupabaseClient();`);
            },
          },
        ],
        expectRed: true,
        expectedFailure: NO_REFRESH_REQUEST,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      true,
      '把「客户端惰性创建」拆掉（于是建客户端时那一次刷新请求发生在闸门之前 ⇒ 会话被删）',
    );
  });

  it('变异三：把刷新端点上的 401/403 翻译拆掉 ⇒ 守卫必须变红（会话会真的被删）', () => {
    const [outcome] = runMutationCases([
      {
        name: '刷新端点上的 401/403 不再翻译',
        testFile: GUARD_401,
        targets: [
          {
            path: 'src/core/authSdkStatus.ts',
            mutate: source => {
              const anchor =
                '  if (\n    (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) &&\n    isRefreshEndpoint(url) &&\n    !hasGoTrueErrorField(body)\n  ) {\n    return TRANSIENT_STATUS_FOR_SDK;\n  }';
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到 401/403 翻译那一段');
              }
              // 变异：不再翻译 ⇒ auth-js 把 401 当成「服务端明确拒绝」
              // ⇒ 访问令牌已过期 ⇒ _removeSession() ⇒ **用户的会话被删掉**。
              return source.replace(
                anchor,
                '  if (false as boolean) {\n    return TRANSIENT_STATUS_FOR_SDK;\n  }',
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: SESSION_MUST_SURVIVE,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      true,
      '把「刷新端点上的 401/403（不是 GoTrue 判决）⇒ 翻译成瞬时故障」拆掉（于是会话被删）',
    );
  });

  it('变异四：把「GoTrue 判决 vs 网关判决」的区分拆掉 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '刷新端点上的 401/403 一律翻译（不看 body 里有没有 GoTrue 的机器字段）',
        testFile: GUARD_JUDGMENT,
        targets: [
          {
            path: 'src/core/authSdkStatus.ts',
            mutate: source => {
              const anchor = '    !hasGoTrueErrorField(body)';
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到 GoTrue 判决那一处');
              }
              // 变异：不问 body ⇒ GoTrue 自己判的「刷新令牌被拒」也被翻译成
              // 「瞬时故障」⇒ 用户永远看不到「请重新登录」⇒ 会话明明死了
              // 却一直说「等我们恢复」。
              return source.replace(anchor, '    true');
            },
          },
        ],
        expectRed: true,
        expectedFailure: GOTRUE_VERDICT_KEEPS_401,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      true,
      '把「GoTrue 自己的判决不许被翻译」拆掉（于是会话真的死了也说「等我们恢复」）',
    );
  });

  it('变异五：等价的正确改写（`||` → 拼成数组）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '可用性判据的等价改写',
        testFile: GUARD_401,
        targets: [
          {
            path: 'src/core/cloudAvailability.ts',
            mutate: source => {
              const anchor =
                '  UNAVAILABLE_STATUS_CODES.includes(status) || PROBE_KEY_REJECTED_STATUSES.includes(status)';
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到判据那一行');
              }
              return source.replace(
                anchor,
                '  [...UNAVAILABLE_STATUS_CODES, ...PROBE_KEY_REJECTED_STATUSES].includes(status)',
              );
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      false,
      '把可用性判据换一种**等价**写法（`||` → 拼数组）',
    );
  });
});
