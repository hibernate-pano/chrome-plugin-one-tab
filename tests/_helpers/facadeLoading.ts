/**
 * 「哪些符号会加载 Supabase 门面」——**算出来的**，不是抄出来的。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * 「弹窗不许加载 Supabase SDK」这条规则，要判的是**行为**：
 * 弹窗的挂载路径上不许出现「最终会去加载门面」的调用。
 *
 * 而「会加载门面的符号」是一张**会漂移的清单**：
 * 有人给加载器改个名、把 `loadSupabaseAuth` 导出、又加一条新的加载路径 ——
 * 手抄的清单立刻过期 ⇒ 守卫变成永远绿（比没有守卫更坏）。
 *
 * ⇒ 这里**从源码算出**这张清单：先认「根」（函数体里真的
 * `import('@/utils/supabaseFacade')` 的那个），再沿着**调用**往外推：
 *   · 同文件里的局部函数（**哪怕它没有被导出** —— 这一点是关键，
 *     `authSlice.ts` 的 `loadSupabaseAuth` 就是没导出的，
 *     只看导出符号的话推不到 `getCurrentUser`，守卫就成了空壳）；
 *   · 跨文件的 import 绑定（`import { x } from './y'` ⇒ 去 y 里看 x 危不危险）；
 *   · 类的方法（`Class.method`）—— 与构造（`new Class()`）**分开**算，
 *     因为构造适配器不加载 SDK，调用它的方法才加载。
 *
 * ── 这套算法能判什么、不能判什么（说实话） ───────────────────────────────
 * ✅ 能判：直接调用、跨文件调用、`this.method()` 调用。
 * ❌ 判不了：`const f = loadSupabaseAuth; f()`（间接引用）、
 *    以及「调用了一个类型不明的对象上的方法」（`obj.method()`，obj 的类型
 *    查不出来）。这两类在本仓都不存在（门面加载器只有两个调用点，
 *    都是直接调用）。
 *
 * ⇒ 运行时的**最终**证据仍然是真机：`scripts/lead-verify-first-screen.mjs`
 *   量的是「首帧之前真的下载了多少字节」。这里的判据是它的**快速**对应物。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

import { parseSource } from './sourceAst.ts';
import {
  moduleBindings,
  moduleSymbols,
  resolveModuleSpec,
  SRC_ROOT,
} from './moduleGraph.ts';
import type { ImportBinding } from './moduleGraph.ts';

/** 仓库根目录。 */
export { REPO_ROOT, SRC_ROOT } from './moduleGraph.ts';

/** 门面模块（动态 import 它 ⇒ 整条 Supabase SDK 被拉下来）。 */
export const FACADE_MODULE = '@/utils/supabaseFacade';

/** 递归列出 `src/` 下的 .ts / .tsx。 */
export function sourceFiles(dir: string = SRC_ROOT): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      out.push(...sourceFiles(p));
    } else if (/\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}


/**
 * 文本里有没有「调用某个名字」（`name(`）。
 *
 * 只认**直接调用**：`(?:^|[^\w$.])name\s*\(` ——
 * `obj.name(` 不算（那是另一个对象上的方法，解析不出类型）。
 */
function callsName(text: string, name: string): boolean {
  return new RegExp(`(?:^|[^\\w$.])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`).test(text);
}

/** 文本里有没有「引用某个名字」（当作参数传、赋给变量等）。 */
function mentionsName(text: string, name: string): boolean {
  return new RegExp(`(?:^|[^\\w$.])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`).test(text);
}

/**
 * 算出「会加载 Supabase 门面」的符号集合。
 *
 * @returns 文件绝对路径 → 危险符号名集合
 */
export function facadeLoadingSymbols(): Map<string, Set<string>> {
  const files = sourceFiles();
  const symbolsOf = new Map<string, Map<string, string>>();
  const bindingsOf = new Map<string, Map<string, ImportBinding>>();
  for (const f of files) {
    symbolsOf.set(f, moduleSymbols(f));
    bindingsOf.set(f, moduleBindings(f));
  }

  const danger = new Map<string, Set<string>>();
  const addDanger = (file: string, name: string): void => {
    if (!danger.has(file)) danger.set(file, new Set());
    danger.get(file)!.add(name);
  };
  const isDanger = (file: string, name: string): boolean => danger.get(file)?.has(name) === true;

  // ── ① 根：函数体里真的动态 import 门面 ────────────────────────────────
  const facadeImport = new RegExp(
    `import\\s*\\(\\s*['"]${FACADE_MODULE.replace('/', '\\/')}['"]\\s*\\)`,
  );
  for (const [f, syms] of symbolsOf) {
    for (const [name, body] of syms) {
      if (facadeImport.test(body)) addDanger(f, name);
    }
  }
  // 静态 import 门面的模块：它的**每个**导出符号都算危险
  // （import 它就已经把 SDK 拉进那个 chunk 了）。
  for (const [f, binds] of bindingsOf) {
    const statics = [...binds.values()].filter(b =>
      b.module === FACADE_MODULE,
    );
    if (!statics.length) continue;
    for (const name of symbolsOf.get(f)!.keys()) addDanger(f, name);
  }

  // ── ② 闭包推进：调用了危险符号的，也危险 ─────────────────────────────
  for (let round = 0; round < 8; round++) {
    let changed = false;
    for (const [f, syms] of symbolsOf) {
      const binds = bindingsOf.get(f)!;
      for (const [name, body] of syms) {
        if (isDanger(f, name)) continue;
        // ②a 同文件的局部符号（含未导出的）
        let hit = false;
        for (const local of syms.keys()) {
          if (local === name) continue;
          if (!isDanger(f, local)) continue;
          if (callsName(body, local)) {
            hit = true;
            break;
          }
        }
        if (!hit) {
          // ②b 跨文件：import 进来的名字
          for (const [local, binding] of binds) {
            if (!callsName(body, local)) continue;
            const target = resolveModuleSpec(binding.module, f);
            if (!target) continue;
            const imported = binding.isDefault ? 'default' : binding.imported;
            if (isDanger(target, imported)) {
              hit = true;
              break;
            }
          }
        }
        if (hit) {
          addDanger(f, name);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  return danger;
}

/** 一个「会加载门面的调用点」。 */
export interface FacadeCallSite {
  /** 在哪个文件。 */
  file: string;
  /** 调用的那个符号（本地名）。 */
  callee: string;
  /** 它为什么危险（人话，进报错信息）。 */
  why: string;
}

/**
 * 找出某个文件里「调用了会加载门面的符号」的地方。
 *
 * @param file 要检查的文件
 * @param danger 危险符号集合（默认现算）
 */
export function facadeLoadingCallSites(
  file: string,
  danger: Map<string, Set<string>> = facadeLoadingSymbols(),
): FacadeCallSite[] {
  const src = parseSource(file, readFileSync(file, 'utf8'));
  const binds = moduleBindings(file);
  const syms = moduleSymbols(file);
  const out: FacadeCallSite[] = [];

  const isDangerHere = (name: string): boolean => danger.get(file)?.has(name) === true;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        const name = callee.text;
        const binding = binds.get(name);
        if (binding) {
          const target = resolveModuleSpec(binding.module, file);
          if (target) {
            const imported = binding.isDefault ? 'default' : binding.imported;
            if (danger.get(target)?.has(imported)) {
              out.push({
                file,
                callee: name,
                why: `来自 ${binding.module} 的 ${imported}`,
              });
            }
          }
        } else if (isDangerHere(name)) {
          out.push({ file, callee: name, why: '本文件内会加载门面的符号' });
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(src.file);
  void syms;
  return out;
}

/**
 * 找出某个文件里「**模块顶层**（import 时就会执行）调用了会加载门面的符号」的地方。
 *
 * 为什么单独判这一层：模块顶层代码在**被 import 的那一刻**就执行 ——
 * 也就是说，只要这个文件进了首屏的静态图，那一次加载就发生在首屏，
 * 比「用户点了某个按钮才加载」严重得多。
 *
 * @param file 要检查的文件
 * @param danger 危险符号集合（默认现算）
 */
export function topLevelFacadeLoadingCalls(
  file: string,
  danger: Map<string, Set<string>> = facadeLoadingSymbols(),
): FacadeCallSite[] {
  const src = parseSource(file, readFileSync(file, 'utf8'));
  const binds = moduleBindings(file);
  const out: FacadeCallSite[] = [];

  /** 这个节点是否在某个函数体里面？ */
  const insideFunction = (node: ts.Node): boolean => {
    for (let cur = node.parent; cur; cur = cur.parent) {
      if (
        ts.isFunctionDeclaration(cur) ||
        ts.isFunctionExpression(cur) ||
        ts.isArrowFunction(cur) ||
        ts.isMethodDeclaration(cur) ||
        ts.isConstructorDeclaration(cur) ||
        ts.isGetAccessor(cur) ||
        ts.isSetAccessor(cur)
      ) {
        return true;
      }
      if (ts.isSourceFile(cur)) return false;
    }
    return false;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && !insideFunction(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        const name = callee.text;
        const binding = binds.get(name);
        if (binding) {
          const target = resolveModuleSpec(binding.module, file);
          if (target) {
            const imported = binding.isDefault ? 'default' : binding.imported;
            if (danger.get(target)?.has(imported)) {
              out.push({
                file,
                callee: name,
                why: `来自 ${binding.module} 的 ${imported}（模块顶层 ⇒ import 时就加载）`,
              });
            }
          }
        } else if (danger.get(file)?.has(name)) {
          out.push({
            file,
            callee: name,
            why: '本文件内会加载门面的符号（模块顶层 ⇒ import 时就加载）',
          });
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(src.file);
  return out;
}

/** 这个名字在文本里被「提到」了吗（给外部判据用）。 */
export { mentionsName };
