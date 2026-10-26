/**
 * 变异自证：第 50 轮那几条「对外文案」判据必须真的看得见破口
 * （2026-10-23）。
 *
 * ── 这个文件防什么 ────────────────────────────────────────────────────────
 *
 * 一条从来没红过的守卫，可能一直是绿的而什么也没守住。
 * 本轮新加/反转的判据有六条，每一条都做两半证明：
 *   ① **故意改坏 ⇒ 必须红**（改回旧说法 / 改坏实现）；
 *   ② **等价改写 ⇒ 必须仍绿**（换个说法表达同一件事）。
 *
 * ② 那一半同样重要：本仓吃过「守卫钉死字面量 ⇒ 改对了实现反而红」的亏，
 * 那条亏的代价是**让人不敢改文案**。
 *
 * ── 为什么另起一个沙箱 ────────────────────────────────────────────────────
 *
 * 见 `tests/guards/outwardCopySandbox.ts` 的文件头：`tests/_helpers/` 那个
 * 助手不拷 `promo-site/` 与 `manifest.json` ⇒ 本轮三条判据在那个沙箱里
 * 会 ENOENT ⇒ 对照组直接失败 ⇒ 看起来「都红」，其实是沙箱坏了（假红）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assertMutationOutcome } from '../_helpers/mutationSandbox.ts';
import { runOutwardMutationCases } from './outwardCopySandbox.ts';

const STORE_GUARD = 'tests/guards/storeListingTruthfulness.test.ts';
const OUTWARD_GUARD = 'tests/guards/outwardCopyTruthfulness.test.ts';

// ────────────────────────────────────────────────────────────────────────────
// ① 官网文案（storeListingTruthfulness）
// ────────────────────────────────────────────────────────────────────────────

describe('变异自证：官网那条「不得否定已有能力」的判据必须看得见破口', () => {
  it('变异一：官网又宣称「锁定会隐藏删除按钮」⇒ 守卫必须变红', () => {
    const [outcome] = runOutwardMutationCases([
      {
        name: '官网写回「重命名与删除按钮一并隐藏」',
        testFile: STORE_GUARD,
        targets: [
          {
            path: 'promo-site/index.html',
            mutate: source =>
              source.replace(
                '会话内不能重命名、不能逐条删除、也不能把标签拖到别的会话，但整张卡仍然可以删除（删前会多问一次）。',
                '重命名与删除按钮一并隐藏。',
              ),
          },
        ],
        expectRed: true,
        expectedFailure: 'promo-site/index.html 仍然宣称锁定会让删除入口消失',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让官网重新宣称锁定会藏起删除入口');
  });

  // ⚠️ 2026-10-26：这条变异的方向**反过来了** ——
  // 撤销机制下线 ⇒ 说「没有撤销」是**真话**（从前是假话），
  // 说「可撤销」才是假话。⇒ 变异改成「让官网重新宣称移除有退路」。
  it('变异二：官网又宣称「移除有退路」⇒ 守卫必须变红', () => {
    const [outcome] = runOutwardMutationCases([
      {
        name: '官网写回「恢复那一步另有 8 秒的「撤销」可退」',
        testFile: STORE_GUARD,
        targets: [
          {
            path: 'promo-site/index.html',
            mutate: source =>
              source.replace(
                '恢复整个会话、或点开单条标签那一步同样没有退路',
                '恢复整个会话、或点开单条标签那一步另有 8 秒的「撤销」可退',
              ),
          },
        ],
        expectRed: true,
        expectedFailure: 'promo-site/index.html 仍然宣称「移除有退路」',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让官网重新宣称「移除有退路」');
  });

  it('变异三：商店链接没有扩展 id ⇒ 守卫必须变红', () => {
    const [outcome] = runOutwardMutationCases([
      {
        name: '商店链接指回没有 id 的地址',
        testFile: STORE_GUARD,
        targets: [
          {
            path: 'promo-site/index.html',
            mutate: source =>
              source.replace(
                'https://chromewebstore.google.com/detail/bbbpnccbclnnphchghpfmcjjfhigepbk',
                'https://chrome.google.com/webstore/detail/tapstack',
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '没有扩展 id',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把商店链接换成落到商店首页的地址');
  });

  it('等价改写：换个说法表达同一件事 ⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runOutwardMutationCases([
      {
        name: '等价改写：锁定那一句 + 删除确认那一句都换个说法',
        testFile: STORE_GUARD,
        targets: [
          {
            path: 'promo-site/index.html',
            mutate: source =>
              source
                .replace(
                  '但整张卡仍然可以删除（删前会多问一次）',
                  '但整张卡照样能删（删之前会多问一次）',
                )
                .replace('删除前会二次确认', '删之前会先确认一次'),
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      false,
      '把官网那两句话换成等价的另一种说法（只换措辞，不换事实）',
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// ② 应用内文案（storeListingTruthfulness 的应用层扫描）
// ────────────────────────────────────────────────────────────────────────────

describe('变异自证：应用内那行谎话必须被扫描面看见', () => {
  it('变异四：同步弹窗又写回「以最后一次保存的一方为准」⇒ 守卫必须变红', () => {
    const [outcome] = runOutwardMutationCases([
      {
        name: '同步弹窗写回「以最后一次保存的一方为准」',
        testFile: STORE_GUARD,
        targets: [
          {
            path: 'src/components/sync/SyncButton.tsx',
            mutate: source =>
              source.replace(
                '同一会话两边都改过时，由操作印记决胜（后改的不一定赢），输的一边这次改动会被整组替换',
                '同一会话在两台设备上都改过时，以最后一次保存的一方为准',
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '应用内文案仍然宣称「最后保存的一方为准」',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让同步弹窗重新宣称「最后保存的一方为准」');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// ③ 退役设置 / 合并语义 / 时长 / manifest（outwardCopyTruthfulness）
// ────────────────────────────────────────────────────────────────────────────

describe('变异自证：退役设置、合并语义、撤销时长、manifest 短描述四条判据', () => {
  it('变异五：合并说明又指向已退役的「同步策略」⇒ 守卫必须变红', () => {
    const [outcome] = runOutwardMutationCases([
      {
        name: '下载侧合并说明写回「按当前同步策略…」',
        testFile: OUTWARD_GUARD,
        targets: [
          {
            path: 'src/components/sync/SyncButton.tsx',
            mutate: source =>
              source.replace(
                '按 ID 把云端会话合并进本地，未命中的本地会话会保留。',
                '按当前同步策略把云端会话合并进本地。',
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '应用内文案仍然出现「同步策略 / 合并策略」',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让下载侧重新指向那个已退役的「同步策略」');
  });

  it('变异六：台账的秒数被改成 10 秒 ⇒ 守卫必须变红', () => {
    const [outcome] = runOutwardMutationCases([
      {
        name: '台账写回「10 秒内有效」',
        testFile: OUTWARD_GUARD,
        targets: [
          {
            path: 'docs/RELEASE-NOTES.md',
            mutate: source => source.replace('**8 秒内有效**', '**10 秒内有效**'),
          },
        ],
        expectRed: true,
        expectedFailure: '台账写「10 秒内有效」',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把台账里的撤销窗口改回 10 秒');
  });

  it('变异七：实现常量被改成 3 秒 ⇒ 守卫必须变红（证明秒数是**反推**的）', () => {
    const [outcome] = runOutwardMutationCases([
      {
        name: 'TOAST_ACTION_DURATION_MS 改成 3000',
        testFile: OUTWARD_GUARD,
        targets: [
          {
            path: 'src/components/common/toastPolicy.ts',
            mutate: source =>
              source.replace(
                'export const TOAST_ACTION_DURATION_MS = 8000;',
                'export const TOAST_ACTION_DURATION_MS = 3000;',
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '台账写「8 秒内有效」',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      true,
      '把实现的撤销窗口改成 3 秒（若守卫是钉死字面量「8 秒」，这条就不会红）',
    );
  });

  it('变异八：manifest 短描述写回那句英文 ⇒ 守卫必须变红', () => {
    const [outcome] = runOutwardMutationCases([
      {
        name: 'manifest.description 写回英文泛化句',
        testFile: OUTWARD_GUARD,
        targets: [
          {
            path: 'manifest.json',
            mutate: source =>
              source.replace(
                '保存即关闭：把当前窗口的标签页存成一个会话并关掉它们，随时找回并恢复。',
                'Save browser work sessions and restore them later',
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '全英文，与商店主语言不一致',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把 manifest 短描述改回那句英文');
  });

  it('等价改写：合并说明换个说法 + manifest 换个说法 ⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runOutwardMutationCases([
      {
        name: '等价改写：合并说明与 manifest 短描述各换一种说法',
        testFile: OUTWARD_GUARD,
        targets: [
          {
            path: 'src/components/sync/SyncButton.tsx',
            mutate: source =>
              source.replace(
                '按 ID 把云端会话合并进本地，未命中的本地会话会保留。',
                '按会话 ID 把云端会话合并进本地，云端没有的那些本地会话会保留下来。',
              ),
          },
          {
            path: 'manifest.json',
            mutate: source =>
              source.replace(
                '保存即关闭：把当前窗口的标签页存成一个会话并关掉它们，随时找回并恢复。',
                '保存即关闭：把当前窗口的标签页存成一个会话，同时关掉这些标签页，随时找回并恢复。',
              ),
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(
      outcome,
      false,
      '把合并说明与 manifest 短描述换成等价的另一种说法（只换措辞，不换事实）',
    );
  });
});
