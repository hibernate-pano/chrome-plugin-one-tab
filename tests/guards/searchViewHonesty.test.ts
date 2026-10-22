/**
 * 搜索页（结果视图）的四条「界面说的不是真的」（2026-10-23 审计）。
 *
 * | 编号 | 缺陷 | 本文件钉住的不变量 |
 * |---|---|---|
 * | SC-4 | 零结果页把空态的出口**整个藏掉了** | 渲染出来的出口 == 判据层给出的出口，且每个出口可点、点了触发对应动作 |
 * | WC-7 | 「恢复整个会话」不告诉用户点完会发生什么 | 提示按锁定态分流，且与列表页**同源**（同一个纯函数） |
 * | WC-12 | 「标签记录」与「标签页」是同一个东西的两个名字 | 界面上「标签记录」为 0 |
 * | DS-43-13 | 删除确认框的计数**含锁定组**，而执行时跳过 | 确认框里的数字 == 真正会删的条数 |
 *
 * ── 判据钉的是**语义**，不是字面量 ────────────────────────────────────────
 *
 *   · 出口集合：拿 `resolveEmptyStateActions` 的**输出**去比，不比对文案；
 *   · 后果措辞：拿 `restoreOutcomeSentence` 的**输出**去比，不比对中文句子；
 *   · 术语：数「标签记录」出现几次（一个**名字**的存活），不比对某句必须逐字长什么样；
 *   · 计数：拿「真正被删掉的条数」去比，不比对「N 个标签？」这句话。
 *
 * 所以改文案不该让这些守卫变红，改**行为**才会。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import {
  makeSearchGroups,
  renderSearchResultList,
} from '../_helpers/searchResultListHarness.ts';
import { resolveEmptyStateActions } from '@/components/tabs/emptyStateActions';
import { runSearchEmptyStateExit } from '@/components/search/searchEmptyStateExits';
import { restoreOutcomeSentence } from '@/components/tabs/restoreFeedbackCopy';
import {
  bulkDeleteConfirmCopy,
  planBulkDelete,
  runBulkDelete,
} from '@/components/search/searchBulkDelete';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

/** 去掉注释（注释里可以讨论「标签记录」这个**名字**，那不算界面上的用词）。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 递归收集 src/ 下的所有 .ts / .tsx。 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════
// SC-4 · 零结果页必须给出**同样的**出口
// ══════════════════════════════════════════════════════════════════════════

/**
 * 出口集合的三种情形（判据层 `resolveEmptyStateActions` 的输入组合）。
 *
 * 这三种都必须能在界面上看到 —— 漏掉任何一种，用户就少一条出路。
 */
const EXIT_CASES: Array<{
  name: string;
  syncBackend: 'supabase' | 'webdav';
  isAuthenticated: boolean;
}> = [
  { name: '云端已登录', syncBackend: 'supabase', isAuthenticated: true },
  { name: '云端未登录', syncBackend: 'supabase', isAuthenticated: false },
  { name: '自带存储', syncBackend: 'webdav', isAuthenticated: false },
];

describe('SC-4 · 零结果页的出口必须与判据层一致', () => {
  for (const testCase of EXIT_CASES) {
    it(`${testCase.name}：渲染出来的出口 == 判据层给出的出口`, async () => {
      const rendered = await renderSearchResultList({
        groups: [],
        searchQuery: 'react',
        syncBackend: testCase.syncBackend,
        isAuthenticated: testCase.isAuthenticated,
      });
      const expected = resolveEmptyStateActions({
        syncBackend: testCase.syncBackend,
        isAuthenticated: testCase.isAuthenticated,
      });
      assert.deepEqual(
        rendered.exits.map(exit => exit.action).sort(),
        [...expected].sort(),
        '零结果页渲染出来的出口必须与判据层一致（当前渲染：' +
          `${rendered.exits.map(exit => exit.action).join('、') || '一个都没有'}）`
      );
    });
  }

  it('筛选浏览态（没搜、只是筛选）零结果时，出口同样在', async () => {
    const rendered = await renderSearchResultList({
      groups: [],
      searchQuery: '',
      filters: { domain: 'github.com' },
      syncBackend: 'supabase',
      isAuthenticated: true,
    });
    const expected = resolveEmptyStateActions({
      syncBackend: 'supabase',
      isAuthenticated: true,
    });
    assert.deepEqual(
      rendered.exits.map(exit => exit.action).sort(),
      [...expected].sort(),
      '筛选浏览态零结果时也必须给出同样的出口'
    );
  });

  it('本机有会话、但没搜到时，出口同样在（搜索只搜本机 ⇒ 「在云端」仍是活的可能）', async () => {
    // 搜索**只搜本机**的会话 ⇒ 零结果最常见的解释之一就是
    // 「那些会话还没同步到本机」⇒ 「从云端恢复会话」正是该给的下一步。
    const rendered = await renderSearchResultList({
      groups: makeSearchGroups([{ id: 'g1', name: '本地会话', tabCount: 1 }]),
      searchQuery: '根本搜不到的词',
      syncBackend: 'supabase',
      isAuthenticated: true,
    });
    assert.ok(
      rendered.exits.length > 0,
      '本机有会话但零结果时，零结果页仍然要给出「我的会话在别处」的出口'
    );
  });

  it('每个出口都必须是一个可点的按钮（不是 disabled 的、也不是 div）', async () => {
    const rendered = await renderSearchResultList({
      groups: [],
      searchQuery: 'react',
      syncBackend: 'supabase',
      isAuthenticated: false,
    });
    assert.ok(rendered.exits.length > 0, '前置条件：零结果页必须渲染出出口');
    for (const exit of rendered.exits) {
      assert.ok(
        exit.clickable,
        `出口 ${exit.action} 必须是一个可点的按钮（disabled 的按钮点了没反应）`
      );
      assert.ok(
        exit.label.trim().length > 0,
        `出口 ${exit.action} 必须有可见文字（不许出现一个空按钮）`
      );
    }
  });
});

describe('SC-4 · 点了会发生什么（执行层）', () => {
  /** 造一组「会记账的」假 IO。 */
  function makeIo(withAuth = true) {
    const calls = {
      openAuth: 0,
      openOptions: 0,
      restoreFromCloud: 0,
      requestImport: 0,
      notify: [] as string[],
    };
    const io = {
      ...(withAuth
        ? {
            openAuth: () => {
              calls.openAuth++;
            },
          }
        : {}),
      openOptions: () => {
        calls.openOptions++;
      },
      restoreFromCloud: () => {
        calls.restoreFromCloud++;
      },
      requestImport: () => {
        calls.requestImport++;
        return true;
      },
      notifyUnavailable: (message: string) => {
        calls.notify.push(message);
      },
    };
    return { calls, io };
  }

  it('每个出口都接到它该接的动作', () => {
    const { calls, io } = makeIo();

    runSearchEmptyStateExit('login', io);
    assert.equal(calls.openAuth, 1, '登录出口必须真的打开登录');
    assert.equal(calls.notify.length, 0, '做成了事就不该再出声抱怨');

    runSearchEmptyStateExit('download', io);
    assert.equal(calls.restoreFromCloud, 1, '从云端恢复出口必须真的发起恢复');

    runSearchEmptyStateExit('options', io);
    assert.equal(calls.openOptions, 1, '设置出口必须真的打开设置页');

    runSearchEmptyStateExit('import', io);
    assert.equal(calls.requestImport, 1, '导入出口必须真的请求导入');
    assert.equal(calls.notify.length, 0, '做成了事就不该再出声抱怨');
  });

  it('登录出口：宿主没接上 ⇒ 必须出声（不许静默无反应）', () => {
    const { calls, io } = makeIo(false);
    const outcome = runSearchEmptyStateExit('login', io);
    assert.equal(calls.openAuth, 0, '没接上就不该有登录动作');
    assert.equal(outcome.kind, 'unavailable', '这个出口此刻做不到 ⇒ 必须承认');
    assert.equal(
      calls.notify.length,
      1,
      '必须出声一次（点了没反应也没提示是本仓明令禁止的失败形态）'
    );
    assert.ok(calls.notify[0].trim().length > 0, '出声必须有一句能看的话');
  });

  it('导入出口：没有订阅者 ⇒ 必须出声（点了没反应也没提示是禁止的失败形态）', () => {
    const calls: string[] = [];
    const outcome = runSearchEmptyStateExit('import', {
      openOptions: () => undefined,
      restoreFromCloud: () => undefined,
      requestImport: () => false,
      notifyUnavailable: (message: string) => {
        calls.push(message);
      },
    });
    assert.equal(outcome.kind, 'unavailable');
    assert.equal(calls.length, 1, '没人接这个请求 ⇒ 必须出声');
  });
});

describe('SC-4 · 接线层：结果视图必须走判据层', () => {
  const source = read('src/components/search/SearchResultList.tsx');

  it('出口集合必须来自共享的判据层（不许自己另判一套）', () => {
    assert.match(
      source,
      /resolveEmptyStateActions\s*\(/,
      '结果视图的出口集合必须来自 emptyStateActions 的判据层（两处各判一遍必然漂）'
    );
    assert.match(
      source,
      /from\s*'@\/components\/tabs\/emptyStateActions'/,
      '结果视图必须从共享的 emptyStateActions 取出口集合'
    );
  });

  it('出口的执行必须走共享的执行层（不许另写一套 switch）', () => {
    assert.match(
      source,
      /runSearchEmptyStateExit\s*\(/,
      '结果视图的出口必须走共享的执行层（core/emptyStateExits 的那一份）'
    );
  });

  it('「登录」出口需要的能力必须由宿主转交下来（弹窗实例在 MainApp 手里）', () => {
    const tabList = read('src/components/tabs/TabList.tsx');
    assert.match(
      tabList,
      /<SearchResultList[\s\S]{0,400}onOpenAuth/,
      '列表层必须把登录能力转交给结果视图（否则那一格永远「点了没反应」）'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// WC-7 · 「恢复整个会话」必须先说清点了会发生什么
// ══════════════════════════════════════════════════════════════════════════

describe('WC-7 · 恢复按钮的后果说明', () => {
  it('按锁定态分流：锁定说「保留」、未锁定说「移除」', async () => {
    const rendered = await renderSearchResultList({
      groups: makeSearchGroups([
        { id: 'g-open', name: '未锁定会话', tabCount: 2 },
        { id: 'g-locked', name: '已锁定会话', tabCount: 2, isLocked: true },
      ]),
      searchQuery: 'page',
    });

    const open = rendered.restoreButtons.find(button => button.groupId === 'g-open');
    const locked = rendered.restoreButtons.find(button => button.groupId === 'g-locked');
    assert.ok(open, '未锁定会话的恢复按钮必须渲染出来');
    assert.ok(locked, '已锁定会话的恢复按钮必须渲染出来');

    assert.ok(
      open!.ariaLabel.includes(restoreOutcomeSentence(false)),
      '未锁定会话的按钮必须说清「恢复后会被移除」'
    );
    assert.ok(
      !open!.ariaLabel.includes(restoreOutcomeSentence(true)),
      '未锁定会话的按钮不能说「仍保留在列表中」'
    );

    assert.ok(
      locked!.ariaLabel.includes(restoreOutcomeSentence(true)),
      '锁定会话的按钮必须说清「恢复后仍保留在列表中」'
    );
    assert.ok(
      !locked!.ariaLabel.includes(restoreOutcomeSentence(false)),
      '锁定会话的按钮不能说「会被移除」—— 锁定恰恰是唯一能让恢复不被消费的开关'
    );
  });

  it('两种锁定态必须给出**不同**的话（否则 = 压根没看 isLocked）', async () => {
    const rendered = await renderSearchResultList({
      groups: makeSearchGroups([
        { id: 'g-open', name: '未锁定会话', tabCount: 2 },
        { id: 'g-locked', name: '已锁定会话', tabCount: 2, isLocked: true },
      ]),
      searchQuery: 'page',
    });
    const open = rendered.restoreButtons.find(button => button.groupId === 'g-open');
    const locked = rendered.restoreButtons.find(button => button.groupId === 'g-locked');
    assert.notEqual(
      open!.ariaLabel,
      locked!.ariaLabel,
      '两种锁定态的提示必须不同（一样 = 没分流）'
    );
  });

  it('与列表页**同源**：两处用的必须是同一个纯函数的输出', async () => {
    // 列表页（TabGroup）与搜索页各写一遍后果措辞 ⇒ 迟早漂成两个说法。
    // ⇒ 两处都必须从 restoreFeedbackCopy 的**同一个函数**派生。
    const searchPage = read('src/components/search/SearchResultList.tsx');
    const listPage = read('src/components/tabs/TabGroup.tsx');
    for (const [name, source] of [
      ['搜索页', searchPage],
      ['列表页', listPage],
    ] as const) {
      assert.match(
        source,
        /import\s*\{[^}]*restoreOutcomeSentence[^}]*\}\s*from\s*'@\/components\/tabs\/restoreFeedbackCopy'/,
        `${name}的后果措辞必须来自共享模块（两处各写一遍迟早漂）`
      );
    }

    // 两处调用它时都必须**按锁定态分流**（同一个纯函数、同一个开关）。
    for (const [name, source] of [
      ['搜索页', searchPage],
      ['列表页', listPage],
    ] as const) {
      const args = callArguments(source, 'restoreOutcomeSentence').flat();
      assert.ok(args.length > 0, `${name}必须真的用共享的那句后果措辞`);
      for (const arg of args) {
        assert.match(
          arg,
          /isLocked/,
          `${name}的后果措辞必须按锁定态分流 —— 这处没有：restoreOutcomeSentence(${arg})`
        );
      }
    }

    // 搜索页**渲染出来**的那句，必须就是共享函数的输出（不是各写一遍）。
    const rendered = await renderSearchResultList({
      groups: makeSearchGroups([
        { id: 'g-locked', name: '已锁定会话', tabCount: 2, isLocked: true },
      ]),
      searchQuery: 'page',
    });
    const button = rendered.restoreButtons.find(item => item.groupId === 'g-locked');
    assert.ok(button, '搜索页的恢复按钮必须渲染出来');
    assert.ok(
      button!.ariaLabel.includes(restoreOutcomeSentence(true)),
      '搜索页渲染出来的提示必须包含共享模块那句话的输出'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// WC-12 · 「标签记录」这个名字必须退休
// ══════════════════════════════════════════════════════════════════════════

describe('WC-12 · 同一个实体只许有一个名字', () => {
  it('搜索页的界面上不许再出现「标签记录」', async () => {
    const rendered = await renderSearchResultList({
      groups: makeSearchGroups([
        { id: 'g-open', name: '未锁定会话', tabCount: 2 },
        { id: 'g-locked', name: '已锁定会话', tabCount: 2, isLocked: true },
      ]),
      searchQuery: 'page',
    });
    assert.ok(
      !rendered.html.includes('标签记录'),
      `界面上不许再出现「标签记录」（同一个东西已经定名「标签页」）\n实际渲染：\n${rendered.text.slice(0, 800)}`
    );
  });

  it('源码里（去掉注释后）不许再出现「标签记录」', () => {
    const stripped = stripComments(read('src/components/search/SearchResultList.tsx'));
    assert.ok(
      !stripped.includes('标签记录'),
      '搜索页的用户可见文案里不许再出现「标签记录」（定名是「标签页」）'
    );
  });

  it('删除确认框（真正给用户看的那两行）里不许再出现「标签记录」', () => {
    // 确认框只在点击后才出现 ⇒ 渲染产物里看不到它 ⇒ 这一条直接问判据层。
    const copy = bulkDeleteConfirmCopy(
      'search',
      makeMatches([
        { id: 'a', locked: false },
        { id: 'b', locked: true },
      ])
    );
    assert.ok(
      !copy.title.includes('标签记录') && !copy.message.includes('标签记录'),
      `删除确认框里不许再出现「标签记录」（当前：${copy.title} / ${copy.message}）`
    );
  });

  it('整个 src/ 里（去掉注释后）不许再出现「标签记录」', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(resolve(ROOT, 'src'))) {
      if (stripComments(readFileSync(file, 'utf8')).includes('标签记录')) {
        offenders.push(file.slice(ROOT.length + 1));
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `这些文件里还有「标签记录」：${offenders.join('、')} —— 同一个东西在本仓曾有三种叫法` +
        '（标签页 / 标签 / 标签记录），定名是「标签页」'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// DS-43-13 · 确认框里的计数必须等于真正会删的条数
// ══════════════════════════════════════════════════════════════════════════

/** 造一批匹配项（标签 + 所属会话）。 */
function makeMatches(
  spec: Array<{ id: string; locked: boolean }>
): Array<{ tab: { id: string }; group: { isLocked: boolean } }> {
  return spec.map(item => ({
    tab: { id: `tab-${item.id}` },
    group: { isLocked: item.locked },
  }));
}

describe('DS-43-13 · 确认框里的数字 == 真正会删的条数', () => {
  const MIXED = makeMatches([
    { id: 'a', locked: false },
    { id: 'b', locked: false },
    { id: 'c', locked: false },
    { id: 'd', locked: true },
    { id: 'e', locked: true },
  ]);
  const ALL_OPEN = makeMatches([
    { id: 'a', locked: false },
    { id: 'b', locked: false },
  ]);

  it('含锁定组时：数字只算未锁定的那些，且与实际删除的条数一致', async () => {
    const copy = bulkDeleteConfirmCopy('search', MIXED);
    const deleted: string[] = [];
    const attempted = await runBulkDelete(MIXED, async match => {
      deleted.push(match.tab.id);
    });

    // 先钉「锁定的东西绝不能被删」—— 这是**后果**，比数字更要紧。
    assert.ok(
      !deleted.includes('tab-d') && !deleted.includes('tab-e'),
      '锁定会话里的标签页绝不能被删（锁定承诺「防误删」）'
    );
    assert.equal(
      copy.count,
      attempted,
      '确认框里的数字必须等于真正会删的条数（DS-43-13）'
    );
    assert.equal(copy.count, 3, '三条未锁定的才该被删（锁定会话里的跳过）');
    assert.equal(deleted.length, 3, '实际删除的条数必须与确认框说的同一个数');
  });

  it('不含锁定组时：数字 == 匹配总数', async () => {
    const copy = bulkDeleteConfirmCopy('search', ALL_OPEN);
    const deleted: string[] = [];
    const attempted = await runBulkDelete(ALL_OPEN, async match => {
      deleted.push(match.tab.id);
    });
    assert.equal(copy.count, attempted, '没有锁定组时数字就是总数');
    assert.equal(copy.count, 2);
    assert.equal(deleted.length, 2);
  });

  it('标题与正文里的数字必须就是那个数（不许正文另说一个）', () => {
    const copy = bulkDeleteConfirmCopy('search', MIXED);
    assert.ok(
      copy.title.includes(String(copy.count)),
      `标题里必须是真正会删的条数（当前标题：${copy.title}）`
    );
    assert.ok(
      copy.message.includes(String(copy.count)),
      `正文里必须是真正会删的条数（当前正文：${copy.message}）`
    );
    assert.ok(
      !copy.message.includes(String(MIXED.length)),
      `正文里不许出现匹配总数（那是含锁定组的数，用户会以为删了那么多）—— 当前正文：${copy.message}`
    );
  });

  it('「（锁定会话除外）」那句必须仍然成立（锁定会话里的确实不会被删）', () => {
    const copy = bulkDeleteConfirmCopy('search', MIXED);
    assert.match(
      copy.message,
      /锁定会话除外/,
      '计数修正后，这句括号仍在告诉用户「锁定会话里的不会被删」'
    );
  });

  it('删哪些与说删多少必须读**同一批**匹配结果（接线层）', () => {
    // 计数与执行各读各的变量 ⇒ 两边迟早漂（这正是 DS-43-13 的根因）。
    const source = read('src/components/search/SearchResultList.tsx');
    const confirmArgs = callArguments(source, 'bulkDeleteConfirmCopy');
    const deleteArgs = callArguments(source, 'runBulkDelete');

    assert.equal(confirmArgs.length, 1, '确认框的文案必须由判据层算出');
    assert.equal(deleteArgs.length, 1, '批量删除必须走判据层');
    assert.ok(
      confirmArgs[0].some(arg => arg.includes('matchingTabs')),
      '确认框的计数必须来自匹配结果本身'
    );
    assert.ok(
      deleteArgs[0].some(arg => arg.includes('matchingTabs')),
      '执行删除的必须是同一批匹配结果'
    );
  });

  it('判据层本身：锁定会话里的永远不进删除集', () => {
    const plan = planBulkDelete(MIXED);
    assert.equal(plan.deletable.length, 3);
    assert.equal(plan.skipped, 2);
  });
});

/**
 * 找出源码里所有 `callee(...)` 调用的实参文本（AST，不靠正则猜）。
 *
 * 为什么用 AST：正则分不清「调用」与「注释/字符串里的同名」，
 * 而判据要盯的是**数据流**（哪个变量被传了进去），不是长相。
 */
function callArguments(source: string, calleeName: string): string[][] {
  const file = ts.createSourceFile(
    'SearchResultList.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const found: string[][] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === calleeName
    ) {
      found.push(node.arguments.map(argument => argument.getText(file)));
    }
    node.forEachChild(visit);
  };
  visit(file);
  return found;
}
