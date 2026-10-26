/**
 * 变异自证：「安静的成功」那套守卫必须看得见破口（2026-10-25，Task 4）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 *
 * `tests/guards/quietSuccess.test.ts` 钉的是「19 处裁决 + 失败不得被静默 +
 * 命名空间不许误伤」。但**一条从来没红过的守卫，可能一直是绿的而什么也没守住**。
 * 唯一的验证办法是把实现改坏，看守卫会不会红 —— 而且必须红在**目标那条断言**上
 * （只断言「红了」是不够的：红在别的断言上说明守卫抓错了地方）。
 *
 * ── 变异清单 ─────────────────────────────────────────────────────────────
 *
 *   ① 未锁定整组恢复**只删掉撤销凭据**（`{ group }` → `undefined`）⇒ 红在
 *      「整组恢复那条必须挂上撤销凭据」
 *   ② 锁定分支的 `r.success !== true` 判定删掉 ⇒ 红在「成功门仍在」
 *   ③ 锁定分支**成功门那一支**的 `showRestoreError` 删掉 ⇒ 红在「成功门仍在」
 *   ④ `deleteAllCountMatches` 恒返回 `true` ⇒ 红在「删除数量不一致必须说」
 *   ⑤ `decideFeedback` 的 `hiddenFact` 分支删掉 ⇒ 红在「fact 档判据」
 *   ⑥ `lockDisclosureText` 恒返回 `null` ⇒ 红在「锁定说明常驻」
 *   ⑦ `ToastKind` 把 `'success'` 加回去 ⇒ 红在「类型层不许再有 success」
 *   ⑧ 反向：`restoreGroupSuccessMessage` 的局部变量 `opened` 改名
 *      （`opened` → `headline`）⇒ 仍然绿
 *
 * ── `expectedFailure` 的铁律：只能是 `assert.*` 的第三个参数原文 ──────────
 *
 * node 的 TAP 输出会把**通过的**子测试标题也打出来 ⇒ 拿一条 `it` 标题当 needle
 * 是**恒真**的（守卫全绿时它也在输出里，`reasonMatched` 白送）。
 * ⇒ 每条 needle 都是某条 `assert.*` 的第三个参数（只在**红了**的时候才打印）。
 * ⇒ 核对办法：跑一次**全绿**的守卫、抓完整 TAP 输出，每个 needle 必须**出现 0 次**。
 *
 * ── 变异必须打在「断言看得见的那条性质」上 ──────────────────────────────
 *
 * ① 原先写的是「把整块 `showConsumeToast` 删掉」。那样确实会红，但红的**第一条**
 * 是「整组恢复的成功播报必须还在」（`assert.ok(groupCall, …)`），
 * ⇒ **撤销凭据**那条断言一次都没被触发过 ⇒ 这条变异没有证明它有任何检测力。
 * ⇒ 改成**只动凭据**（第二个实参），让红的必然是关于凭据的那一句。
 *
 * 变异只发生在沙箱副本里（`tests/_helpers/mutationSandbox.ts`），
 * 共享工作树一个字节都不动。
 *
 * ── 为什么每个 `mutate` 都用 `replaceIn` 而不是 `source.replace` ──────────
 *
 * 沙箱的 `replaceIn` 找不到目标片段时会抛「变异前提没成立」。那是**必须**的：
 * 源码挪了位置而变异静默失效的话，下面每条 `assertMutationOutcome` 都会
 * 因为「变异后仍然绿」而红 —— 看起来像「守卫没牙齿」，实际是「变异没跑起来」。
 * 两种失败要能分开，所以前提必须显式断言。
 *
 * ⚠️ 片段必须与源码**逐字一致（含缩进）**。下面每一段都是先 `grep -n` 定位、
 *    再逐行打印确切字节后照抄的。改源码时如果这些片段失配，
 *    报错会是「变异前提没成立」而不是「守卫是空的」—— 这是刻意的。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/quietSuccess.test.ts';
const TAB_GROUP = 'src/components/tabs/TabGroup.tsx';
const DELETE_ALL_MESSAGES = 'src/components/layout/deleteAllMessages.ts';
const FEEDBACK_POLICY = 'src/core/feedbackPolicy.ts';
const LOCK_COPY = 'src/components/tabs/lockFeedbackCopy.ts';
const TOAST_POLICY = 'src/components/common/toastPolicy.ts';
const MOVE_COPY = 'src/components/tabs/moveFeedbackCopy.ts';

/** 把源码里的一段文字换掉；找不到就抛（变异没生效 = 前提变了，必须让人知道）。 */
const replaceIn = (source: string, from: string, to: string): string => {
  if (!source.includes(from)) {
    throw new Error(`变异前提没成立：源码里找不到这段文字 ——\n${from}`);
  }
  const next = source.replace(from, to);
  if (next === source) throw new Error('变异没有生效（源码没变）');
  return next;
};

describe('变异自证：「安静的成功」的守卫必须看得见破口', () => {
  it('① 整组恢复的成功路径又出声了 ⇒ 守卫必须变红（红在「成功路径必须静默」）', () => {
    const [outcome] = runMutationCases([
      {
        name: '成功路径里多了一条播报',
        testFile: GUARD,
        targets: [
          {
            path: TAB_GROUP,
            // ⚠️ 变异只加**一条播报**（模拟「撤销机制还在时」的样子）：
            //    位置在 consumeSession() 之后、失败分支之前 ⇒ 属于**成功路径**。
            //    守卫红在「整组恢复的成功路径必须静默」那条。
            mutate: source =>
              replaceIn(
                source,
                '        consumeSession();\n',
                '        consumeSession();\n        showRestoreSuccessMessage(\'测试播报\');\n',
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '整组恢复的成功路径必须静默',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '给整组恢复的成功路径加回一条播报');
  });

  it('② 删掉锁定分支的成功门 ⇒ 守卫必须变红（红在「成功门仍在」）', () => {
    const [outcome] = runMutationCases([
      {
        name: '锁定分支不判 success',
        testFile: GUARD,
        targets: [
          {
            path: TAB_GROUP,
            // 只把**判定条件**换成恒假（`if (false)`）——
            // 用「先定位再替换」并让 replaceIn 断言前提成立（Ruling 6）。
            mutate: source =>
              replaceIn(
                source,
                '          if (!r || r.success !== true) {\n' +
                  '            // 失败必须释放冷却档位：否则这条标签被记住一整个冷却窗口，',
                '          if (false) {\n' +
                  '            // 失败必须释放冷却档位：否则这条标签被记住一整个冷却窗口，',
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '锁定分支必须判过成功门 —— SW 拒开时界面不许谎报「已打开」',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把锁定分支的成功门判定删掉');
  });

  it('③ 删掉锁定分支成功门那一支的失败出口 ⇒ 守卫必须变红（红在「成功门仍在」）', () => {
    const [outcome] = runMutationCases([
      {
        name: '成功门里不报失败',
        testFile: GUARD,
        targets: [
          {
            path: TAB_GROUP,
            // 只删**成功门那一支**里的 `showRestoreError`。
            // ⚠️ 锁定分支里另有一处 `.catch` 也调 `showRestoreError` ⇒
            //    「分支里出现过 showRestoreError」那条断言**不会**红。
            //    这正是本变异要证明的：守卫必须钉「成功门那一支里出声」。
            mutate: source =>
              replaceIn(
                source,
                '            releaseOnFailure();\n' +
                  "            showRestoreError(toServiceWorkerErrorCopy(r?.error, '打开失败，标签仍保留在会话中'));\n" +
                  '            return;',
                '            releaseOnFailure();\n' +
                  '            return;',
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '成功门判到失败时，那一支里必须真的出声 —— 打不开必须明说（记录原样保留）',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把锁定分支成功门那一支的失败出口删掉');
  });

  it('④ deleteAllCountMatches 恒返回 true ⇒ 守卫必须变红（红在「删除数量不一致必须说」）', () => {
    const [outcome] = runMutationCases([
      {
        name: '数量对不上也当一致',
        testFile: GUARD,
        targets: [
          {
            path: DELETE_ALL_MESSAGES,
            // 纯函数 ⇒ 替换**函数体**（不是调用点）。
            mutate: source =>
              replaceIn(
                source,
                '}): boolean => input.deletedCount === input.confirmedCount;',
                '}): boolean => true;',
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '实际比确认的少 ⇒ 界面看不见这个差，必须说出来',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让 deleteAllCountMatches 恒返回 true');
  });

  it('⑤ 删掉 decideFeedback 的 hiddenFact 分支 ⇒ 守卫必须变红（红在「fact 档判据」）', () => {
    const [outcome] = runMutationCases([
      {
        name: '判据层不认 fact',
        testFile: GUARD,
        targets: [
          {
            path: FEEDBACK_POLICY,
            // 规则②（`hiddenFact` 非空 ⇒ fact）整块删掉 ⇒ 非空 fact 会掉到
            // 规则④ ⇒ 全部 silent ⇒ 那 8 处「说事实」全哑。
            mutate: source =>
              replaceIn(
                source,
                "  if (typeof hiddenFact === 'string' && hiddenFact.trim().length > 0) {\n" +
                  '    return {\n' +
                  "      level: 'fact',\n" +
                  "      reason: '命中规则②：有一件界面看不见、但用户必须知道的事实 ⇒ 说事实（判据只判有没有，不碰文案）。',\n" +
                  '    };\n' +
                  '  }',
                '  void hiddenFact;',
              ),
          },
        ],
        expectRed: true,
        expectedFailure:
          '有非空 fact 时必须判成 fact —— 这一档没了，「清掉了几个」这类界面表达不了的事就全哑了',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把判据层的 hiddenFact 分支删掉');
  });

  it('⑥ lockDisclosureText 恒返回 null ⇒ 守卫必须变红（红在「锁定说明常驻」）', () => {
    const [outcome] = runMutationCases([
      {
        name: '锁定说明永远不渲染',
        testFile: GUARD,
        targets: [
          {
            path: LOCK_COPY,
            // 纯函数 ⇒ 替换函数体。
            mutate: source =>
              replaceIn(
                source,
                'export const lockDisclosureText = (isLocked: boolean): string | null =>\n' +
                  '  isLocked\n' +
                  "    ? '已锁定 · 恢复后保留在列表 · 不参与「清理重复标签」与拖到别的会话'\n" +
                  '    : null;',
                'export const lockDisclosureText = (_isLocked: boolean): string | null => null;',
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '锁定时必须有那行说明',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让 lockDisclosureText 恒返回 null');
  });

  it("⑦ 把 'success' 加回 ToastKind ⇒ 守卫必须变红（红在「类型层不许再有 success」）", () => {
    const [outcome] = runMutationCases([
      {
        name: 'toast 类型层又有 success',
        testFile: GUARD,
        targets: [
          {
            path: TOAST_POLICY,
            // 类型字面量 ⇒ 目标断言是类型层那条（`unionMembers` 解析联合成员）。
            mutate: source =>
              replaceIn(
                source,
                "export type ToastKind = 'error' | 'info' | 'warning';",
                "export type ToastKind = 'error' | 'info' | 'warning' | 'success';",
              ),
          },
        ],
        expectRed: true,
        expectedFailure: "ToastKind 里不该再有 'success'",
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, "把 'success' 加回 ToastKind");
  });

  // ══════════════════════════════════════════════════════════════════════
  // ⑧ 反向变异：守卫钉的是**性质**，不是字面量
  // ══════════════════════════════════════════════════════════════════════
  //
  // ── 为什么 brief 的「改 inCurrentWindow 参数名」在这里会**红** ──────────
  //
  // brief 说「把 `restoreGroupSuccessMessage` 的 `inCurrentWindow` 参数改名 ⇒
  // 守卫仍绿（守卫钉的是性质不是字面量）」。**这条期望在当前仓库里不成立**，
  // 而且不成立是**对的**：
  //
  //   · `tests/guards/restoreWindowWording.test.ts` 有一条断言
  //     `assert.deepEqual(paramNames, ['tabCount','inCurrentWindow'])` ——
  //     它**故意**钉死了签名（理由写在那条断言里：「参数没了，文案就只能猜一个」，
  //     而历史上正是猜错过 ⇒ 说「新窗口」而实际开在当前窗口）。
  //   · 本文件（`quietSuccess.test.ts`）Task 4 登记表里那行
  //     `restoreGroupSuccessMessage 只剩「未锁定」（且 inCurrentWindow 参数仍在）`
  //     也钉了同一个签名（brief 的样板行明写「且 `inCurrentWindow` 参数**仍在**」）。
  //
  // ⇒ 把参数改名**不是**等价改写：它会让上面两条断言都红。如果在这里写
  //   `expectRed: false`，沙箱会报「守卫钉的是长相而不是行为」—— 而真正的问题
  //   是**这个变异选错了**（它改的是一个被刻意钉住的公开契约，不是实现细节）。
  //
  // ⇒ 处置（与 brief 不一致，理由如上）：反向变异换成**真正的等价改写** ——
  //   把 `restoreGroupSuccessMessage` 内部那个局部变量 `opened` 改名成 `headline`。
  //   它满足「同一行为、不同长相」的定义：
  //     · 函数签名不变（`(tabCount, inCurrentWindow)`）；
  //     · 输出文案逐字不变（两句模板串跟着变量名走）；
  //     · 调用点一字不动。
  //   ⇒ 所有守卫都必须仍然绿。谁要是把文案函数钉成「源码里必须有 `opened`」，
  //     这条就会红 —— 那正是我们要抓的「钉长相」。
  it('⑧ 等价改写（文案函数的局部变量改名）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '文案函数的局部变量改名',
        testFile: GUARD,
        targets: [
          {
            path: MOVE_COPY,
            // ⚠️ 2026-10-26：原来的等价改写对象（restoreGroupSuccessMessage）
            //    随「撤销机制下线 + 恢复成功静默」一起删了 ⇒ 换成**还活着**的
            //    同类文案函数 moveEmptiesSessionMessage：只改它**函数内**的
            //    局部变量名（subject → label），输出文案逐字不变。
            mutate: source =>
              replaceIn(
                replaceIn(
                  source,
                  "  const subject = source ? `「${source}」` : '原会话';",
                  "  const label = source ? `「${source}」` : '原会话';",
                ),
                '  return `${subject}的最后一条标签${where}，该会话已从列表移除`;',
                '  return `${label}的最后一条标签${where}，该会话已从列表移除`;',
              ),
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把文案函数的局部变量改名');
  });
});
