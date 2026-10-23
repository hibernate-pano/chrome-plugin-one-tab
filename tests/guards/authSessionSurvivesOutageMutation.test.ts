/**
 * 变异自证：「云端不可用时本机会话不许被删掉」这条守卫必须真的看得见破口。
 *
 * ── 为什么必须自证 ────────────────────────────────────────────────────────
 * 这条守卫有**两个**可以恒绿的缝：
 *   ① 它验的是「会话还在」—— 而「会话还在」在「刷新压根没发生」与
 *      「刷新发生了但没删会话」两种情况下**都成立** ⇒ 只断言会话还在，
 *      主防线被拆掉时它照样绿。
 *   ② 它验的是「翻译还在」—— 而翻译是**一个函数** ⇒ 改它（改对或改坏）
 *      都不会让任何**类型**报错 ⇒ 只能靠「改了会不会红」来验。
 *
 * ⇒ 这里用三个方向证明它有检测力：
 *   ① **把兜底防线拆掉**（auth 端点上的状态码不再翻译）⇒ 必须变红
 *      （SDK 删会话 ⇒ 守卫的核心断言炸）；
 *   ② **把主防线拆掉**（探活判据不再判「不可用」）⇒ 必须变红
 *      （SDK 被问去刷新 ⇒ 守卫的「不许问刷新端点」断言炸）；
 *   ③ **把主防线的 IO 拆掉**（闸门不拦）⇒ 必须变红（同上，但坏在另一层）；
 *   ④ **等价的正确改写**（`includes` 换成 `some(s => s === status)`）⇒
 *      必须**仍然绿**（证明它判的是行为，不是长相）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/authSessionSurvivesOutage.test.ts';

/** 断言消息里的关键片段（守卫改了措辞时，这里要一起改）。 */
const SESSION_DELETED = '删掉用户的会话令牌';
const SDK_REFRESH_ASKED = '让 SDK 去刷新会话';

describe('变异自证：云端不可用时会话不许被删掉（这条守卫必须看得见破口）', () => {
  it('变异一：把「状态码翻译」拆掉（auth 端点不再翻译）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'auth 端点上的「服务端不可用」不再翻译',
        testFile: GUARD,
        targets: [
          {
            path: 'src/core/authSdkStatus.ts',
            mutate: source => {
              const anchor =
                '  if (UNAVAILABLE_STATUS_CODES.includes(status)) return TRANSIENT_STATUS_FOR_SDK;';
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到状态码翻译那一行');
              }
              // 变异：翻译消失 ⇒ SDK 把 402 当成「刷新令牌被拒」⇒ 删掉会话。
              return source.replace(anchor, '  // 变异：翻译被拆掉');
            },
          },
        ],
        expectRed: true,
        expectedFailure: SESSION_DELETED,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      true,
      '把 auth 端点上的「服务端不可用」翻译拆掉（SDK 于是会删掉用户的会话）',
    );
  });

  it('变异二：把「探活判据」拆掉（不再判「云端不可用」）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '探活判据恒判「在服务」',
        testFile: GUARD,
        targets: [
          {
            path: 'src/core/cloudAvailability.ts',
            mutate: source => {
              const anchor = `  UNAVAILABLE_STATUS_CODES.includes(status) || PROBE_KEY_REJECTED_STATUSES.includes(status)
    ? 'unavailable'
    : 'available';`;
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到可用性判据那一行');
              }
              // 变异：402 也判「在服务」⇒ 主防线形同虚设 ⇒ SDK 被问去刷新。
              return source.replace(
                anchor,
                "  'available' as 'available' | 'unavailable';",
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: SDK_REFRESH_ASKED,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      true,
      '把探活判据拆掉（云端不可用时不再拦 ⇒ SDK 会被问去刷新会话）',
    );
  });

  it('变异三：把「问一句」的闸门拆掉（不可用也不拦）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '闸门不再拦「云端不可用」',
        testFile: GUARD,
        targets: [
          {
            path: 'src/utils/supabase/cloudAvailability.ts',
            mutate: source => {
              const anchor = "  if (probe.kind === 'unavailable') {";
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到闸门那一行');
              }
              // 变异：闸门形同虚设 ⇒ 明知云端不服务也去让 SDK 刷新。
              return source.replace(anchor, "  if (false as boolean) {");
            },
          },
        ],
        expectRed: true,
        expectedFailure: SDK_REFRESH_ASKED,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      true,
      '把「问一句」的闸门拆掉（云端不可用时也去让 SDK 刷新会话）',
    );
  });

  it('变异四：等价的正确改写（`includes` → `some`）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '可用性判据的等价改写',
        testFile: GUARD,
        targets: [
          {
            path: 'src/core/cloudAvailability.ts',
            mutate: source => {
              const anchor = `  UNAVAILABLE_STATUS_CODES.includes(status) || PROBE_KEY_REJECTED_STATUSES.includes(status)
    ? 'unavailable'
    : 'available';`;
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到可用性判据那一行');
              }
              // 等价改写：行为一模一样，只是不用 `includes`。
              return source.replace(
                anchor,
                `  UNAVAILABLE_STATUS_CODES.some(s => s === status) || PROBE_KEY_REJECTED_STATUSES.some(s => s === status)
    ? 'unavailable'
    : 'available';`,
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
      '把可用性判据换成等价的正确写法（`includes` → `some`）',
    );
  });
});
