// popup 首屏准入守卫（2026-10-23）。
//
// ── 这条守卫钉的是什么 ────────────────────────────────────────────────────
// 用户点开弹窗只需要**看会话列表**（会话在本机 IndexedDB 里）。
// 2026-10-23 之前，构建产物把**整条同步栈**（Supabase SDK 58.9KB gzip +
// 读写实现 + WebDAV 适配器）塞进首屏的 modulepreload 清单：
// 实测首屏 262.2KB / 预算 265KB，只差 3KB 就要破门。
//
// 「哪些模块算首屏」是**产品决定**，但「哪些模块**不许**算首屏」必须有一个
// 可单测的真相源 ⇒ `src/core/firstScreenPolicy.ts`（纯函数）。
//
// 本文件三层：
//   1. **纯函数单测** —— 策略本身的判定逻辑（路径归一化、分组命中）。
//   2. **源码静态图** —— 从 popup 入口出发走**静态** import，闭包里不许出现
//      禁止组的模块（动态 import 不算首屏）。
//   3. **产物清单** —— 若 dist 已构建，popup 的首屏清单里不许出现
//      禁止组的块名。
//
// ⚠️ 为什么第 2 层要自己解析 import 而不是只信第 3 层：
//   第 3 层需要先构建（`pnpm build`），而 `pnpm test` 应当**不依赖构建产物**
//   就能守住这条规则；反过来，第 2 层是源码图，与产物可能有偏差
//   （Rollup 会合并块、会把动态 import 变成静态边）⇒ 两层都要有。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FIRST_SCREEN_FORBIDDEN_GROUPS,
  firstScreenForbiddenReason,
  firstScreenGroupFor,
  forbiddenChunkNames,
  isForbiddenInFirstScreen,
  normalizeModuleId,
} from '@/core/firstScreenPolicy';

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
const importCache = new Map<string, string[]>();
function runtimeImportsOf(file: string): string[] {
  const cached = importCache.get(file);
  if (cached) return cached;
  const raw = readFileSync(file, 'utf8');
  // 去块注释与行注释（避免注释里的 import 字样被当成真 import）
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const out = new Set<string>();
  const stmtRe = /(?:^|\n)\s*(?:import|export)\b([\s\S]*?)\bfrom\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = stmtRe.exec(src))) {
    const clause = m[1] || '';
    // `import type {...} from` / `export type {...} from` 编译后消失 ⇒ 不算静态依赖
    if (/^\s*type\b/.test(clause) || /\bimport\s+type\b/.test(clause)) continue;
    out.add(m[2]);
  }
  for (const mm of src.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) out.add(mm[1]);
  const list = [...out];
  importCache.set(file, list);
  return list;
}

function resolveSpec(spec: string, fromFile: string): string | null {
  let target: string;
  if (spec.startsWith('@/')) target = resolve(SRC, spec.slice(2));
  else if (spec.startsWith('.')) target = resolve(dirname(fromFile), spec);
  else return null; // 裸包名 = node_modules，不是本仓源码
  return resolveFile(target);
}

/** 从 popup 入口出发走静态 import，返回闭包里的本仓源文件（仓库根相对）。 */
function popupStaticClosure(): Set<string> {
  const entry = resolveFile(resolve(SRC, 'popup/index.tsx'));
  assert.ok(entry, '找不到 popup 入口 src/popup/index.tsx');
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length) {
    const f = queue.shift()!;
    for (const spec of runtimeImportsOf(f)) {
      const t = resolveSpec(spec, f);
      if (!t || seen.has(t)) continue;
      seen.add(t);
      queue.push(t);
    }
  }
  return new Set([...seen].map(rel));
}

describe('首屏准入策略：纯函数', () => {
  it('normalizeModuleId 把绝对路径 / pnpm 虚拟 store 路径归一成仓库根相对', () => {
    assert.equal(
      normalizeModuleId('/Users/x/repo/src/utils/supabase/client.ts'),
      'src/utils/supabase/client.ts'
    );
    assert.equal(
      normalizeModuleId('/Users/x/repo/src/utils/storage.ts?used'),
      'src/utils/storage.ts'
    );
    // pnpm 虚拟 store：必须切到第一个 node_modules/，并保留 node_modules/ 前缀
    assert.equal(
      normalizeModuleId(
        '/Users/x/repo/node_modules/.pnpm/@supabase+supabase-js@2.118.0/node_modules/@supabase/supabase-js/dist/index.mjs'
      ),
      'node_modules/.pnpm/@supabase+supabase-js@2.118.0/node_modules/@supabase/supabase-js/dist/index.mjs'
    );
  });

  it('分组命中：SDK / Supabase 实现 / WebDAV / 性能追踪各自归位', () => {
    assert.equal(firstScreenGroupFor('node_modules/@supabase/supabase-js/dist/index.mjs')?.chunk, 'supabase-vendor');
    // pnpm 虚拟 store 下的 auth-js 也必须命中（startsWith 写法会永远漏判）
    assert.equal(
      firstScreenGroupFor(
        'node_modules/.pnpm/@supabase+auth-js@2.118.0/node_modules/@supabase/auth-js/dist/module/GoTrueClient.js'
      )?.chunk,
      'supabase-vendor'
    );
    assert.ok(isForbiddenInFirstScreen('src/utils/supabase/upload.ts'));
    assert.ok(isForbiddenInFirstScreen('src/utils/supabaseFacade.ts'));
    assert.ok(isForbiddenInFirstScreen('src/sync-backend/webdav/adapter.ts'));
    assert.ok(isForbiddenInFirstScreen('src/utils/perfTrace.ts'));
    assert.ok(isForbiddenInFirstScreen('src/utils/journal.ts'));
  });

  it('不被误伤：同前缀的别的文件、正常业务模块', () => {
    // `src/utils/supabase/` 不该命中 `src/utils/supabaseFacade.ts` 之外的邻居
    assert.equal(firstScreenGroupFor('src/utils/supabaseFacade.ts')?.chunk, '');
    assert.equal(isForbiddenInFirstScreen('src/utils/storage.ts'), false);
    assert.equal(isForbiddenInFirstScreen('src/store/slices/tabSlice.ts'), false);
    assert.equal(isForbiddenInFirstScreen('src/core/firstScreenPolicy.ts'), false);
    assert.equal(isForbiddenInFirstScreen('node_modules/react/index.js'), false);
  });

  it('禁止组里没有重复的块名（守卫按名字断言，重复名会让断言失真）', () => {
    const names = forbiddenChunkNames();
    assert.deepEqual(names, [...new Set(names)]);
  });

  it('每个禁止组都写清了理由（空理由 = 没人知道为什么不能进首屏）', () => {
    for (const g of FIRST_SCREEN_FORBIDDEN_GROUPS) {
      assert.ok(g.reason.trim().length > 10, `禁止组 ${g.chunk || '(无名)'} 缺理由`);
      assert.ok(
        firstScreenForbiddenReason(
          g.files[0] ?? `${g.prefixes[0]}__probe__.ts`
        ) !== null,
        `禁止组 ${g.chunk || '(无名)'} 的判定路径走不通`
      );
    }
  });
});

describe('首屏准入：popup 入口的静态依赖闭包里没有禁止组', () => {
  it('源码静态图（动态 import 不算首屏）', () => {
    const closure = popupStaticClosure();
    const violations: string[] = [];
    for (const file of closure) {
      if (isForbiddenInFirstScreen(file)) {
        violations.push(`${file}\n    理由：${firstScreenForbiddenReason(file)}`);
      }
    }
    assert.equal(
      violations.length,
      0,
      `popup 的静态 import 图里出现了禁止组模块：\n${violations.join('\n')}\n` +
        '修法：调用点改成 `await import(...)`，或断开这条静态边。'
    );
  });

  it('关键接缝确实是「按需加载」（钉住「改回静态 import」这个回归）', () => {
    // ── Supabase 门面 ────────────────────────────────────────────────
    // 取法统一走 `utils/supabaseRuntime`（页面动态加载、SW 静态注册）。
    // 断言**调用点用的是注册表**，而不是各自 `await import(...)` ——
    // 后者会让 service worker 里出现非法的 import()。
    for (const file of ['src/store/slices/authSlice.ts', 'src/sync-backend/supabaseAdapter.ts']) {
      const src = readFileSync(resolve(ROOT, file), 'utf8');
      assert.match(
        src,
        /loadSupabaseFacade\(\)/,
        `${file} 必须通过 utils/supabaseRuntime 取门面（SW 里 import() 被 Chrome 禁止）`
      );
      assert.doesNotMatch(
        src,
        /await import\(['"]@\/utils\/supabaseFacade['"]\)/,
        `${file} 不许直接 await import 门面 —— SW 侧会抛 import() is disallowed`
      );
    }
    const runtime = readFileSync(resolve(ROOT, 'src/utils/supabaseRuntime.ts'), 'utf8');
    assert.match(
      runtime,
      /await import\(['"]@\/utils\/supabaseFacade['"]\)/,
      '注册表的默认路径必须是动态加载（页面侧才延后下载）'
    );
    assert.match(
      runtime,
      /isServiceWorkerRealm\(\)/,
      '注册表必须在 SW 里**明确报错**（而不是让 Chrome 抛一句规范条款）'
    );

    // ── WebDAV 传输栈 ────────────────────────────────────────────────
    const barrel = readFileSync(resolve(ROOT, 'src/sync-backend/index.ts'), 'utf8');
    assert.doesNotMatch(
      barrel,
      /^import\s+\{[^}]*\}\s+from\s+'\.\/webdav\/(client|adapter|permission)'/m,
      'sync-backend 不许静态 import WebDAV 传输栈（adapter 单文件 100KB+ 源码）' +
        '—— 只有 webdav/config（配置读写，gzip 约 1.8KB）是允许静态的'
    );
    assert.match(
      barrel,
      /loadWebDavTransport\(\)/,
      'sync-backend 必须通过 webdavRuntime 取 WebDAV 传输栈'
    );
    const webdavRuntime = readFileSync(resolve(ROOT, 'src/sync-backend/webdavRuntime.ts'), 'utf8');
    assert.match(
      webdavRuntime,
      /import\('\.\/webdav\/adapter'\)/,
      'WebDAV 传输栈必须按需加载'
    );
    assert.match(
      webdavRuntime,
      /isServiceWorkerRealm\(\)/,
      'WebDAV 注册表必须在 SW 里明确报错'
    );
  });
});

describe('首屏准入：构建产物里 popup 的首屏清单没有禁止组', () => {
  it('dist 已构建时，popup 的 modulepreload 清单里没有禁止组的块名', (t) => {
    const popupHtml = resolve(ROOT, 'dist/src/popup/index.html');
    if (!existsSync(popupHtml)) {
      t.skip('dist 未构建（先跑 pnpm build）—— 产物级断言跳过，源码级断言仍然生效');
      return;
    }
    const html = readFileSync(popupHtml, 'utf8');
    const firstScreen = [...html.matchAll(/(?:href|src)="([^"]+\.js)"/g)].map(m => m[1]);
    assert.ok(firstScreen.length > 0, 'popup 的 HTML 里一个 js 引用都没有 —— 解析器失效了');
    const forbidden = forbiddenChunkNames();
    for (const name of forbidden) {
      const hit = firstScreen.filter(f => f.includes(name));
      assert.equal(
        hit.length,
        0,
        `popup 首屏清单里出现了禁止组块名「${name}」：${hit.join(', ')}\n` +
          '它意味着这条依赖是**静态**的 —— 首屏必须下载它。'
      );
    }
    // 额外一条更直白的：Supabase SDK 那个块不许进首屏
    assert.equal(
      firstScreen.filter(f => f.includes('supabase-vendor')).length,
      0,
      'Supabase SDK 进了 popup 首屏（它只在真的同步/核登录态时才用得上）'
    );
  });
});
