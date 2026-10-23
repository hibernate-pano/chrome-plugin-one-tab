/**
 * 「挂载路径」分析：弹窗**打开时**会不会加载 Supabase 门面。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * 「弹窗不许加载 Supabase SDK」这句话有两种读法：
 *   ① 弹窗**永远**不许加载 SDK；
 *   ② 弹窗**打开时**不许加载 SDK（用户点「去登录」「下载」时加载，是设计要的）。
 *
 * 只有 ② ���对的：点「去登录」时必须能加载门面，否则登录功能没了。
 * 而 ① 会把守卫写成「不许 import」⇒ 逼着实现把登录功能删掉。
 *
 * ⇒ 这里判 ②，而且判得**精确**（不是「文件里出现��就红」）。
 *
 * ── 挂载时真正会跑的代码 ────────────────────────────────────────────────
 *   · **模块顶层**（import 的那一刻就执行）；
 *   · **useEffect / useLayoutEffect 的回调**（挂载后立刻跑）；
 *   · **useMemo 的工厂**（渲染时就跑）——
 *     注意 `useCallback` 的回调**不在**这里（它只是被记住，不被调用）。
 *
 * 然后从这些「挂载根」出发，跟着**调用**走：
 *   · 走到**本文件的局部函数** ⇒ 那个函数也在挂载时跑 ⇒ 跟进去；
 *   · 走到**别的文件 import 进来的符号** ⇒ 查它在它自己文件里危不危险
 *     （危险集已经是跨文件传递闭包算出来的）。
 *
 * ⚠️ **事件处理器不算挂载路径**：
 *   `onClick={() => signOut()}` —— 这段代码在**点击时**才跑。
 *   「点退出登录才加载 SDK」是设计要的（用户明确要求了）。
 *   所以 JSX 属性里的函数**整个跳过**。
 */
import { readFileSync } from 'node:fs';
import ts from 'typescript';

import { parseSource } from './sourceAst.ts';
import { moduleBindings, dynamicImportBindings, resolveModuleSpec } from './moduleGraph.ts';

/** 一个「挂载时就会加载门面的调用点」。 */
export interface MountFacadeCall {
  /** 文件（仓库根相对）。 */
  file: string;
  /** 那个调用。 */
  callee: string;
  /** 为什么说它挂载时就会加载。 */
  why: string;
}

/** React 的「挂载就跑」的 hook。 */
const MOUNT_HOOKS = new Set(['useEffect', 'useLayoutEffect']);
/** React 的「渲染就跑」的 hook（工厂函数在渲染时执行）。 */
const RENDER_HOOKS = new Set(['useMemo']);

/** 这个节点是否落在某个 JSX 属性的值里（⇒ 点击时才跑）。 */
function isInsideJsxAttribute(node: ts.Node): boolean {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (ts.isJsxAttribute(cur)) return true;
    if (ts.isSourceFile(cur)) return false;
  }
  return false;
}

/** 这个节点是不是「一个函数的实现」（⇒ 只有被调用时才跑）。 */
function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  );
}

/**
 * 找出某个文件里「挂载时就会调用会加载门面的符号」的地方。
 *
 * @param file              要检查的文件（绝对路径）
 * @param danger            危险符号集合（文件绝对路径 → 符号名集合）
 * @param isDangerousImport 判定「某个 import 进来的符号危不危险」
 */
export function mountFacadeCalls(
  file: string,
  danger: Map<string, Set<string>>,
  isDangerousImport: (targetFile: string, importedName: string) => boolean,
): MountFacadeCall[] {
  const parsed = parseSource(file, readFileSync(file, 'utf8'));
  const sf = parsed.file;
  const binds = moduleBindings(file);
  // ⚠️ **动态** import 也要算：它在运行时才下载那个模块 ——
  // 但它照样是一条「把 SDK 拉下来」的边（静态闭包抓不到它）。
  const dynBinds = dynamicImportBindings(file);

  /** 本文件的局部函数（名字 → 声明节点）。 */
  const localFns = new Map<string, ts.Node>();
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      localFns.set(stmt.name.text, stmt);
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer && isFunctionLike(decl.initializer)) {
          localFns.set(decl.name.text, decl.initializer);
        }
      }
    }
  }

  /** 收集「在给定节点里**直接**执行」的调用（不含嵌套函数体里的）。 */
  const directCalls = (root: ts.Node): ts.CallExpression[] => {
    const out: ts.CallExpression[] = [];
    const walk = (node: ts.Node): void => {
      if (node !== root && isFunctionLike(node)) {
        // 嵌套函数体：**不**在这里执行 —— 除非它**立刻被调用**（IIFE）。
        // `void (async () => { … })()` 是挂载时立刻跑的 ⇒ 必须跟进去。
        // （漏掉 IIFE 是一条真实的漏判：旧代码的核登录态就藏在
        //   `void (async () => { … })()` 里。）
        if (!isImmediatelyInvoked(node)) return;
        // JSX 属性里的箭头函数是「点击时才跑」——同样不执行。
        if (isInsideJsxAttribute(node)) return;
      }
      if (ts.isCallExpression(node) && !isInsideJsxAttribute(node)) {
        out.push(node);
      }
      node.forEachChild(walk);
    };
    walk(root);
    return out;
  };

  /** 这个函数是不是**立刻**被调用（IIFE：`(() => {…})()` / `(async () => {…})()`）。 */
  const isImmediatelyInvoked = (fn: ts.Node): boolean => {
    let cur: ts.Node | undefined = fn.parent;
    // 跳过括号包装：`(async () => {…})()`
    while (cur && ts.isParenthesizedExpression(cur)) cur = cur.parent;
    if (!cur || !ts.isCallExpression(cur)) return false;
    let callee: ts.Node = cur.expression;
    while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
    return callee === fn;
  };

  /** 模块顶层的「import 时就执行」的节点（不含函数/类声明）。 */
  const moduleLevelRoots: ts.Node[] = [];
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) continue;
    if (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) continue;
    moduleLevelRoots.push(stmt);
  }

  /** useEffect / useLayoutEffect / useMemo 的回调。 */
  const hookRoots: ts.Node[] = [];
  const visitHooks = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (MOUNT_HOOKS.has(name) || RENDER_HOOKS.has(name)) {
        const first = node.arguments[0];
        if (first && isFunctionLike(first)) hookRoots.push(first);
      }
    }
    node.forEachChild(visitHooks);
  };
  visitHooks(sf);

  // ── 沿调用走：挂载根 ⇒ 本地函数 ⇒ …… ─────────────────────────────────
  const reachableCalls = new Set<ts.CallExpression>();
  const queue: ts.Node[] = [...moduleLevelRoots, ...hookRoots];
  const seen = new Set<ts.Node>();

  while (queue.length) {
    const node = queue.shift()!;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const call of directCalls(node)) {
      reachableCalls.add(call);
      const callee = call.expression;
      if (ts.isIdentifier(callee)) {
        const local = localFns.get(callee.text);
        if (local && !seen.has(local)) queue.push(local);
      }
    }
  }

  // ── 判定每一个「挂载时会跑的调用」危不危险 ─────────────────────────────
  const out: MountFacadeCall[] = [];
  for (const call of reachableCalls) {
    const callee = call.expression;
    if (!ts.isIdentifier(callee)) continue;
    const name = callee.text;
    const binding = binds.get(name) ?? dynBinds.get(name);
    if (binding) {
      const target = resolveModuleSpec(binding.module, file);
      if (!target) continue;
      const imported = binding.isDefault ? 'default' : binding.imported;
      if (isDangerousImport(target, imported)) {
        out.push({
          file,
          callee: name,
          why: `来自 ${binding.module} 的 ${imported}（挂载时就会跑到）`,
        });
      }
      continue;
    }
    if (danger.get(file)?.has(name)) {
      out.push({
        file,
        callee: name,
        why: '本文件内会加载门面的符号（挂载时就会跑到）',
      });
    }
  }
  return out;
}
