/**
 * 「使用记录」的**接缝守卫**（v1.33）：打开动作成功之后必须真的记一次。
 *
 * ── 为什么必须有这道守卫 ──────────────────────────────────────────────────
 *
 * 「最近使用」排序依赖本机记录表（`storage-kv/lastUsedAtStore`）。判据层与
 * 存储层都可以全绿，而**打开动作根本没调记录函数** —— 列表按一张永远为空
 * 的表排序，看起来像「这个功能坏了」。本仓在 L-10（排序没接线）上栽过同一
 * 类跟头，所以接线必须单独钉一遍。
 *
 * ── 钉的是**结构条件**，不是「源码里出现了某个函数名」─────────────────────
 *
 * 只 grep 函数名是零检测力：把调用挪到失败分支、挪到成功门之前，grep 照样绿。
 * 这里用 TypeScript AST 对每个调用点回答三个问题：
 *   ① 它在**哪个处理函数**里（按函数名定位一段代码）；
 *   ② 它是不是落在「打开失败」分支里（`success !== true` 的 then 块）；
 *   ③ 成功门（`success !== true`）是不是排在它前面。
 *
 * ── 覆盖的打开动作（产品口径 §2.5：从这条会话里打开过标签 = 使用）───────
 *
 *   · 列表页：恢复整个会话（锁定组也算）/ 点开单个标签（锁定 + 未锁定两分支）
 *   · 搜索页：恢复整个会话 / 点开单个标签（锁定 + 未锁定两分支）/ **批量恢复**
 *   · 顶栏骰子：随机打开一条（它就是「点开一行」）
 *
 * 只删标签、只重命名**不算**使用（那是「修改」，见 core/sessionSort）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8');

interface RecordSite {
  /** 调用点在源码里的字符偏移。 */
  start: number;
  /** 是否落在 `success !== true` 的**失败分支**里。 */
  inFailureBranch: boolean;
  /** 成功门是否排在它前面（同一处理函数内）。 */
  hasGateBefore: boolean;
  /** 是否落在 `if (group.isLocked) { ... }` 的锁定分支里。 */
  inLockedBranch: boolean;
}

interface FunctionAnalysis {
  /** 处理函数的源码文本（方便做「A 必须在 B 之前」这类断言）。 */
  regionText: string;
  sites: RecordSite[];
}

/**
 * 解析一份源码，抽出某个具名处理函数里所有 `recordSessionUsed(...)` 调用。
 *
 * 纯函数（吃源码文本、吐结构）⇒ 守卫可以喂它一段**被改坏**的源码，
 * 自证检测力（见文件末尾的「自证」用例）。
 */
function analyzeRecordSites(sourceText: string, functionName: string): FunctionAnalysis {
  const src = ts.createSourceFile(
    'analyze.tsx',
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );

  // 用对象持有节点：`let` 变量在闭包里赋值时，TS 的流程分析会把它当成
  // 初始化时的 null（闭包里的赋值不算）⇒ 后续访问会被窄化成 never。
  const holder: { node: ts.Node | null } = { node: null };
  const find = (node: ts.Node): void => {
    if (holder.node) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === functionName &&
      node.initializer
    ) {
      let initializer: ts.Node = node.initializer;
      // useCallback(fn, deps) ⇒ 第一个实参才是处理函数本体。
      if (ts.isCallExpression(initializer) && initializer.arguments.length > 0) {
        initializer = initializer.arguments[0];
      }
      holder.node = initializer;
      return;
    }
    node.forEachChild(find);
  };
  find(src);
  assert.ok(holder.node, `源码里找不到处理函数 ${functionName}（守卫的前提没成立）`);

  const fnNode: ts.Node = holder.node;
  const regionText = fnNode.getText(src);
  const regionStart = fnNode.getStart(src);
  const sites: RecordSite[] = [];

  const walk = (node: ts.Node, ancestors: ts.Node[]): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'recordSessionUsed'
    ) {
      const start = node.getStart(src) - regionStart;
      const isInsideThenOf = (ancestor: ts.Node, needle: string): boolean => {
        if (!ts.isIfStatement(ancestor)) return false;
        const condition = ancestor.expression.getText(src);
        return (
          condition.includes(needle) &&
          node.getStart(src) >= ancestor.thenStatement.getStart(src) &&
          node.getEnd() <= ancestor.thenStatement.getEnd()
        );
      };
      const inFailureBranch = ancestors.some(ancestor =>
        isInsideThenOf(ancestor, 'success !== true')
      );
      const inLockedBranch = ancestors.some(ancestor =>
        isInsideThenOf(ancestor, 'group.isLocked')
      );
      const gateAt = regionText.indexOf('success !== true');
      sites.push({
        start,
        inFailureBranch,
        hasGateBefore: gateAt !== -1 && gateAt < start,
        inLockedBranch,
      });
    }
    for (const child of node.getChildren(src)) {
      walk(child, [...ancestors, node]);
    }
  };
  walk(fnNode, []);

  return { regionText, sites };
}

/** 断言某个处理函数里恰好有 `expected` 个记录点，且每个都满足结构条件。 */
function assertRecordSites(
  file: string,
  functionName: string,
  expected: number
): FunctionAnalysis {
  const analysis = analyzeRecordSites(read(file), functionName);
  assert.equal(
    analysis.sites.length,
    expected,
    `${file} 的 ${functionName} 里应有 ${expected} 个 recordSessionUsed 调用` +
      `（实际 ${analysis.sites.length} 个）—— 少一个就是某条打开路径没记「使用」`
  );
  for (const site of analysis.sites) {
    assert.equal(
      site.inFailureBranch,
      false,
      `${file} 的 ${functionName}：recordSessionUsed 落在「打开失败」分支里 —— ` +
        '没打开也刷新使用时间，等于把失败说成使用'
    );
    assert.equal(
      site.hasGateBefore,
      true,
      `${file} 的 ${functionName}：recordSessionUsed 排在成功门（success !== true）之前 —— ` +
        'SW 拒开时也会记账'
    );
  }
  return analysis;
}

const TAB_GROUP = 'src/components/tabs/TabGroup.tsx';
const SEARCH_LIST = 'src/components/search/SearchResultList.tsx';
const HEADER = 'src/components/layout/Header.tsx';

describe('列表页 · 打开动作成功后记「使用」', () => {
  it('恢复整个会话（锁定组也算）：成功门之后、消费之前', () => {
    const analysis = assertRecordSites(TAB_GROUP, 'openAllTabs', 1);
    const site = analysis.sites[0];
    assert.ok(
      site.start < analysis.regionText.indexOf('consumeSession();'),
      '使用记录必须在消费之前 —— 消费失败（记录没删掉）不影响「打开过」这个事实'
    );
  });

  it('点开单个标签：锁定 + 未锁定两个分支各记一次', () => {
    const analysis = assertRecordSites(TAB_GROUP, 'handleOpenTab', 2);
    assert.equal(
      analysis.sites.some(site => site.inLockedBranch),
      true,
      '锁定分支也必须记「使用」—— 锁定只阻止消费，不阻止打开'
    );
    assert.equal(
      analysis.sites.some(site => !site.inLockedBranch),
      true,
      '未锁定分支也必须记'
    );
    // 未锁定分支的记录必须在消费之前。
    const beforeConsume = analysis.sites.some(
      site => site.start < analysis.regionText.indexOf('deleteTabAndSync(')
    );
    assert.equal(beforeConsume, true, '未锁定分支的记账必须排在 deleteTabAndSync 之前');
  });

  it('TabGroup 的 import 来自本机记录模块（不是别处同名函数）', () => {
    const source = read(TAB_GROUP);
    assert.match(
      source,
      /import \{[^}]*recordSessionUsed[^}]*\} from '@\/storage-kv\/lastUsedAtStore'/,
      '记录函数必须从 @/storage-kv/lastUsedAtStore 引入'
    );
  });
});

describe('搜索页 · 三种打开动作都要记「使用」', () => {
  it('恢复整个会话（锁定组也算）：成功门之后、消费之前', () => {
    const analysis = assertRecordSites(SEARCH_LIST, 'restoreSession', 1);
    const site = analysis.sites[0];
    assert.ok(
      site.start < analysis.regionText.indexOf('consumeSession();'),
      '使用记录必须在消费之前'
    );
  });

  it('点开单个标签：锁定 + 未锁定两个分支各记一次', () => {
    const analysis = assertRecordSites(SEARCH_LIST, 'handleOpenTab', 2);
    assert.equal(
      analysis.sites.some(site => site.inLockedBranch),
      true,
      '锁定分支也必须记「使用」（与列表页同口径）'
    );
    assert.equal(
      analysis.sites.some(site => !site.inLockedBranch),
      true,
      '未锁定分支也必须记'
    );
  });

  it('批量恢复：只记「至少有一个可打开标签」的会话，且排在消费之前', () => {
    const analysis = assertRecordSites(SEARCH_LIST, 'runRestoreAllSearchResults', 1);
    const site = analysis.sites[0];
    assert.ok(
      analysis.regionText.slice(0, site.start).includes('isOpenableTabUrl'),
      '批量恢复必须按 isOpenableTabUrl 过滤 —— 全是打不开的地址的会话其实什么都没打开'
    );
    assert.ok(
      site.start < analysis.regionText.indexOf('consumeMatchedTabs()'),
      '使用记录必须在消费之前'
    );
  });
});

describe('顶栏骰子 · 随机打开也是「使用」', () => {
  it('handleRandomPick：成功门之后、消费之前', () => {
    const analysis = assertRecordSites(HEADER, 'handleRandomPick', 1);
    const site = analysis.sites[0];
    assert.ok(
      site.start < analysis.regionText.indexOf('deleteTabAndSync('),
      '使用记录必须排在 deleteTabAndSync 之前'
    );
  });
});

describe('撤销 / 确认框不记「使用」', () => {
  it('restoreFeedbackCopy 里没有记录调用（文案模块只说话，不动状态）', () => {
    const source = read('src/components/tabs/restoreFeedbackCopy.ts');
    assert.equal(source.includes('recordSessionUsed'), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 自证检测力：把源码改坏，分析器必须看得见
// ─────────────────────────────────────────────────────────────────────────

describe('自证 · 分析器对三种破口都有检测力', () => {
  it('破口一：删掉记录调用 ⇒ 数出 0 个', () => {
    const source = read(TAB_GROUP);
    const mutated = source.replace('void recordSessionUsed(group.id);\n        consumeSession();', 'consumeSession();');
    assert.notEqual(mutated, source, '变异前提没成立：找不到恢复会话的调用点');
    const analysis = analyzeRecordSites(mutated, 'openAllTabs');
    assert.equal(analysis.sites.length, 0, '删掉调用后分析器必须看得见（否则上面的计数是空的）');
  });

  it('破口二：把调用挪到成功门之前 ⇒ hasGateBefore = false', () => {
    const source = read(TAB_GROUP);
    const gate = '// 没有 success:true 就没有证据证明标签打开了：记录原样保留，可重试。';
    assert.ok(source.includes(gate), '变异前提没成立：找不到成功门的注释锚点');
    const mutated = source.replace(
      gate,
      `void recordSessionUsed(group.id);\n        ${gate}`
    );
    // 原来的那个调用点仍然在 ⇒ 现在应该有两个，其中「在成功门之前」的那个被标记。
    const analysis = analyzeRecordSites(mutated, 'openAllTabs');
    assert.ok(analysis.sites.length >= 2, '变异前提没成立：新调用点没有出现');
    assert.equal(
      analysis.sites.some(site => site.hasGateBefore === false),
      true,
      '挪到成功门之前的调用必须被标记（否则「成功门之后」这条断言是空的）'
    );
  });

  it('破口三：把调用挪进失败分支 ⇒ inFailureBranch = true', () => {
    const source = read(TAB_GROUP);
    const anchor = '          releaseAllOnce();\n          // 2026-10-19 审计 F-7';
    assert.ok(source.includes(anchor), '变异前提没成立：找不到失败分支的锚点');
    const mutated = source.replace(
      anchor,
      '          releaseAllOnce();\n          void recordSessionUsed(group.id);\n          // 2026-10-19 审计 F-7'
    );
    const analysis = analyzeRecordSites(mutated, 'openAllTabs');
    assert.equal(
      analysis.sites.some(site => site.inFailureBranch === true),
      true,
      '失败分支里的调用必须被标记（否则「不许在失败分支」这条断言是空的）'
    );
  });
});
