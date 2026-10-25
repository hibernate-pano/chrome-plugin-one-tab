/**
 * 登录成功后的回执：三种结果 ⇒ 三种不同的反馈（2026-10-22 审计 SC-6）。
 *
 * ── 缺陷本体 ──────────────────────────────────────────────────────────────
 *
 * `restoreAfterLogin` 原先只回一个**数字**，而
 * 「**拉回失败**」与「**云端本来就是空的**」都回 **0** ⇒ 两种 0 混成一种：
 *
 *   · `LoginForm`：`if (count > 0) showToast(…)` ⇒ **count === 0 时一句话都没有**；
 *   · `RegisterForm`：`void restoreAfterLogin(dispatch)` ⇒ 更是永远零反馈。
 *
 * ⇒ 用户登录成功、弹窗关闭、界面显示「已登录」，但**云端的会话一个都没回来**，
 * 而且**一句解释都没有**。用户会以为「云端的数据没了」。
 *
 * ── 这条守卫钉的是**不变量** ──────────────────────────────────────────────
 *
 *   ① **三种结果 ⇒ 三种不同的反馈**（拉到 N 个 / 云端为空 / 拉回失败）；
 *   ② **失败必须出声**（不许静默 —— 静默 = 用户以为数据没了）；
 *   ③ 「云端为空」**不是失败**（语气不能是错误级）。
 *
 * 另有一条诚实度判据：报的数字必须是**云端**的会话数，不是「合并后」的总��
 * （本机 30 个 + 云端 2 个 ⇒ 报「拉回 32 个」是夸大）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loginRestoreFeedback } from '@/components/auth/restoreFeedbackCopy';
import { restoreAfterLogin } from '@/components/auth/restoreAfterLogin';
import type { AppDispatch } from '@/store/hooks';
import type { CloudPullOutcome } from '@/domain/tabGroup/cloudPullCopy';

/** 假 dispatch：只需要「接得住一个 thunk 并 resolve」。 */
const fakeDispatch = (() => Promise.resolve([])) as unknown as AppDispatch;

describe('SC-6 判据层：三种结果 ⇒ 三种不同的反馈', () => {
  it('拉到 N 个 / 云端为空 / 拉回失败 ⇒ 三句**不同**的话', () => {
    const pulled = loginRestoreFeedback({ kind: 'pulled', count: 3 });
    const empty = loginRestoreFeedback({ kind: 'empty' });
    const failed = loginRestoreFeedback({ kind: 'failed' });
    const texts = [pulled.text, empty.text, failed.text];
    for (const text of texts) {
      assert.ok(text.trim().length > 0, '每种结果都必须有一句能看的话');
    }
    assert.equal(
      new Set(texts).size,
      3,
      `三种结果必须是三句不同的话（混成一句 = 谎报），实际：${texts.join(' | ')}`
    );
  });

  it('失败必须出声（不许静默 —— 静默 = 用户以为云端的数据没了）', () => {
    const failed = loginRestoreFeedback({ kind: 'failed', reason: 'not_authenticated' });
    assert.ok(failed.text.trim().length > 0, '失败必须有一句能看的话');
    assert.equal(failed.tone, 'error', '失败必须是错误语气');
  });

  it('「云端为空」**不是失败**（语气不能是错误级）', () => {
    const empty = loginRestoreFeedback({ kind: 'empty' });
    assert.equal(empty.tone, 'info', '云端本来就是空的 ⇒ 不是错误，是一条提示');
  });

  it('拉到东西 ⇒ 中性语气（成功是状态不是事件，提示层没有成功这一档）', () => {
    assert.equal(loginRestoreFeedback({ kind: 'pulled', count: 2 }).tone, 'info');
  });
});

describe('SC-6 行为层：restoreAfterLogin 必须把三种结果分开报', () => {
  it('下载失败 ⇒ 如实报 failed（不是 0、不是 empty）', async () => {
    const outcome = await restoreAfterLogin(fakeDispatch, {
      download: async () => ({ ok: false, error: 'not_authenticated' }),
      scheduleNotice: () => undefined,
    });
    assert.equal(outcome.kind, 'failed');
  });

  it('下载成功但云端为空 ⇒ empty', async () => {
    const outcome = await restoreAfterLogin(fakeDispatch, {
      download: async () => ({ ok: true, payload: { groups: [], stats: { cloudCount: 0 } } }),
      scheduleNotice: () => undefined,
    });
    assert.equal(outcome.kind, 'empty');
  });

  it('下载成功且云端有 N 个 ⇒ pulled 且报出 N', async () => {
    const outcome = await restoreAfterLogin(fakeDispatch, {
      download: async () => ({
        ok: true,
        payload: { groups: [{ id: 'a' }, { id: 'b' }], stats: { cloudCount: 2 } },
      }),
      scheduleNotice: () => undefined,
    });
    assert.equal(outcome.kind, 'pulled');
    assert.equal(
      (outcome as Extract<CloudPullOutcome, { kind: 'pulled' }>).count,
      2,
      '必须报出真实条数'
    );
  });

  it('报的数字是**云端**的条数，不是「合并后」的总和（不许夸大）', async () => {
    // 云端 2 个，本机合并后 32 个 ⇒ 「拉回 2 个」才是真的。
    const outcome = await restoreAfterLogin(fakeDispatch, {
      download: async () => ({
        ok: true,
        payload: {
          groups: Array.from({ length: 32 }, (_, i) => ({ id: `g${i}` })),
          stats: { cloudCount: 2, localCount: 30, mergedCount: 32 },
        },
      }),
      scheduleNotice: () => undefined,
    });
    assert.equal(
      (outcome as Extract<CloudPullOutcome, { kind: 'pulled' }>).count,
      2,
      '本机 30 个 + 云端 2 个 ⇒ 报「拉回 32 个」是夸大'
    );
  });

  it('下载命令本身抛异常 ⇒ 也是 failed（不许当成「云端为空」）', async () => {
    const outcome = await restoreAfterLogin(fakeDispatch, {
      download: async () => {
        throw new Error('boom');
      },
      scheduleNotice: () => undefined,
    });
    assert.equal(outcome.kind, 'failed');
  });
});
