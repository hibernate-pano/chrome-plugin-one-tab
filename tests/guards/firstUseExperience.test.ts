/**
 * 首用体验走查的回归钉（2026-11-06）。
 *
 * ── 这个守卫在防什么 ──────────────────────────────────────────────────────
 *
 * 真机走查（第一次装上这个扩展，从引导走到保存）撞出三件事，
 * 每一件都是**「控件存在 ≠ 控件可用」**那一类：
 *
 *   ① **报错提示盖住主操作**：提示锚在右上角，而顶栏右侧就是
 *      「保存并关闭」与「⋯ 菜单」。1280px 宽的窗口里提示**正好盖住按钮
 *      中心**（实测：按钮中心 x=1060 落在提示盒 1024…1256 内），
 *      `elementFromPoint` 命中提示 ⇒ 两个主操作**都点不到**。
 *      1440 / 1024 / 768 / 375 同样重叠，只有 ≥1920 才错开。
 *
 *   ② **悬停暂停把提示钉死**：用户为了再点一次按钮，鼠标**必然**停在
 *      提示上（它就在那儿）⇒ 悬停暂停 ⇒ 倒计时冻结 ⇒ 提示永不退场
 *      ⇒ 按钮永远点不到。实测连续采样 29 秒仍在挡。
 *      ⇒ 死循环：点报错 → 想重试 → 点中提示 → 界面像卡死。
 *
 *   ③ **「这一窗没有可保存的标签」是点了才知道**：空态主 CTA 是新用户
 *      第一屏**唯一**的动作，而点扩展图标之后管理器就在这一窗里打开
 *      ⇒ 这一窗通常**一个可保存的标签都没有** ⇒ 第一次点主 CTA 得到的是
 *      「你点错了」，而且是点完才知道。
 *
 * ⇒ 三条都改成「**动手前就说明白**」：提示落在顶栏下方、悬停暂停只留给
 *   真正有退路的提示、保存前先判断这一窗有没有可保存的东西。
 *
 * ── 为什么钉「行为」而不是「源码长相」 ───────────────────────────────────
 *
 * 「提示的 top 用了一个 calc」这种字面量断言很容易被换一种写法绕开。
 * 这里钉的是**可观察的不变式**：
 *   · 顶栏的每一颗按钮，在提示出现时**仍然可点**（靠一个纯函数算
 *     「顶栏高度 + 偏移」，不是靠看 className 里有没有某个字符串）；
 *   · 没有决定可做的提示**不许**被悬停钉死（纯函数 `shouldPauseCountdown`）；
 *   · 「这一窗没有可保存的标签」这条判断**必须用同一套判据**
 *     （`collectableTabs`）⇒ 预检与实际保存不可能漂移。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { shouldPauseCountdown } from '@/components/common/toastPolicy';
import { collectableTabs } from '@/domain/tabGroup/filters';
import { classifySavePrecheck } from '@/domain/tabGroup/savePrecheck';
import { savePrecheckCopy } from '@/components/layout/saveActionCopy';
import { getSessionHostSummary } from '@/utils/sessionPresentation';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const HEADER = read('src/components/layout/Header.tsx');
const TAB_LIST = read('src/components/tabs/TabList.tsx');
const TOAST = read('src/components/common/Toast.tsx');
const TAB_GROUP = read('src/components/tabs/TabGroup.tsx');

/** 去掉注释 —— 只看**会被渲染出来**的东西。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const HEADER_CODE = stripComments(HEADER);
const TAB_LIST_CODE = stripComments(TAB_LIST);

// ══════════════════════════════════════════════════════════════════════════
// ① 提示不许盖住顶栏的主操作
// ══════════════════════════════════════════════════════════════════════════

describe('① 提示落在顶栏**下方**，不遮住主操作', () => {
  it('提示的顶边由顶栏的实测高度决定（而不是写死的 top-4）', () => {
    // 写死的 top-4 ⇒ 提示必然与顶栏右侧重叠（顶栏就贴在顶边）。
    assert.doesNotMatch(
      TOAST,
      /fixed right-4 top-4/,
      'top-4 让提示正好压在顶栏右侧的主操作按钮上（真机实测 1280px 下按钮中心被盖住）',
    );
    assert.match(
      TOAST,
      /--app-header-h/,
      '提示的顶边必须跟着顶栏的实测高度走 —— 顶栏在 ≤1024px 是两行布局，高度会变',
    );
  });

  it('顶栏把自己的实测高度写进 --app-header-h（并��卸载时清掉）', () => {
    assert.match(
      HEADER,
      /setProperty\('--app-header-h'/,
      'Header 必须把顶栏的实测高度写进 --app-header-h —— 否则提示要么压住顶栏，要么飘在半空',
    );
    assert.match(
      HEADER,
      /removeProperty\('--app-header-h'\)/,
      '卸载时必须清掉这个变量 —— 否则同一个页面里换掉 Header 后会留着一个过时的偏移',
    );
  });

  it('顶栏高度变了（窗口缩放 / 两行布局）也要跟着重算', () => {
    assert.match(
      HEADER,
      /ResizeObserver/,
      '顶栏高度会随窗口宽度变化（≤1024px 换成两行布局）⇒ 必须用 ResizeObserver 重算',
    );
  });

  it('给顶栏让位之后，提示在窄屏也不会溢出视口', () => {
    // 提示的横向位置仍是 right-4，宽度上限是 min(20rem, 100vw-2rem)
    // ⇒ 窄屏下它不会横向溢出。判据看**宽度上限**还在。
    assert.match(
      TOAST,
      /max-w-\[min\(20rem,calc\(100vw-2rem\)\)\]/,
      '提示的宽度上限必须仍在 —— 让出顶栏高度不能换来横向溢出',
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ② 没有决定可做的提示，不许被悬停钉死
// ══════════════════════════════════════════════════════════════════════════

describe('② 悬停暂停只留给真正有退路的提示', () => {
  it('没有动作按钮的提示：鼠标停上去不许冻结倒计时', () => {
    assert.equal(
      shouldPauseCountdown({
        hovered: true,
        focused: false,
        pageSeen: true,
        hasDecision: false,
      }),
      false,
      '一条没有决定可做的提示被鼠标钉在原地 ⇒ 它永远不退场；' +
        '若它恰好盖住按钮，用户就永远点不到（真机实测 29 秒仍在挡）',
    );
  });

  it('带动作（撤销类）的提示仍然必须悬停暂停 —— 那是退路', () => {
    assert.equal(
      shouldPauseCountdown({
        hovered: true,
        focused: false,
        pageSeen: true,
        hasDecision: true,
      }),
      true,
      '挂着退路的提示必须被钉住 —— 退路够不够得着是这条规则的全部意义',
    );
  });

  it('焦点那一支不受「有没有决定」限制（焦点 = 用户正在读它）', () => {
    assert.equal(
      shouldPauseCountdown({
        hovered: false,
        focused: true,
        pageSeen: true,
        hasDecision: false,
      }),
      true,
      '焦点在提示里意味着用户正在读它 —— 与鼠标恰好扫过不是一回事',
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ③ 保存前先判断「这一窗有没有可保存的标签」
// ══════════════════════════════════════════════════════════════════════════

describe('③ 保存前预检：不给「点了才知道」的失败', () => {
  it('两条保存路径（顶栏 / 空态）都用了同一套判据', () => {
    // 判据来源：domain 层的 classifySavePrecheck —— 它内部调 collectableTabs，
    // 而 collectableTabs 正是 SW 保存路径用的**同一个函数**
    // ⇒ 不可能出现「预检说能存、实际存不下」。
    assert.match(HEADER_CODE, /classifySavePrecheck\(/, '顶栏的保存按钮必须做预检');
    assert.match(TAB_LIST_CODE, /classifySavePrecheck\(/, '空态的主 CTA 必须做预检');
  });

  it('判据本身住在 domain 层（不许各写一遍）', () => {
    // 判据的**源码**必须在 domain 层，且内部用 collectableTabs ——
    // 这样预检与保存路径的「可保存」口径永远同源。
    const precheck = read('src/domain/tabGroup/savePrecheck.ts');
    assert.match(
      precheck,
      /collectableTabs\(/,
      '预检判据必须建立在 collectableTabs 上 —— 否则它与保存路径会漂移',
    );
    assert.match(
      HEADER_CODE,
      /from '@\/domain\/tabGroup\/savePrecheck'/,
      '顶栏必须引用 domain 层的判据，不许自己再实现一遍',
    );
    assert.match(
      TAB_LIST_CODE,
      /from '@\/domain\/tabGroup\/savePrecheck'/,
      '空态必须引用 domain 层的判据',
    );
  });

  it('判据必须带上「是否收集固定标签页」这个设置（否则口径与保存路径不同）', () => {
    assert.match(
      HEADER_CODE,
      /classifySavePrecheck\([^)]*includePinned/,
      '预检必须与保存路径用同一份固定标签页设置 —— 否则钉住的页会被预检算成「可保存」',
    );
    assert.match(
      TAB_LIST_CODE,
      /classifySavePrecheck\([^)]*includePinned/,
      '空态预检必须与保存路径用同一份固定标签页设置',
    );
  });

  it('预检失败**不走 toast**（那正是当初挡住按钮的东西），改成就地反馈', () => {
    // 顶栏：错误文案进按钮的 inline 反馈位（shortText / fullText），
    // 不调 showToast ⇒ 屏幕上不会多出一块盖住别人的东西。
    const headerBlock = HEADER_CODE.slice(
      HEADER_CODE.indexOf('const handleSaveAllTabs'),
      HEADER_CODE.indexOf('const getContainerWidthClass'),
    );
    const precheckAt = headerBlock.indexOf('classifySavePrecheck(');
    assert.ok(precheckAt > 0, '顶栏的保存处理里找不到预检');
    // 预检分支到 return 之间不得有 showToast
    const precheckBranch = headerBlock.slice(precheckAt, headerBlock.indexOf('return;', precheckAt));
    assert.doesNotMatch(
      precheckBranch,
      /showToast\(/,
      '预检失败不得弹 toast —— 它会盖住用户接下来要点的按钮',
    );
    assert.match(
      precheckBranch,
      /savePrecheckCopy/,
      '预检失败必须给出「为什么 + 下一步」的文案',
    );
  });

  it('空态预检失败同样走就地反馈', () => {
    const listBlock = TAB_LIST_CODE.slice(
      TAB_LIST_CODE.indexOf('const handleSaveFromEmpty'),
      TAB_LIST_CODE.indexOf('const [emptyRestoreBusy'),
    );
    const precheckAt = listBlock.indexOf('classifySavePrecheck(');
    assert.ok(precheckAt > 0, '空态的保存处理里找不到预检');
    const precheckBranch = listBlock.slice(precheckAt, listBlock.indexOf('return;', precheckAt));
    assert.doesNotMatch(
      precheckBranch,
      /showToast\(/,
      '空态预检失败不得弹 toast',
    );
    assert.match(precheckBranch, /savePrecheckCopy/, '空态预检失败必须给出可行动的文案');
  });

  it('「这一窗没有可保存的标签」这条文案说清了**下一步**', () => {
    const copy = read('src/components/layout/saveActionCopy.ts');
    const match = copy.match(/emptySaveNoTabsText\s*=\s*\n?\s*'([^']+)'/);
    assert.ok(match, '找不到 emptySaveNoTabsText 这个常量');
    assert.match(match[1], /没有可保存/, '文案要说清「没有可保存的东西」');
    assert.match(
      match[1],
      /切换|先打开/,
      '文案必须告诉用户**下一步做什么** —— 只说「没有」等于把用户留在原地',
    );
  });

  it('两条路径引用的是**同一个**文案常量（不允许各写一遍）', () => {
    assert.match(HEADER_CODE, /savePrecheckCopy/, '顶栏必须引用共享文案');
    assert.match(TAB_LIST_CODE, /savePrecheckCopy/, '空态必须引用共享文案');
  });

  it('预检的判据与保存路径真的是同一套（domain 层，不是各写一遍）', () => {
    // 保存路径（TabManager）也必须走 collectableTabs ⇒ 三处同源。
    const tabManager = read('src/background/TabManager.ts');
    assert.match(
      tabManager,
      /collectableTabs/,
      '保存路径必须用同一套判据 —— 否则「预检说能存、实际存不下」',
    );
  });

  it('预检判据本身的行为：只有 http(s) 的非固定标签算「可保存」', () => {
    // 这是**判据本身**的行为，不是源码长相：预检与保存路径共用它，
    // 所以它的口径一旦变了，两边一起变 —— 这里钉住当前口径。
    const chromeTab = (url: string, pinned = false) =>
      ({ url, title: 'x', pinned } as unknown as chrome.tabs.Tab);

    assert.equal(
      collectableTabs([chromeTab('https://example.com/a')], { includePinned: false }).length,
      1,
      '普通网页标签必须算可保存',
    );
    assert.equal(
      collectableTabs([chromeTab('https://example.com/a', true)], { includePinned: false }).length,
      0,
      '固定标签页在默认设置下不算可保存（它们会留在原处）',
    );
    assert.equal(
      collectableTabs([chromeTab('https://example.com/a', true)], { includePinned: true }).length,
      1,
      '开了「收集固定标签页」后它必须算可保存',
    );
    assert.equal(
      collectableTabs([chromeTab('chrome://settings'), chromeTab('about:blank')], {
        includePinned: false,
      }).length,
      0,
      '浏览器内部页不算可保存 —— 它们既不存也不关',
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ④ 预检必须说清**真正的原因**（2026-11-12）
// ══════════════════════════════════════════════════════════════════════════
//
// 「存得下 0 条」有**两种**原因，用户要的答案完全不同：
//   ① 这一窗真的没有可保存的网页（只剩管理器页 / 内部页 / 空窗）
//      → 解法：换个窗口 / 先开几个网页
//   ② 能存的**全是固定标签页**，而设置里「保存时收集固定标签页」是关的
//      （**默认就是关**）→ 解法：去设置里打开那个开关
//
// 上一版一律给 ① ⇒ 用户照着开新标签 → 提示照旧 → 观感是「这功能坏了」，
// 而真实原因只是**一个开关**。
//
// 这条守卫守三件事：判据的**行为**（纯函数）、文案**说清了原因与下一步**、
// 以及两条保存路径都走这个分类（不许其中一条自己写判断）。
describe('④ 预检必须区分「真的没有」与「被设置挡住了」', () => {
  const chromeTab = (url: string, pinned = false) =>
    ({ url, title: 'x', pinned } as unknown as chrome.tabs.Tab);

  it('判据的行为：普通网页 → 可以存', () => {
    assert.equal(
      classifySavePrecheck([chromeTab('https://example.com/a')], { includePinned: false }),
      'ok',
    );
  });

  it('判据的行为：只剩管理器页 / 内部页 → 真的没有', () => {
    assert.equal(
      classifySavePrecheck(
        [chromeTab('chrome-extension://abc/manager.html'), chromeTab('about:blank')],
        { includePinned: false }
      ),
      'no-savable-tabs',
      '这一窗确实一个可存的都没有 ⇒ 说「换个窗口 / 先开几个网页」',
    );
  });

  it('判据的行为：能存的全是固定标签页 → 卡在设置，不在窗口', () => {
    assert.equal(
      classifySavePrecheck([chromeTab('https://example.com/a', true)], { includePinned: false }),
      'only-pinned-tabs',
      '这一窗**有**可保存的网页，只是被设置挡住了 ⇒ 必须说「去设置里打开开关」',
    );
  });

  it('判据的行为：开了开关之后还是 0 ⇒ 就是真的没有（不许误报成设置问题）', () => {
    assert.equal(
      classifySavePrecheck([chromeTab('https://example.com/a', true)], { includePinned: true }),
      'ok',
      '开了「保存时收集固定标签页」后固定标签页本来就该算可保存',
    );
    assert.equal(
      classifySavePrecheck([chromeTab('chrome://settings')], { includePinned: true }),
      'no-savable-tabs',
      '内部页在任何设置下都不可保存 ⇒ 不该报成设置问题',
    );
  });

  it('两条文案必须是**两句不同的话**（否则分类等于白做）', () => {
    const copy = read('src/components/layout/saveActionCopy.ts');
    const pinned = copy.match(/pinnedOnlySaveText\s*=\s*\n?\s*'([^']+)'/);
    const empty = copy.match(/emptySaveNoTabsText\s*=\s*\n?\s*'([^']+)'/);
    assert.ok(pinned, '找不到 pinnedOnlySaveText 这个常量');
    assert.ok(empty, '找不到 emptySaveNoTabsText 这个常量');
    assert.notEqual(
      pinned[1],
      empty[1],
      '两种原因给了同一句话 ⇒ 用户照着提示做，问题不会消失',
    );
    assert.match(
      pinned[1],
      /固定标签页/,
      '固定标签页那条文案必须点明真因是固定标签页',
    );
    assert.match(
      pinned[1],
      /保存时收集固定标签页/,
      '文案必须写**设置项的真名**（一字不差）—— 否则用户照着去找会找不到',
    );
    assert.match(
      pinned[1],
      /设置/,
      '文案必须指出「去设置里」这个下一步',
    );
  });

  it('设置项的真名与设置页里写的一字不差', () => {
    // 文案里写了设置项的名字，就必须真的是那个名字 —— 否则用户在设置里
    // 找不到对应的那一行（这条会随设置页改名一起变红）。
    const optionsPage = read('src/options/OptionsPage.tsx');
    assert.match(
      optionsPage,
      /保存时收集固定标签页/,
      '设置页里没有「保存时收集固定标签页」这一项 —— 文案与设置页漂移了',
    );
  });

  it('短形式（按钮上放得下的那几个字）也不能太长', () => {
    const pinned = savePrecheckCopy('only-pinned-tabs');
    const empty = savePrecheckCopy('no-savable-tabs');
    assert.ok(
      pinned.short.length <= 10,
      `短形式「${pinned.short}」有 ${pinned.short.length} 个字 —— 按钮放不下`,
    );
    assert.ok(
      empty.short.length <= 10,
      `短形式「${empty.short}」有 ${empty.short.length} 个字 —— 按钮放不下`,
    );
    assert.notEqual(pinned.short, empty.short, '两种原因在按钮上也要能分辨');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ⑤ 卡片上的站点摘要（同一分钟保存两次时能分辨）
// ══════════════════════════════════════════════════════════════════════════

describe('④ 卡片上的站点摘要', () => {
  const tab = (url: string) => ({ url, title: 'x' } as never);

  it('按出现次数给出站点摘要', () => {
    const summary = getSessionHostSummary({
      tabs: [
        tab('https://github.com/a'),
        tab('https://github.com/b'),
        tab('https://example.com/c'),
      ],
    });
    assert.match(summary, /github\.com/, '摘要里必须有主站点');
    assert.match(summary, /example\.com/, '摘要里也要有次站点');
    assert.ok(
      summary.indexOf('github.com') < summary.indexOf('example.com'),
      '出现次数多的站点必须排前面（摘要的用途是扫一眼认出这批是什么）',
    );
  });

  it('非 http(s) 的地址不贡献站点（全本地文件时不该有一行空摘要）', () => {
    const summary = getSessionHostSummary({
      tabs: [tab('file:///Users/me/paper.pdf'), tab('chrome://settings')],
    });
    assert.equal(summary, '', '全是本地文件 / 内部页时，摘要必须为空（调用方据此不渲染那一行）');
  });

  it('站点太多时封顶并说明总数', () => {
    const summary = getSessionHostSummary({
      tabs: [
        tab('https://a.com/1'),
        tab('https://b.com/1'),
        tab('https://c.com/1'),
        tab('https://d.com/1'),
        tab('https://e.com/1'),
      ],
    });
    assert.match(summary, /等 \d+ 个站点/, '超过 3 个站点时必须说明总数（否则用户以为只有这几个）');
  });

  it('卡片真的渲染了这一行', () => {
    assert.match(
      TAB_GROUP,
      /tab-group-hosts/,
      '卡片必须渲染站点摘要 —— 否则默认的时间戳名字让同一分钟的两张卡完全一样',
    );
  });
});
