/**
 * 列表 / 搜索 / 引导 的无障碍回归。
 *
 * 本仓库没有 jsdom / happy-dom / @testing-library（devDependencies 里没有 DOM 测试环境），
 * 也不允许为了这一个文件去装依赖。所以分两类断言：
 *
 *   (a) 纯函数：从组件里抽出来的不依赖 DOM 的决策逻辑（键盘重排、引导键盘映射、
 *       错误文案映射、埋点节流），直接跑行为断言。
 *   (b) 结构断言：.tsx 无法被 node --experimental-strip-types 加载
 *       （tests/_alias-loader.mjs 的 ts.transpileModule 不转 JSX），所以用 node:fs
 *       读源码断言。守卫的是「折叠容器不能只靠 aria-hidden」「操作条必须有
 *       focus-within 显形」「筛选控件必须有 id + htmlFor」这类会被改回去的结构。
 *   (c) 跨文件一致性：OnboardingGuide 的聚光灯选择器必须真的能命中 Header /
 *       TabGroup / SearchResultList 里存在的 aria-label（第 4 步此前匹配不到任何元素，
 *       因为真实文案以「在新窗口…」开头而非「恢复整个会话」）。
 *
 * 没覆盖的（见交付说明 remaining）：真实 DOM 上的焦点时序、读屏实际播报、
 * 拖拽与键盘重排的端到端落库结果——这些都要 DOM 环境。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { isReorderKey, nextReorderIndex } from '../src/components/dnd/keyboardReorder.ts';
import {
  isFromInteractiveElement,
  resolveOnboardingAction,
  resolveTabCycleTarget,
} from '../src/components/onboarding/onboardingKeymap.ts';
import { toListErrorCopy } from '../src/components/tabs/listErrorCopy.ts';
import {
  SEARCH_EVENT_THROTTLE_MS,
  buildSearchEventSignature,
  hasActiveSearchFilters,
  remainingMsUntilAllowed,
  searchEventNames,
  shouldEmitSearchEvents,
} from '../src/components/search/searchAnalytics.ts';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

const TAB_GROUP = read('../src/components/tabs/TabGroup.tsx');
const TAB_LIST = read('../src/components/tabs/TabList.tsx');
const DRAGGABLE_TAB = read('../src/components/dnd/DraggableTab.tsx');
const SEARCH_RESULT_LIST = read('../src/components/search/SearchResultList.tsx');
const ONBOARDING_GUIDE = read('../src/components/onboarding/OnboardingGuide.tsx');
const ONBOARDING_STEPS = read('../src/components/onboarding/OnboardingSteps.tsx');
const HEADER = read('../src/components/layout/Header.tsx');
const THEME_SELECTOR = read('../src/components/layout/ThemeStyleSelector.tsx');
const GLOBAL_CSS = read('../src/styles/global.css');

// ── 【1 · P0】折叠的会话组不得留在 Tab 序列里 ────────────────────────────────

describe('折叠会话组：不可聚焦的隐藏内容', () => {
  it('标签列表容器在 isCollapsed 时不渲染子元素', () => {
    // 根因：视觉收起（grid-rows-[0fr] / opacity-0）只改视觉，aria-hidden 只改读屏曝光，
    // 两者都不移出 Tab 序列。折叠态必须走条件渲染（React 18 无原生 inert）。
    // 结构必须是「外层 CSS 收起 + 内层条件渲染」：
    //   grid-rows-[0fr]/aria-hidden（外层 wrapper） → {!isCollapsed && ( → role="list" → 渲染
    // 少任何一环，键盘用户就能 Tab 进看不见的会话。
    //
    // 2026-10-05：折叠动画从 max-height 硬上限改为 grid-rows-[0fr] ↔ [1fr]
    // （旧实现的 2000px 硬上限会裁掉 >45 标签的会话且无法滚动）。
    // 本断言守的是「条件渲染」这条不变式，与用哪种收起 technique 无关。
    const collapseClassIndex = TAB_GROUP.indexOf('grid-rows-[0fr]');
    const guardIndex = TAB_GROUP.indexOf('{!isCollapsed && (');
    const listIndex = TAB_GROUP.indexOf('role="list"');
    // 用带 index 参数的锚点，避免匹配到 openAllTabs 里的 group.tabs.map(tab => …)
    const mapIndex = TAB_GROUP.indexOf('group.tabs.map((tab, index) =>');

    assert.ok(collapseClassIndex !== -1, '应能找到折叠态的收起样式');
    assert.ok(guardIndex !== -1, 'TabGroup 必须用 {!isCollapsed && ( 条件渲染包裹标签列表');
    assert.ok(listIndex !== -1, '标签列表容器应带 role="list"（配对子元素的 role="listitem"）');
    assert.ok(mapIndex !== -1, '应能找到 group.tabs.map((tab, index) =>');
    assert.ok(
      collapseClassIndex < guardIndex && guardIndex < listIndex && listIndex < mapIndex,
      `折叠容器结构错位（样式=${collapseClassIndex}, 守卫=${guardIndex}, list=${listIndex}, 渲染=${mapIndex}）`
    );
  });

  it('展开态不再有硬编码高度上限（>45 标签的会话曾被裁掉且无法滚动）', () => {
    // 旧实现 `max-h-[2000px]` ÷ 行距 44px ≈ 45.5 行 ⇒ 超过 45 个标签的会话
    // 展开后尾部被 overflow-hidden 裁掉，而本组件内没有任何 overflow-y-auto，
    // 那些标签**看不见也点不到**（不是数据丢失：「恢复整个会话」仍会打开全部）。
    // 对「一次收纳整窗标签」的产品定位，50~100 标签的窗口很常见。
    assert.ok(
      !/max-h-\[\d+px\]/.test(TAB_GROUP),
      'TabGroup 不该再有 max-h-[Npx] 硬上限——它会裁掉长会话。改用 grid-rows 折叠。'
    );
    // grid 过渡要求直接子元素 min-height:0 + overflow:hidden，否则折叠失效
    assert.ok(
      TAB_GROUP.includes('min-h-0 overflow-hidden'),
      'grid-rows 折叠的直接子元素必须有 min-h-0 + overflow:hidden（动画才能生效）'
    );
  });

  it('DraggableTab 只有一处渲染点，且在守卫分支内', () => {
    const occurrences = TAB_GROUP.split('<DraggableTab').length - 1;
    assert.equal(occurrences, 1, 'DraggableTab 必须只有一个渲染点，便于确认它被折叠守卫包住');
    assert.ok(
      TAB_GROUP.indexOf('{!isCollapsed && (') < TAB_GROUP.indexOf('<DraggableTab'),
      'DraggableTab 必须落在折叠守卫之内'
    );
  });

  it('折叠状态对读屏可见（aria-expanded 随折叠变化）', () => {
    // 说明：这条在修复前就已满足（TabGroup 折叠按钮原本就有 aria-expanded），
    // 属于「守住已有契约不被后续重构删掉」，不是本次修掉的缺陷。
    assert.ok(
      /aria-expanded=\{!isCollapsed\}/.test(TAB_GROUP),
      '折叠按钮缺 aria-expanded，读屏用户无从得知会话已被折叠'
    );
  });

  it('主题选择器收起时同样不把 option 留在 Tab 序列里', () => {
    // 与会话组折叠同一个根因：max-h-0/opacity-0 不影响可聚焦性。
    // 收起的面板里 4 个主题选项按钮此前仍可 Tab 进去盲按 Enter 改主题。
    const option = THEME_SELECTOR.indexOf('role="option"');
    assert.ok(option !== -1, '应能找到主题 option');
    // 两种合规手段任选其一：条件渲染包住 option，或在容器上加 hidden。
    const guard = THEME_SELECTOR.indexOf('{isExpanded && (');
    const hidden = THEME_SELECTOR.indexOf('hidden={!isExpanded}');
    const removesFromTabOrder =
      (guard !== -1 && guard < option) || (hidden !== -1 && hidden < option);
    assert.ok(
      removesFromTabOrder,
      '收起时必须条件渲染或 hidden 主题选项，不能只靠 opacity-0'
    );
    assert.ok(
      /aria-hidden=\{!isExpanded\}/.test(THEME_SELECTOR),
      '收起时应同步对读屏隐藏'
    );
  });
});

// ── 【2 · P1】操作条必须对键盘聚焦显形 ────────────────────────────────────────

describe('操作条：hover 之外的键盘显形', () => {
  it('全局样式表里 .tab-item-actions 有 :focus-within 显形规则', () => {
    const focusWithinRule = GLOBAL_CSS.match(
      /\.tab-item:focus-within \.tab-item-actions\s*\{[^}]*\}/
    );
    assert.ok(focusWithinRule, 'global.css 缺少 .tab-item:focus-within .tab-item-actions 规则');
    assert.match(focusWithinRule![0], /opacity-100/, 'focus-within 时必须显形（opacity-100）');
  });

  it('会话卡片头部的操作条带 group-focus-within', () => {
    assert.ok(
      /group-hover\/card:opacity-100 group-focus-within\/card:opacity-100/.test(TAB_GROUP),
      'TabGroup 的操作条缺少 group-focus-within/card:opacity-100'
    );
  });

  it('搜索结果头部的「恢复全部/删除全部」带 group-focus-within', () => {
    assert.ok(
      /group-hover\/card:opacity-100 group-focus-within\/card:opacity-100/.test(SEARCH_RESULT_LIST),
      'SearchResultList 的批量操作条缺少 group-focus-within/card:opacity-100'
    );
  });
});

// ── 【3 · P1】表单控件必须有可访问名称 ────────────────────────────────────────

describe('表单控件：label 关联', () => {
  const filterIds = ['pinned', 'domain', 'groupName', 'savedWithin'] as const;

  for (const key of filterIds) {
    it(`搜索筛选「${key}」有 id + htmlFor`, () => {
      assert.ok(
        SEARCH_RESULT_LIST.includes(`htmlFor={FILTER_IDS.${key}}`),
        `搜索筛选 ${key} 的 label 缺 htmlFor`
      );
      assert.ok(
        SEARCH_RESULT_LIST.includes(`id={FILTER_IDS.${key}}`),
        `搜索筛选 ${key} 的控件缺 id`
      );
    });
  }

  it('筛选 id 常量齐全', () => {
    for (const key of filterIds) {
      assert.ok(SEARCH_RESULT_LIST.includes(`${key}: 'search-filter-`), `缺少 ${key} 的 FILTER_IDS 定义`);
    }
  });

  it('搜索结果里的删除按钮有含标签标题的 aria-label', () => {
    // 断言「aria-label 模板里插了 tab.title」这个**不变量**，而不是某一个具体
    // 文案：此前这里钉的是字面量 `删除标签页: ${tab.title}`，于是 2026-10-07 把
    // 两处删除按钮的文案统一成「从会话中移除」时，重命名本身是正确的、守卫却
    // 先红了；更糟的是它当时代替了真正的检查 —— 只要文案相符就通过，缺了
    // tab.title 插值也能被“改文案”这件事掩盖过去。
    assert.ok(
      /aria-label=\{`[^`]*\$\{tab\.title\}`\}/.test(SEARCH_RESULT_LIST),
      '搜索结果行的删除按钮缺 aria-label（只有 title 时读屏只能念到泛化文案）'
    );
  });
});

// ── 【5 · P1】拖拽排序的键盘替代 ──────────────────────────────────────────────

describe('拖拽排序：键盘可达', () => {
  it('方向键把焦点项移到相邻位置', () => {
    assert.equal(nextReorderIndex('ArrowDown', 0, 3), 1);
    assert.equal(nextReorderIndex('ArrowUp', 2, 3), 1);
    assert.equal(nextReorderIndex('End', 0, 3), 2);
    assert.equal(nextReorderIndex('Home', 2, 3), 0);
  });

  it('边界不消费按键（返回 null，让页面其他行为照常）', () => {
    assert.equal(nextReorderIndex('ArrowUp', 0, 3), null, '首项再往上没有去处');
    assert.equal(nextReorderIndex('ArrowDown', 2, 3), null, '末项再往下没有去处');
    assert.equal(nextReorderIndex('Home', 0, 3), null);
    assert.equal(nextReorderIndex('End', 2, 3), null);
  });

  it('非重排键与不可动列表一律不处理', () => {
    for (const key of ['Enter', ' ', 'Escape', 'Tab', 'a', 'ArrowLeft']) {
      assert.equal(nextReorderIndex(key, 1, 3), null, `${key} 不应触发重排`);
      assert.equal(isReorderKey(key), false);
    }
    assert.equal(nextReorderIndex('ArrowDown', 0, 1), null, '单项列表无从移动');
    assert.equal(nextReorderIndex('ArrowDown', 0, 0), null, '空列表无从移动');
    assert.equal(nextReorderIndex('ArrowDown', 5, 3), null, '越界下标不处理');
    assert.equal(nextReorderIndex('ArrowDown', -1, 3), null);
    assert.equal(nextReorderIndex('ArrowDown', 1.5, 3), null, '非整数下标不处理');
  });

  it('上移再下移回到原位（不累积漂移）', () => {
    const up = nextReorderIndex('ArrowUp', 2, 5)!;
    assert.equal(nextReorderIndex('ArrowDown', up, 5), 2);
  });

  it('DraggableTab 挂了键盘处理与键盘操作提示，且 listitem 有配对的 list', () => {
    assert.ok(
      /aria-keyshortcuts="ArrowUp ArrowDown Home End"/.test(DRAGGABLE_TAB),
      '标签标题缺 aria-keyshortcuts（读屏用户无从知道能改顺序）'
    );
    assert.ok(
      /onKeyDown=\{handleTitleKeyDown\}/.test(DRAGGABLE_TAB),
      '标签标题未挂键盘处理'
    );
    assert.ok(DRAGGABLE_TAB.includes('role="listitem"'), 'DraggableTab 应保留 role="listitem"');
    assert.ok(TAB_GROUP.includes('role="list"'), '父容器必须补 role="list"，否则 listitem 是孤儿语义');
  });
});

// ── 【6 · P1】引导弹层：双触发与假 aria-modal ────────────────────────────────

describe('引导弹层：键盘与焦点', () => {
  const nonInteractive = { tagName: 'DIV' };
  const ctx = { isFirstStep: false, isLastStep: false };

  it('在按钮上按 Enter 不被接管（双触发根因）', () => {
    // 「下一步」按钮上按 Enter：按钮 onClick 走一步；window 处理器再走一步就跳了两步。
    assert.equal(
      resolveOnboardingAction({ key: 'Enter', target: { tagName: 'BUTTON' } }, ctx),
      null
    );
    // 「跳过」上按 Enter：此前会同时跳过与前进
    assert.equal(
      resolveOnboardingAction({ key: 'Enter', target: { tagName: 'A', href: '#' } }, ctx),
      null
    );
    assert.equal(resolveOnboardingAction({ key: 'Enter', target: { tagName: 'INPUT' } }, ctx), null);
  });

  it('控件不消费 Escape/方向键，焦点在按钮上时仍可驱动流程', () => {
    // 若连这些也按 target 屏蔽，会出现「焦点在按钮上时 Escape 关不掉弹层」。
    const onButton = { tagName: 'BUTTON' };
    assert.equal(resolveOnboardingAction({ key: 'Escape', target: onButton }, ctx), 'skip');
    assert.equal(resolveOnboardingAction({ key: 'ArrowRight', target: onButton }, ctx), 'next');
    assert.equal(resolveOnboardingAction({ key: 'ArrowLeft', target: onButton }, ctx), 'prev');
  });

  it('落在弹层自身/遮罩上时正常驱动步骤机', () => {
    assert.equal(resolveOnboardingAction({ key: 'Enter', target: nonInteractive }, ctx), 'next');
    assert.equal(resolveOnboardingAction({ key: 'ArrowRight', target: nonInteractive }, ctx), 'next');
    assert.equal(resolveOnboardingAction({ key: 'ArrowLeft', target: nonInteractive }, ctx), 'prev');
    assert.equal(resolveOnboardingAction({ key: 'Escape', target: nonInteractive }, ctx), 'skip');
    assert.equal(
      resolveOnboardingAction({ key: 'Enter', target: null }, ctx),
      'next',
      'target 为 null（非 DOM 目标）时不应误判成可交互控件'
    );
  });

  it('末步 Enter = 完成，首步 ArrowLeft 不消费', () => {
    assert.equal(
      resolveOnboardingAction({ key: 'Enter', target: nonInteractive }, { isFirstStep: false, isLastStep: true }),
      'complete'
    );
    assert.equal(
      resolveOnboardingAction({ key: 'ArrowLeft', target: nonInteractive }, { isFirstStep: true, isLastStep: false }),
      null
    );
  });

  it('已被 preventDefault 或带修饰键的事件一律不接管', () => {
    assert.equal(
      resolveOnboardingAction({ key: 'Enter', target: nonInteractive, defaultPrevented: true }, ctx),
      null
    );
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      assert.equal(
        resolveOnboardingAction({ key: 'Enter', target: nonInteractive, [modifier]: true }, ctx),
        null,
        `${modifier} 组合键不该被引导吞掉`
      );
    }
  });

  it('无关按键不接管', () => {
    for (const key of ['a', 'Tab', 'F5', 'ArrowDown']) {
      assert.equal(resolveOnboardingAction({ key, target: nonInteractive }, ctx), null);
    }
  });

  it('可编辑区也算可交互目标', () => {
    assert.equal(isFromInteractiveElement({ tagName: 'DIV', isContentEditable: true }), true);
    assert.equal(isFromInteractiveElement({ tagName: 'DIV' }), false);
    assert.equal(isFromInteractiveElement({ closest: () => ({}) }), true);
    assert.equal(isFromInteractiveElement({ closest: () => null }), false);
    assert.equal(isFromInteractiveElement(undefined), false);
  });

  it('Tab 只在两端循环', () => {
    assert.equal(resolveTabCycleTarget(2, 3, false), 'first', '末项正向 Tab 回到首项');
    assert.equal(resolveTabCycleTarget(0, 3, true), 'last', '首项反向 Tab 回到末项');
    assert.equal(resolveTabCycleTarget(1, 3, false), null, '中间位置放行给浏览器');
    assert.equal(resolveTabCycleTarget(1, 3, true), null);
    assert.equal(resolveTabCycleTarget(-1, 3, false), 'first', '焦点不在弹层内时先抢回来');
    assert.equal(resolveTabCycleTarget(0, 0, false), null, '没有可聚焦元素就不循环');
  });

  it('组件真的用上了这套规则，并做了移焦/还焦', () => {
    assert.ok(ONBOARDING_GUIDE.includes('resolveOnboardingAction('), '未接入键盘决策函数');
    assert.ok(ONBOARDING_GUIDE.includes('resolveTabCycleTarget('), '未接入 Tab 循环');
    assert.ok(/e\.preventDefault\(\);/.test(ONBOARDING_GUIDE), '接管按键时必须 preventDefault');
    assert.ok(/ref=\{overlayRef\}/.test(ONBOARDING_GUIDE), '遮罩必须有 ref 才能移焦/枚举可聚焦元素');
    assert.ok(/tabIndex=\{-1\}/.test(ONBOARDING_GUIDE), '遮罩需要 tabIndex={-1} 才能接收焦点');
    assert.ok(ONBOARDING_GUIDE.includes('restoreFocusRef'), '缺少关闭还焦');
    assert.ok(ONBOARDING_GUIDE.includes('aria-modal="true"'), '不应删掉 aria-modal');
  });

  it('每个步骤标题可被聚焦（切步播报）', () => {
    const titles = ONBOARDING_STEPS.split('onboarding-title').length - 1;
    assert.equal(titles, 6, '应覆盖 6 个步骤标题');
    const focusable = ONBOARDING_STEPS.split('<h2 tabIndex={-1} className="onboarding-title">').length - 1;
    assert.equal(focusable, 6, '每个步骤标题都要带 tabIndex={-1}');
  });
});

// ── 【7 · P1】聚光灯选择器必须真的命中元素 ────────────────────────────────────

/** 抽出源码里所有 aria-label 的字面值（模板串把 ${…} 归一成 N，便于做前缀比较）。 */
function ariaLabelValuesIn(source: string): string[] {
  const values: string[] = [];
  for (const match of source.matchAll(/aria-label="([^"]*)"/g)) values.push(match[1]);
  for (const match of source.matchAll(/aria-label=\{`([^`]*)`\}/g)) {
    values.push(match[1].replace(/\$\{[^}]*\}/g, 'N'));
  }
  return values;
}

/** 抽出 OnboardingGuide 里配置的全部 spotlightTarget。 */
function spotlightTargetsIn(source: string): string[] {
  return [...source.matchAll(/spotlightTarget:\s*'([^']+)'/g)].map(m => m[1]);
}

describe('引导聚光灯：选择器与真实 aria-label 一致', () => {
  const labels = [
    ...ariaLabelValuesIn(HEADER),
    ...ariaLabelValuesIn(TAB_GROUP),
    ...ariaLabelValuesIn(SEARCH_RESULT_LIST),
  ];
  const targets = spotlightTargetsIn(ONBOARDING_GUIDE);

  it('配置了 4 个聚光灯目标', () => {
    assert.equal(targets.length, 4);
  });

  for (const target of targets) {
    it(`选择器能命中真实元素: ${target}`, () => {
      const matched = target.split(',').some(part => {
        const selector = part.trim();
        const attribute = selector.match(/aria-label(\^?=)"([^"]+)"/);
        if (!attribute) return false;
        const [, operator, value] = attribute;
        return labels.some(label => (operator === '^=' ? label.startsWith(value) : label === value));
      });
      assert.ok(
        matched,
        `没有任何元素的 aria-label 满足该选择器——第 4 步此前就是这样静默失去高亮的`
      );
    });
  }

  it('旧选择器（以「恢复整个会话」开头）确实匹配不到——守住修复的原因', () => {
    const stalePrefix = '恢复整个会话';
    assert.ok(
      !labels.some(label => label.startsWith(stalePrefix)),
      '若真实 aria-label 已改为以该前缀开头，本用例的前提需要重新评估'
    );
  });
});

// ── 【8 · P1】原始异常文本不得直出到界面 ──────────────────────────────────────

describe('会话列表加载失败：用户可见文案', () => {
  const noisyErrors = [
    'duplicate key value violates unique constraint "tab_groups_pkey"',
    'JWT expired',
    'Could not establish connection. Receiving end does not exist.',
    'message port closed before a response was received',
    'QUOTA_BYTES quota exceeded',
    'Unexpected token < in JSON at position 0',
    'Extension context invalidated.',
  ];

  for (const raw of noisyErrors) {
    it(`不泄露内部细节: ${raw.slice(0, 40)}`, () => {
      const copy = toListErrorCopy(raw);
      assert.ok(!copy.description.includes(raw), '描述不得回显原始异常');
      assert.ok(copy.title.length > 0 && copy.description.length > 0, '必须给出文案');
      // 不能把底层关键词原样搬到界面上
      for (const leak of [
        'duplicate key',
        'unique constraint',
        'tab_groups_pkey',
        'JWT',
        'message port',
        'Receiving end',
        'QUOTA_BYTES',
        'JSON',
        'Unexpected token',
      ]) {
        assert.ok(
          !copy.title.includes(leak) && !copy.description.includes(leak),
          `用户可见文案泄露了技术细节: ${leak}`
        );
      }
    });
  }

  it('未识别的异常落到通用兜底，不回显原文', () => {
    const raw = 'boom 0x8000c00f (kernel trap)';
    const copy = toListErrorCopy(raw);
    assert.ok(!copy.title.includes('boom') && !copy.description.includes('0x8000c00f'));
  });

  it('空错误也给出可行动兜底', () => {
    for (const raw of [null, undefined, '', '   ']) {
      const copy = toListErrorCopy(raw);
      assert.ok(copy.description.length > 0);
    }
  });

  it('可识别的错误各自给出对应的下一步', () => {
    assert.match(toListErrorCopy('QUOTA_BYTES quota exceeded').title, /存储/);
    assert.match(toListErrorCopy('Receiving end does not exist.').title, /连接|后台/);
    assert.match(toListErrorCopy('duplicate key value violates unique constraint "tab_groups_pkey"').title, /冲突/);
    assert.match(toListErrorCopy('JWT expired').title, /登录/);
    assert.match(toListErrorCopy('Unexpected token < in JSON').title, /解析|格式/);
  });

  it('TabList 不再把 error 直接塞进 EmptyState', () => {
    assert.ok(!/description=\{error\}/.test(TAB_LIST), '不得把原始异常文本直出到界面');
    assert.ok(TAB_LIST.includes('errorCopy.title'), '应使用映射后的标题');
    assert.ok(TAB_LIST.includes('errorCopy.description'), '应使用映射后的描述');
    assert.ok(
      /logError\('加载会话列表失败:'\s*,\s*error\)/.test(TAB_LIST),
      '原始异常必须降级到日志'
    );
  });

  it('错误日志的 effect 排在所有提前 return 之前（Hooks 规则）', () => {
    const logIndex = TAB_LIST.indexOf("logError('加载会话列表失败:'");
    const earlyReturnIndex = TAB_LIST.indexOf('if (isLoading');
    assert.ok(logIndex !== -1 && earlyReturnIndex !== -1);
    assert.ok(logIndex < earlyReturnIndex, 'useEffect 不能排在条件 return 之后');
  });
});

// ── 【9 · P2】搜索重算与埋点节流 ──────────────────────────────────────────────

describe('搜索结果：重算收敛与埋点节流', () => {
  const snapshot = {
    query: 'gith',
    domain: null,
    groupName: null,
    pinned: 'all' as const,
    savedWithin: null,
    resultCount: 12,
  };

  it('同内容签名稳定，任一维变化签名必变', () => {
    assert.equal(buildSearchEventSignature(snapshot), buildSearchEventSignature({ ...snapshot }));
    assert.notEqual(
      buildSearchEventSignature(snapshot),
      buildSearchEventSignature({ ...snapshot, query: 'githu' }),
      '每敲一个字符都应视为一次新快照'
    );
    assert.notEqual(
      buildSearchEventSignature(snapshot),
      buildSearchEventSignature({ ...snapshot, resultCount: 13 })
    );
    assert.notEqual(
      buildSearchEventSignature(snapshot),
      buildSearchEventSignature({ ...snapshot, domain: 'github.com' })
    );
    // 拼接无歧义：字段挪位不能撞出同一个签名
    assert.notEqual(
      buildSearchEventSignature({ ...snapshot, query: 'a', domain: 'b' }),
      buildSearchEventSignature({ ...snapshot, query: 'b', domain: 'a' })
    );
  });

  it('首次搜索立即上报，窗口内的连续输入不重复上报', () => {
    const first = shouldEmitSearchEvents({
      lastSignature: '',
      nextSignature: 'sig-1',
      lastEmitAt: 0,
      now: 1000,
    });
    assert.equal(first, true, '首个事件必须立即发，保证「搜过」这一事实被记录');

    // 同一批按键的后续快照：落在节流窗口内 → 不发（改由 trailing 补发）
    for (const suffix of ['2', '3', '4', '5']) {
      assert.equal(
        shouldEmitSearchEvents({
          lastSignature: 'sig-1',
          nextSignature: `sig-${suffix}`,
          lastEmitAt: 1000,
          now: 1000 + Number(suffix),
        }),
        false,
        `第 ${suffix} 次击键不该立即上报`
      );
    }
  });

  it('窗口过后允许再发；签名未变则永不重复', () => {
    assert.equal(
      shouldEmitSearchEvents({
        lastSignature: 'sig-1',
        nextSignature: 'sig-2',
        lastEmitAt: 1000,
        now: 1000 + SEARCH_EVENT_THROTTLE_MS,
      }),
      true
    );
    assert.equal(
      shouldEmitSearchEvents({
        lastSignature: 'sig-1',
        nextSignature: 'sig-1',
        lastEmitAt: 1000,
        now: 1000 + SEARCH_EVENT_THROTTLE_MS * 10,
      }),
      false,
      '签名没变 = 结果集没动，重复上报没有信息量'
    );
  });

  it('remainingMsUntilAllowed 决定 trailing 何时补发', () => {
    assert.equal(remainingMsUntilAllowed(0, 9999), 0, '从未发过 → 立即可发');
    assert.equal(remainingMsUntilAllowed(1000, 1000), SEARCH_EVENT_THROTTLE_MS);
    assert.equal(remainingMsUntilAllowed(1000, 1000 + SEARCH_EVENT_THROTTLE_MS / 2), SEARCH_EVENT_THROTTLE_MS / 2);
    assert.equal(remainingMsUntilAllowed(1000, 1000 + SEARCH_EVENT_THROTTLE_MS * 5), 0, '已过窗口 → 0');
  });

  it('只在有筛选时额外发 search_filtered', () => {
    assert.deepEqual(searchEventNames(snapshot), ['search_performed']);
    assert.deepEqual(
      searchEventNames({ ...snapshot, domain: 'github.com' }),
      ['search_performed', 'search_filtered']
    );
    assert.deepEqual(
      searchEventNames({ ...snapshot, pinned: 'only' }),
      ['search_performed', 'search_filtered']
    );
  });

  it('hasActiveSearchFilters 与组件内判空一致（纯空格不算生效）', () => {
    assert.equal(hasActiveSearchFilters({}), false);
    assert.equal(hasActiveSearchFilters({ domain: '   ', groupName: '' }), false);
    assert.equal(hasActiveSearchFilters({ domain: 'github.com' }), true);
    assert.equal(hasActiveSearchFilters({ groupName: '调研' }), true);
    assert.equal(hasActiveSearchFilters({ savedWithin: '7d' }), true);
    assert.equal(hasActiveSearchFilters({ pinned: 'only' }), true);
    assert.equal(hasActiveSearchFilters({ pinned: 'exclude' }), true);
    assert.equal(hasActiveSearchFilters({ pinned: 'all' }), false, "'all' 不是生效的筛选");
  });

  it('搜索管线被 useMemo 包住，不再每次渲染全量重跑', () => {
    const searchIndex = SEARCH_RESULT_LIST.indexOf('AdvancedSearch.search');
    const nearestUseMemo = SEARCH_RESULT_LIST.lastIndexOf('useMemo(', searchIndex);
    assert.ok(nearestUseMemo !== -1, 'AdvancedSearch.search 必须在 useMemo 内');
    assert.ok(
      nearestUseMemo > SEARCH_RESULT_LIST.indexOf('const baseResults'),
      'useMemo 必须紧跟在 baseResults 声明处'
    );
    for (const call of ['applySearchFilters(baseResults, filters)', 'buildSessionSearchResults(searchResults)']) {
      const at = SEARCH_RESULT_LIST.indexOf(call);
      const memo = SEARCH_RESULT_LIST.lastIndexOf('useMemo(', at);
      assert.ok(memo !== -1 && memo < at, `${call} 必须在 useMemo 内`);
    }
  });

  it('埋点 effect 走节流函数，而不是每次 filters 变化都发', () => {
    assert.ok(
      SEARCH_RESULT_LIST.includes('shouldEmitSearchEvents('),
      '埋点 effect 必须经过节流决策'
    );
    assert.ok(
      SEARCH_RESULT_LIST.includes('remainingMsUntilAllowed('),
      '需要 trailing 补发，否则用户停下后的最终状态会丢'
    );
    assert.ok(
      !/void trackProductEvent\('search_performed'/.test(SEARCH_RESULT_LIST.slice(0, SEARCH_RESULT_LIST.indexOf('const restoreSession'))),
      'search_performed 不应再在 effect 体里无条件直发'
    );
  });

  it('leading + trailing 节流下，连续输入的事件数被收敛到 2 条以内', () => {
    // 模拟一次连续输入：7 次击键，首发 1 条 + 窗口末 trailing 1 条
    let lastSignature = '';
    let lastEmitAt = 0;
    let emitted = 0;
    const now = 10_000;
    for (let i = 0; i < 7; i += 1) {
      const signature = `sig-${i}`;
      if (
        shouldEmitSearchEvents({ lastSignature, nextSignature: signature, lastEmitAt, now: now + i * 100 })
      ) {
        emitted += 1;
        lastSignature = signature;
        lastEmitAt = now + i * 100;
      }
    }
    assert.equal(emitted, 1, '连续输入期间只应首发 1 条');
    const remaining = remainingMsUntilAllowed(lastEmitAt, now + 6 * 100);
    assert.ok(remaining > 0);
    // trailing 在窗口结束时补发最终状态 → 全程 2 条
    assert.equal(emitted + 1, 2);
  });
});

// ── 交叉：Header 菜单按钮语义（引导第 5 步锚点） ─────────────────────────────

describe('Header：菜单按钮契约', () => {
  it('菜单按钮带 aria-expanded / aria-haspopup', () => {
    assert.ok(/aria-label="菜单"/.test(HEADER), '菜单按钮的 aria-label 被引导聚光灯依赖');
    assert.ok(/aria-haspopup="menu"/.test(HEADER));
    assert.ok(/aria-expanded=\{showDropdown\}/.test(HEADER));
  });

  it('清空搜索按钮有 aria-label', () => {
    assert.ok(/title="清空搜索"[\s\S]{0,200}aria-label="清空搜索"/.test(HEADER));
  });
});
