/**
 * 整页错误视图必须**按 errorSource 分流**（2026-10-22 审计 SC-2）。
 *
 * ── 缺陷本体（真实路径）───────────────────────────────────────────────────
 *
 * 用户删掉最后一个会话（成功）⇒ 列表空了、显示空态 ⇒ 他又点了一次删除
 * ⇒ 删除失败 ⇒ `state.error` 被写上、`errorSource === 'action'`、`groups.length === 0`
 * ⇒ **整页错误页接管**，标题是「会话列表暂时不可用」+ 一个「重新加载」按钮。
 *
 * ⇒ 真正发生的事（删除失败）被整页盖掉；用户去点「重新加载」（重读列表），
 * 而他的删除请求**再也不会被重试**，也没人告诉他「删除没成功」。
 *
 * ⚠️ 2026-10-26：这条审计的原始案例是「一次失败的**撤销**」—— 撤销机制已整套
 *   下线 ⇒ 案例换成了**删除会话失败**（今天唯一会产出 `errorAction` 的操作）。
 *   缺陷的**形状**没变，所以判据也不变。
 *
 * ── 这条守卫钉的是**不变量** ──────────────────────────────────────────────
 *
 *   ① 整页错误视图的**文案与按钮随 errorSource 变化**；
 *   ② `action` 来源时**不许**出现「重新加载」（重读列表不能重试那个操作）；
 *   ③ `load` 来源时**必须**有「重新加载」（那是唯一能重试读路径的动作）。
 *
 * 判据落在两层：
 *   · **判据层**（纯函数 `toListErrorView`）：来源 ⇒ 视图长什么样；
 *   · **渲染层**（真的渲染一遍）：界面真的照它渲染了吗。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderTabList } from '../_helpers/tabListHarness.ts';
import { ACTION_ERROR_COPY, toListErrorView } from '@/components/tabs/listErrorCopy';

/** 「重新加载」这个按钮的字（它是「重试读路径」的唯一动作）。 */
const RELOAD_LABEL = '重新加载';

describe('SC-2 判据层：整页错误视图按来源分流', () => {
  it("'load' ⇒ 给「重新加载」", () => {
    const view = toListErrorView({ errorSource: 'load', error: 'boom' });
    assert.equal(view.kind, 'load');
    assert.equal(
      view.reloadable,
      true,
      '读路径失败时，「重新加载」是唯一能重试的动作 ⇒ 必须给'
    );
  });

  it("'action' ⇒ 不给「重新加载」", () => {
    const view = toListErrorView({
      errorSource: 'action',
      error: 'Timeout: deleteSession',
      errorAction: 'deleteSession',
    });
    assert.equal(view.kind, 'action');
    assert.equal(
      view.reloadable,
      false,
      '重读列表**不能**重试一次失败的操作 ⇒ 给那个按钮是把用户引到死路上'
    );
    assert.ok(
      typeof view.dismissLabel === 'string' && view.dismissLabel.trim().length > 0,
      '动作失败必须给一个**真正能做的下一步**（不是「重新加载」）'
    );
  });

  it("'action' 的文案与 'load' 的文案必须不同（不许再报成「列表不可用」）", () => {
    const load = toListErrorView({ errorSource: 'load', error: 'boom' });
    const action = toListErrorView({
      errorSource: 'action',
      error: 'boom',
      errorAction: 'deleteSession',
    });
    assert.notEqual(
      action.title,
      load.title,
      '一次失败的操作被报成「会话列表暂时不可用」= 真正发生的事被盖掉'
    );
    assert.notEqual(action.description, load.description);
  });

  it('标题里出现的是**这次失败的那个操作**（不同操作 ⇒ 不同标题）', () => {
    const del = toListErrorView({
      errorSource: 'action',
      error: 'boom',
      errorAction: 'deleteSession',
    });
    const rename = toListErrorView({
      errorSource: 'action',
      error: 'boom',
      errorAction: 'renameSession',
    });
    assert.ok(
      del.title.includes(ACTION_ERROR_COPY.deleteSession.operation),
      `标题必须点名这次失败的操作（${ACTION_ERROR_COPY.deleteSession.operation}），实际：${del.title}`
    );
    assert.notEqual(
      del.title,
      rename.title,
      '不同操作失败 ⇒ 标题必须不同（说清是**哪个**操作没能完成）'
    );
  });

  it('超时 ⇒ 不许说「失败」（后台可能仍在继续）', () => {
    const view = toListErrorView({
      errorSource: 'action',
      error: '操作超时（超过 30 秒无响应）：后台可能仍在继续删除会话',
      errorAction: 'deleteSession',
    });
    assert.ok(
      !view.title.includes('没能完成'),
      `超时不等于没发生（后台可能仍在继续）⇒ 标题不许断言失败，实际：${view.title}`
    );
  });
});

describe('SC-2 渲染层：界面真的照来源分流了吗', () => {
  it("'load' ⇒ 整页错误页上有「重新加载」按钮", async () => {
    const rendered = await renderTabList({
      groups: [],
      initialLoadCompleted: true,
      error: 'boom',
      errorSource: 'load',
    });
    assert.ok(
      rendered.buttonTexts.some(text => text.includes(RELOAD_LABEL)),
      `读路径失败必须给「重新加载」，实际按钮：${rendered.buttonTexts.join('、')}`
    );
  });

  it("'action' ⇒ 整页错误页上**不许**有「重新加载」按钮", async () => {
    const rendered = await renderTabList({
      groups: [],
      initialLoadCompleted: true,
      error: 'Timeout: deleteSession',
      errorSource: 'action',
      errorAction: 'deleteSession',
    });
    assert.ok(
      !rendered.buttonTexts.some(text => text.includes(RELOAD_LABEL)),
      `动作失败时给「重新加载」= 把用户引到一条解决不了问题的路上，实际按钮：${rendered.buttonTexts.join('、')}`
    );
  });

  it("'action' ⇒ 仍然给得出一个下一步（不是一堵墙）", async () => {
    const rendered = await renderTabList({
      groups: [],
      initialLoadCompleted: true,
      error: 'Timeout: deleteSession',
      errorSource: 'action',
      errorAction: 'deleteSession',
    });
    assert.ok(
      rendered.buttonTexts.length > 0,
      '整页错误视图必须给得出下一步（关掉提示 / 回到列表）'
    );
  });
});
