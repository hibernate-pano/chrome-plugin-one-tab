/**
 * 变异自证：DS-4 / DS-5 那条线的守卫必须看得见破口。
 *
 * ── 变异清单 ─────────────────────────────────────────────────────────────
 *   ① DS-4：读失败又变回「没有待决」（`return false`）⇒ 必须红
 *   ② DS-4：读失败改成「保守值」（`return true`）⇒ **也必须红**
 *      （上一轮给的方向就是这一版：方向对，但照抄会引入「静默的假成功」——
 *        进白名单模式 ⇒ 本轮一个都不传 ⇒ 对账看到空集 ⇒ 报「全部已同步」。
 *        守卫必须能挡住它，否则下一个人会照抄回去。）
 *   ③ DS-5：读失败又变回「登记是干净的」（`return clean`）⇒ 必须红
 *   ④ 界面：读失败落回「没有待决」（`setOwnershipPending(false)`）⇒ 必须红
 *   ⑤ 界面：状态退回布尔（`useState(false)`）⇒ 必须红
 *   ⑥ 等价改写：错误消息换个说法 ⇒ 必须**仍然绿**
 *
 * 变异只发生在沙箱副本里（`tests/_helpers/mutationSandbox.ts`），
 * 共享工作树一个字节都不动。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/readFailureFailClosed.test.ts';
const STORAGE = 'src/utils/storage.ts';
const SETTINGS = 'src/components/sync/WebDavSettings.tsx';

/** 把源码里的一段文字换掉；找不到就抛（变异没生效 = 前提变了，必须让人知道）。 */
const replaceIn = (source: string, from: string, to: string): string => {
  if (!source.includes(from)) {
    throw new Error(`变异前提没成立：源码里找不到这段文字 ——\n${from}`);
  }
  const next = source.replace(from, to);
  if (next === source) throw new Error('变异没有生效（源码没变）');
  return next;
};

describe('变异自证：DS-4 / DS-5 的守卫必须看得见破口', () => {
  it('① 读失败又变回「没有待决」⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '回到 fail-open',
        testFile: GUARD,
        targets: [
          {
            path: STORAGE,
            mutate: source =>
              replaceIn(
                source,
                `      throw new Error(
        '读不到归属决策状态，已中止本轮上传以免历史会话被误传。原始错误：' +
          (error instanceof Error ? error.message : String(error))
      );`,
                `      void error;
      return false;`
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '读不到归属待决状态',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把「读失败 ⇒ 没有待决」放回去');
  });

  it('② 读失败改成「保守值」（return true）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '上一轮那版改法',
        testFile: GUARD,
        targets: [
          {
            path: STORAGE,
            mutate: source =>
              replaceIn(
                source,
                `      throw new Error(
        '读不到归属决策状态，已中止本轮上传以免历史会话被误传。原始错误：' +
          (error instanceof Error ? error.message : String(error))
      );`,
                `      void error;
      return true;`
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '读不到归属待决状态',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把「读失败 ⇒ 当成待决」放回去（上一轮那版）');
  });

  it('③ 读失败又变回「登记是干净的」⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '回到 fail-open',
        testFile: GUARD,
        targets: [
          {
            path: STORAGE,
            mutate: source =>
              replaceIn(
                source,
                `      throw new Error(
        '读不到「本次改动的会话 id」登记状态，已中止本轮上传。原始错误：' +
          (error instanceof Error ? error.message : String(error))
      );`,
                `      void error;
      return clean;`
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '读不到登记状态',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把「读失败 ⇒ 登记是干净的」放回去');
  });

  it('④ 界面把「读不到」落回「没有待决」⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '落回 false',
        testFile: GUARD,
        targets: [
          {
            path: SETTINGS,
            mutate: source =>
              replaceIn(source, 'setOwnershipPending(null);', 'setOwnershipPending(false);'),
          },
        ],
        expectRed: true,
        expectedFailure: '不许落回「没有待决」',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让界面把「读不到」落回「没有待决」');
  });

  it('⑤ 界面状态退回布尔 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '退回布尔',
        testFile: GUARD,
        targets: [
          {
            path: SETTINGS,
            mutate: source =>
              replaceIn(
                source,
                'const [ownershipPending, setOwnershipPending] = useState<boolean | null>(false);',
                'const [ownershipPending, setOwnershipPending] = useState(false);'
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '读不到是第三种状态',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把三态退回布尔');
  });

  it('⑥ 等价改写（错误消息换个说法）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '换措辞',
        testFile: GUARD,
        targets: [
          {
            path: STORAGE,
            mutate: source =>
              replaceIn(
                source,
                "'读不到归属决策状态，已中止本轮上传以免历史会话被误传。原始错误：'",
                "'读不到归属决策状态，本轮上传已中止。原始错误：'"
              ),
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把抛出的错误消息换个说法');
  });
});
