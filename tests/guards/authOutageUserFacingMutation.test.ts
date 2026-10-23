/**
 * 变异自证：「云端故障期间，面向用户的那几句话必须说得对」这条守卫必须真的看得见破口。
 *
 * ── 为什么必须自证 ────────────────────────────────────────────────────────
 * 这一轮改的三处都是**「说错方向 / 做不到」**类缺陷，而这类缺陷最容易写成
 * 「看着像修了」的代码：
 *   ① 登录失败时**抛什么**、store 里**记成哪一档**（机器标记能不能活过
 *      RTK 的序列化）；
 *   ② 登出时**用哪个 scope**、**本机会话有没有真的被清掉**；
 *   ③ 核账号**有没有上限**。
 * 这三处只要有一处「看起来对」而实际没生效，守卫就会恒绿 ⇒ 缺陷会带着
 * 「已经修过了」的标签留在代码里。
 *
 * ⇒ 六个方向（每个方向都指向**一条具体断言**，失败输出里必须命中关键字）：
 *   ① **把「云端不可用 → 带机器标记」这一步拆掉** ⇒ 必须变红；
 *   ② **把 `signIn.rejected` 里的「云端不可用」那一档拆掉** ⇒ 必须变红；
 *   ③ **把「本机会话由我们自己清」这一步拆掉** ⇒ 必须变红；
 *   ④ **把 `scope: 'local'` 改回 `scope: 'global'`** ⇒ 必须变红；
 *   ⑤ **把核账号的等待上限拆掉** ⇒ 必须变红（红在**时间**那条断言上）；
 *   ⑥ **把「已从本机登出」改回「已退出登录」** ⇒ 必须变红（文案说准这件事
 *      也得有检测力 —— 说错了用户会以为所有设备都退了）；
 *   ⑦ **等价的正确改写** ⇒ 必须**仍然绿**（证明它判的是行为，不是长相）。
 *
 * ⚠️ 为什么「拆掉上限」这一条要**改 15 秒的挂起**配合：
 *   守卫里假云端的用户端点挂 15 秒，而判据是「8 秒内结束」⇒
 *   拆掉上限之后**稳稳地**越过判据（不是擦边 7.9s 混过去）。
 *   ⇒ 而**正常**那一版由 5 秒的 `withDeadline` 截断 ⇒ 5 秒就结束（不拖 15 秒）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/authOutageUserFacing.test.ts';

/** 断言消息里的关键片段（守卫改了措辞时，这里要一起改）。 */
const MARKER_MISSING = '402 期间登录失败必须带「云端不可用」的机器标记';
const BUCKET_WRONG = '这一档必须是「云端不可用」，不是「未登录」';
const LOCAL_SESSION_KEPT = '本机会话令牌必须被清掉';
const SCOPE_WRONG = 'scope=local';
const NO_UPPER_BOUND = '核账号必须在上限内结束';
const COPY_WRONG = '文案必须说清是「本机」这一档';

describe('变异自证：云端故障期间，这几句话必须说得对（这条守卫必须看得见破口）', () => {
  it('变异一：把「云端不可用 → 带机器标记」这一步拆掉 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '登录/注册失败时不再把「云端不可用」统一成带 code 的错误',
        testFile: GUARD,
        targets: [
          {
            path: 'src/store/slices/authSlice.ts',
            mutate: source => {
              const anchor = `const toBackendUnavailable = (error: unknown): BackendUnavailableError | null => {
  if (isBackendUnavailableError(error)) {
    // 已经是本仓的专用错误 ⇒ 原样带出（别把 httpStatus 弄丢）。
    if (error instanceof BackendUnavailableError) return error;
    // 是 SDK 的原始错误（status 在，但序列化会丢）⇒ 换成带 code 的那一个。
    return new BackendUnavailableError(
      backendUnavailableAuthCopy(),
      readHttpStatus(error) ?? undefined,
    );
  }
  const copy = authBackendUnavailableCopy(error);
  if (!copy) return null;
  return new BackendUnavailableError(copy, readHttpStatus(error) ?? undefined);
};`;
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到「统一成带机器标记的错误」那一段');
              }
              // 变异：这一步被拆掉 ⇒ 登录失败落回「登录失败，请稍后重试」
              //       （**错方向**的那句话：用户会以为是自己密码错了）。
              return source.replace(
                anchor,
                `const toBackendUnavailable = (error: unknown): BackendUnavailableError | null => {
  void error;
  return null;
};`,
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: MARKER_MISSING,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      true,
      '把「云端不可用 → 带机器标记」这一步拆掉（登录失败于是说成「登录失败，请稍后重试」）',
    );
  });

  it('变异二：把 signIn.rejected 里的「云端不可用」那一档拆掉 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '登录失败被一律记成「未登录」那一档',
        testFile: GUARD,
        targets: [
          {
            path: 'src/store/slices/authSlice.ts',
            mutate: source => {
              const anchor = `        if (isBackendUnavailableError(action.error)) {
          state.error = backendUnavailableAuthCopy();
          state.backendUnavailable = true;
          state.authStatusKind = 'backend_unavailable';
          logWarn('[auth] 登录失败的原因是「云端不可用」—— 不说「登录失败」（方向错了）');
          return;
        }`;
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到登录 rejected 里「云端不可用」那一档');
              }
              // 变异：那一档被拆掉 ⇒ store 记成「未登录」
              //       （用户明明登录着，却被说成没登录 ⇒ 被赶去重新输密码）。
              return source.replace(anchor, '        // 变异：这一档被拆掉了。');
            },
          },
        ],
        expectRed: true,
        expectedFailure: BUCKET_WRONG,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      true,
      '把登录失败时的「云端不可用」那一档拆掉（store 于是记成「未登录」）',
    );
  });

  it('变异三：把「本机会话由我们自己清」这一步拆掉 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '本机登出不再自己清会话（只靠 SDK 的 signOut）',
        testFile: GUARD,
        targets: [
          {
            path: 'src/store/slices/authSlice.ts',
            mutate: source => {
              const anchor = '  await remove.call(client);';
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到「本机清理会话」那一行');
              }
              // 变异：不清本机会话 ⇒ SDK 的 signOut 早退时（刷新失败）
              //       本机会话原样留着 ⇒ 用户换不了账号。
              return source.replace(
                anchor,
                '  // 变异：本机会话没被清掉。',
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: LOCAL_SESSION_KEPT,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      true,
      '把「本机会话由我们自己清」这一步拆掉（用户于是换不了账号）',
    );
  });

  it('变异四：把 scope=local 改回 scope=global ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '服务端登出改回全局（撤所有设备）',
        testFile: GUARD,
        targets: [
          {
            path: 'src/store/slices/authSlice.ts',
            mutate: source => {
              const anchor = "        const r = await client.signOut({ scope: 'local' });";
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到「服务端登出」那一行');
              }
              // 变异：改回全局 ⇒ 撤的是**所有设备**的会话，
              //       而文案说的是「已从本机登出」⇒ 两头对不上。
              return source.replace(
                anchor,
                "        const r = await client.signOut({ scope: 'global' });",
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: SCOPE_WRONG,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      true,
      '把服务端登出的 scope 改回 global（于是撤的是所有设备）',
    );
  });

  it('变异五：把核账号的等待上限拆掉 ⇒ 守卫必须变红（红在时间那条断言上）', () => {
    const [outcome] = runMutationCases([
      {
        name: '核账号不再有等待上限',
        testFile: GUARD,
        targets: [
          {
            path: 'src/utils/supabase/session.ts',
            mutate: source => {
              const anchor = `  const userResult = await withDeadline(
    supabase.auth.getUser(),
    SESSION_READ_DEADLINE_MS,
    '获取用户信息',
  ).catch((err: unknown) => {`;
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到「核账号」那一段的上限');
              }
              // 变异：上限被拆掉 ⇒ 弱网时核账号一路拖到 SDK 自带的 45 秒
              //       ⇒ 同步管线的 30 秒协议上界被打爆。
              return source.replace(
                anchor,
                `  const userResult = await Promise.resolve(supabase.auth.getUser()).catch((err: unknown) => {`,
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: NO_UPPER_BOUND,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      true,
      '把核账号的等待上限拆掉（于是它一路拖到 45 秒 fetch 超时）',
    );
  });

  it('变异六：把「已从本机登出」改回「已退出登录」⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '降级档的文案改回「已退出登录」',
        testFile: GUARD,
        targets: [
          {
            path: 'src/store/slices/authSlice.ts',
            mutate: source => {
              const anchor = `const LOCAL_SIGNOUT_COPY =
  '已从本机登出。TapStack 云端暂时不可用，其它设备可能仍是登录状态。';`;
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到「已从本机登出」那句文案');
              }
              // 变异：文案改回「已退出登录」⇒ 用户会以为**所有设备**都退了
              //       （别的设备上的会话还在云端，仍是登录态）—— 那是假的。
              return source.replace(
                anchor,
                `const LOCAL_SIGNOUT_COPY =
  '已退出登录。';`,
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: COPY_WRONG,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      true,
      '把降级档的文案改回「已退出登录」（用户于是以为所有设备都退了）',
    );
  });

  it('变异七：把「不许碰 SDK」这条断言废掉（绕过探活闸门直接问 SDK）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '服务端登出绕过探活闸门，云端不可用时也去问 SDK',
        testFile: GUARD,
        targets: [
          {
            path: 'src/store/slices/authSlice.ts',
            mutate: source => {
              const anchor = `    const result = await facade.readSessionSafely(
      async () => {
        // ⚠️ \`scope: 'local'\` ⇒ **只撤这一台**（其它设备的会话不动）。
        const r = await client.signOut({ scope: 'local' });
        return { data: { session: null }, error: r.error };
      },
      '退出登录',
    );`;
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到「服务端登出」那一段');
              }
              // 变异：绕过探活闸门 ⇒ 云端明明不可用也去问 SDK ⇒
              //       SDK 会先去刷新会话 ⇒ 撞上故障就连打 8 次、退避 25.4 秒
              //       （界面卡 25 秒，而且往一个刚被配额限制的项目上再打 8 个请求）。
              return source.replace(
                anchor,
                `    const result = await (async () => {
      // 变异：绕过探活闸门。
      const r = await client.signOut({ scope: 'local' });
      return { data: { session: null }, error: r.error };
    })();`,
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: '一个 SDK 请求都不许发',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      true,
      '把「云端不可用时不许碰 SDK」这条防线拆掉（于是 SDK 被问了，刷新风暴照旧打）',
    );
  });

  it('变异八：等价的正确改写 ⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '等价改写：抽出 promise + 换一种调用写法',
        testFile: GUARD,
        targets: [
          {
            path: 'src/utils/supabase/session.ts',
            mutate: source => {
              const anchor = `  const userResult = await withDeadline(
    supabase.auth.getUser(),
    SESSION_READ_DEADLINE_MS,
    '获取用户信息',
  ).catch((err: unknown) => {`;
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到「核账号」那一段');
              }
              // 等价改写：行为一模一样（同一个 promise、同一个上限、同一段 catch），
              // 只是先把 promise 取出来再交给 withDeadline。
              return source.replace(
                anchor,
                `  const userPromise = supabase.auth.getUser();
  const userResult = await withDeadline(
    userPromise,
    SESSION_READ_DEADLINE_MS,
    '获取用户信息',
  ).catch((err: unknown) => {`,
              );
            },
          },
          {
            path: 'src/store/slices/authSlice.ts',
            mutate: source => {
              const anchor = '  await remove.call(client);';
              if (!source.includes(anchor)) {
                throw new Error('变异前提没成立：找不到「本机清理会话」那一行');
              }
              // 等价改写：`remove.call(client)` ≡ `Reflect.apply(remove, client, [])`
              // （同一个 this、同一组参数）—— 只换写法，不换行为。
              return source.replace(
                anchor,
                '  await Reflect.apply(remove, client, []);',
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
      '把「核账号」与「本机清理」换成等价的正确写法（行为一模一样）',
    );
  });
});
