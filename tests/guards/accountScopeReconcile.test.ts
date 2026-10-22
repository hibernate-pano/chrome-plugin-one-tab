/**
 * 账号闸门与上传对账的接缝（2026-10-22 DS-1 收口；2026-10-23 审计 R-2 / R-3 改写）。
 *
 * ── 这条接缝上出过什么问题 ──────────────────────────────────────────────
 * 账号闸门（`utils/supabase/upload.ts`）把「属于别的账号」的会话挡在上行
 * 集合之外 —— 硬底线，挡住了跨账号泄露。但**上游的对账**不知道这件事：
 * `syncEngine` 把「本轮交给适配器的清单」当成「本轮真的提交了什么」，
 * 于是被挡下的那批被算成「已裁决」：
 *   ① 用户看不到「还有 N 个会话没同步」；
 *   ② 「本轮是全量」被误判成 true ⇒ 漏登记的那批改动被当成已补上
 *      ⇒ 可能永远补不回来。
 *
 * ── 2026-10-23 审计 R-2：旧守卫的判据**零检测力** ──────────────────────
 * 旧版的主断言是**整文件 grep**（`/blockedAccountIds/`、`/blockedByAccountScope\.has\(/`、
 * `/notThisAccountIds:/`、`/filter\(id => !blockedByAccountScope\.has\(id\)\)/`）。
 * 后果：
 *   · 把**真的那步过滤**（`submittedGroupIds = …filter(id => !blocked…has(id))`）
 *     从引擎里删掉，守卫**照样全绿** —— 因为「本轮是不是全量」那一步
 *     （另一个地方也有 `blockedByAccountScope.has(`）让 grep 命中了。
 *   · 判据钉的是**字面量** ⇒ 等价改写（`const blockedSet = blockedByAccountScope;`
 *     之后用 `blockedSet.has(id)`）会被误判成「没接线」⇒ 把正确的实现改成红的
 *     （本仓库第三次踩「守卫钉字面量挡正确修复」那个坑）。
 *
 * ── 这版判据钉的是什么 ──────────────────────────────────────────────────
 * **数据流**，不是长相。三个接缝各自对应一份**接口契约里的字段名**
 * （`SyncBackendPort.blockedAccountIds`、`UploadCoverageInput.submittedIds` /
 * `notThisAccountIds`、`decideRegistryAfterUpload` 入参的 `submittedFullScope`），
 * 判据从这些字段**往回追数据**：
 *   ① 「提交给后端的清单」这一路，必须**把被闸门挡下的剔掉**；
 *   ② 「本轮是不是全量」这一路，必须**把被闸门挡下的排除**；
 *   ③ 对账函数必须**收到**被闸门挡下的那批。
 * 而「被闸门挡下的那批」是什么，不看某个变量名 —— 而是从**协议源头**
 * （上传结果里的 `blockedAccountIds`）出发，沿「容器方向」（new Set / 数组 /
 * 展开 / ?? / 条件表达式）求闭包，**别名也算同一个源头**。
 * ⇒ 等价改写（换个变量名、抽个别名、换个写法）**照样绿**；
 *   真把某一步摘掉**一定红**。
 *
 * ── 自证检测力（写在本文件末尾，三条用例）──────────────────────────────
 * A. 摘掉「从已提交里剔出去」这一步（= 旧守卫看不见的那个破口）⇒ 必须红；
 * B. 把「被闸门挡下的那批」改成**别名**再用（语义等价的改写）⇒ 必须**绿**；
 * C. 整个归属闸门失效（引擎根本读不到 `blockedAccountIds`）⇒ 必须红。
 *
 * 三个判据函数都是**纯函数**（吃源码文本、吐结构）⇒ 上面三条可以直接喂它
 * 改过的源码，不用「改文件→跑→改回来」，失败时也不会留下半改的工作区。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8');

const ENGINE = 'src/services/syncEngine.ts';
const ADAPTER = 'src/sync-backend/supabaseAdapter.ts';
const SERVICE = 'src/services/tabGroupSyncService.ts';
const SUPABASE_UPLOAD = 'src/utils/supabase/upload.ts';

/**
 * 协议字段名：后端端口（`SyncBackendPort`）与对账函数入参（`UploadCoverageInput`）
 * 的一部分。**钉它合法** —— 它是接口契约里的名字，不是某个人的局部变量名
 * （局部变量名一律不钉，见文件头）。
 */
const BLOCKED_FIELD = 'blockedAccountIds';

// ══════════════════════════════════════════════════════════════════════════
// 一、纯函数层：对账函数自己的口径
// ══════════════════════════════════════════════════════════════════════════

test('对账：属于别的账号的会话不计入「未同步」', async () => {
  const { reconcileUploadCoverage } = await import('@/core/uploadCoverage');

  const coverage = reconcileUploadCoverage({
    registeredIds: ['mine-1', 'foreign-1'],
    submittedIds: ['mine-1'],
    uploadPerformed: true,
    // 闸门挡下的那批：它们没进上行集合，也不该算「没传上去」。
    notThisAccountIds: ['foreign-1'],
  });

  assert.equal(
    coverage.unsyncedCount,
    0,
    '属于别的账号的会话不是「没传上去」，不许算作未同步（否则 pending_upload 永远清不掉）'
  );
  assert.equal(coverage.canClearPending, true, '本账号的会话都传上去了 ⇒ 可以清 pending_upload');
  assert.equal(coverage.cannotConfirmAllSynced, false);
});

test('对账：不传 notThisAccountIds 时，被挡下的那批仍算未同步（不得偷偷放行）', async () => {
  const { reconcileUploadCoverage } = await import('@/core/uploadCoverage');

  const coverage = reconcileUploadCoverage({
    registeredIds: ['mine-1', 'foreign-1'],
    submittedIds: ['mine-1'],
    uploadPerformed: true,
  });

  assert.equal(
    coverage.unsyncedCount,
    1,
    '没告知「这批属于别的账号」时，必须按「没传上去」算（保守方向）'
  );
  assert.equal(coverage.canClearPending, false);
});

// ══════════════════════════════════════════════════════════════════════════
// 二、数据流层：引擎里的三处接缝
// ══════════════════════════════════════════════════════════════════════════

/** 变量绑定：声明与赋值各算一条（同名取最后一条 = 生效的那条）。 */
interface Binding {
  name: string;
  init: ts.Expression;
}

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile('analyze.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function collectBindings(src: ts.SourceFile): Binding[] {
  const out: Binding[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      out.push({ name: n.name.text, init: n.initializer });
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(n.left)
    ) {
      out.push({ name: n.left.text, init: n.right });
    }
    n.forEachChild(visit);
  };
  visit(src);
  return out;
}

/**
 * 这个表达式是不是**派生自**「被闸门挡下的那批」。
 *
 * ⚠️ 只沿「容器方向」走（new Set / 数组 / 展开 / ?? / 条件表达式），
 * **不钻进函数体** —— 否则「消费者」（例如把清单过滤掉的那一步）也会被
 * 误认成「源头」，判据就变成自证。
 */
function derivesFromBlocked(node: ts.Node, known: ReadonlySet<string>): boolean {
  if (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  ) {
    return false;
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isAwaitExpression(node)
  ) {
    return derivesFromBlocked(node.expression, known);
  }
  if (ts.isIdentifier(node)) return known.has(node.text);
  if (ts.isPropertyAccessExpression(node)) {
    // 协议源头：上传结果里的 blockedAccountIds。
    if (node.name.text === BLOCKED_FIELD) return true;
    return derivesFromBlocked(node.expression, known);
  }
  if (ts.isElementAccessExpression(node)) {
    if (ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === BLOCKED_FIELD) {
      return true;
    }
    return derivesFromBlocked(node.expression, known);
  }
  if (ts.isSpreadElement(node)) return derivesFromBlocked(node.expression, known);
  if (ts.isArrayLiteralExpression(node)) return node.elements.some(e => derivesFromBlocked(e, known));
  if (ts.isNewExpression(node)) return (node.arguments ?? []).some(a => derivesFromBlocked(a, known));
  if (ts.isCallExpression(node)) return node.arguments.some(a => derivesFromBlocked(a, known));
  if (ts.isBinaryExpression(node)) {
    return derivesFromBlocked(node.left, known) || derivesFromBlocked(node.right, known);
  }
  if (ts.isConditionalExpression(node)) {
    return derivesFromBlocked(node.whenTrue, known) || derivesFromBlocked(node.whenFalse, known);
  }
  // ⚠️ 故意**不**沿对象字面量往下走：装着「被挡下的那批」的对象是**消费者**
  // （比如对账结果 coverage），不是「被挡下的那批」本身 —— 把它算进同源闭包
  // 会让判据自证（任何「消费端」都被当成「源头」）。
  if (ts.isPropertyAssignment(node)) return derivesFromBlocked(node.initializer, known);
  if (ts.isShorthandPropertyAssignment(node)) return derivesFromBlocked(node.name, known);
  if (ts.isSpreadAssignment(node)) return derivesFromBlocked(node.expression, known);
  return false;
}

/** 「被闸门挡下的那批」的全部同源变量（源头 + 别名 + 容器派生）。 */
function blockedVarClosure(bindings: Binding[]): string[] {
  const known = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of bindings) {
      if (known.has(b.name)) continue;
      if (derivesFromBlocked(b.init, known)) {
        known.add(b.name);
        changed = true;
      }
    }
  }
  return [...known];
}

/** 这个「成员判断」是不是处于**否定**位置（`!x.has(id)` / `x.has(id) === false`）。 */
function isNegated(n: ts.Node): boolean {
  let cur: ts.Node = n;
  let parent = cur.parent;
  while (parent && ts.isParenthesizedExpression(parent)) {
    cur = parent;
    parent = parent.parent;
  }
  if (!parent) return false;
  if (
    ts.isPrefixUnaryExpression(parent) &&
    parent.operator === ts.SyntaxKind.ExclamationToken &&
    parent.operand === cur
  ) {
    return true;
  }
  if (ts.isBinaryExpression(parent)) {
    const kind = parent.operatorToken.kind;
    const isEq = kind === ts.SyntaxKind.EqualsEqualsEqualsToken || kind === ts.SyntaxKind.EqualsEqualsToken;
    const isNeq =
      kind === ts.SyntaxKind.ExclamationEqualsEqualsToken || kind === ts.SyntaxKind.ExclamationEqualsToken;
    if (isEq || isNeq) {
      const other = parent.left === cur ? parent.right : parent.left;
      if (other.kind === ts.SyntaxKind.FalseKeyword) return isEq;
      if (other.kind === ts.SyntaxKind.TrueKeyword) return isNeq;
    }
  }
  return false;
}

/** 处于否定位置的「对被闸门挡下的那批的成员判断」里，用到的是哪些变量。 */
function negatedMembershipVars(node: ts.Node, known: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'has' &&
      ts.isIdentifier(n.expression.expression) &&
      known.has(n.expression.expression.text) &&
      isNegated(n)
    ) {
      found.add(n.expression.expression.text);
    }
    n.forEachChild(visit);
  };
  visit(node);
  return [...found];
}

/** 这段表达式里引用了哪些「被闸门挡下的那批」的变量（不要求否定位置）。 */
function referencedBlockedVars(node: ts.Node, known: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && known.has(n.text)) found.add(n.text);
    n.forEachChild(visit);
  };
  visit(node);
  return [...found];
}

function findCall(src: ts.SourceFile, name: string): ts.CallExpression | null {
  let found: ts.CallExpression | null = null;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) {
      found = n;
      return;
    }
    n.forEachChild(visit);
  };
  visit(src);
  return found;
}

function firstObjectArg(call: ts.CallExpression): ts.ObjectLiteralExpression | null {
  const first = call.arguments[0];
  return first && ts.isObjectLiteralExpression(first) ? first : null;
}

function getProp(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | null {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name) {
      return p.initializer;
    }
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) {
      return p.name;
    }
  }
  return null;
}

/** 把「变量名」追到它生效的那条绑定上（同名取最后一条）。 */
function resolveValue(bindings: Binding[], expr: ts.Expression): ts.Expression {
  if (!ts.isIdentifier(expr)) return expr;
  let resolved: ts.Expression = expr;
  for (const b of bindings) {
    if (b.name === expr.text) resolved = b.init;
  }
  return resolved;
}

interface EngineWiring {
  /** 「被闸门挡下的那批」的全部同源变量（源头 + 别名）。 */
  blockedVars: string[];
  /** 「提交给后端的清单」有没有把被挡下的剔掉。 */
  submittedExcludesBlocked: boolean;
  /** 「本轮是不是全量」有没有把被挡下的排除。 */
  fullScopeExcludesBlocked: boolean;
  /** 对账函数有没有收到被挡下的那批。 */
  reconcileCarriesBlocked: boolean;
  /** 三处各自引用了哪个同源变量（诊断用）。 */
  usedInSubmitted: string[];
  usedInFullScope: string[];
  usedInReconcile: string[];
}

/** 解析引擎源码，抽出三处接缝的数据流（纯函数，无 IO）。 */
function analyzeEngineWiring(source: string): EngineWiring {
  const src = parse(source);
  const bindings = collectBindings(src);
  const known = new Set(blockedVarClosure(bindings));

  // ① 「提交给后端的清单」：对账函数入参里的 submittedIds 那一路。
  const reconcileCall = findCall(src, 'reconcileUploadCoverage');
  const reconcileObj = reconcileCall ? firstObjectArg(reconcileCall) : null;
  const submittedProp = reconcileObj ? getProp(reconcileObj, 'submittedIds') : null;
  const submittedExpr = submittedProp ? resolveValue(bindings, submittedProp) : null;

  // ② 「本轮是不是全量」：登记状态裁决入参里的 submittedFullScope 那一路。
  const registryCall = findCall(src, 'decideRegistryAfterUpload');
  const registryObj = registryCall ? firstObjectArg(registryCall) : null;
  const fullScopeProp = registryObj ? getProp(registryObj, 'submittedFullScope') : null;
  const fullScopeExpr = fullScopeProp ? resolveValue(bindings, fullScopeProp) : null;

  // ③ 对账函数有没有收到被挡下的那批。
  const notThisProp = reconcileObj ? getProp(reconcileObj, 'notThisAccountIds') : null;

  const usedInSubmitted = submittedExpr ? negatedMembershipVars(submittedExpr, known) : [];
  const usedInFullScope = fullScopeExpr ? negatedMembershipVars(fullScopeExpr, known) : [];
  const usedInReconcile = notThisProp ? referencedBlockedVars(notThisProp, known) : [];

  return {
    blockedVars: [...known],
    submittedExcludesBlocked: usedInSubmitted.length > 0,
    fullScopeExcludesBlocked: usedInFullScope.length > 0,
    reconcileCarriesBlocked: usedInReconcile.length > 0,
    usedInSubmitted,
    usedInFullScope,
    usedInReconcile,
  };
}

test('接线：syncEngine 把被闸门挡下的会话从「已提交」里剔出去', () => {
  const wiring = analyzeEngineWiring(read(ENGINE));
  assert.ok(
    wiring.blockedVars.length > 0,
    `${ENGINE} 必须从上传结果里读出被账号闸门挡下的那批（blockedAccountIds）` +
      '—— 读不到就等于不知道哪些会话不属于当前账号'
  );
  assert.ok(
    wiring.submittedExcludesBlocked,
    `${ENGINE} 算「本轮提交了什么」时必须把被闸门挡下的会话剔出去` +
      '（不剔的后果：用户看不到「还有 N 个会话没同步」，且「本轮是全量」被误判成 true）'
  );
});

test('接线：syncEngine 判「本轮是不是全量」时排除被闸门挡下的会话', () => {
  const wiring = analyzeEngineWiring(read(ENGINE));
  assert.ok(
    wiring.fullScopeExcludesBlocked,
    `${ENGINE} 判「本轮覆盖了全部活跃会话」时必须排除不属于当前账号的会话` +
      '（否则这个缺口永远关不上 ⇒ pending_upload 永远清不掉）'
  );
});

test('接线：syncEngine 把被闸门挡下的会话告诉对账函数', () => {
  const wiring = analyzeEngineWiring(read(ENGINE));
  assert.ok(
    wiring.reconcileCarriesBlocked,
    `${ENGINE} 必须把被闸门挡下的会话传进对账函数（notThisAccountIds）—— ` +
      '不传的话它们会被算成「未同步」'
  );
});

test('接线：三处接缝认的是**同一批**被闸门挡下的会话（同一个数据流）', () => {
  const wiring = analyzeEngineWiring(read(ENGINE));
  const all = [
    ...wiring.usedInSubmitted,
    ...wiring.usedInFullScope,
    ...wiring.usedInReconcile,
  ];
  assert.ok(all.length > 0, '前提：三处接缝都得有引用');
  // 每一处引用的变量都必须在同一个同源闭包里（源头是协议字段 blockedAccountIds）。
  for (const name of all) {
    assert.ok(
      wiring.blockedVars.includes(name),
      `「${name}」不属于「被闸门挡下的那批」的同源闭包 —— 三处接缝用的不是同一份数据`
    );
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 三、透传层：协议字段必须一路活到引擎（不许在中途被吞掉）
// ══════════════════════════════════════════════════════════════════════════

/** 这个文件里**产出**协议字段 blockedAccountIds 的那些初值。 */
function blockedFieldValues(source: string): ts.Expression[] {
  const src = parse(source);
  const out: ts.Expression[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isObjectLiteralExpression(n)) {
      for (const p of n.properties) {
        if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === BLOCKED_FIELD) {
          out.push(p.initializer);
        } else if (ts.isShorthandPropertyAssignment(p) && p.name.text === BLOCKED_FIELD) {
          out.push(p.name);
        }
      }
    }
    n.forEachChild(visit);
  };
  visit(src);
  return out;
}

test('接线：被挡下的 id 一路透传到 syncEngine（适配器与门面不许吞）', () => {
  for (const file of [SUPABASE_UPLOAD, ADAPTER, SERVICE]) {
    const values = blockedFieldValues(read(file));
    assert.ok(
      values.length > 0,
      `${file} 必须把闸门挡下的 id 放进返回值（协议字段 ${BLOCKED_FIELD}）` +
        '—— 中途吞掉的话，引擎根本不知道哪些会话没上传成功'
    );
    assert.ok(
      values.every(v => !(ts.isArrayLiteralExpression(v) && v.elements.length === 0)),
      `${file} 不许把 ${BLOCKED_FIELD} 写死成空数组（那等于永远告诉引擎「没有会话被挡下」）`
    );
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 四、自证检测力（三个变体：摘掉一步 / 等价改写 / 整个闸门失效）
// ══════════════════════════════════════════════════════════════════════════

/** 找到「把被闸门挡下的剔出去」那一步（.filter(回调里有否定成员判断)）。 */
function findExclusionCall(root: ts.Node, known: ReadonlySet<string>): ts.CallExpression | null {
  let found: ts.CallExpression | null = null;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'filter'
    ) {
      const cb = n.arguments[0];
      if (cb && negatedMembershipVars(cb, known).length > 0) {
        found = n;
        return;
      }
    }
    n.forEachChild(visit);
  };
  visit(root);
  return found;
}

/** 「提交给后端的清单」那一路里的排除调用。 */
function findSubmittedExclusion(source: string): ts.CallExpression | null {
  const src = parse(source);
  const bindings = collectBindings(src);
  const known = new Set(blockedVarClosure(bindings));
  const reconcileCall = findCall(src, 'reconcileUploadCoverage');
  const obj = reconcileCall ? firstObjectArg(reconcileCall) : null;
  const prop = obj ? getProp(obj, 'submittedIds') : null;
  if (!prop) return null;
  const expr = resolveValue(bindings, prop);
  return findExclusionCall(expr, known);
}

/** 变体 A：把「从已提交里剔出去」这一步摘掉（= 旧守卫看不见的那个破口）。 */
function removeSubmittedExclusion(source: string): string {
  const src = parse(source);
  const call = findSubmittedExclusion(source);
  if (!call) return source;
  return (
    source.slice(0, call.getStart()) +
    call.expression.getText(src) +
    source.slice(call.getEnd())
  );
}

/** 变体 B：把「被闸门挡下的那批」换成别名再用（语义等价的改写）。 */
function rewriteWithAlias(source: string): string {
  const bindings = collectBindings(parse(source));
  const known = new Set(blockedVarClosure(bindings));
  const reconcileCall = findCall(parse(source), 'reconcileUploadCoverage');
  const obj = reconcileCall ? firstObjectArg(reconcileCall) : null;
  const prop = obj ? getProp(obj, 'submittedIds') : null;
  if (!prop) return source;
  const expr = resolveValue(bindings, prop);
  const call = findExclusionCall(expr, known);
  if (!call) return source;
  const receiver = findReceiverIdentifier(call, known);
  if (!receiver) return source;

  const original = receiver.text;
  const alias = 'blockedSetAliasForTest';
  const withAliasUse =
    source.slice(0, receiver.getStart()) + alias + source.slice(receiver.getEnd());

  // 在使用别名的那条语句之前插入 `const 别名 = 原变量;`
  const src2 = parse(withAliasUse);
  let aliasNode: ts.Identifier | null = null;
  const visit = (n: ts.Node): void => {
    if (aliasNode) return;
    if (ts.isIdentifier(n) && n.text === alias) {
      aliasNode = n;
      return;
    }
    n.forEachChild(visit);
  };
  visit(src2);
  if (!aliasNode) return withAliasUse;
  const stmt = enclosingStatement(aliasNode);
  const indent = ' '.repeat(leadingSpacesOf(stmt, src2));
  return (
    withAliasUse.slice(0, stmt.getStart()) +
    `${indent}const ${alias} = ${original};\n` +
    withAliasUse.slice(stmt.getStart())
  );
}

/** 找出排除回调里那个「成员判断」的接收者标识符。 */
function findReceiverIdentifier(
  call: ts.CallExpression,
  known: ReadonlySet<string>
): ts.Identifier | null {
  const cb = call.arguments[0];
  if (!cb) return null;
  let found: ts.Identifier | null = null;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'has' &&
      ts.isIdentifier(n.expression.expression) &&
      known.has(n.expression.expression.text) &&
      isNegated(n)
    ) {
      found = n.expression.expression as ts.Identifier;
      return;
    }
    n.forEachChild(visit);
  };
  visit(cb);
  return found;
}

/** 某节点所在的最外层语句。 */
function enclosingStatement(n: ts.Node): ts.Statement {
  let cur: ts.Node = n;
  let parent = cur.parent;
  while (parent && !ts.isStatement(parent)) {
    cur = parent;
    parent = parent.parent;
  }
  return (parent ?? cur) as ts.Statement;
}

/** 该语句前面缩进了几个空格（用来给插入的声明对齐）。 */
function leadingSpacesOf(n: ts.Node, src: ts.SourceFile): number {
  const lineStart = src.getLineAndCharacterOfPosition(n.getStart()).line;
  const line = src.getFullText().split('\n')[lineStart] ?? '';
  return line.length - line.trimStart().length;
}

/** 变体 C：整个归属闸门失效 —— 引擎根本读不到 blockedAccountIds。 */
function breakGateRoot(source: string): string {
  const src = parse(source);
  const bindings = collectBindings(src);
  const root = bindings.find(b => mentionsBlockedField(b.init));
  if (!root) return source;
  return source.slice(0, root.init.getStart()) + '[]' + source.slice(root.init.getEnd());
}

/** 变体 D：把「本轮是不是全量」那一步里的排除摘掉。 */
function removeFullScopeExclusion(source: string): string {
  const src = parse(source);
  const bindings = collectBindings(src);
  const known = new Set(blockedVarClosure(bindings));
  const registryCall = findCall(src, 'decideRegistryAfterUpload');
  const obj = registryCall ? firstObjectArg(registryCall) : null;
  const prop = obj ? getProp(obj, 'submittedFullScope') : null;
  if (!prop) return source;
  const expr = resolveValue(bindings, prop);
  const call = findExclusionCall(expr, known);
  if (!call) return source;
  return source.slice(0, call.getStart()) + call.expression.getText(src) + source.slice(call.getEnd());
}

/** 变体 E：把「被挡下的那批」从对账函数的入参里摘掉。 */
function removeNotThisAccountIds(source: string): string {
  const src = parse(source);
  const reconcileCall = findCall(src, 'reconcileUploadCoverage');
  const obj = reconcileCall ? firstObjectArg(reconcileCall) : null;
  if (!obj) return source;
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'notThisAccountIds') {
      const start = p.getStart();
      // 连同后面的逗号一起删掉（不留悬空逗号）。
      const end = p.getEnd();
      const after = source.slice(end);
      const comma = /^\s*,/.exec(after);
      const cutEnd = comma ? end + comma[0].length : end;
      return source.slice(0, start) + source.slice(cutEnd);
    }
  }
  return source;
}

/** 这个表达式里有没有直接提到协议字段 blockedAccountIds。 */
function mentionsBlockedField(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAccessExpression(n) && n.name.text === BLOCKED_FIELD) {
      found = true;
      return;
    }
    if (ts.isElementAccessExpression(n) && ts.isStringLiteral(n.argumentExpression) && n.argumentExpression.text === BLOCKED_FIELD) {
      found = true;
      return;
    }
    n.forEachChild(visit);
  };
  visit(node);
  return found;
}

test('自证检测力：把「从已提交里剔出去」这一步摘掉，守卫必须看得见', () => {
  const original = read(ENGINE);
  const before = analyzeEngineWiring(original);
  assert.equal(
    before.submittedExcludesBlocked,
    true,
    '前提没成立：当前源码里找不到这一步（判据需要更强的信号）'
  );

  const broken = removeSubmittedExclusion(original);
  assert.notEqual(broken, original, '本用例前提没成立：源码里找不到可摘掉的那一步');

  const after = analyzeEngineWiring(broken);
  assert.equal(
    after.submittedExcludesBlocked,
    false,
    '判据失效：接线被摘掉后仍应识别出「没剔」（旧守卫在这里是绿的 ⇒ 零检测力）'
  );
  // 破口是**外科手术式**的：另外两处接缝不该受影响。
  assert.equal(after.fullScopeExcludesBlocked, true, '前提没成立：变体只应影响「已提交」那一路');
  assert.equal(after.reconcileCarriesBlocked, true, '前提没成立：变体只应影响「已提交」那一路');
});

test('自证检测力：语义等价的改写（抽个别名再用）必须**照样绿**', () => {
  const original = read(ENGINE);
  const rewritten = rewriteWithAlias(original);
  assert.notEqual(rewritten, original, '本用例前提没成立：源码里找不到可改写的成员判断');

  const after = analyzeEngineWiring(rewritten);
  assert.equal(
    after.submittedExcludesBlocked,
    true,
    '判据过严：换个变量名/抽个别名就被判成「没接线」—— 这会让**正确的修复**变红' +
      '（本仓库已经因为「守卫钉字面量」红过三次）'
  );
  assert.equal(after.fullScopeExcludesBlocked, true, '判据过严：别名改写不该影响另一处接缝');
  assert.equal(after.reconcileCarriesBlocked, true, '判据过严：别名改写不该影响另一处接缝');
});

test('自证检测力：整个归属闸门失效时，守卫必须看得见', () => {
  const original = read(ENGINE);
  const broken = breakGateRoot(original);
  assert.notEqual(broken, original, '本用例前提没成立：源码里找不到协议源头');

  const after = analyzeEngineWiring(broken);
  assert.equal(after.blockedVars.length, 0, '前提没成立：闸门失效后不该再有同源变量');
  assert.equal(after.submittedExcludesBlocked, false, '判据失效：闸门整个没了，守卫必须看得见');
  assert.equal(after.fullScopeExcludesBlocked, false, '判据失效：闸门整个没了，守卫必须看得见');
  assert.equal(after.reconcileCarriesBlocked, false, '判据失效：闸门整个没了，守卫必须看得见');
});

test('自证检测力：另外两处接缝被摘掉时，也必须看得见', () => {
  const original = read(ENGINE);

  // 变体 D：「本轮是不是全量」那一步不再排除被挡下的会话。
  const withoutFullScope = removeFullScopeExclusion(original);
  assert.notEqual(withoutFullScope, original, '前提没成立：源码里找不到可摘掉的那一步');
  const afterD = analyzeEngineWiring(withoutFullScope);
  assert.equal(
    afterD.fullScopeExcludesBlocked,
    false,
    '判据失效：「全量判断」那一步被摘掉后仍应识别出「没排除」'
  );
  assert.equal(afterD.submittedExcludesBlocked, true, '前提没成立：变体 D 只应影响「全量」那一路');

  // 变体 E：被挡下的那批不再告诉对账函数。
  const withoutNotThis = removeNotThisAccountIds(original);
  assert.notEqual(withoutNotThis, original, '前提没成立：源码里找不到 notThisAccountIds');
  const afterE = analyzeEngineWiring(withoutNotThis);
  assert.equal(
    afterE.reconcileCarriesBlocked,
    false,
    '判据失效：被挡下的那批没告诉对账函数时仍应识别出「没接上」'
  );
  assert.equal(afterE.submittedExcludesBlocked, true, '前提没成立：变体 E 只应影响对账入参那一路');
});
