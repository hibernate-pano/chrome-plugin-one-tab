/**
 * 2026-10-19 专家评审 · 界面批的回归守卫。
 *
 * 覆盖本轮修掉的六条界面问题：
 *   F-1（P0）400px 的 popup 里搜索框被压成 0 宽 —— 「找回」入口整框消失
 *   I-1     首屏两张大卡 + 两个同义主 CTA
 *   I-2     设置页信息架构倒置（唯一要配的「同步」在首屏之外）
 *   I-3     顶栏「保存」的可见文字不披露「会关闭标签」
 *   V-3     窄屏卡头 6 颗按钮把标题挤成 74px
 *   V-5     不可撤销的删除用 warning 琥珀色确认按钮
 *   V-6     弹层不跟主题（暖色主题里弹出一块冷蓝面板）
 *   V-7     tooltip 撑破视口
 *   C-1     popup 声明 lang="en" 而界面全中文
 *   C-7     菜单声明 role="menu" 却没有 menuitem / 方向键
 *
 * 【为什么这些用源码结构断言】仓库没有 DOM 测试环境（无 jsdom /
 * @testing-library），.tsx 加载不了 —— 沿用本仓既有惯例
 * （见 guards/focusRingVisibility.test.ts 等）。
 *
 * 【判据纪律】每条都钉住**具体的失效形态**（例如「搜索那一列不能是
 * minmax(0, 1fr) 且操作区不许 flex-shrink:0」），而不是「有某段 CSS」。
 * 否则把实现改回原样照样全绿。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');
const code = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

const GLOBAL_CSS = code('src/styles/global.css');
const HEADER = code('src/components/layout/Header.tsx');
const TAB_LIST = code('src/components/tabs/TabList.tsx');
const TAB_GROUP = code('src/components/tabs/TabGroup.tsx');
const OPTIONS = code('src/options/OptionsPage.tsx');
const SYNC_BUTTON = code('src/components/sync/SyncButton.tsx');
const MODAL = code('src/components/common/ModalFrame.tsx');
const TOOLTIP = code('src/components/common/Tooltip.tsx');
const DROPDOWN = code('src/components/layout/HeaderDropdown.tsx');

// ══════════════════════════════════════════════════════════════════════════
// F-1（P0）：搜索框不许塌陷
// ══════════════════════════════════════════════════════════════════════════
describe('F-1（P0）搜索框在任何宽度都不许塌陷到 0 宽', () => {
  it('窄屏时搜索独占一行（grid-template-areas），不与品牌/操作区抢宽度', () => {
    // 判据要数**块**：两处窄屏媒体查询（≤640 与 641–1024）都必须让搜索独占一行。
    // 只断言「文件里存在这么一处」会被另一处满足 —— 变异掉其中一处照样全绿。
    const blocks = [...GLOBAL_CSS.matchAll(/grid-template-areas:\s*([\s\S]{0,120}?);/g)];
    assert.ok(blocks.length >= 2, `至少要有两处窄屏栅格（实际 ${blocks.length}）`);
    for (const [, body] of blocks) {
      assert.match(
        body,
        /['"]brand actions['"]\s*['"]search search['"]/,
        `每一处窄屏栅格都必须让搜索独占第二行 —— 挤在同一行它永远是输家（实际：${body.trim()}）`
      );
    }
  });

  it('窄屏栅格的操作区列不许是可压没的 1fr', () => {
    // 原来的三段栅格是 `auto | minmax(0, 1fr) | auto`：中间那列是搜索，
    // 下限 0 意味着可以被压没。窄屏改成两列后，第二列是**操作区**
    // （`auto`）而搜索独占整行 —— 第二列不能再是 1fr。
    const blocks = [...GLOBAL_CSS.matchAll(/grid-template-areas:\s*([\s\S]{0,240}?);/g)];
    assert.ok(blocks.length >= 2, `至少要有两处窄屏栅格（实际 ${blocks.length}）`);
    for (const [, body] of blocks) {
      const cols = body.match(/grid-template-columns:\s*([^;]+)/);
      if (!cols) continue;
      assert.doesNotMatch(
        cols[1],
        /minmax\(0,\s*1fr\)/,
        `窄屏栅格不得再有 minmax(0, 1fr) 列：那一列可以被压成 0 宽（${cols[1].trim()}）`
      );
    }
  });

  it('搜索与操作区在窄屏不同行（不共处一列 ⇒ 不会被压没）', () => {
    // 真正的失效形态是「两者在同一个网格行里抢宽度」。
    // （注：`.app-header-actions` 是**网格项**不是 flex 子项，
    //   `flex-shrink` 对它无效 —— 根因是栅格轨道 minmax(0, 1fr) 可被压到 0，
    //   所以判据是「不同行」而不是「flex-shrink」。）
    assert.match(
      GLOBAL_CSS,
      /grid-template-areas:[\s\S]{0,80}?['"]search search['"]/,
      '搜索必须横跨整行'
    );
  });

  it('同步按钮在 lg 以下收成图标（不再占 148px 的文字宽度）', () => {
    assert.match(SYNC_BUTTON, /hidden lg:inline">上传/);
    assert.match(SYNC_BUTTON, /hidden lg:inline">下载/);
  });

  it('同步按钮保住了可访问名称（收成图标后读屏仍有名字）', () => {
    assert.match(SYNC_BUTTON, /aria-label="上传本地会话到云端"/);
    assert.match(SYNC_BUTTON, /aria-label="从云端下载会话到本地"/);
  });

  it('极窄屏时品牌名让位（320px 下品牌与操作区曾重叠）', () => {
    assert.match(GLOBAL_CSS, /@media \(max-width: 380px\)/);
    assert.match(HEADER, /app-header-brand-name/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// I-1：空态只有一张卡、一个主 CTA
// ══════════════════════════════════════════════════════════════════════════
describe('I-1 空态收敛成一张卡、一个主 CTA', () => {
  it('空态分支只渲染一张卡', () => {
    // 分支边界要按**出现顺序**取：空态分支在「加载失败」分支**之后**，
    // 用 indexOf('if (error...)') 当下界会切出一段空区间，断言恒等于 1 —— 假绿。
    const branchAt = TAB_LIST.indexOf('if (filteredGroups.length === 0 && !searchQuery) {');
    assert.ok(branchAt !== -1, '找不到空态分支');
    const endAt = TAB_LIST.indexOf('\n  return (', branchAt);
    assert.ok(endAt > branchAt, '找不到空态分支的结束位置');
    const body = TAB_LIST.slice(branchAt, endAt);
    // 数**卡**而不是数 EmptyState：欢迎卡是 div.tab-group-card，
    // 数 EmptyState 的话「多插一张欢迎卡」根本不会被这条断言发现。
    const emptyState = (body.match(/<EmptyState/g) ?? []).length;
    const welcomeCard = (body.match(/tab-group-card/g) ?? []).length;
    assert.equal(emptyState, 1, `空态只允许一个 EmptyState（实际 ${emptyState}）`);
    assert.equal(
      welcomeCard,
      0,
      `空态不得再叠一张 tab-group-card 欢迎卡（实际 ${welcomeCard} 张）`
    );
  });

  it('欢迎卡组件已被删除（它占 43% 视口高度却零操作价值）', () => {
    assert.doesNotMatch(
      TAB_LIST,
      /<PersonalizedWelcome/,
      '空态不再叠第二张欢迎卡'
    );
  });

  it('顶栏在空态时降为次级（避免两个同色主 CTA）', () => {
    assert.match(
      HEADER,
      /groups\.length === 0 \? 'btn-secondary' : 'btn-primary'/,
      '空态时顶栏保存按钮必须降为次级样式'
    );
  });

  it('保存 CTA 的措辞只有一个来源', () => {
    assert.match(TAB_LIST, /saveAndCloseLabel/);
    assert.match(HEADER, /saveAndCloseLabel/);
    assert.match(
      read('src/components/layout/saveActionCopy.ts'),
      /export const saveAndCloseLabel/,
      '两处必须共用同一个常量'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// I-2：设置页信息架构
// ══════════════════════════════════════════════════════════════════════════
describe('I-2 设置页：数据同步排在外观之前', () => {
  it('DOM 顺序是 同步 → 自带存储 → 标签页 → 外观', () => {
    const sync = OPTIONS.indexOf('aria-labelledby="sec-sync"');
    const webdav = OPTIONS.indexOf('aria-labelledby="sec-webdav"');
    const tabs = OPTIONS.indexOf('aria-labelledby="sec-tabs"');
    const appearance = OPTIONS.indexOf('aria-labelledby="sec-appearance"');
    assert.ok([sync, webdav, tabs, appearance].every(i => i > -1), '四个区块都要存在');
    assert.ok(sync < appearance, '数据同步必须在外观之前（它是唯一需要配置的外部依赖）');
    assert.ok(webdav < appearance, '自带存储配置在外观之前');
    assert.ok(tabs < appearance, '标签页在外观之前');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// I-3：保存的可见文字必须披露「会关闭」
// ══════════════════════════════════════════════════════════════════════════
describe('I-3 保存按钮的可见文字必须说清「会关闭标签」', () => {
  it('可见文案本身带「关闭」二字（不只写在 tooltip 里）', () => {
    const copy = read('src/components/layout/saveActionCopy.ts');
    const match = copy.match(/export const saveAndCloseLabel = '([^']+)'/);
    assert.ok(match, '找不到 saveAndCloseLabel');
    assert.match(match[1], /关闭/, '可见文案必须含「关闭」—— 否则用户点下去才发现窗口被清空');
  });

  it('顶栏按钮的可见 span 用的是这个常量', () => {
    assert.match(HEADER, /saveAndCloseLabel/);
    assert.doesNotMatch(
      HEADER,
      /'保存会话'/,
      '旧文案「保存会话」不含「关闭」，不得复活'
    );
  });

  it('说明文案讲清了「删除不可撤销」', () => {
    const copy = read('src/components/layout/saveActionCopy.ts');
    assert.match(copy, /不可撤销/);
  });

  it('引导的聚光灯锚点跟着 aria-label 走', () => {
    const guide = code('src/components/onboarding/OnboardingGuide.tsx');
    assert.match(guide, /saveAndCloseDescription/, '锚点必须引用共享常量，不能各写一遍');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// V-3：窄屏卡头降级
// ══════════════════════════════════════════════════════════════════════════
describe('V-3 窄屏卡头：只留核心动作，其余收进「更多」', () => {
  it('次要操作在窄屏隐藏（hidden sm:inline-flex）', () => {
    // 精确数量，不是「至少 N」：阈值会被「少一处」骗过 ——
    // 少一颗就意味着那颗在窄屏仍然平铺，又把标题挤窄了。
    const hidden = (TAB_GROUP.match(/hidden sm:inline-flex/g) ?? []).length;
    assert.equal(hidden, 4, `四颗次要按钮都要收进「更多」（实际 ${hidden}）`);
  });

  it('「恢复整个会话」在窄屏仍然常驻（它是零学习成本的核心动作）', () => {
    const restoreBlock = TAB_GROUP.match(/<button[^>]*onClick=\{handleOpenAllTabs\}/);
    assert.ok(restoreBlock, '找不到恢复按钮');
    assert.doesNotMatch(
      restoreBlock[0],
      /hidden sm:/,
      '恢复按钮不许在窄屏被隐藏'
    );
  });

  it('存在一个窄屏可见的「更多操作」菜单', () => {
    assert.match(TAB_GROUP, /<details className="sm:hidden relative"/);
    assert.match(TAB_GROUP, /的更多操作/);
  });

  it('菜单面板 portal 到 body（否则被卡片的 transform 层叠上下文困住）', () => {
    // 2026-10-19 审计 P0-2：会话卡的 `animate-in` 带 transform（fadeInUp 的
    // to 帧 translateY(0) + forwards），于是**每张卡都是 stacking context**。
    // 面板若是卡的子元素，z-index 只在卡内有效 ⇒ 窄屏下「删除会话」那一行
    // elementFromPoint 命中的是背后的标签行，**完全点不到**。
    // 解法是 portal 到 body + position: fixed。
    assert.match(TAB_GROUP, /createPortal\(/, '菜单面板必须 portal 到 body');
    assert.match(TAB_GROUP, /position:\s*'fixed'/, 'portal 出去的面板必须用 fixed 定位');
    assert.match(TAB_GROUP, /document\.body/, 'portal 的挂载点必须是 body');
  });

  it('菜单能通过外部点击与 Esc 收起（键盘用户没有任何出口）', () => {
    assert.match(TAB_GROUP, /'Escape'/, 'Esc 必须能关闭菜单');
    assert.match(TAB_GROUP, /closeMoreMenu/, '必须有统一的关闭函数');
    assert.match(TAB_GROUP, /addEventListener\('click'/, '外部点击必须能关闭');
  });

  it('点完菜单项后菜单自动收起（否则浮层压住刚打开的编辑框）', () => {
    // P2-9：点「重命名会话」后菜单不收，浮在输入框上面。
    const closeCalls = (TAB_GROUP.match(/closeMoreMenu\(\);/g) ?? []).length;
    assert.ok(closeCalls >= 4, `四个菜单项都要先收起菜单（实际 ${closeCalls} 处调用）`);
  });

  it('「更多」菜单里包含被收起来的那几项', () => {
    for (const label of ['在当前窗口打开', '重命名会话', '解锁会话', '锁定会话', '删除会话']) {
      assert.match(TAB_GROUP, new RegExp(label), `「更多」菜单里必须有「${label}」`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// V-5：不可撤销的删除用 danger
// ══════════════════════════════════════════════════════════════════════════
describe('V-5 不可撤销的删除必须用 danger 确认按钮', () => {
  it('清理重复标签的确认框是 danger（不是 warning）', () => {
    // 以标题为锚点切出这一处 showConfirm（块里有嵌套的 {}，不能用 `\}\);` 收尾）。
    const at = HEADER.indexOf("title: '确认清理重复标签和空会话'");
    assert.ok(at > -1, '找不到清理重复的确认框');
    const block = HEADER.slice(Math.max(0, at - 200), at + 400);
    assert.match(block, /type: 'danger'/, '「此操作无法撤销」的删除必须用 danger');
    assert.doesNotMatch(block, /type: 'warning'/, 'warning 琥珀色表达的是「提醒」，不是「要真删」');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// V-6：弹层跟主题
// ══════════════════════════════════════════════════════════════════════════
describe('V-6 弹层必须跟主题', () => {
  it('ModalFrame 的弹层本体不写死 slate 配色', () => {
    // 判据只针对**弹层本体**（role="dialog" 的那块面板）：
    // 背景遮罩（bg-slate-950/55 半透明黑幕）是压暗底层用的，与主题无关，
    // 留着是对的 —— 把它一起禁掉会误伤。
    // 弹层的 className 是**模板字符串**（含 ${maxWidthClassName}），
    // 用 overflow-hidden 锚定它（关闭按钮没有这个类）。
    const panel = MODAL.match(/className=\{?`(.+?overflow-hidden.+?)`\}?/);
    assert.ok(panel, '找不到弹层 className，守卫前提变了');
    assert.doesNotMatch(panel[1], /bg-slate-/, '弹层底色不得写死 slate（暖色主题下是冷蓝补丁）');
    assert.doesNotMatch(panel[1], /text-slate-/, '弹层文字不得写死 slate');
    assert.match(panel[1], /theme-bg-elevated/);
    assert.match(panel[1], /theme-border-default/);
    assert.match(panel[1], /theme-radius-panel/);
  });

  it('ModalFrame 的标题与正文走主题文字色', () => {
    assert.match(MODAL, /theme-text-primary/, '标题必须走主题文字色');
    assert.match(MODAL, /theme-text-secondary/, '正文必须走主题文字色');
  });

  it('ConfirmDialog 的取消按钮也跟主题', () => {
    const confirm = code('src/components/common/ConfirmDialog.tsx');
    const cancel = confirm.match(/onClick=\{onCancel\}[\s\S]*?className="([^"]+)"/);
    assert.ok(cancel, '找不到取消按钮');
    assert.doesNotMatch(cancel[1], /bg-slate-/, '取消按钮不得写死 slate');
    assert.match(cancel[1], /theme-bg-tertiary/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// V-7：tooltip 不撑破视口
// ══════════════════════════════════════════════════════════════════════════
describe('V-7 tooltip 不得撑破视口', () => {
  it('允许换行且宽度跟着视口走', () => {
    assert.match(TOOLTIP, /whitespace-normal/, 'tooltip 不得 nowrap（400px 下会撑到 466px）');
    assert.match(TOOLTIP, /max-w-\[min\(/, '宽度上限必须跟着视口走');
    assert.doesNotMatch(TOOLTIP, /whitespace-nowrap/, '旧的 nowrap 不得复活');
  });

  it('提示条靠右对齐（居中锚点在窄屏会有一半在视口外）', () => {
    const pos = TOOLTIP.match(/getPositionClasses[\s\S]{0,900}?\};/);
    assert.ok(pos, '找不到 getPositionClasses');
    assert.match(pos[0], /right-0/, 'top/bottom 方向必须靠右对齐');
    assert.doesNotMatch(pos[0], /left-1\/2/, '居中锚点会被视口右缘切掉');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// C-1：html lang 与界面语言一致
// ══════════════════════════════════════════════════════════════════════════
describe('C-1 内置页面的 lang 与界面语言一致', () => {
  it('popup / 设置页 / 隐私页都是 zh-CN', () => {
    for (const rel of ['src/popup/index.html', 'src/options/index.html', 'src/legal/privacy.html', 'popup.html']) {
      const html = read(rel);
      const lang = html.match(/<html[^>]*\blang="([^"]+)"/)?.[1];
      assert.equal(lang, 'zh-CN', `${rel} 的 lang 必须是 zh-CN（界面全中文，实际 ${lang}）`);
    }
  });

  it('界面上没有残留的英文可见文案', () => {
    // 页脚原来的英文 tagline 已在本轮之前移除；这里防它回来。
    assert.doesNotMatch(HEADER, /Save the session/);
    assert.doesNotMatch(TAB_LIST, /Find it later/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// C-7：菜单语义
// ══════════════════════════════════════════════════════════════════════════
describe('C-7 菜单的 role="menu" 必须配套 menuitem 与方向键', () => {
  it('容器声明 role="menu"', () => {
    assert.match(DROPDOWN, /role="menu"/);
  });

  it('每一行菜单项都带 role="menuitem"', () => {
    // 精确计数，不是「至少 N」：阈值会被「少一处」骗过 ——
    // 少一颗就意味着那一行在读屏里不再是菜单项。
    //
    // 判据：**菜单行**（用 MENU_ROW 样式的那些 button）必须带 menuitem。
    // 状态卡里的「去登录 / 去设置」是内联链接，不是菜单行 —— 它们用
    // text-xs + underline 造型，与菜单行（MENU_ROW）区分得开。
    //
    // 判据：**菜单行**（用 MENU_ROW 样式的那些 button）必须带 menuitem。
    // 状态卡里的「去登录 / 去设置」是内联链接，不是菜单行 —— 它们用
    // text-xs + underline 造型，与菜单行（MENU_ROW）区分得开。
    //
    // 数法：数「MENU_ROW 按钮里带 menuitem 的」与「MENU_ROW 按钮总数」，
    // 两者必须相等。用「menuitem 总数 ≥ 菜单行数」会被多出来的几个
    // （刷新按钮、删除全部、选择器字符串里的那个）骗过 ——
    // 拿掉一行菜单的角色，总数仍然 ≥ 行数，断言却照样绿。
    const menuRowButtons = (DROPDOWN.match(/<button\b[^>]*?className=\{MENU_ROW/g) ?? []).length;
    const menuRowItems = (DROPDOWN.match(/<button\b[^>]*?role="menuitem"[^>]*?className=\{MENU_ROW/g) ?? []).length;
    assert.ok(menuRowButtons > 0, '菜单里应该有 MENU_ROW 行');
    assert.equal(
      menuRowItems,
      menuRowButtons,
      `每一行菜单项都要带 role="menuitem"（${menuRowButtons} 行菜单，实际 ${menuRowItems} 行带角色）`
    );
  });

  it('实现了方向键移动（↑/↓/Home/End）', () => {
    assert.match(DROPDOWN, /ArrowDown/);
    assert.match(DROPDOWN, /ArrowUp/);
    assert.match(DROPDOWN, /'Home'/);
    assert.match(DROPDOWN, /'End'/);
  });

  it('方向键只接管焦点已在菜单内的情况（打开后 ↓ 进入第一项）', () => {
    assert.match(DROPDOWN, /currentIndex === -1/, '焦点不在菜单内时要能「进入菜单」');
    assert.match(DROPDOWN, /items\[target\]\.focus\(\)/);
  });
});
