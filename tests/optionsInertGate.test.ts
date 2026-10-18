// A 组 A7：设置页「未就绪」窗口的**键盘**闸门（2026-10-18）。
//
// ── 缺陷形状 ──────────────────────────────────────────────────────────────
// `OptionsPage.tsx` 原先在设置未就绪时用 `pointer-events-none` 拦，但那个属性
// **不阻止键盘聚焦与激活**，全文件也没有 aria-disabled / inert / disabled。
// 而那些控件本身就是原生可聚焦的（`role="switch"` 的按钮、四个 `role="radio"`
// 的按钮、select）：
//
//   settingsReady === false 的那个窗口（挂载 → loadSettings resolve 之间；
//   或存储坏了则永远）→ 键盘用户 Tab 到「自动同步」按 Enter
//   → 乐观 dispatch + saveSettings fail-closed 拒写 + 弹一个他从未触发的错误 toast。
//
// 「指针挡得住、键盘挡不住」正是 `pointer-events-none` 这类 CSS 层的典型盲区：
// 它看起来像一道闸门，实际只覆盖一种输入方式。
//
// ── 修法 ──────────────────────────────────────────────────────────────────
// 在容器上加 `inert`（manifest.json 已声明 minimum_chrome_version=120，
// 而 inert 要 Chrome 102+），**不**改成 disabled（那会改变灰态语义：disabled
// 控件不再被读屏当作「存在但不可用」，而这里是「正在加载」）。保留
// pointer-events-none 不动。
//
// ── 为什么这条能真做行为断言 ──────────────────────────────────────────────
// 本仓库没有 jsdom / happy-dom / @testing-library，也不为此装依赖
// （见 tests/a11yDialogs.test.ts 顶部注释）。但**服务端渲染**不需要 DOM：
// `react-dom/server` 可以把组件渲染成 HTML 字符串。所以这里的断言不是
// 「源码里有 inert 这个词」，而是「真的渲染一遍，看输出的 HTML 里有没有」——
// 这条尤其重要，因为 `inert={true}` 在 React 18 下**会渲染成什么都没**，
// 而 `inert="false"` 在 HTML 语义里是**真值**。光看源码两种错法都看不出来。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// react-dom/server 依赖 window/localStorage 的一小撮 API（主题 provider 会读）。
// 这是**桩**而不是 DOM 环境：只提供被读到的几个方法，不提供文档树与事件系统。
const lsData = new Map<string, string>();
(globalThis as Record<string, unknown>).window = {
  localStorage: {
    get length() {
      return lsData.size;
    },
    key: (i: number) => [...lsData.keys()][i] ?? null,
    getItem: (k: string) => (lsData.has(k) ? (lsData.get(k) as string) : null),
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

/** 只关心「容器标签本身」：把 aria-busy 之前的位置截掉，取到下一个 '>'。 */
const containerTagOf = (html: string): string | null => {
  const at = html.indexOf('aria-busy=');
  if (at === -1) return null;
  const start = html.lastIndexOf('<', at);
  const end = html.indexOf('>', at);
  return start === -1 || end === -1 ? null : html.slice(start, end + 1);
};

describe('A7 未就绪时容器必须 inert（挡住键盘，不只是指针）', () => {
  it('真实渲染：settingsReady=false 时容器带 inert 属性', async () => {
    const React = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { Provider } = await import('react-redux');
    const { createStore } = await import('../src/store/index.ts');
    const mod = await import('../src/options/OptionsPage.tsx');

    // 不 dispatch loadSettings ⇒ 组件停在 settingsReady=false，正是缺陷的窗口。
    const html = renderToStaticMarkup(
      React.createElement(
        Provider,
        { store: createStore() } as unknown as React.ComponentProps<typeof Provider>,
        React.createElement((mod as { OptionsPage: React.FC }).OptionsPage)
      )
    );
    assert.ok(html.length > 0, '渲染失败 —— 下面的断言会变成恒真');
    const tag = containerTagOf(html);
    assert.ok(tag, '找不到表单容器（aria-busy 锚点漂了）');
    assert.match(tag as string, /aria-busy="true"/, '前提：此刻确实未就绪');
    assert.match(
      tag as string,
      /\sinert(=""|="inert")?[\s>]/,
      '未就绪容器必须 inert：pointer-events-none 拦不住键盘，Tab+Enter 仍能触发变更'
    );
    // 保留原有语义：inert 是**叠加**，不是替换。
    assert.match(tag as string, /pointer-events-none/, '保留 pointer-events-none（不要用 inert 替换它）');
    assert.match(tag as string, /opacity-50/, '保留视觉灰态');
  });

  it('属性形状：未就绪带 inert、就绪完全不出现（inert="false" 在 HTML 里是真值）', async () => {
    const { formContainerGateProps } = await import('../src/options/OptionsPage.tsx');

    const notReady = formContainerGateProps(false);
    assert.equal(notReady['aria-busy'], true);
    assert.equal(notReady.inert, '', 'React 18 只认字符串形式；布尔 true 会被丢弃且报警告');
    assert.match(notReady.className, /pointer-events-none/);

    const ready = formContainerGateProps(true);
    assert.equal(ready['aria-busy'], false);
    assert.ok(
      !('inert' in ready),
      '就绪时必须**完全没有**该属性 —— 输出 inert="false" 会让表单永久锁死'
    );
    assert.doesNotMatch(ready.className, /pointer-events-none/, '就绪后不应继续拦指针');
  });

  it('不是把控件改成 disabled（灰态语义必须保持）', () => {
    const CODE = read('src/options/OptionsPage.tsx')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    // 只看容器那一段：别的控件本来就可能有合法的 disabled。
    const at = CODE.indexOf('formContainerGateProps(settingsReady)');
    assert.ok(at > -1, '容器必须使用 formContainerGateProps');
    const near = CODE.slice(Math.max(0, at - 200), at + 200);
    assert.doesNotMatch(near, /disabled=/, '不得改成 disabled：那会改变灰态与读屏语义');
  });

  it('浏览器最低版本足以支持 inert（否则本条修复在旧版上静默失效）', async () => {
    const manifest = JSON.parse(read('manifest.json')) as { minimum_chrome_version?: string };
    const min = Number(manifest.minimum_chrome_version ?? '0');
    assert.ok(
      min >= 102,
      `manifest.minimum_chrome_version=${manifest.minimum_chrome_version} 低于 102，inert 不会生效`
    );
  });
});
