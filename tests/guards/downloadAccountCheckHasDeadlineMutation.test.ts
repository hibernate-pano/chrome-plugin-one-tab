/**
 * 变异自证：「核账号必须有等待上限」这条守卫必须真的看得见破口。
 *
 * ── 为什么必须自证 ────────────────────────────────────────────────────────
 * 这条守卫有**两个**可以恒绿的缝：
 *   ① 它验的是「在上限内结束」—— 而「上限」是**实现里的一个数字**
 *      ⇒ 改它（改对或改坏）都不会让任何**类型**报错
 *      ⇒ 只能靠「改了会不会红」来验；
 *   ② 它的结构判据用 AST —— 而 AST 判据最常见的失败模式是
 *      「窗口压根没覆盖到那个位置」（本仓 `.memory/` 里
 *      `mutation-can-fail-to-apply.md` 记的就是这一条）。
 *
 * ⇒ 四个方向（每个方向都指向**一条具体断言**）：
 *   ① **把 download.ts 的核账号改回裸调**（去掉收口入口）⇒ 必须变红
 *      （这就是本轮那个真缺陷的原形态：45 秒 ⇒ 打爆 30 秒协议上界）；
 *   ② **把上限本身去掉**（`withDeadline` 不再包住 `getUser`）⇒ 必须变红；
 *   ③ **把收口入口的上限数字改成 45 秒**（= SDK 自带的那个）⇒ 必须变红
 *      （上限还在，但**大到没用** ⇒ 45 秒 > 30 秒协议上界 ⇒ 仍然打爆）；
 *   ④ **等价的正确改写**（把 `withDeadline(...)` 换成 `withDeadline(...)` +
 *      改个变量名 / 换个参数顺序）⇒ 必须**仍然绿**。
 *
 * ⚠️ **变异必须先证明落地**（本仓纪律）：每个 `mutate` 都先
 *   `assert source.includes(anchor)`（前提不成立就直接抛），
 *   再改 ⇒ 避免「变异没应用上 ⇒ 看起来像测试太弱」。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/downloadAccountCheckHasDeadline.test.ts';

/** 断言消息里的关键片段（守卫改了措辞时，这里要一起改）。 */
const NO_DEADLINE = '必须在上限内结束';
const NOT_WRAPPED = '必须被 `withDeadline(...)` 包住';

describe('变异自证：核账号必须有等待上限（这条守卫必须看得见破口）', () => {
  it('变异一：把 download.ts 的核账号改回**裸调**（去掉收口入口）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'download.ts 的核账号改回裸的 getUser()',
        testFile: GUARD,
        targets: [
          {
            path: 'src/utils/supabase/download.ts',
            mutate: source => {
              const anchor = '    const userId = await requireSessionUser();';
              const count = source.split(anchor).length - 1;
              if (count !== 2) {
                throw new Error(`变异前提没成立：锚点出现了 ${count} 次（预期 2 次）`);
              }
              // 变异：核账号改回**裸调** ⇒ 没有上限 ⇒ 弱网时拖满 45 秒。
              return source.split(anchor).join('    const userId = (await supabase.auth.getUser()).data.user?.id ?? \'\';');
            },
          },
        ],
        expectRed: true,
        expectedFailure: NO_DEADLINE,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      true,
      '把 download.ts 的核账号改回裸调（弱网时拖满 45 秒 ⇒ 打爆 30 秒协议上界）',
    );
  });

  it('变异二：把结构判据拆掉（getUser 不再被 withDeadline 包住）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'session.ts 的收口入口不再给 getUser 加上限',
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
                throw new Error('变异前提没成立：找不到 withDeadline 包住 getUser 那一段');
              }
              // 变异：上限被摘掉 ⇒ 裸调 getUser ⇒ 结构判据与行为判据都要红。
              return source.replace(
                anchor,
                `  const userResult = await Promise.resolve({
    data: { user: await supabase.auth.getUser() },
    error: null,
  }).catch((err: unknown) => {`,
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: NOT_WRAPPED,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      true,
      '把「核账号」的等待上限摘掉（getUser 不再被 withDeadline 包住）',
    );
  });

  it('变异三：把上限数字改成 45 秒（= SDK 自带的那个）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '收口入口的上限从 5 秒改成 45 秒',
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
                throw new Error('变异前提没成立：找不到 withDeadline 那一段');
              }
              // 变异：上限还在，但**大到没用**（45 秒 > 30 秒协议上界）
              // ⇒ 弱网时仍然打爆协议上界 ⇒ 用户仍然只看到「操作超时」。
              return source.replace(
                anchor,
                `  const userResult = await withDeadline(
    supabase.auth.getUser(),
    45_000,
    '获取用户信息',
  ).catch((err: unknown) => {`,
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: NO_DEADLINE,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      true,
      '把核账号的等待上限改成 45 秒（上限还在，但大到打爆 30 秒协议上界）',
    );
  });

  it('变异四：等价的正确改写（换个变量名）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '收口入口里的变量改名（语义完全等价）',
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
                throw new Error('变异前提没成立：找不到 withDeadline 那一段');
              }
              // 等价改写：只换变量名，行为一模一样。
              return source.replace(
                anchor,
                `  const accountResult = await withDeadline(
    supabase.auth.getUser(),
    SESSION_READ_DEADLINE_MS,
    '获取用户信息',
  ).catch((err: unknown) => {`,
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
      '把收口入口里的变量换个名字（行为一模一样）',
    );
  });
});
