/**
 * 守卫：WebDAV 传输栈的**取法唯一**与**注入完整**（2026-10-23，第 50 轮）。
 *
 * ── 这条守卫钉的是什么 ────────────────────────────────────────────────────
 * MV3 模块化 service worker **不允许 `import()`**（见 `core/runtimeRealm.ts`），
 * 于是仓库的约定是「同一份模块，两种取法」：页面侧走注册表（动态 import），
 * service worker 侧走入口静态注册（见 `sync-backend/webdavRuntime.ts`）。
 *
 * **唯一性就是这个约定的全部价值所在。** 一旦出现第三条取法，维护者读
 * `webdavRuntime.ts` 会以为只有一条路，而真实情况是「一半页面、一半 SW、
 * 外加一处直连」——三种写法必然漂移。
 *
 * 第 50 轮之前，第三条取法就在那儿：设置页 `WebDavSettings.tsx` **直接静态
 * import** 了 `webdav/client` 与 `webdav/adapter`。而且那两处造出来的适配器
 * **一个 seq 依赖都没给** ⇒ 退回适配器自带的兜底号位（与写作路径的计数器
 * 不共享）。今天只读所以没出事，一旦有人在那两处加一次写操作，就落回 D-7
 * 的缺陷形态（墓碑号退化成「云端 seq + 1」⇒ 跨设备删除被静默撤销）。
 *
 * ── 四条判据 ──────────────────────────────────────────────────────────────
 *   A. **取法唯一**：全仓只有注册表（webdavRuntime.ts）与 service worker 入口
 *      能在**值位置**引用 `webdav/client` / `webdav/adapter`（类型位置不算）。
 *   B. **注入完整**：凡 `new WebDavBackendAdapter(` 的构造点，其依赖集必须
 *      含 `peekDeviceSeq` / `nextDeviceSeq` / `bumpDeviceSeqIfLower` 三项。
 *   C. **显式标注**：每个构造点必须**明确**写出自己是不是只读（`readOnly`
 *      字面量布尔）——「只读探针」不能只是调用方的自觉。
 *   D. **可写入口唯一**：全仓只允许**一个**可写构造点（生产路径），
 *      其余（设置页的探针）必须只读。
 *
 * 判据钉的是**数据流**（依赖从哪来、最终含哪些能力），不是某一行字面量：
 * 把依赖抽成局部常量再展开、把工厂换个文件写，判据都仍然绿。
 *
 * ── 扫描范围为什么是 `src/` 而不是整个仓库 ──────────────────────────────
 * `tests/` 里有 10 个文件直接 import 传输栈实现（`webdavAdapter.test.ts` 等），
 * 那是**正确的**：单测就是要测实现本身，用注册表反而测不到真东西。
 * 判据要管的是「**产品代码**从哪儿拿这栈」—— 生产代码里出现第二条取法，
 * 才会让约定失效、才会把 150KB 拖进首屏。测试是这条约定的**消费者**，
 * 不是它的破坏者。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import {
  buildProbeAdapterDeps,
  buildWebDavAdapterDeps,
  type WebDavProbe,
} from '@/sync-backend/webdav/factory';
import { loadWebDavTransport } from '@/sync-backend/webdavRuntime';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = resolve(ROOT, 'src');

/** 仓库根相对路径（跨平台统一成正斜杠）。 */
const rel = (abs: string): string => relative(ROOT, abs).replace(/\\/g, '/');

// ── 判据 A 的常量 ──────────────────────────────────────────────────────────

/** 传输栈的实现模块（**取法**的目标）。 */
const TRANSPORT_MODULES = ['src/sync-backend/webdav/client.ts', 'src/sync-backend/webdav/adapter.ts'];

/** 允许在值位置引用它们的地方（注册表 + service worker 入口）。 */
const ALLOWED_REFERENCERS = ['src/sync-backend/webdavRuntime.ts', 'src/service-worker.ts'];

/**
 * 传输栈**自己**不在扫描范围内。
 *
 * 为什么：`adapter.ts` 在**运行时**依赖 `client.ts`（它要用 `WebDavError`
 * 做 `instanceof` 判定）。那是「实现内部的依赖」，不是「又一条取法」——
 * 取法说的是「谁去拿这栈」，而实现自己当然知道自己在哪儿。
 *
 * 把它算进去的话，这条守卫就会对着实现本身喊「出现第三条取法」，
 * 于是不得不加豁免 —— 而豁免一旦有了口子，真正的第三条取法就能混进来。
 */
const IS_TRANSPORT_IMPLEMENTATION = (fileRel: string): boolean =>
  TRANSPORT_MODULES.includes(fileRel);

/** 注入必须齐全的三项 seq 能力（缺一不可，见 webdav/factory.ts 的注释）。 */
const REQUIRED_SEQ_DEPS = ['peekDeviceSeq', 'nextDeviceSeq', 'bumpDeviceSeqIfLower'];

// ── 源码扫描的基础设施 ────────────────────────────────────────────────────

/** 递归列出 src 下的全部源文件。 */
function listSourceFiles(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/**
 * 解析一个源文件。
 *
 * ⚠️ **按扩展名选 ScriptKind**：用 TSX 模式解析 `.ts` 会把 `<T>(x) => x`
 * 这类泛型箭头函数误判成 JSX（本仓 `src/utils/` 下就有这种写法）。
 */
function parse(absPath: string): ts.SourceFile {
  const kind = absPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(absPath, readFileSync(absPath, 'utf8'), ts.ScriptTarget.Latest, true, kind);
}

/** 模块说明符 → 绝对路径（`@/` 与相对路径都认；解析不到返回 null）。 */
function resolveSpecifier(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = resolve(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  else return null;
  for (const ext of ['.ts', '.tsx']) {
    if (existsSync(base + ext)) return base + ext;
  }
  for (const ext of ['.ts', '.tsx']) {
    const idx = resolve(base, 'index' + ext);
    if (existsSync(idx)) return idx;
  }
  return null;
}

/** 一个模块的静态信息（供依赖解析用）。 */
interface ModuleInfo {
  file: string;
  sf: ts.SourceFile;
  /** 顶层 `const` / `let` → 初始化表达式。 */
  vars: Map<string, ts.Expression>;
  /** 顶层函数声明 → 声明节点。 */
  funcs: Map<string, ts.FunctionDeclaration>;
  /** import 进来的本地名 → { 文件, 被导入的名字 }。 */
  imports: Map<string, { file: string; imported: string }>;
}

const moduleCache = new Map<string, ModuleInfo>();

function loadModule(absPath: string): ModuleInfo {
  const cached = moduleCache.get(absPath);
  if (cached) return cached;
  const sf = parse(absPath);
  const vars = new Map<string, ts.Expression>();
  const funcs = new Map<string, ts.FunctionDeclaration>();
  const imports = new Map<string, { file: string; imported: string }>();

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const target = resolveSpecifier(stmt.moduleSpecifier.text, absPath);
      if (!target) continue;
      const clause = stmt.importClause;
      if (!clause) continue;
      if (clause.name) imports.set(clause.name.text, { file: target, imported: 'default' });
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          imports.set(el.name.text, { file: target, imported: (el.propertyName ?? el.name).text });
        }
      }
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) vars.set(decl.name.text, decl.initializer);
      }
      continue;
    }
    if (ts.isFunctionDeclaration(stmt) && stmt.name) funcs.set(stmt.name.text, stmt);
  }

  const info: ModuleInfo = { file: absPath, sf, vars, funcs, imports };
  moduleCache.set(absPath, info);
  return info;
}

/** 剥掉与「值」无关的外壳（await / 括号 / 类型断言 / 非空断言）。 */
function unwrap(expr: ts.Expression): ts.Expression {
  let cur = expr;
  for (;;) {
    if (
      ts.isAwaitExpression(cur) ||
      ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isTypeAssertionExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isSatisfiesExpression(cur)
    ) {
      cur = cur.expression;
      continue;
    }
    return cur;
  }
}

/** 一个解析上下文（模块 + 当前作用域的局部变量）。 */
interface Scope {
  mod: ModuleInfo;
  /** 局部变量（函数内的 const/let）→ 初始化表达式；找不到时回落到模块级。 */
  locals: Map<string, ts.Expression>;
}

function lookupVar(scope: Scope, name: string): ts.Expression | undefined {
  return scope.locals.get(name) ?? scope.mod.vars.get(name);
}

/**
 * 收集一个表达式的「对象属性」集合（属性名 → 值表达式）。
 *
 * 能跟的数据流：
 *   · 对象字面量 ⇒ 它的属性；
 *   · `...局部常量` ⇒ 展开的那个常量的属性（等价改写不该误报）；
 *   · `f(...)` ⇒ `f` 返回的那个对象字面量的属性（跨模块也跟）。
 */
function collectProps(expr: ts.Expression | undefined, scope: Scope, depth = 0): Map<string, ts.Expression> {
  const out = new Map<string, ts.Expression>();
  if (!expr || depth > 8) return out;
  const node = unwrap(expr);

  if (ts.isObjectLiteralExpression(node)) {
    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop)) {
        if (ts.isIdentifier(prop.name)) out.set(prop.name.text, prop.initializer);
        else if (ts.isStringLiteral(prop.name)) out.set(prop.name.text, prop.initializer);
        continue;
      }
      if (ts.isShorthandPropertyAssignment(prop)) {
        out.set(prop.name.text, prop.name);
        continue;
      }
      if (ts.isSpreadAssignment(prop)) {
        for (const [name, value] of collectProps(prop.expression, scope, depth + 1)) out.set(name, value);
      }
    }
    return out;
  }

  if (ts.isIdentifier(node)) {
    const local = lookupVar(scope, node.text);
    if (local) return collectProps(local, scope, depth + 1);
    const imported = scope.mod.imports.get(node.text);
    if (imported) {
      const target = loadModule(imported.file);
      const varInit = target.vars.get(imported.imported);
      if (varInit) {
        return collectProps(varInit, { mod: target, locals: new Map() }, depth + 1);
      }
    }
    return out;
  }

  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const name = node.expression.text;
    const localFn = scope.mod.funcs.get(name);
    if (localFn) {
      return collectReturnProps(localFn, scope.mod, depth + 1);
    }
    const imported = scope.mod.imports.get(name);
    if (imported) {
      const target = loadModule(imported.file);
      const fn = target.funcs.get(imported.imported);
      if (fn) return collectReturnProps(fn, target, depth + 1);
    }
  }

  return out;
}

/**
 * 取一个表达式的布尔值（`true` / `false`，或指向布尔常量的标识符）。
 *
 * 取不到（是变量、是函数调用）⇒ 返回 null —— 守卫据此判「没写明」，
 * 而不是猜一个默认值（猜默认值 = 把「没标注」当成「标注了」）。
 */
function booleanValueOf(expr: ts.Expression | undefined, scope: Scope, depth = 0): boolean | null {
  if (!expr || depth > 4) return null;
  const node = unwrap(expr);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isIdentifier(node)) {
    const local = lookupVar(scope, node.text);
    if (local) return booleanValueOf(local, scope, depth + 1);
  }
  return null;
}

/** 收集一个函数**返回**的对象的属性（只看它自己的 return 语句）。 */
function collectReturnProps(
  fn: ts.FunctionDeclaration,
  mod: ModuleInfo,
  depth: number
): Map<string, ts.Expression> {
  const out = new Map<string, ts.Expression>();
  // 函数内的局部 const/let（闭包变量）。
  const locals = new Map<string, ts.Expression>();
  const collectLocals = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      locals.set(node.name.text, node.initializer);
    }
    node.forEachChild(collectLocals);
  };
  fn.body?.forEachChild(collectLocals);

  const scope: Scope = { mod, locals };
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression) {
      for (const [name, value] of collectProps(node.expression, scope, depth)) out.set(name, value);
    }
    // 只看本函数的 return（跳过嵌套函数）。
    if (node !== fn && ts.isFunctionLike(node)) return;
    node.forEachChild(visit);
  };
  visit(fn);
  return out;
}

/** 一个适配器构造点。 */
interface ConstructionSite {
  file: string;
  /** 依赖表达式（`new WebDavBackendAdapter(...)` 的第一个参数）。 */
  deps: ts.Expression | undefined;
  /** 解析出来的依赖属性（名 → 值表达式）。 */
  props: Map<string, ts.Expression>;
  /** 该构造点所在模块（用于解析布尔值）。 */
  mod: ModuleInfo;
}

/** 全仓所有 `new WebDavBackendAdapter(` 构造点（含依赖解析）。 */
function constructionSites(): ConstructionSite[] {
  const sites: ConstructionSite[] = [];
  for (const file of listSourceFiles()) {
    const mod = loadModule(file);
    const scope: Scope = { mod, locals: new Map() };
    const visit = (node: ts.Node): void => {
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'WebDavBackendAdapter'
      ) {
        const deps = node.arguments?.[0];
        sites.push({ file: rel(file), deps, props: collectProps(deps, scope), mod });
      }
      node.forEachChild(visit);
    };
    visit(mod.sf);
  }
  return sites;
}

/** 构造点是不是「可写」（readOnly 明确为 false）。 */
function isWritable(site: ConstructionSite): boolean {
  return booleanValueOf(site.props.get('readOnly'), { mod: site.mod, locals: new Map() }) === false;
}

/** 一个文件在**值位置**引用了哪些模块（静态 import / re-export / 动态 import）。 */
function valueModuleReferences(absPath: string): string[] {
  const sf = parse(absPath);
  const specs: string[] = [];

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const clause = stmt.importClause;
      // `import type { X } from '…'` ⇒ 编译后消失 ⇒ 不是依赖。
      if (clause && clause.isTypeOnly) continue;
      // `import { type X, Y } from '…'` ⇒ 只有 Y 是运行时依赖。
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        const hasValue = clause.namedBindings.elements.some(el => !el.isTypeOnly);
        if (!hasValue) continue;
      }
      specs.push(stmt.moduleSpecifier.text);
      continue;
    }
    if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      if (stmt.isTypeOnly) continue;
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        const hasValue = stmt.exportClause.elements.some(el => !el.isTypeOnly);
        if (!hasValue) continue;
      }
      specs.push(stmt.moduleSpecifier.text);
    }
  }

  // 动态 `import('…')` —— 第三条取法最常见的形状。
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specs.push(node.arguments[0].text);
    }
    node.forEachChild(visit);
  };
  visit(sf);

  return specs;
}

describe('守卫 A：WebDAV 传输栈的取法唯一', () => {
  it('只有注册表与 service worker 入口能在值位置引用传输栈实现', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles()) {
      const fileRel = rel(file);
      if (IS_TRANSPORT_IMPLEMENTATION(fileRel)) continue;
      for (const spec of valueModuleReferences(file)) {
        const target = resolveSpecifier(spec, file);
        if (!target) continue;
        const targetRel = rel(target);
        if (!TRANSPORT_MODULES.includes(targetRel)) continue;
        if (ALLOWED_REFERENCERS.includes(fileRel)) continue;
        offenders.push(`${fileRel} → ${spec}（解析到 ${targetRel}）`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `出现第三条取法：\n${offenders.join('\n')}\n` +
        '传输栈只许经注册表取（页面动态 import / service worker 静态注册，' +
        '见 src/sync-backend/webdavRuntime.ts）。\n' +
        '直接 import 实现会让「同��份模块、两种取法」这条约定悄悄失效 —— ' +
        '而且静态引入会把 150KB 源码拖进首屏。'
    );
  });

  it('注册表与 service worker 入口都真的用上了（免得上面那条判据空转）', () => {
    const runtime = readFileSync(resolve(SRC, 'sync-backend/webdavRuntime.ts'), 'utf8');
    for (const mod of ['client', 'adapter']) {
      assert.match(
        runtime,
        new RegExp(`import\\(['"]\\./webdav/${mod}['"]\\)`),
        `注册表必须动态加载 webdav/${mod}（页面侧首屏不下载它）`
      );
    }
    const entry = readFileSync(resolve(SRC, 'service-worker.ts'), 'utf8');
    for (const mod of ['client', 'adapter']) {
      assert.match(
        entry,
        new RegExp(`from '@/sync-backend/webdav/${mod}'`),
        `service worker 入口必须静态 import webdav/${mod}（SW 里 import() 被 Chrome 禁止）`
      );
    }
  });
});

describe('守卫 B/C/D：适配器构造点的依赖集', () => {
  it('全仓至少有一个构造点（判据别自己把自己钉空了）', () => {
    assert.ok(
      constructionSites().length > 0,
      '一个 `new WebDavBackendAdapter(` 都没找到 ⇒ 判据解析失效了（比红更坏：它会假装一切正常）'
    );
  });

  it('每个构造点都注入了三项 seq 能力', () => {
    const offenders: string[] = [];
    for (const site of constructionSites()) {
      const missing = REQUIRED_SEQ_DEPS.filter(name => !site.props.has(name));
      if (missing.length > 0) {
        offenders.push(`${site.file}：缺 ${missing.join(' / ')}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `有构造点没注入完整的 seq 能力：\n${offenders.join('\n')}\n` +
        '缺 peekDeviceSeq ⇒ 水位线的「seq 时钟回退自检」恒等于 0（守卫成了死代码）；\n' +
        '缺 nextDeviceSeq / bumpDeviceSeqIfLower ⇒ 删除广播的墓碑号退化成「云端 seq + 1」' +
        '（D-7 的缺陷形态：跨设备删除被静默撤销、会话复活）。'
    );
  });

  it('每个构造点都明确写出自己是不是只读', () => {
    const offenders: string[] = [];
    for (const site of constructionSites()) {
      const value = booleanValueOf(site.props.get('readOnly'), { mod: site.mod, locals: new Map() });
      if (value === null) {
        offenders.push(`${site.file}：readOnly 没写成明确的 true / false`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `有构造点没显式标注只读：\n${offenders.join('\n')}\n` +
        '「只读探针」不能只是调用方的自觉 —— 依赖里必须写明（readOnly: true / false）。'
    );
  });

  it('全仓只有一个可写构造点（写远端的入口必须唯一）', () => {
    const writable = constructionSites().filter(isWritable);
    assert.equal(
      writable.length,
      1,
      `可写的适配器构造点必须**只有**生产路径一个，实际有 ${writable.length} 个：` +
        `${writable.map(s => s.file).join('、')}\n` +
        '设置页那两处是只读探针 —— 它们过去没注入 seq 能力，' +
        '一旦有人加写操作就会落回 D-7 的缺陷形态（墓碑号退化成「云端 seq + 1」）。'
    );
  });
});

describe('守卫 E：只读探针在运行时真的写不了', () => {
  it('探针适配器拒绝一切写操作', async () => {
    const { WebDavBackendAdapter } = await loadWebDavTransport();
    const probe = new WebDavBackendAdapter(
      await buildProbeAdapterDeps({
        baseUrl: 'https://dav.example.com/',
        username: 'user',
        password: 'app-password',
        rootPath: 'TapStack',
        passphrase: 'pass',
        encryption: 'required',
      })
    );
    for (const method of ['uploadGroups', 'broadcastDeletes', 'purgeExpiredDeletes', 'uploadSettings'] as const) {
      await assert.rejects(
        // @ts-expect-error 只读探针没有这些方法（编译期另有断言把关）
        () => probe[method]([]),
        /只读探针/,
        `${method} 必须被只读探针拒绝`
      );
    }
  });

  it('生产适配器不被只读闸门拦住（闸门只拦探针，不拦真同步）', async () => {
    const { WebDavBackendAdapter } = await loadWebDavTransport();
    const prod = new WebDavBackendAdapter(
      await buildWebDavAdapterDeps({
        baseUrl: 'https://dav.example.com/',
        username: 'user',
        password: 'app-password',
        rootPath: 'TapStack',
        passphrase: 'pass',
        encryption: 'required',
      })
    );
    // 不去真的写远端（没有服务器），只确认「只读」这道闸门没误伤生产路径：
    // 它的报错必须是网络错误，而不是「只读探针」。
    await assert.rejects(
      () => prod.uploadGroups([]),
      err => !/只读探针/.test(String(err)),
      '生产适配器不该被只读闸门拦住'
    );
  });
});

/**
 * 探针适配器**不得**暴露写方法（编译期断言）。
 *
 * ⚠️ 这条由 `tsc -p tsconfig.test.json --noEmit` 把关，不是本测试自己。
 * 若有人把 `WebDavProbe` 放宽成完整适配器，下面这行会变成「未使用的
 * @ts-expect-error」⇒ 类型检查报错。
 */
export function assertProbeExposesNoWriteMethod(probe: WebDavProbe): void {
  // @ts-expect-error 只读探针不得暴露写方法（否则设置页可能发出墓碑）
  probe.uploadGroups([]);
}
