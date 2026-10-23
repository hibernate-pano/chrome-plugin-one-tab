/**
 * 变异自证：WebDAV 传输栈「取法唯一 / 注入完整」那条守卫必须看得见破口
 * （2026-10-23，第 50 轮）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * `tests/guards/webDavTransportSingleAcquisition.test.ts` 钉的是
 * 「全仓只有一条取法」与「每个构造点都注入完整的 seq 能力」。听起来很扎实 ——
 * 但一条从来没红过的守卫，可能一直是绿的而什么也没守住。
 *
 * 唯一的验证办法是**把实现改坏，看守卫会不会红**；反过来，
 * **把实现换成一个等价的正确写法，守卫必须仍然绿**（否则这条守卫钉的是长相
 * 而不是行为，换个写法就误报，等于逼着实现不敢改）。
 *
 * ── 变异清单 ──────────────────────────────────────────────────────────────
 *   ① 设置页改回直接 import 实现              ⇒ 守卫必须变红（取法又变三条）
 *   ② 装配点漏掉 `nextDeviceSeq`               ⇒ 守卫必须变红（注入不完整）
 *   ③ 探针的 `readOnly: true` 被改成 false     ⇒ 守卫必须变红（只读标注失效）
 *   ④ 三项 seq 能力提成常量再展开（等价改写）  ⇒ 守卫必须**仍然绿**
 *
 * 沙箱的做法见 `tests/_helpers/mutationSandbox.ts`：变异只发生在沙箱副本里，
 * 共享工作树一个字节都不动。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/webDavTransportSingleAcquisition.test.ts';
const SETTINGS = 'src/components/sync/WebDavSettings.tsx';
const FACTORY = 'src/sync-backend/webdav/factory.ts';

/** 把源码里的一段文字换掉；找不到就抛（变异没生效 = 前提变了，必须让人知道）。 */
const replaceIn = (source: string, from: string, to: string): string => {
  if (!source.includes(from)) {
    throw new Error(`变异前提没成立：源码里找不到这段文字 ——\n${from}`);
  }
  const next = source.replace(from, to);
  if (next === source) throw new Error('变异没有生效（源码没变）');
  return next;
};

/** 装配点里那三行 seq 能力。 */
const SEQ_PROPS = `    peekDeviceSeq: webDavSeqDeps.peekDeviceSeq,
    nextDeviceSeq: webDavSeqDeps.nextDeviceSeq,
    bumpDeviceSeqIfLower: webDavSeqDeps.bumpDeviceSeqIfLower,`;

describe('变异自证：WebDAV 传输栈的「取法唯一 / 注入完整」守卫', () => {
  it('① 设置页改回直接 import 实现 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '设置页直接 import 传输栈实现',
        testFile: GUARD,
        targets: [
          {
            path: SETTINGS,
            mutate: source =>
              replaceIn(
                source,
                "import { loadWebDavTransport } from '@/sync-backend/webdavRuntime';",
                "import { loadWebDavTransport } from '@/sync-backend/webdavRuntime';\n" +
                  "import { WebDavClient } from '@/sync-backend/webdav/client';"
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '出现第三条取法',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让设置页直接 import 传输栈实现');
  });

  it('② 装配点漏掉 nextDeviceSeq ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '装配点漏注入 nextDeviceSeq',
        testFile: GUARD,
        targets: [
          {
            path: FACTORY,
            mutate: source => replaceIn(source, SEQ_PROPS, `    peekDeviceSeq: webDavSeqDeps.peekDeviceSeq,
    bumpDeviceSeqIfLower: webDavSeqDeps.bumpDeviceSeqIfLower,`),
          },
        ],
        expectRed: true,
        expectedFailure: '缺 nextDeviceSeq',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让装配点漏掉 nextDeviceSeq');
  });

  it('③ 探针的只读标注被改成 false ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '探针不再只读',
        testFile: GUARD,
        targets: [
          {
            path: FACTORY,
            // ⚠️ 锚到**代码**那一行（`return { ...deps, readOnly: true };`），
            // 不要只写 'readOnly: true' —— 那个字串在文件头的注释里也出现过，
            // 替换会打在注释上 ⇒ 代码没变 ⇒ 变异静默失效（守卫当然还绿）。
            mutate: source =>
              replaceIn(source, 'return { ...deps, readOnly: true };', 'return { ...deps, readOnly: false };'),
          },
        ],
        expectRed: true,
        expectedFailure: '可写的适配器构造点必须',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让只读探针变成可写的');
  });

  it('④ 三项 seq 能力提成常量再展开（等价改写）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '三项 seq 能力提成常量',
        testFile: GUARD,
        targets: [
          {
            path: FACTORY,
            mutate: source => {
              const withConst = replaceIn(
                source,
                `export const webDavSeqDeps: WebDavSeqDeps = {
  peekDeviceSeq: () => webDavSeqRegistry.peekDeviceSeq(),
  nextDeviceSeq: () => webDavSeqRegistry.nextSeq(),
  bumpDeviceSeqIfLower: (candidate: number) => webDavSeqRegistry.bumpSeqIfLower(candidate),
};`,
                `export const webDavSeqDeps: WebDavSeqDeps = {
  peekDeviceSeq: () => webDavSeqRegistry.peekDeviceSeq(),
  nextDeviceSeq: () => webDavSeqRegistry.nextSeq(),
  bumpDeviceSeqIfLower: (candidate: number) => webDavSeqRegistry.bumpSeqIfLower(candidate),
};

/** 三项 seq 能力（提成常量再展开 —— 与上面的写法完全等价）。 */
const SEQ_CAPABILITIES = {
  peekDeviceSeq: webDavSeqDeps.peekDeviceSeq,
  nextDeviceSeq: webDavSeqDeps.nextDeviceSeq,
  bumpDeviceSeqIfLower: webDavSeqDeps.bumpDeviceSeqIfLower,
};`
              );
              return replaceIn(withConst, SEQ_PROPS, '    ...SEQ_CAPABILITIES,');
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把三项 seq 能力提成常量再展开');
  });
});
