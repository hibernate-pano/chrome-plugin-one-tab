// 覆盖上传预览卡片的**真实渲染**断言（2026-10-20 P1 收尾）。
//
// ── 为什么要有这个文件 ────────────────────────────────────────────────────
//
// P1（覆盖上传会删掉「本机读不出来」的云端行）给预览卡片加了一行：
//
//   「另有 N 个会话这台设备读不出来，云端上那几份不会被删除或覆盖」
//
// 实现方（agent）自己如实报告了一条**没验证的东西**：
//   > 组件层的改动只做了纯函数断言 + 源码级接线断言，没有用 react-dom/server
//   > 渲染成 HTML 做真实渲染断言。渲染结果的实际观感未验证。
//
// 这正是本仓反复出现的那类盲区：**「源码里有这句话」不等于「界面上有这句话」**。
// 反例在本仓里是现成的：`inert={true}` 在 React 18 下**渲染成什么都没有**，
// 而 `inert="false"` 在 HTML 语义里是**真值** —— 光看源码两种错法都看不出来
// （见 tests/optionsInertGate.test.ts 的文件头）。
//
// 别的错法同样看不出来：
//   · 条件写反（`preservedRemoteCount <= 0` 时反而显示）；
//   · JSX 里把 `{preservedRemoteCount}` 写到了不该在的位置（渲染成 "[object Object]"）；
//   · 组件根本没被接上（函数存在，但调用方没传那个数）⇒ 永远不显示。
//
// ── 为什么能用 react-dom/server ──────────────────────────────────────────
// 本仓没有 jsdom / happy-dom / @testing-library，也不为此装依赖。
// 但**服务端渲染**不需要 DOM：`react-dom/server` 把组件渲染成 HTML 字符串。
// 于是这里的断言不是「源码里有这个词」，而是「真的渲染一遍，看输出的 HTML 里有没有」。
//
// ── 断言钉的是不变量 ──────────────────────────────────────────────────────
// 钉「该出现时出现、且说的是可判定的事实」，不钉具体 HTML 结构
// （class 名、标签名都不是这个产品对用户的承诺）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// react-dom/server 依赖 window/localStorage 的一小撮 API。
// 这是**桩**而不是 DOM 环境：只提供被读到的几个方法，不提供文档树与事件系统。
const lsData = new Map<string, string>();
(globalThis as Record<string, unknown>).window = {
  localStorage: {
    get length() {
      return lsData.size;
    },
    key: (i: number) => [...lsData.keys()][i] ?? null,
    getItem: (k: string) => (lsData.has(k) ? lsData.get(k) : null),
    setItem: (k: string, v: string) => void lsData.set(k, String(v)),
    removeItem: (k: string) => void lsData.delete(k),
    clear: () => lsData.clear(),
  },
  matchMedia: () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }),
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true,
};
(globalThis as Record<string, unknown>).localStorage = (
  globalThis as unknown as { window: { localStorage: unknown } }
).window.localStorage;
(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: {
      get: async () => ({}),
      set: async () => undefined,
      remove: async () => undefined,
    },
    onChanged: { addListener: () => undefined, removeListener: () => undefined },
  },
  runtime: { getManifest: () => ({ version: 'test' }) },
};

/** 一个可渲染的最小预览摘要（字段与 SyncPreviewSummary 同形）。 */
const summaryOf = (over: Record<string, unknown> = {}) => ({
  additions: 0,
  updates: 0,
  deletions: 0,
  unchanged: 0,
  beforeCount: 3,
  afterCount: 3,
  addedNames: [],
  updatedNames: [],
  deletedNames: [],
  preservedRemoteCount: 0,
  ...over,
});

const render = async (
  summary: unknown,
  preservedRemoteCount: number
): Promise<string> => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { renderPreviewSummary } = await import('@/components/sync/syncPreviewView');
  // renderPreviewSummary 是**普通函数**（返回 JSX），不是 React 组件 ——
  // 用 createElement 把它当组件渲染会把参数形状搞错（props 变成第一个参数、
  // 后面的实参变成 children）。这里直接调用它，拿它返回的 JSX 去渲染。
  return renderToStaticMarkup(
    renderPreviewSummary(
      summary as never,
      '云端' as never,
      '覆盖模式' as never,
      preservedRemoteCount
    )
  );
};

describe('覆盖上传预览：保留几份「读不出来的云端会话」必须真的显示在界面上', () => {
  it('保留数 > 0 ⇒ 渲染出的 HTML 里真的有那句话，且带着那个数字', async () => {
    const html = await render(summaryOf(), 2);

    assert.match(
      html,
      /读不出来/,
      '保留数 > 0 时界面必须告诉用户「有会话读不出来」—— ' +
        '那是用户唯一的知情入口（代码里写了不等于界面上有）'
    );
    assert.match(
      html,
      /2/,
      '那句话里必须带着那个数字（用户要能核对「哪几份」）'
    );
    assert.match(
      html,
      /不会被删除或覆盖|不会删除或覆盖/,
      '必须说清「不会被动」（否则用户不知道该做什么）'
    );
  });

  it('保留数 = 0 ⇒ 界面里一个字都不多说', async () => {
    const html = await render(summaryOf(), 0);

    assert.doesNotMatch(
      html,
      /读不出来/,
      '没有需要保留的行时，那句话一个字都不该出现 —— ' +
        '「0 个会话读不出来」是纯噪音，且会让人以为云端出了问题'
    );
  });

  it('保留数 > 0 时仍要保留原有的统计数字（不是把卡片换掉了）', async () => {
    const html = await render(summaryOf({ deletions: 2, updates: 1 }), 3);

    // 三个统计格还在（新增/更新/删除的标签）。
    for (const label of ['新增', '更新', '删除']) {
      assert.match(html, new RegExp(label), `统计格「${label}」必须还在（新增的那行不能顶掉它们）`);
    }
    // 「不会被动」那句与统计格是**并存**的，不是二选一。
    assert.match(html, /读不出来/);
  });
});
