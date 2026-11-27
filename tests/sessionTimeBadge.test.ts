/**
 * 卡片时间位：「显示的时间必须是**当前排序依据的那个时间**」（v1.33）。
 *
 * ── 为什么时间位必须跟着排序键换 ──────────────────────────────────────────
 *
 * 修复前时间位永远显示 `createdAt`。用户在「最近使用 / 最近修改」下看到列表
 * 按一个**没显示出来**的时间排 ⇒ 顺序看起来像随机的；而且「今天」到底是
 * 保存、修改还是使用的今天，不带前缀就分不出来。
 *
 * 本文件钉四件事：
 *   ① 四档前缀：`保存 ·` / `修改 ·` / `使用 ·`，导入件沿用 `导入 ·`；
 *   ② 「最近使用 + 没有记录」**不渲染**（不能写「未使用」——那是把
 *      「这台设备上没有记录」说成会话的属性）；
 *   ③ 时间戳非法时说「时间未知」，绝不出现「Invalid Date」；
 *   ④ 卡片上真的按 `settings.sessionSort` 换前缀（渲染层，不只是纯函数）。
 *
 * 【为什么第 ④ 条必须渲染一遍】本仓在 L-10 上栽过：判据层做完了、守卫全绿，
 * 而界面根本没接线。纯函数测试证明不了「TabGroup 真的读了排序键」。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatSessionTimeBadge,
  type TimeBadgeSession,
} from '../src/components/tabs/sessionTimeBadge.ts';

const DAY = 24 * 60 * 60 * 1000;

/** 「现在」必须是真实的当下（写死日期 = 定时炸弹，见 sessionSort 旧教训）。 */
const nowIso = (): string => new Date(Date.now()).toISOString();
const daysAgoIso = (days: number): string => new Date(Date.now() - days * DAY).toISOString();

const session = (over: Partial<TimeBadgeSession> = {}): TimeBadgeSession => ({
  id: 'g1',
  name: '会话',
  createdAt: nowIso(),
  updatedAt: nowIso(),
  tabs: [],
  ...over,
});

describe('时间位 · 保存 / 名称 / 会话大小 ⇒ 保存时间', () => {
  for (const sort of ['saved', 'name', 'size'] as const) {
    it(`${sort} ⇒ 「保存 · 今天」`, () => {
      assert.equal(formatSessionTimeBadge(session(), sort), '保存 · 今天');
    });
  }

  it('导入件（保存时间未知）沿用「导入 · 昨天」，不伪装成「保存」', () => {
    // OneTab 导入件没有保存时间 ⇒ 判据是 importedAt 有值（见 core/sessionSaveTime）。
    const imported = session({
      createdAt: nowIso(),
      importedAt: daysAgoIso(1),
    });
    assert.equal(formatSessionTimeBadge(imported, 'saved'), '导入 · 昨天');
  });
});

describe('时间位 · 最近修改 ⇒ 修改时间（与排序同一判据）', () => {
  it('组的 updatedAt 更新 ⇒ 「修改 · 今天」', () => {
    assert.equal(formatSessionTimeBadge(session(), 'accessed'), '修改 · 今天');
  });

  it('标签的 lastAccessed 更新 ⇒ 也用「修改」（口径同 lastActivityAt）', () => {
    const g = session({
      updatedAt: daysAgoIso(10),
      tabs: [{ lastAccessed: nowIso() }],
    });
    assert.equal(formatSessionTimeBadge(g, 'accessed'), '修改 · 今天');
  });

  it('没有任何动静 ⇒ 「修改 · 时间未知」，不是 Invalid Date', () => {
    const g = session({ updatedAt: undefined, tabs: [] });
    // createdAt 不参与 lastActivityAt；没有 updatedAt/tabs ⇒ -Infinity。
    assert.equal(formatSessionTimeBadge(g, 'accessed'), '修改 · 时间未知');
  });
});

describe('时间位 · 最近使用 ⇒ 本机记录（没有记录就不渲染）', () => {
  it('有记录 ⇒ 「使用 · 昨天」', () => {
    assert.equal(
      formatSessionTimeBadge(session(), 'recentUsed', daysAgoIso(1)),
      '使用 · 昨天'
    );
  });

  it('没有记录 ⇒ null（这一格不渲染）', () => {
    assert.equal(formatSessionTimeBadge(session(), 'recentUsed', undefined), null);
  });

  it('空字符串同样当作「没有记录」⇒ null', () => {
    assert.equal(formatSessionTimeBadge(session(), 'recentUsed', ''), null);
  });

  it('记录时间非法 ⇒ 「使用 · 时间未知」，绝不出现 Invalid Date', () => {
    const badge = formatSessionTimeBadge(session(), 'recentUsed', '不是时间戳');
    assert.equal(badge, '使用 · 时间未知');
    assert.equal(String(badge).includes('Invalid Date'), false);
  });

  it('最近使用档不看 createdAt（哪怕它是今天）—— 没记录就是不渲染', () => {
    const g = session({ createdAt: nowIso(), updatedAt: nowIso() });
    assert.equal(formatSessionTimeBadge(g, 'recentUsed', undefined), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 渲染层：卡片真的按 settings.sessionSort 换前缀
// ─────────────────────────────────────────────────────────────────────────

describe('渲染层 · TabGroup 的时间位跟着 settings.sessionSort 走', () => {
  const countOf = (haystack: string, needle: string): number =>
    haystack.split(needle).length - 1;

  it('最近使用 + 有记录 ⇒ 显示「使用 ·」；没有记录的会话不留时间位', async () => {
    // 这里的 import 是**动态**的：harness 会在渲染前装浏览器桩。
    const { renderTabList, makeGroups } = await import('./_helpers/tabListHarness.ts');
    const store = await import('@/storage-kv/lastUsedAtStore');

    const groups = makeGroups([
      { id: 'used', name: '用过的', tabCount: 1, createdAt: daysAgoIso(30) },
      { id: 'never', name: '没用过', tabCount: 1, createdAt: daysAgoIso(30) },
    ]);
    store.__seedLastUsedAtForTests({ used: daysAgoIso(1) });
    try {
      const rendered = await renderTabList({ groups, sessionSort: 'recentUsed' });
      assert.equal(
        countOf(rendered.html, '使用 ·'),
        1,
        '只有「用过的」那张卡有时间位（没有记录的那张不渲染这一格）'
      );
      assert.equal(rendered.html.includes('使用 · 昨天'), true);
      assert.equal(
        rendered.html.includes('未使用'),
        false,
        '「没有记录」不是会话的属性 ⇒ 不许写「未使用」'
      );
    } finally {
      store.__resetLastUsedAtForTests();
    }
  });

  it('最近修改 ⇒ 卡片前缀是「修改 ·」，不是「保存 ·」', async () => {
    const { renderTabList, makeGroups } = await import('./_helpers/tabListHarness.ts');
    const groups = makeGroups([
      { id: 'g1', name: '会话', tabCount: 1, createdAt: daysAgoIso(30) },
    ]);
    const rendered = await renderTabList({ groups, sessionSort: 'accessed' });
    assert.equal(rendered.html.includes('修改 ·'), true);
    assert.equal(
      rendered.html.includes('保存 ·'),
      false,
      '按修改时间排序时还显示保存时间 = 用户看不出顺序依据'
    );
  });

  it('默认（最近保存）⇒ 卡片前缀是「保存 ·」', async () => {
    const { renderTabList, makeGroups } = await import('./_helpers/tabListHarness.ts');
    const groups = makeGroups([
      { id: 'g1', name: '会话', tabCount: 1, createdAt: nowIso() },
    ]);
    const rendered = await renderTabList({ groups });
    assert.equal(rendered.html.includes('保存 · 今天'), true);
  });
});
