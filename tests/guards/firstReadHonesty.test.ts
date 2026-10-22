/**
 * 冷启动那一两秒：界面**不许**说「你没有会话」（2026-10-22 审计 SC-1）。
 *
 * ── 缺陷本体 ──────────────────────────────────────────────────────────────
 *
 * 首次读取**不是立即发生的**：它是异步的（读一次存储），而 Redux 的初值是
 * `isLoading = false`（它只表示「**这一轮**读取在途」）、`groups = []`
 * ⇒ **第一次渲染**时既不是 loading、也不是 error、列表还是空的
 * ⇒ 渲染的是**空态卡**：
 *
 *   · 「先保存一个工作会话」= 一句**谎报**（用户可能有 50 个会话，只是还没读完）；
 *   · 那个「保存并关闭」按钮在这段时间里**可点** ⇒ 误点即误操作
 *     （它会关掉当前窗口的标签）。
 *
 * （修复前还多一层：首次读取被**一次 SW 往返**挡在后面 —— 先
 * `await chrome.runtime.sendMessage({type:'RUN_MIGRATIONS'})`，之后才读。
 * 那一次往返让「还没读」这件事拖得更久；现在读取不再被它挡住，见
 * `src/components/tabs/firstReadBootstrap.ts`。）
 *
 * ── 这条守卫钉的是**不变量**，不是某句文案 ──────────────────────────────────
 *
 *   **首次读取走完之前，界面不许渲染「你没有会话」。**
 *
 * 判据落在三处（缺一层都不够）：
 *   ① **渲染层**：真的把列表渲染一遍，看那一帧里有没有空态出口 / 主 CTA；
 *   ② **接线层**：那个「读完了」的标志必须**真的**被 slice 置位 ——
 *      否则判据层写对了、界面照样显示空态（本仓反复栽在这个坑上）；
 *   ③ **启动层**：首次读取不许被那一次 SW 往返卡住 ——
 *      SW 不回话时读取照样要发生，否则界面永远停在骨架屏上。
 *
 * 另有一条配套的不变量：**读取失败 ⇒ 走错误页，不是空态**。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderTabList } from '../_helpers/tabListHarness.ts';
import { findAll } from '../_helpers/htmlTree.ts';
import { saveAndCloseLabel } from '@/components/layout/saveActionCopy';

describe('SC-1 渲染层：首次读取没走完之前，界面不许说「你没有会话」', () => {
  it('首次读取未完成 ⇒ 一个空态出口都不许出现', async () => {
    const rendered = await renderTabList({ groups: [], initialLoadCompleted: false });
    assert.deepEqual(
      rendered.exitActions,
      [],
      '冷启动那一两秒里不许出现空态出口（登录 / 从云端拉回 / 导入…）—— ' +
        '那时我们还不知道用户有没有会话'
    );
  });

  it('首次读取未完成 ⇒ 「保存并关闭」这个主 CTA 不许可点', async () => {
    const rendered = await renderTabList({ groups: [], initialLoadCompleted: false });
    assert.ok(
      !rendered.buttonTexts.includes(saveAndCloseLabel),
      `冷启动那一两秒里「${saveAndCloseLabel}」是可点的 ⇒ 用户以为列表是空的，` +
        '可能误点（它会关掉当前窗口的标签）'
    );
  });

  it('首次读取未完成 ⇒ 界面在「正在加载」，不是「什么都没有」', async () => {
    const rendered = await renderTabList({ groups: [], initialLoadCompleted: false });
    const statuses = findAll(rendered.tree, element => element.attrs['role'] === 'status');
    assert.ok(
      statuses.length > 0,
      '必须给出「正在读」的信号（骨架屏），而不是一片空白或一个谎报的空态'
    );
  });

  it('首次读取完成且确实一个会话都没有 ⇒ 空态照旧出现（基线：这条必须先成立）', async () => {
    const rendered = await renderTabList({ groups: [], initialLoadCompleted: true });
    assert.ok(
      rendered.exitActions.length > 0,
      '读完了、确实没有会话 ⇒ 空态出口必须出现（否则新用户第一步就没路）'
    );
    assert.ok(
      rendered.buttonTexts.includes(saveAndCloseLabel),
      '读完了、确实没有会话 ⇒ 主 CTA 必须出现'
    );
  });

  it('读取失败 ⇒ 走错误页（有「重新加载」），不是空态', async () => {
    const rendered = await renderTabList({
      groups: [],
      initialLoadCompleted: true,
      error: 'boom',
      errorSource: 'load',
    });
    assert.deepEqual(
      rendered.exitActions,
      [],
      '读失败时不该出现空态出口 —— 用户会以为「我真的没有会话」'
    );
    assert.ok(
      !rendered.buttonTexts.includes(saveAndCloseLabel),
      '读失败时不该出现「保存并关闭」的主 CTA'
    );
    assert.ok(
      rendered.buttonTexts.some(text => text.includes('重新加载')),
      `读失败必须给出路（「重新加载」），实际按钮：${rendered.buttonTexts.join('、')}`
    );
  });
});

describe('SC-1 启动层：首次读取不许被 SW 往返卡住', () => {
  /**
   * 喂一个**永不 settle** 的迁移（SW 不回话 / SW 卡住），
   * 断言首次读取照样发生了 —— 这就是「不许卡在骨架屏上」的可执行形式。
   *
   * 为什么必须单独验：useEffect 在服务端渲染里**不会执行** ⇒ 渲染层判据
   * 看不见这一段时序（这是本仓栽过的坑：判据写对了、接线没接上）。
   */
  it('迁移永不回话 ⇒ 首次读取照样发生', async () => {
    const { bootstrapFirstRead } = await import('@/components/tabs/firstReadBootstrap');
    let readCount = 0;
    bootstrapFirstRead({
      read: () => {
        readCount += 1;
      },
      runMigrations: () => new Promise<never>(() => {}),
      onMigrationsUnconfirmed: () => undefined,
    });
    // 让一个微任务过去：读取只要**不依赖那一次 SW 往返**就行，
    // 同步调还是排在一个微任务里都是对的（判据要的是语义，不是写法）。
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(
      readCount,
      1,
      '首次读取不许等那一次 SW 往返 —— SW 不回话时，界面会永远停在骨架屏上'
    );
  });

  it('读先走、迁移后走（顺序反了 = 首屏被 SW 往返拖住）', async () => {
    const { bootstrapFirstRead } = await import('@/components/tabs/firstReadBootstrap');
    const order: string[] = [];
    bootstrapFirstRead({
      read: () => {
        order.push('read');
      },
      runMigrations: async () => {
        order.push('migrations');
        return undefined;
      },
      onMigrationsUnconfirmed: () => undefined,
    });
    assert.deepEqual(order, ['read', 'migrations'], '首次读取必须先于迁移发生');
  });

  it('迁移的消息通道被关 ⇒ 记「结果未知」，且不许把启动流程带崩', async () => {
    const { bootstrapFirstRead } = await import('@/components/tabs/firstReadBootstrap');
    const reasons: unknown[] = [];
    bootstrapFirstRead({
      read: () => undefined,
      runMigrations: () => Promise.reject(new Error('message channel closed')),
      onMigrationsUnconfirmed: (reason: unknown) => {
        reasons.push(reason);
      },
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(reasons.length, 1, '结果未知必须被记录 —— 不许静默');
    assert.match(
      String((reasons[0] as Error)?.message ?? ''),
      /message channel closed/,
      '记录下来的必须是原始原因（渠道被关 ≠ 迁移失败，但也不能什么都不说）'
    );
  });
});

describe('SC-1 接线层：「读完了」这个标志必须真的被 slice 置位', () => {
  /** 造一个只含 tabs 的 store。 */
  async function makeStore() {
    const { configureStore } = await import('@reduxjs/toolkit');
    const { default: tabReducer } = await import('@/store/slices/tabSlice');
    return configureStore({ reducer: { tabs: tabReducer } });
  }

  it('冷启动的初值是「还没读完」（否则界面第一帧就在谎报）', async () => {
    const store = await makeStore();
    assert.equal(
      store.getState().tabs.hasCompletedInitialLoad,
      false,
      '初值必须是 false —— 第一帧还没读过任何东西'
    );
  });

  it('loadGroups 成功 ⇒ 标志变成 true', async () => {
    const store = await makeStore();
    const { loadGroups } = await import('@/store/slices/tabSlice');
    store.dispatch(loadGroups.fulfilled([], 'R1', undefined));
    assert.equal(
      store.getState().tabs.hasCompletedInitialLoad,
      true,
      '读完（哪怕是空的）就必须置位 —— 否则界面永远停在骨架屏'
    );
  });

  it('loadGroups 失败 ⇒ 标志**也**变成 true（读不到 ≠ 还在读）', async () => {
    const store = await makeStore();
    const { loadGroups } = await import('@/store/slices/tabSlice');
    store.dispatch(loadGroups.rejected(new Error('boom'), 'R2', undefined));
    assert.equal(
      store.getState().tabs.hasCompletedInitialLoad,
      true,
      '失败也算「读完了」—— 否则用户永远看不到错误页，也永远不知道出了什么事'
    );
  });
});
