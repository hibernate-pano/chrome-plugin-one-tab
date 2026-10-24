/**
 * 换账号提示的**发出闭环**（2026-10-23 审计 R-4 · 补强守卫）。
 *
 * ── 这条提示是什么 ─────────────────────────────────────────────────────
 * 「本机还有 N 个会话属于上一个账号，不会被上传到当前账号」是**持久**的：
 * 它存在归属记录里（utils/authCache.ts 管的归属账本，落在**KV 层**，
 * 与本机会话同一个库），不是某个内存变量 ⇒ 提示发不出去时它不会丢。
 *
 * ── 这道守卫盯什么（全部是**不变量**，不是字面量）─────────────────────
 * ① **页面挂载时必须消费**：提示必须有一条「**每次页面挂载就会跑**」的出口。
 *    只有计时器（setTimeout）出口是不够的 —— 用户在提示发出前关掉弹窗，
 *    提示就永远没人告知（违反「不许静默」）。
 *    判据钉的是**数据流**：调用点是否落在 useEffect 的回调里
 *    （或被 useEffect 回调调用到的本地函数里），**不是**「文件里出现过
 *    某个函数名」—— 后者正是「挂载路径上的消费被删掉、守卫却看不见」的形状。
 * ② **没登录不许消费**：提示说的是「不会上传到**当前账号**」——没登录时
 *    压根没有「当前账号」，这句话对用户没有意义；更要紧的是**消费即清空**：
 *    没登录时消费 = 把事实吃掉，还没告诉任何人 ⇒ 永远没人知道。
 * ③ **同一条提示只告知一次**（并发消费也不许发两条）。
 * ④ **读失败 fail-closed**：读不到就不显示，绝不显示半截/错的。
 * ⑤ **提示真的走到了界面**：errorHandler → ToastContext 注册的 toast 回调。
 *
 * ── 自证检测力 ────────────────────────────────────────────────────────
 * A. 把挂载路径上的消费调用**摘掉** ⇒ 判据必须报「挂载路径上没有消费者」；
 * B. 把同一处改成**语义等价**的写法（改用别名导入）⇒ 判据必须**仍然绿**
 *    （守卫钉的是数据流，不是「某个串出现过」）。
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import ts from 'typescript';

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '../_alias-loader.mjs')
).href;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = join(ROOT, 'src');

/** 「提示通道」导出的名字（提示的发出 / 取用都从这里走）。 */
const CONSUMER_EXPORTS = ['deliverAccountSwitchNotice', 'consumeAccountSwitchNotice'];

/** 递归列出 src 下的 .ts/.tsx。 */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.tsx?$/.test(full)) {
      out.push(full);
    }
  }
  return out;
}

/** 解析 import 说明符到仓库里的源文件（只认 @/ 与相对路径）。 */
function resolveModuleFile(specifier: string, fromFile: string): string | null {
  let base: string | null = null;
  if (specifier.startsWith('@/')) {
    base = join(SRC, specifier.slice(2));
  } else if (specifier.startsWith('.')) {
    base = resolve(dirname(fromFile), specifier);
  } else {
    return null;
  }
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** 某个模块是不是真的导出了这个名字（防止「同名但不是提示通道」的假阳性）。 */
function moduleExports(file: string, name: string): boolean {
  const text = readFileSync(file, 'utf-8');
  return [
    new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`),
    new RegExp(`export\\s+(?:const|let|var)\\s+${name}\\b`),
    new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`),
  ].some(pattern => pattern.test(text));
}

interface ImportBinding {
  /** 文件里用的本地名（可能是别名）。 */
  local: string;
  /** 真正被导出的名字。 */
  exported: string;
  start: number;
  end: number;
}

interface ConsumerSite {
  file: string;
  /** 文件里用的本地名。 */
  local: string;
  /** 真正被导出的名字。 */
  exported: string;
  /** 这个调用点是不是落在「页面挂载时就会跑」的路径上。 */
  onMountPath: boolean;
  /** 这个调用点是不是在 setTimeout / setInterval 回调里。 */
  insideTimer: boolean;
  /** 调用表达式的文本范围（自证变异用）。 */
  start: number;
  end: number;
  /** 被调用标识符的文本范围（别名改写用）。 */
  calleeStart: number;
  calleeEnd: number;
}

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

/** 从调用点往外找函数祖先（最近的在前）。 */
function ancestorFunctions(node: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  let current = node.parent;
  while (current) {
    if (isFunctionLike(current)) out.push(current);
    current = current.parent;
  }
  return out;
}

/**
 * 分析一个文件里所有「消费提示」的调用点。
 *
 * 判据是**数据流**：
 *   · 调用目标必须是**从提示通道模块导入的**消费入口（认别名）——
 *     否则「恰好有个同名的本地函数」会造成假阳性；
 *   · 「页面挂载路径」= 调用点落在 useEffect 的回调里，或落在**被
 *     useEffect 回调调用到的本地函数**里（等价改写也不误伤）；
 *   · 落在 setTimeout / setInterval 回调里的调用**不算**挂载路径
 *     （那正是 R-4 里那个「靠 400ms 定时器活着才发得出去」的旧形状）。
 */
function analyzeFile(
  absFile: string,
  relFile: string,
  source: string
): { sites: ConsumerSite[]; imports: ImportBinding[] } {
  const src = ts.createSourceFile(
    absFile,
    source,
    ts.ScriptTarget.Latest,
    true,
    /\.tsx$/.test(absFile) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  // ① 本地别名 → 真正的导出名（只有被导入模块确实导出了它才算数）
  const aliases = new Map<string, string>();
  const imports: ImportBinding[] = [];
  for (const stmt of src.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const target = resolveModuleFile(stmt.moduleSpecifier.text, absFile);
    if (!target) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const spec of bindings.elements) {
      const exported = spec.propertyName?.text ?? spec.name.text;
      if (!CONSUMER_EXPORTS.includes(exported)) continue;
      if (!moduleExports(target, exported)) continue;
      aliases.set(spec.name.text, exported);
      imports.push({
        local: spec.name.text,
        exported,
        start: spec.getStart(),
        end: spec.getEnd(),
      });
    }
  }
  if (aliases.size === 0) return { sites: [], imports };

  // ② 收集挂载回调 / 计时器回调 / 本地函数
  const mountCallbacks: ts.Node[] = [];
  const timerCallbacks: ts.Node[] = [];
  const localFunctions = new Map<string, ts.Node>();
  const collect = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;
      if (name === 'useEffect' || name === 'useLayoutEffect') {
        const arg = node.arguments[0];
        if (arg && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) {
          mountCallbacks.push(arg);
        }
      }
      if (name === 'setTimeout' || name === 'setInterval') {
        const arg = node.arguments[0];
        if (arg && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) {
          timerCallbacks.push(arg);
        }
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      localFunctions.set(node.name.text, node);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      localFunctions.set(node.name.text, node.initializer);
    }
    node.forEachChild(collect);
  };
  collect(src);

  // ③ 从挂载回调出发，找出「被挂载路径调用到的本地函数」（不动点）
  const reached = new Set<ts.Node>(mountCallbacks);
  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of Array.from(reached)) {
      const scan = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          const target = localFunctions.get(node.expression.text);
          if (target && !reached.has(target)) {
            reached.add(target);
            changed = true;
          }
        }
        if (node !== fn && isFunctionLike(node)) return; // 不钻进嵌套函数
        node.forEachChild(scan);
      };
      scan(fn);
    }
  }

  // ④ 逐个调用点判定
  const sites: ConsumerSite[] = [];
  const findCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const exported = aliases.get(node.expression.text);
      if (exported) {
        const chain = ancestorFunctions(node);
        const insideTimer = chain.some(ancestor => timerCallbacks.includes(ancestor));
        const nearest = chain[0];
        const onMountPath =
          !insideTimer && nearest !== undefined && reached.has(nearest);
        sites.push({
          file: relFile,
          local: node.expression.text,
          exported,
          onMountPath,
          insideTimer,
          start: node.getStart(),
          end: node.getEnd(),
          calleeStart: node.expression.getStart(),
          calleeEnd: node.expression.getEnd(),
        });
      }
    }
    node.forEachChild(findCalls);
  };
  findCalls(src);

  return { sites, imports };
}

/** 全仓扫描所有「消费提示」的调用点。 */
function findConsumerSites(overrides?: Map<string, string>): ConsumerSite[] {
  const out: ConsumerSite[] = [];
  for (const abs of listSourceFiles(SRC)) {
    const rel = abs.replace(ROOT + '/', '');
    const source = overrides?.get(rel) ?? readFileSync(abs, 'utf-8');
    out.push(...analyzeFile(abs, rel, source).sites);
  }
  return out;
}

/** 自证用：把文件里的消费调用**摘掉**（源码层面）。 */
function removeConsumerCalls(absFile: string, source: string): string {
  const rel = absFile.replace(ROOT + '/', '');
  const { sites } = analyzeFile(absFile, rel, source);
  let out = source;
  for (const site of [...sites].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, site.start) + 'undefined /* 消费者被摘掉 */' + out.slice(site.end);
  }
  return out;
}

/** 自证用：改成**语义等价**的写法（别名导入 + 别名调用）。 */
function aliasConsumerCalls(absFile: string, source: string): string {
  const rel = absFile.replace(ROOT + '/', '');
  const { sites, imports } = analyzeFile(absFile, rel, source);
  const target = sites[0];
  if (!target) return source;
  const alias = `${target.local}AsConsumer`;
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const binding = imports.find(item => item.local === target.local);
  if (binding) {
    edits.push({
      start: binding.start,
      end: binding.end,
      text: `${binding.exported} as ${alias}`,
    });
  }
  for (const site of sites) {
    if (site.local !== target.local) continue;
    edits.push({ start: site.calleeStart, end: site.calleeEnd, text: alias });
  }
  let out = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

describe('R-4 补强：换账号提示的发出闭环（行为）', () => {
  const storage = new Map<string, unknown>();
  let toasts: Array<{ message: string; type: string }> = [];
  /** KV 层（归属账本的落盘处）：命中这些键的读会抛错（模拟存储故障）。 */
  const failReadKeys = new Set<string>();
  const lsData = new Map<string, string>();

  before(() => {
    register(LOADER_PATH);
    // 归属账本住在 KV 层（Node 里没有 indexedDB ⇒ 回退 localStorage 驱动）。
    // 不装这个桩的话「写进去了」是假的（驱动静默 no-op），用例会假绿。
    const localStorageStub = {
      get length() {
        return lsData.size;
      },
      key: (i: number) => [...lsData.keys()][i] ?? null,
      getItem: (k: string) => {
        if (failReadKeys.has(k)) throw new Error(`simulated read failure: ${k}`);
        return lsData.has(k) ? (lsData.get(k) as string) : null;
      },
      setItem: (k: string, v: string) => void lsData.set(k, String(v)),
      removeItem: (k: string) => void lsData.delete(k),
      clear: () => void lsData.clear(),
    };
    (globalThis as Record<string, unknown>).window = { localStorage: localStorageStub };
    (globalThis as Record<string, unknown>).localStorage = localStorageStub;
  });

  beforeEach(() => {
    storage.clear();
    lsData.clear();
    failReadKeys.clear();
    toasts = [];
    (globalThis as Record<string, unknown>).chrome = {
      storage: {
        local: {
          get: async (key: string | string[]) => {
            const keys = Array.isArray(key) ? key : [key];
            const out: Record<string, unknown> = {};
            for (const one of keys) if (storage.has(one)) out[one] = storage.get(one);
            return out;
          },
          set: async (obj: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(obj)) storage.set(k, v);
          },
          remove: async (key: string) => {
            storage.delete(key);
          },
        },
        onChanged: { addListener: () => undefined, removeListener: () => undefined },
      },
      runtime: { getManifest: () => ({ version: 'test' }) },
    };
  });

  /** 这台机器上登录着（auth_cache 里有账号且 isAuthenticated）。 */
  function seedLoggedIn(userId = 'user-b'): void {
    storage.set('auth_cache', {
      user: { id: userId, email: `${userId}@example.com` },
      isAuthenticated: true,
      timestamp: Date.now(),
    });
  }

  /**
   * 归属记录里挂着一条待告知的换账号提示。
   *
   * 走**公开接口**写（accountScopeStore.write）而不是直接塞存储：
   * 归属账本住在 KV 层，键在哪、值怎么归一化都由它管 ⇒ 用例不该知道这些。
   */
  async function seedNotice(
    text = '本机还有 1 个会话属于上一个账号，不会被上传到当前账号'
  ): Promise<void> {
    const { accountScopeStore } = await import('@/utils/authCache');
    await accountScopeStore.write({
      ownerUserId: 'user-b',
      foreignOwners: { 'g-a': 'user-a' },
      pendingNotice: { text, previousUserId: 'user-a', residualCount: 1, at: Date.now() },
    });
  }

  /** 归属记录里现在的待告知提示（消费后应当是 null）。 */
  async function pendingNoticeInStorage(): Promise<unknown> {
    const { accountScopeStore } = await import('@/utils/authCache');
    const record = await accountScopeStore.read();
    return record?.pendingNotice;
  }

  async function captureToasts(): Promise<() => Promise<void>> {
    const { errorHandler } = await import('@/utils/errorHandler');
    errorHandler.setToastCallback((message: string, type: 'error' | 'warning') => {
      toasts.push({ message, type });
    });
    const { deliverAccountSwitchNotice } = await import('@/components/auth/restoreAfterLogin');
    return () => deliverAccountSwitchNotice();
  }

  it('登录着的时候：提示会被消费，并真的走到界面上（errorHandler → toast 回调）', async () => {
    seedLoggedIn();
    await seedNotice();
    const deliver = await captureToasts();

    await deliver();

    assert.equal(toasts.length, 1, '提示必须真的到达界面 —— 消费了却没人看见 = 静默');
    assert.equal(
      toasts[0].message,
      '本机还有 1 个会话属于上一个账号，不会被上传到当前账号'
    );
    assert.equal(toasts[0].type, 'warning', '换账号提示是 warning 级（不是错误，但必须让用户看见）');
    assert.equal(await pendingNoticeInStorage(), null, '消费即清空 ⇒ 同一条提示不会被告知两次');
  });

  it('没登录的时候：不消费（提示不能被吃掉）', async () => {
    await seedNotice(); // 故意不 seed 登录态
    const deliver = await captureToasts();

    await deliver();

    assert.equal(
      toasts.length,
      0,
      '没登录时不该出现「不会上传到当前账号」这种提示 —— 压根没有「当前账号」'
    );
    assert.notEqual(
      await pendingNoticeInStorage(),
      null,
      '提示不许被消费掉：消费即清空 ⇒ 清了还没告知 = 这条事实永远没人知道'
    );
  });

  it('两条通道同时消费同一条提示：只告知一次', async () => {
    seedLoggedIn();
    await seedNotice();
    const deliver = await captureToasts();

    await Promise.all([deliver(), deliver()]);

    assert.equal(
      toasts.length,
      1,
      '同一条提示不许弹两次（挂载通道与登录兜底通道可能同时到；StrictMode 也会双跑 effect）'
    );
  });

  it('读存储失败：fail-closed（不显示，也不抛错）', async () => {
    seedLoggedIn();
    await seedNotice();
    // 只让**归属记录**读失败（登录缓存仍读得到 ⇒ 登录态判定不受影响）。
    // 归属记录住在 KV 层 ⇒ 故障注入在 KV 那一侧（不是 chrome.storage.local）。
    failReadKeys.add('local_account_scope');
    const deliver = await captureToasts();

    await deliver(); // 不许把异常抛给调用方

    assert.equal(toasts.length, 0, '读不到就不许显示（更不能显示半截/错的提示）');
  });

  it('归属记录形状损坏：fail-closed（不显示半截/错的提示）', async () => {
    seedLoggedIn();
    const { accountScopeStore } = await import('@/utils/authCache');
    await accountScopeStore.write({
      ownerUserId: 'user-b',
      foreignOwners: {},
      pendingNotice: { text: 123 } as never, // 缺字段
    });
    const deliver = await captureToasts();

    await deliver();

    assert.equal(toasts.length, 0, '记录形状坏了就不许显示任何提示');
  });

  it('errorHandler 这条通道真的接到了界面上（ToastContext 注册了 toast 回调）', () => {
    const toastContext = readFileSync(join(SRC, 'contexts/ToastContext.tsx'), 'utf-8');
    assert.ok(
      toastContext.includes('errorHandler.setToastCallback('),
      'errorHandler 必须被 ToastContext 注册 —— 否则提示发出去没人看得见（又变回静默）'
    );
  });
});

describe('R-4 补强：提示必须在**页面挂载路径**上被消费', () => {
  it('挂载路径（useEffect）上必须有一个消费提示的调用点', () => {
    const sites = findConsumerSites();
    const onMountPath = sites.filter(site => site.onMountPath);
    assert.ok(
      onMountPath.length > 0,
      '换账号提示必须有一条「每次页面挂载就会跑」的出口' +
        `（当前消费点：${sites
          .map(site => `${site.file}${site.insideTimer ? '（计时器里）' : ''}`)
          .join('、') || '一个都没有'}）` +
        ' —— 只有计时器出口的话，用户在提示发出前关掉弹窗，这条提示就永远没人告知（违反「不许静默」）'
    );
  });

  it('自证检测力：把挂载路径上的消费调用摘掉，判据必须看得见', () => {
    const sites = findConsumerSites();
    const onMountPath = sites.filter(site => site.onMountPath);
    assert.ok(onMountPath.length > 0, '前提没成立：当前没有挂载路径上的消费者');

    const victim = onMountPath[0].file;
    const abs = join(ROOT, victim);
    const source = readFileSync(abs, 'utf-8');
    const withoutConsumer = removeConsumerCalls(abs, source);
    assert.notEqual(withoutConsumer, source, '前提没成立：源码里找不到可摘掉的消费调用');

    const after = findConsumerSites(new Map([[victim, withoutConsumer]]));
    assert.equal(
      after.filter(site => site.onMountPath).length,
      0,
      '判据失效：挂载路径上的消费被摘掉后仍应识别出「没有挂载路径上的消费者」'
    );
  });

  it('自证检测力：语义等价的改写（别名导入）不许误伤', () => {
    const sites = findConsumerSites();
    const onMountPath = sites.filter(site => site.onMountPath);
    assert.ok(onMountPath.length > 0, '前提没成立：当前没有挂载路径上的消费者');

    const victim = onMountPath[0].file;
    const abs = join(ROOT, victim);
    const source = readFileSync(abs, 'utf-8');
    const rewritten = aliasConsumerCalls(abs, source);
    assert.notEqual(rewritten, source, '前提没成立：没能生成等价改写');

    const after = findConsumerSites(new Map([[victim, rewritten]]));
    assert.ok(
      after.filter(site => site.onMountPath).length > 0,
      '判据失效：语义等价的改写（别名导入）不该被判成「没有消费者」 —— 守卫钉的必须是数据流，不是字面量'
    );
  });
});
