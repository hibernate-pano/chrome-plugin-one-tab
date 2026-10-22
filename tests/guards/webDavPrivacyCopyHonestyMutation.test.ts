/**
 * 变异自证：「自带存储的隐私说明必须等于真实行为」这条守卫必须真的看得见破口。
 *
 * ── 为什么这道文件单独存在 ────────────────────────────────────────────────
 *
 * 守卫文件里的断言**全绿**只能说明「现在的实现是对的」，
 * 说明不了「这条断言有能力发现坏实现」——
 * 一条从来没红过的守卫，可能一直是绿的而什么也没守住。
 *
 * ⇒ 这里把实现**改坏**，在沙箱里重跑**守卫自己**，要求它变红；
 * 再把实现换成**等价的正确写法**，要求它**仍然绿**。
 *
 * 沙箱的做法见 `tests/_helpers/mutationSandbox.ts`。
 *
 * ── 这几条分别证明什么 ────────────────────────────────────────────────────
 *
 *   M1 明文模式换回旧说法 ⇒ 「不许声称加密后存放」那条真的会红
 *   M2 加密模式删掉 salt ⇒ 「明文字段逐项核对」那条真的会红
 *   M3 面板不再调用纯函数 ⇒ 「接线」那条真的会红（纯函数不是文案孤儿）
 *   M4 等价改写（换个说法，语义不变）⇒ 守卫**仍然绿**（它钉的是行为，不是长相）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/webDavPrivacyCopyHonesty.test.ts';

describe('变异自证：WC-5 隐私说明守卫必须看得见破口', () => {
  it('变异一：明文模式换回旧说法「会话内容加密后存放」⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '明文模式又说自己加密了',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/sync/webDavPrivacyCopy.ts',
            mutate: source =>
              source.replace(
                '会话名称与网址以明文存放，云盘服务商能直接看到。',
                '会话内容加密后存放，但目录清单文件（manifest）以明文记录「有多少个会话、' +
                  '各自在何时被修改」，云盘服务商能看到这些信息，但不包含会话名称与网址。',
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '明文模式下说「加密后存放」就是在骗人',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把明文模式的说法换回「会话内容加密后存放」');
  });

  it('变异二：加密模式漏掉 salt ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '加密模式不说 salt 了',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/sync/webDavPrivacyCopy.ts',
            // ⚠️ 必须把 **salt 这个词本身**去掉：判据钉的是「字段被说出来了」，
            //    不是「这句话的形状」。留着词就等于没变异（第一次就踩了这个坑：
            //    替换文本里写了「（salt 的事不重要）」⇒ 守卫当然还是绿的）。
            mutate: source =>
              source.replace(
                '以及本库的加密 salt（salt 本身不是秘密，它的作用是阻止跨库预计算攻击）。',
                '（这一项就不提了）。',
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '加密模式的隐私说明漏了「加密 salt」',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '从加密模式的说明里删掉 salt 那一项');
  });

  it('变异三：面板不再调用那个纯函数 ⇒ 守卫必须变红（纯函数不是文案孤儿）', () => {
    const [outcome] = runMutationCases([
      {
        name: '面板自己写死了一句隐私说明',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/sync/WebDavSettings.tsx',
            mutate: source =>
              source.replace(
                '{webDavPrivacyNotice(encryption)}',
                '隐私说明：会话内容加密后存放，云盘服务商看不到会话名称与网址',
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '面板必须真的调用 webDavPrivacyNotice',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让面板不再渲染那个纯函数');
  });

  it('等价改写：换个说法但语义不变 ⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '等价改写：「以明文存放」说成「是明文存放」',
        testFile: GUARD,
        targets: [
          {
            path: 'src/components/sync/webDavPrivacyCopy.ts',
            mutate: source =>
              source.replace(
                '会话名称与网址以明文存放，云盘服务商能直接看到。',
                '会话名称与网址是明文存放，云盘服务商直接看得到。',
              ),
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把明文模式的措辞换个说法（语义不变）');
  });
});
