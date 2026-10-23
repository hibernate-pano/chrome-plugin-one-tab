/**
 * 变异自证：「云端状态」的判据守卫必须真的看得见破口（2026-10-23，第 51 轮）。
 *
 * ── 为什么必须自证 ────────────────────────────────────────────────────────
 * 这条守卫盯的三条判据都藏在**函数**里：把它们改坏（改对或改坏）都不会让
 * 任何**类型**报错 ⇒ 只能靠「改了会不会红」来验。
 * 而更要紧的是：一条**从来没红过**的守卫，可能一直是绿的而什么也没守住。
 *
 * ── 六个方向 ──────────────────────────────────────────────────────────────
 *   ① **把「期限到了 ⇒ 云端不可用」的落地拆掉**（永远落在「不知道」）
 *      ⇒ 必须变红（同步路径于是又说「请重试」）；
 *   ② **把判据层拆掉**（`classifyDeadlineOutcome` 恒返回 unknown）
 *      ⇒ 必须变红（坏在判据层，而不是坏在接线层）；
 *   ③ **把状态码优先级改回旧的**（自报状态码压过真实状态码）
 *      ⇒ 必须变红（真 503 被读成 400 ⇒ 判据说「不是服务端不可用」）；
 *   ④ **把配置的 try 拆掉**（env 读取抛错就抛出去）
 *      ⇒ 必须变红（「不知道」被读成「崩了」）；
 *   ⑤ **把配置的缓存拆掉**（每次重读 env）
 *      ⇒ 必须变红（探活每问一次就重跑一遍解析，DEV 日志一行行刷屏）；
 *   ⑥ **把「归一」改回只认状态码** ⇒ 必须变红（没带状态码的专用错误被降级
 *      ⇒ 机器码丢掉 ⇒ 上游又落回「请重试」）；
 *   ⑦ **把「机器码」判据从 `isBackendUnavailable` 里拆掉** ⇒ 必须变红
 *      （apikey 被拒的 401、期限改判这些**没状态码**的专用错误被漏判）；
 *   ⑧ **等价的正确改写** ⇒ 必须**仍然绿**（证明它判的是行为，不是长相）。
 *
 * ⚠️ 仓库既有约定：守卫只放**性质断言**，变异自证单独成文件 ——
 * 沙箱会把整个 `tests/` 拷一份再跑守卫，若守卫自己调用 `runMutationCases`，
 * 沙箱里的那份会再开一个沙箱 ⇒ 无限递归。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/authStatusJudgment.test.ts';

/** 断言消息里的关键片段（守卫改了措辞时，这里要一起改）。 */
const DEADLINE_UNAVAILABLE = '期限到了 + 已观测到「云端不可用」';
const REAL_STATUS_WINS = '真实状态码必须压过自报状态码';
const CONFIG_READ_FAILS = '读不到配置必须返回 null';
const CONFIG_CACHED = '成功的那次结果必须被缓存';
const CODE_SURVIVES_NORMALIZE = '机器码「backend_unavailable」不许在归一这一步丢掉';
const MACHINE_CODE_RECOGNIZED = '专用错误必须被 isBackendUnavailable 认';

describe('变异自证：云端状态的判据（这条守卫必须看得见破口）', () => {
  it('变异一：把「期限到了 ⇒ 云端不可用」的落地拆掉 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '「等到期限」永远落在「不知道」',
        testFile: GUARD,
        targets: [
          {
            path: 'src/utils/supabase/sessionRead.ts',
            mutate: source => {
              const anchor = "  if (outcome === 'backend_unavailable') {";
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到落地那一行');
              }
              // 变异：落地消失 ⇒ 期限到了永远是「不知道」⇒ 同步路径说「请重试」。
              return source.replace(
                anchor,
                "  if (false as boolean) {",
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: DEADLINE_UNAVAILABLE,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      true,
      '把「期限到了 + 观测到云端不可用 ⇒ 云端不可用」的落地拆掉（于是又说「请重试」）',
    );
  });

  it('变异二：把判据层拆掉（classifyDeadlineOutcome 恒返回 unknown）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '「期限到了落在哪一档」的判据恒判「不知道」',
        testFile: GUARD,
        targets: [
          {
            path: 'src/core/backendUnavailable.ts',
            mutate: source => {
              const anchor =
                "  opts.deadlineExceeded && opts.cloudUnavailableObserved\n" +
                "    ? 'backend_unavailable'\n" +
                "    : 'unknown';";
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到判据那一段');
              }
              // 变异：判据恒判「不知道」⇒ 观测到的不可用被丢掉。
              return source.replace(
                anchor,
                "  'unknown' as DeadlineOutcome;",
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: DEADLINE_UNAVAILABLE,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      true,
      '把「期限到了落在哪一档」的判据恒改成「不知道」（观测到的不可用被丢掉）',
    );
  });

  it('变异三：把状态码优先级改回旧的（自报状态码压过真实状态码）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'readHttpStatus 改回「先读响应体里的 http_status」',
        testFile: GUARD,
        targets: [
          {
            path: 'src/core/backendUnavailable.ts',
            mutate: source => {
              const anchor =
                '  readTransportHttpStatus(err) ?? readSelfReportedHttpStatus(err);';
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到 readHttpStatus 那一行');
              }
              // 变异：旧的优先级 ⇒ 服务端自报的状态码压过传输层观测到的。
              return source.replace(
                anchor,
                '  readSelfReportedHttpStatus(err) ?? readTransportHttpStatus(err);',
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: REAL_STATUS_WINS,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      true,
      '把状态码优先级改回「自报压过真实」（真 503 于是被读成 400）',
    );
  });

  it('变异四：把配置的 try 拆掉（env 读取抛错就抛出去）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '配置读不到时抛出，而不是返回 null',
        testFile: GUARD,
        targets: [
          {
            path: 'src/utils/supabase/config.ts',
            mutate: source => {
              const anchor =
                '  } catch {\n' +
                '    // 读 env / 解析抛了 ⇒ 「读不到」⇒ 不是「配错了」，是「还没配」。\n' +
                '    return null;\n' +
                '  }';
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到配置那段的 catch');
              }
              // 变异：异常直接往上抛 ⇒ 探活抛 ⇒ 「不知道」被读成「崩了」。
              return source.replace(
                anchor,
                '  } catch (error) {\n' +
                '    throw error;\n' +
                '  }',
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: CONFIG_READ_FAILS,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      true,
      '把配置读取的 try 拆掉（读不到配置时抛出 ⇒ 「不知道」被读成「崩了」）',
    );
  });

  it('变异五：把配置的缓存拆掉（每次重读 env）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '配置不再缓存，每次都重读 env',
        testFile: GUARD,
        targets: [
          {
            path: 'src/utils/supabase/config.ts',
            mutate: source => {
              const anchor = '  if (configResolved) return cachedConfig;';
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到缓存那一行');
              }
              // 变异：缓存消失 ⇒ 每次探活都重跑一遍解析，DEV 日志一行行刷屏。
              return source.replace(
                anchor,
                '  if (false as boolean) return cachedConfig;',
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: CONFIG_CACHED,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      true,
      '把配置的缓存拆掉（每次探活都重读 env ⇒ DEV 日志一行行刷屏）',
    );
  });

  it('变异六：把「归一」改回只认状态码 ⇒ 守卫必须变红（机器码被丢掉）', () => {
    const [outcome] = runMutationCases([
      {
        name: '归一那一步只认状态码（专用错误的 code 被降级掉）',
        testFile: GUARD,
        targets: [
          {
            path: 'src/utils/supabase/sessionRead.ts',
            mutate: source => {
              const anchor = '  if (isBackendUnavailableError(err)) {';
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到归一那一行');
              }
              // 变异：只认状态码 ⇒ 没带状态码的专用错误被降级成普通 Error
              // ⇒ `code` 丢掉 ⇒ 上游落回「请重试」。
              return source.replace(anchor, '  if (readHttpStatus(err) !== null) {');
            },
          },
        ],
        expectRed: true,
        expectedFailure: CODE_SURVIVES_NORMALIZE,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      true,
      '把「归一」改回只认状态码（没带状态码的专用错误被降级 ⇒ 机器码丢掉）',
    );
  });

  it('变异七：把「机器码」判据从 isBackendUnavailable 里拆掉 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'isBackendUnavailable 不再认专用错误的 code',
        testFile: GUARD,
        targets: [
          {
            path: 'src/core/backendUnavailable.ts',
            mutate: source => {
              const anchor = '  if (hasUnavailableCode(err)) return true;';
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到机器码判据那一行');
              }
              // 变异：只认状态码与报文 ⇒ 没带状态码的专用错误（apikey 被拒的 401、
              // 期限改判）在每一个走 isBackendUnavailable 的调用点都漏判。
              return source.replace(anchor, '  if (false as boolean) return true;');
            },
          },
        ],
        expectRed: true,
        expectedFailure: MACHINE_CODE_RECOGNIZED,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      true,
      '把「机器码」判据从 isBackendUnavailable 里拆掉（没状态码的专用错误被漏判）',
    );
  });

  it('变异八：等价的正确改写 ⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '状态码优先级与期限判据的等价改写',
        testFile: GUARD,
        targets: [
          {
            path: 'src/core/backendUnavailable.ts',
            mutate: source => {
              const priority =
                'export const readHttpStatus = (err: unknown): number | null =>\n' +
                '  readTransportHttpStatus(err) ?? readSelfReportedHttpStatus(err);';
              const deadline =
                "  opts.deadlineExceeded && opts.cloudUnavailableObserved\n" +
                "    ? 'backend_unavailable'\n" +
                "    : 'unknown';";
              if (!source.includes(priority) || !source.includes(deadline)) {
                throw new Error('变异前提没成立：找不到要改写的那两段');
              }
              // 等价改写一：状态码优先级改成 if/else（行为一模一样）。
              const rewrittenPriority =
                'export const readHttpStatus = (err: unknown): number | null => {\n' +
                '  const transport = readTransportHttpStatus(err);\n' +
                '  return transport !== null ? transport : readSelfReportedHttpStatus(err);\n' +
                '};';
              // 等价改写二：期限判据改成布尔表达式（行为一模一样）。
              const rewrittenDeadline =
                "  (opts.deadlineExceeded && opts.cloudUnavailableObserved) === true\n" +
                "    ? 'backend_unavailable'\n" +
                "    : 'unknown';";
              return source
                .replace(priority, rewrittenPriority)
                .replace(deadline, rewrittenDeadline);
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
      '把状态码优先级与期限判据换成等价的正确写法（if/else + 显式布尔）',
    );
  });
});
