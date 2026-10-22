/**
 * 变异自证：「设置页的后端选择卡必须披露定时拉取默认关闭」这条守卫
 * 必须真的看得见破口。
 *
 * 沙箱的做法见 `tests/_helpers/mutationSandbox.ts`。
 *
 * ── 这几条分别证明什么 ────────────────────────────────────────────────────
 *
 *   M1 副标题还原成「需要登录，跨设备自动同步」⇒ 「必须提定时拉取」那条真的会红
 *   M2 **事实来源**变了（`DEFAULT_SETTINGS.syncEnabled` 改成 true）
 *      ⇒ 「前提」那条真的会红（判据钉的是「默认关闭」这个事实，不是某句话）
 *   M3 副标题丢掉「需要登录」⇒ 「不能被顶掉」那条真的会红
 *   M4 等价改写（「在设置里开启」→「在设置页开启」）⇒ 守卫**仍然绿**
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/backendSelectionDisclosure.test.ts';

describe('变异自证：WC-10 后端卡披露守卫必须看得见破口', () => {
  it('变异一：副标题还原（去掉「定时拉取默认关闭」）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '后端卡又不说定时拉取的默认状态了',
        testFile: GUARD,
        targets: [
          {
            path: 'src/options/OptionsPage.tsx',
            mutate: source =>
              source.replace(
                '需要登录，跨设备自动同步；定时拉取默认关闭，可在设置里开启',
                '需要登录，跨设备自动同步',
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '后端卡的副标题没有提「定时拉取」',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把后端卡的副标题还原成旧文案');
  });

  it('变异二：事实来源变了（定时拉取默认打开）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '自动同步开关默认打开了',
        testFile: GUARD,
        targets: [
          {
            path: 'src/utils/storage.ts',
            mutate: source => source.replace('syncEnabled: false', 'syncEnabled: true'),
          },
        ],
        expectRed: true,
        expectedFailure: '事实来源变了：定时拉取不再默认关闭',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把定时拉取的默认值改成默认打开');
  });

  it('变异三：副标题丢掉「需要登录」⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '后端卡不再说「需要登录」',
        testFile: GUARD,
        targets: [
          {
            path: 'src/options/OptionsPage.tsx',
            mutate: source =>
              source.replace(
                '需要登录，跨设备自动同步；定时拉取默认关闭，可在设置里开启',
                '跨设备自动同步；定时拉取默认关闭，可在设置里开启',
              ),
          },
        ],
        expectRed: true,
        expectedFailure: '副标题仍然必须说清「需要登录」',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把后端卡副标题里的「需要登录」删掉');
  });

  it('等价改写：「在设置里开启」→「在设置页开启」⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '等价改写：换个说法指向同一个地方',
        testFile: GUARD,
        targets: [
          {
            path: 'src/options/OptionsPage.tsx',
            mutate: source =>
              source.replace(
                '需要登录，跨设备自动同步；定时拉取默认关闭，可在设置里开启',
                '需要登录，跨设备自动同步；定时拉取默认关闭，可在设置页开启',
              ),
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把「在设置里开启」说成「在设置页开启」（语义不变）');
  });
});
