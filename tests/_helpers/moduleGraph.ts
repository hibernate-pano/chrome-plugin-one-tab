/**
 * 模块图：**静态** import 闭包（AST 判定，不是正则）。
 *
 * ── 为什么用 AST 而不是正则 ──────────────────────────────────────────────
 * 正则分不清「运行时 import」与「类型 import」：
 *   · `import type { X } from './x'` —— 编译后消失 ⇒ 不是依赖；
 *   · `import { type X } from './x'` —— 同上；
 *   · `export type { X } from './x'` —— 同上；
 *   · `export { X } from './x'` —— **是**依赖（re-export）。
 * 正则很容易把类型导入算成运行时依赖（或反过来）⇒ 闭包算错 ⇒
 * 判据在真被改坏时仍然绿。
 *
 * ⇒ 这里用 TypeScript AST 逐条判定。
 *
 * ── 「静态 import 闭包」是什么 ──────────────────────────────────────────
 * = 从入口出发，沿**运行时** import 走出来的全部本仓源文件。
 * 它就是「打开这个页面时**必须**下载并解析的集合」
 * （= HTML 里 modulepreload 清单的那些的源码侧对应物）。
 *
 * 动态 import（`await import()`）**不算**在内 ——
 * 它不在首屏，只在真的用到时才下载。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

import { parseSource } from './sourceAst.ts';

/** 仓库根目录。 */
export const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '../..');
/** 源码根目录。 */
export const SRC_ROOT = resolve(REPO_ROOT, 'src');

/** 扩展名候选。 */
const EXTS = ['.ts', '.tsx'];

/** 模块说明符 → 绝对路径（`@/` 与相对路径都认；解析不到返回 null）。 */
export function resolveModuleSpec(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = resolve(SRC_ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  else return null; // 裸包名 = node_modules，不是本仓源码
  for (const ext of EXTS) {
    if (existsSync(base + ext)) return base + ext;
  }
  for (const ext of EXTS) {
    const idx = resolve(base, 'index' + ext);
    if (existsSync(idx)) return idx;
  }
  return null;
}

/**
 * 一个源文件的**运行时** import 说明符。
 *
 * 计入：`import … from`、`export … from`（re-export）、副作用 import（`import './x'`）。
 * 不计入：`import type` / `export type` / `import { type X }`（编译后消失）。
 */
export function runtimeImportSpecs(file: string): string[] {
  const parsed = parseSource(file, readFileSync(file, 'utf8'));
  const sf = parsed.file;
  const out = new Set<string>();

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const clause = stmt.importClause;
      // `import type { X } from '…'` ⇒ 类型导入，编译后消失。
      if (clause && clause.isTypeOnly) continue;
      // `import { type X, Y } from '…'` ⇒ 只有 Y 是运行时依赖。
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        const hasValue = clause.namedBindings.elements.some(el => !el.isTypeOnly);
        if (!hasValue) continue;
      }
      out.add(stmt.moduleSpecifier.text);
      continue;
    }
    if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier) {
      if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      // `export type { X } from '…'` ⇒ 类型 re-export，编译后消失。
      if (stmt.isTypeOnly) continue;
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        const hasValue = stmt.exportClause.elements.some(el => !el.isTypeOnly);
        if (!hasValue) continue;
      }
      out.add(stmt.moduleSpecifier.text);
      continue;
    }
    if (ts.isImportEqualsDeclaration(stmt) && ts.isExternalModuleReference(stmt.moduleReference)) {
      const expr = stmt.moduleReference.expression;
      if (expr && ts.isStringLiteral(expr)) out.add(expr.text);
    }
  }
  return [...out];
}

/**
 * 从 `entry` 出发走**静态** import，返回闭包里的本仓源文件（**绝对路径**）。
 */
export function staticClosure(entry: string): Set<string> {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    for (const spec of runtimeImportSpecs(file)) {
      const target = resolveModuleSpec(spec, file);
      if (!target || seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return seen;
}

/** 一个 import 绑定：本地名 → 来源。 */
export interface ImportBinding {
  /** 模块说明符（原文）。 */
  module: string;
  /** 从那个模块里取的**导出名**。 */
  imported: string;
  /** 是不是 default 导入。 */
  isDefault: boolean;
}

/**
 * 一个模块里的**全部**顶层符号（含未导出的）→ 各自的实现文本。
 *
 * ⚠️ **必须包含未导出的符号**：`authSlice.ts` 的 `loadSupabaseAuth` 没有导出，
 * 但它才是真正加载门面的那一步。只看导出符号 ⇒ 推不到 `getCurrentUser`
 * ⇒ 「弹窗不许加载 SDK」这条守卫变成空壳（改回去了也不红）。
 *
 * 类的方法单列（`Class.method`），**类本身不算** ——
 * `new SupabaseBackendAdapter()` 只是构造（不加载 SDK），
 * 真正加载的是它那些方法。
 */
export function moduleSymbols(file: string): Map<string, string> {
  const parsed = parseSource(file, readFileSync(file, 'utf8'));
  const out = new Map<string, string>();
  const sf = parsed.file;
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      out.set(stmt.name.text, stmt.getText(sf));
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        // 解构式导出（`export const { a, b } = x`）不展开 ——
        // 那两个名字拿到的是同一个对象上的属性，判据层不需要它们。
        if (!decl.initializer) continue;
        if (ts.isIdentifier(decl.name)) {
          out.set(decl.name.text, decl.initializer.getText(sf));
        }
      }
      continue;
    }
    if (ts.isClassDeclaration(stmt) && stmt.name) {
      const className = stmt.name.text;
      for (const member of stmt.members) {
        if (ts.isConstructorDeclaration(member)) {
          out.set(`${className}.constructor`, member.getText(sf));
        } else if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          out.set(`${className}.${member.name.text}`, member.getText(sf));
        }
      }
    }
  }
  return out;
}

/** 一个模块的 import 绑定（本地名 → 来源）。 */
export function moduleBindings(file: string): Map<string, ImportBinding> {
  const src = parseSource(file, readFileSync(file, 'utf8'));
  const out = new Map<string, ImportBinding>();
  for (const stmt of src.file.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const module = stmt.moduleSpecifier.text;
    const clause = stmt.importClause;
    if (clause === undefined) continue;
    if (clause.name) {
      out.set(clause.name.text, { module, imported: 'default', isDefault: true });
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        out.set(el.name.text, {
          module,
          imported: (el.propertyName ?? el.name).text,
          isDefault: false,
        });
      }
    }
  }
  return out;
}

/**
 * 一个模块里的**动态** import（`await import('…')`）绑定。
 *
 * ── 为什么也要算动态的 ────────────────────────────────────────────────────
 * `await import('@/store/slices/authSlice')` 在**运行时**才下载那个模块 ——
 * 所以它**不在**静态闭包里（静态闭包只管「打开页面就必须下载的那些」）。
 * 但它照样是一条**会把 SDK 拉下来**的边（authSlice 里就有加载门面的那一步）。
 *
 * ⚠️ 只看静态 import 的话，判据会漏掉这一类 ——
 * 而「漏掉」在这里正好是那个缺陷的形状（弹窗挂载时动态取模块来核登录态）。
 *
 * @returns 本地名 → { 模块说明符, 导出名 }
 */
export function dynamicImportBindings(file: string): Map<string, ImportBinding> {
  const src = parseSource(file, readFileSync(file, 'utf8'));
  const out = new Map<string, ImportBinding>();
  const visit = (node: ts.Node): void => {
    // `const { a, b } = await import('…')` / `const mod = await import('…')`
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isAwaitExpression(node.initializer) &&
      ts.isCallExpression(node.initializer.expression) &&
      node.initializer.expression.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.initializer.expression.arguments.length === 1 &&
      ts.isStringLiteral(node.initializer.expression.arguments[0])
    ) {
      const module = node.initializer.expression.arguments[0].text;
      const pattern = node.name;
      if (ts.isObjectBindingPattern(pattern)) {
        for (const el of pattern.elements) {
          if (!ts.isBindingElement(el)) continue;
          const name = el.propertyName ?? el.name;
          if (!ts.isIdentifier(name)) continue;
          if (!ts.isIdentifier(el.name)) continue;
          out.set(el.name.text, {
            module,
            imported: name.text,
            isDefault: false,
          });
        }
      } else if (ts.isIdentifier(pattern)) {
        out.set(pattern.text, { module, imported: 'default', isDefault: true });
      }
    }
    node.forEachChild(visit);
  };
  visit(src.file);
  return out;
}

/**
 * popup 入口的静态 import 闭包（**仓库根相对**路径）。
 *
 * 抛错而不是返回空集：找不到入口 ⇒ 判据失效（那比判据红更坏，
 * 因为它会假装一切正常）。
 */
export function popupStaticClosure(): Set<string> {
  const entry = resolve(SRC_ROOT, 'popup/index.tsx');
  if (!existsSync(entry)) {
    throw new Error('找不到 popup 入口 src/popup/index.tsx');
  }
  const closure = staticClosure(entry);
  const out = new Set<string>();
  for (const f of closure) {
    out.add(f.startsWith(REPO_ROOT + '/') ? f.slice(REPO_ROOT.length + 1) : f);
  }
  return out;
}
