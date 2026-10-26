// 管理页是**完整标签页**，不是浏览器弹窗 —— 2026-10-20 审计 §3.0。
//
// ── 为什么这条值得用测试钉住 ─────────────────────────────────────────────
//
// 本轮审计（以及 2026-10-19 那轮）都从「Chrome 扩展 popup 的真实宽度是 400px」
// 这个前提出发，量了一堆 400×600 下的几何与对比度，还把它写进了
// 2026-10-19 的 **P0**（"顶栏搜索框被压成 0px"）和提交给审核方的商店文案。
//
// 而 `manifest.json` **没有 `default_popup`** ⇒ 管理页是
// `chrome.tabs.create({url})` 打开的一个**普通标签页**，宽度由用户决定。
// 那个 P0 针对的是一个**不存在的场景**。
//
// 这类错误的代价不是「多修了一个不存在的 bug」（响应式本身是对的），
// 而是**优先级被带偏**：一个不存在场景的 P0 挤掉了真实场景的问题
// （比如「点扩展图标 = 保存并关闭」这条核心入口的破坏性）。
//
// 教训：「审计文档里写了什么」不能替代「产品实际怎么运行」。
// 这条测试就是让「产品实际怎么运行」变成可断言的事实。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const manifest = () => JSON.parse(read('manifest.json'));

// ─────────────────────────────────────────────────────────────────────────
// 1. manifest 的事实
// ─────────────────────────────────────────────────────────────────────────

describe('管理页的形态：完整标签页，不是浏览器弹窗', () => {
  it('manifest 没有 default_popup', () => {
    assert.equal(
      manifest().action.default_popup,
      undefined,
      "若将来真的加回 default_popup，本文件其它断言需要一并复核（那时 400px 就是真的了）"
    );
  });

  it('action 的悬停标题必须与「点图标 = 打开标签管理器（有能存的先存并关掉）」一致', () => {
    const action = manifest().action;
    assert.ok(action.default_icon, '必须有图标');
    assert.ok(action.default_title, '必须有悬停标题');
    // ── 历史：2026-10-22 审计 P0-1 把点图标改成「只打开管理器」，这条断言
    //    那时要求标题里有「打开」、没有「保存|关闭」。
    // ── 2026-10-24：产品负责人要求**恢复旧交互**（点图标 = 保存当前窗口并关闭），
    //    多 Chrome 实例并存时那才是对的 ⇒ 判据跟着翻转。
    // ── 2026-10-26：产品定案「点图标**一定**打开标签管理器；有能收集的标签
    //    就先收集（存下并关掉），没有就直接打开」⇒ 标题必须同时说清
    //    **两件都会发生的事**：打开管理器 + 破坏性地关掉标签。
    //
    // 悬停标题是用户点之前**唯一**能看到的说明。它若只说一半，用户预期就会错：
    // 只说「打开」⇒ 他不知道标签会被关掉；只说「保存」⇒ 他不知道会看到管理器。
    assert.match(
      action.default_title,
      /标签管理器/,
      '悬停标题必须说明点图标会打开标签管理器（这是 1.29.0 起不变的承诺）'
    );
    assert.match(
      action.default_title,
      /保存|save/i,
      '悬停标题必须说明点图标会保存'
    );
    assert.match(
      action.default_title,
      /关闭|close/i,
      '悬停标题必须说明点图标会关掉这些标签 —— 破坏性动作不许藏着'
    );
    assert.doesNotMatch(
      action.default_title,
      /只打开|仅打开/,
      '点图标不只打开管理器，还会收集 —— 悬停标题说「只打开」就是在骗用户'
    );
  });

  it('options_ui 在独立标签页打开（open_in_tab）', () => {
    assert.equal(
      manifest().options_ui.open_in_tab,
      true,
      '设置页必须在独立标签页打开 —— WebDAV 表单塞不进瞬态下拉'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 代码里打开管理页的方式
// ─────────────────────────────────────────────────────────────────────────

describe('打开管理页的实现与 manifest 一致', () => {
  it('管理页是用 tabs.create 打开的标签页', () => {
    const src = read('src/background/TabManager.ts');
    assert.match(
      src,
      /chrome\.tabs\.create\(\{\s*url:\s*this\.getExtensionUrl\(\)/,
      '管理页必须作为标签页打开（与无 default_popup 的 manifest 一致）'
    );
  });

  it('没有依赖 popup 尺寸的硬编码假设（管理页宽度由用户决定）', () => {
    const src = read('src/background/TabManager.ts');
    assert.doesNotMatch(
      src,
      /400|256/,
      '打开管理页的代码里不该出现 popup 尺寸假设'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. 文档里不得再把管理页说成「扩展弹窗」
// ─────────────────────────────────────────────────────────────────────────

describe('文档不得把管理页说成扩展弹窗', () => {
  it('商店文案（提交给审核方）里没有「扩展弹窗」的说法', () => {
    const store = read('CHROMEWEBSTORE.md');
    assert.doesNotMatch(
      store,
      /扩展弹窗/,
      '审核方点开看到的是一个标签页；说「扩展弹窗」既不准确也让人困惑'
    );
  });

  it('README 也不把管理页说成 popup', () => {
    const readme = read('README.md');
    assert.doesNotMatch(
      readme,
      /扩展弹窗|弹窗的真实宽度/,
      'README 同样不该继承错误前提'
    );
  });

  it('设置页关于 256px 的说明保留（那是 Chrome 下拉菜单的真实上限，与管理页无关）', () => {
    // ⚠️ 这条是**反向**守卫：`src/options/index.tsx` 里的「popup 宽度上限只有
    // 256px」说的是 Chrome 的**下拉菜单**上限，是事实，不能被上面的清理误伤。
    const src = read('src/options/index.tsx');
    assert.match(src, /256px/, '设置页的 256px 说明是真事实，必须保留');
  });
});
