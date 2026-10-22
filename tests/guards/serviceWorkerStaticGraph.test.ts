// service worker 的静态图里**不许出现会被执行到的动态 import**（2026-10-23）。
//
// ── 这条守卫钉的是什么 ────────────────────────────────────────────────────
// MV3 的 module service worker 里 **`import()` 被 Chrome 禁止**
// （HTML 规范：ServiceWorkerGlobalScope 上不允许 import()）——
// 真机报错：`TypeError: import() is disallowed on ServiceWorkerGlobalScope
// by the HTML specification`。
//
// 2026-10-23 做首屏瘦身时踩到过：为了让弹窗首屏不下载云端栈，把
// Supabase 门面 / WebDAV 传输栈改成按需加载 ⇒ 这些 `import()` 恰好都在
// service worker 的执行路径上 ⇒ **同步与登录态校验在 SW 里全炸**。
// 症状具有迷惑性：界面照常能看（页面侧一切正常），只有后台同步静默失效。
//
// 现在的做法：**重依赖的取法只有一个注册表**
//   · 页面：动态加载（首屏不下载）
//   · SW：入口静态 import 之后注册进去
// ⇒ SW 的执行路径上不再有任何 `import()`。
//
// ── 为什么是「结构守卫」而不是「跑一次看看」──────────────────────────────
// 这个缺陷的形态是：**编译期完全合法、类型检查全绿、页面侧一切正常**，
// 只有真机 + 真 SW 才能发现（.memory：SW 启动即崩这一类缺陷）。
// 能提前发现的唯一办法，就是把「SW 静态图里不许有会被执行到的 import()」
// 写成一条**每次跑测试都会检查**的结构规则。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = resolve(ROOT, 'src');
const EXTS = ['.ts', '.tsx', '.js', '.jsx'];

const rel = (p: string) => (p.startsWith(ROOT) ? p.slice(ROOT.length + 1) : p);

function resolveFile(p: string): string | null {
  if (existsSync(p) && statSync(p).isFile()) return p;
  for (const e of EXTS) if (existsSync(p + e)) return p + e;
  for (const e of EXTS) {
    const idx = resolve(p, 'index' + e);
    if (existsSync(idx)) return idx;
  }
  return null;
}

/** 解析一个源文件的**运行时** import（`import type` / `export type` 不算）。 */
const importCache = new Map<string, { statics: string[]; dynamics: string[] }>();
function importsOf(file: string): { statics: string[]; dynamics: string[] } {
  const cached = importCache.get(file);
  if (cached) return cached;
  const raw = readFileSync(file, 'utf8');
  // 去块注释与行注释（避免注释里的 import 字样被当成真 import）
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const statics = new Set<string>();
  const dynamics: string[] = [];
  const stmtRe = /(?:^|\n)\s*(?:import|export)\b([\s\S]*?)\bfrom\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = stmtRe.exec(src))) {
    const clause = m[1] || '';
    if (/^\s*type\b/.test(clause) || /\bimport\s+type\b/.test(clause)) continue;
    statics.add(m[2]);
  }
  for (const mm of src.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) statics.add(mm[1]);
  for (const mm of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) dynamics.push(mm[1]);
  const out = { statics: [...statics], dynamics };
  importCache.set(file, out);
  return out;
}

function resolveSpec(spec: string, fromFile: string): string | null {
  let target: string;
  if (spec.startsWith('@/')) target = resolve(SRC, spec.slice(2));
  else if (spec.startsWith('.')) target = resolve(dirname(fromFile), spec);
  else return null;
  return resolveFile(target);
}

/** 从 service worker 入口出发走静态 import，返回闭包与其中的动态 import。 */
function serviceWorkerStaticGraph(): {
  closure: Set<string>;
  dynamicImports: { file: string; spec: string }[];
} {
  const entry = resolveFile(resolve(SRC, 'service-worker.ts'));
  assert.ok(entry, '找不到 service worker 入口 src/service-worker.ts');
  const seen = new Set<string>([entry]);
  const queue = [entry];
  const dynamicImports: { file: string; spec: string }[] = [];
  while (queue.length) {
    const f = queue.shift()!;
    const { statics, dynamics } = importsOf(f);
    for (const d of dynamics) dynamicImports.push({ file: rel(f), spec: d });
    for (const spec of statics) {
      const t = resolveSpec(spec, f);
      if (!t || seen.has(t)) continue;
      seen.add(t);
      queue.push(t);
    }
  }
  return { closure: new Set([...seen].map(rel)), dynamicImports };
}

/**
 * SW 静态图里**允许**出现动态 import 的地方，以及各自的理由。
 *
 * ⚠️ 这张表就是「已知的地雷」清单：新增条目必须写清理由，
 * 不许「先放着再说」——地雷清单只涨不跌就会变成没人看的坟场。
 */
const ALLOWED_DYNAMIC_IMPORT_SITES: Record<string, string> = {
  // 三个注册表：默认路径是「页面动态加载」，SW 侧由入口注册静态加载器，
  // 走到默认路径时会**明确报错**（isServiceWorkerRealm）。
  'src/utils/supabaseRuntime.ts': 'Supabase 门面注册表（SW 侧注册静态加载器）',
  'src/sync-backend/webdavRuntime.ts': 'WebDAV 传输栈注册表（SW 侧注册静态加载器）',
  'src/sync-backend/webdav/libraryIdentityRuntime.ts':
    '库身份注册表（SW 侧注册静态加载器）—— 待决位按库寻址 ⇒ SW 也必须算得出「本机在哪个库」',
  // ── 2026-10-23 审计 P0-1 已修 ──────────────────────────────────────────
  // 原先这里有一条地雷：`src/storage-kv/firstSyncPendingRecord.ts` 直接
  // `await import('@/sync-backend/webdav/libraryIdentity')` ⇒ SW 里必然抛
  // ⇒ SW 算出的库作用域恒为 no-library ⇒ 落进保守分支 ⇒ SW 永远以为
  // 归属决策没做完 ⇒ 历史会话被永久挡在用户自己的云盘之外（而回包报「成功」）。
  // 修法：改走上面的「库身份注册表」（页面动态 / SW 静态注册），
  // 于是这一条不再是地雷 —— **不许再加回来**。
};

describe('service worker 的静态图', () => {
  it('入口与关键注册都在位（SW 必须自己把重依赖带进来）', () => {
    const entry = readFileSync(resolve(SRC, 'service-worker.ts'), 'utf8');
    assert.match(
      entry,
      /setSupabaseFacadeLoader\(/,
      'SW 入口必须注册 Supabase 门面的静态加载器（SW 里 import() 被禁止）'
    );
    assert.match(
      entry,
      /setWebDavTransportLoader\(/,
      'SW 入口必须注册 WebDAV 传输栈的静态加载器'
    );
    // 注册必须是**静态 import** 进来的（不能是 import()）。
    assert.match(
      entry,
      /import\s+\*\s+as\s+supabaseFacade\s+from\s+'@\/utils\/supabaseFacade'/,
      'SW 入口必须静态 import Supabase 门面'
    );
    assert.match(
      entry,
      /import\s+\{[^}]*WebDavClient[^}]*\}\s+from\s+'@\/sync-backend\/webdav\/client'/,
      'SW 入口必须静态 import WebDAV 传输栈'
    );
    // ── 2026-10-23 审计 P0-1：库身份也必须由 SW 入口静态带进来 ──────────
    // 待决位按库寻址 ⇒ 页面与 SW 必须得出同一个「本机在哪个库」的答案。
    // SW 里 import() 被禁止 ⇒ 那一段只能静态 import + 注册。
    assert.match(
      entry,
      /setLibraryIdentityLoader\(/,
      'SW 入口必须注册「库身份」的静态加载器（SW 里 import() 被禁止，算不出库就永远以为归属待决）'
    );
    assert.match(
      entry,
      /import\s+\*\s+as\s+libraryIdentity\s+from\s+'@\/sync-backend\/webdav\/libraryIdentity'/,
      'SW 入口必须静态 import 库身份模块'
    );
  });

  it('静态图里只有「已登记的地雷」才有动态 import', () => {
    const { dynamicImports } = serviceWorkerStaticGraph();
    const offenders = dynamicImports.filter(d => !(d.file in ALLOWED_DYNAMIC_IMPORT_SITES));
    assert.deepEqual(
      offenders.map(d => `${d.file} → ${d.spec}`),
      [],
      'service worker 的静态图里出现了未登记的动态 import —— ' +
        'SW 里 import() 被 Chrome 禁止，一执行就抛 ' +
        '「import() is disallowed on ServiceWorkerGlobalScope」。\n' +
        '修法：重依赖改成「入口静态 import + 注册表」（见 src/utils/supabaseRuntime.ts）。\n' +
        '确实需要动态 import 的话，先在 ALLOWED_DYNAMIC_IMPORT_SITES 里登记并写清理由。'
    );
  });

  it('三个注册表在 SW 里都会**明确报错**，而不是让浏览器抛规范条款', () => {
    for (const file of [
      'src/utils/supabaseRuntime.ts',
      'src/sync-backend/webdavRuntime.ts',
      'src/sync-backend/webdav/libraryIdentityRuntime.ts',
    ]) {
      const src = readFileSync(resolve(ROOT, file), 'utf8');
      assert.match(
        src,
        /isServiceWorkerRealm\(\)/,
        `${file} 必须判断自己是不是跑在 service worker 里`
      );
      assert.match(
        src,
        /throw new Error\(/,
        `${file} 在 SW 里必须抛一条说人话的错`
      );
    }
  });

  it('storage-kv 那段作用域解析**不许**再直接动态 import（它在地雷清单里）', () => {
    // 钉住 P0-1 的修法：作用域解析必须经由注册表，
    // 否则 SW 侧又会回到「恒为 no-library ⇒ 永远以为归属待决」那条路。
    const src = readFileSync(resolve(ROOT, 'src/storage-kv/firstSyncPendingRecord.ts'), 'utf8');
    const dynamicImports = [...src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
    assert.deepEqual(
      dynamicImports,
      [],
      'firstSyncPendingRecord.ts 里出现了直接动态 import —— ' +
        'service worker 里 import() 被 Chrome 禁止 ⇒ SW 算不出「本机在哪个库」⇒ ' +
        '归属待决的判据整个换成分支 ⇒ 历史会话被永久挡在用户自己的云盘之外。' +
        '改成经由 sync-backend/webdav/libraryIdentityRuntime.ts 取。'
    );
    assert.match(
      src,
      /loadLibraryIdentity\(/,
      'firstSyncPendingRecord.ts 必须经由库身份注册表取模块（页面动态 / SW 静态）'
    );
  });

  it('注册表清单里的每一条都写清了理由（空理由 = 没人知道为什么可以留）', () => {
    for (const [file, why] of Object.entries(ALLOWED_DYNAMIC_IMPORT_SITES)) {
      assert.ok(why.trim().length > 10, `${file} 的登记理由太短`);
      assert.ok(existsSync(resolve(ROOT, file)), `登记的文件不存在：${file}`);
    }
  });
});
