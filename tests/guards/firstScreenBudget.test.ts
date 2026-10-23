// popup 首屏准入守卫（2026-10-23）。
//
// ── 这条守卫钉的是什么 ────────────────────────────────────────────────────
// 用户点开弹窗只需要**看会话列表**（会话在本机 IndexedDB 里）。
// 2026-10-23 之前，构建产物把**整条同步栈**（Supabase SDK 58.9KB gzip +
// 读写实现 + WebDAV 适配器）塞进首屏的 modulepreload 清单：
// 实测首屏 262.2KB / 预算 265KB，只差 3KB 就要破门。
//
// 「哪些模块算首屏」是**产品决定**，但「哪些模块**不许**算首屏」必须有一个
// 可单测的真相源 ⇒ `src/core/firstScreenPolicy.ts`（纯判据）。
//
// 本文件三层：
//   1. **纯函数单测** —— 策略本身的判定逻辑（路径归一化、分组命中、白名单）。
//   2. **源码静态图** —— 从 popup 入口出发走**静态** import，闭包里不许出现
//      禁止组的模块，**也不许出现白名单之外的第三方包**（动态 import 不算首屏）。
//   3. **产物清单** —— 若 dist 已构建，popup 的首屏清单里不许出现
//      禁止组的块名。
//
// ⚠️ 为什么第 2 层要自己解析 import 而不是只信第 3 层：
//   第 3 层需要先构建（`pnpm build`），而 `pnpm test` 应当**不依赖构建产物**
//   就能守住这条规则；反过来，第 2 层是源码图，与产物可能有偏差
//   （Rollup 会合并块、会把动态 import 变成静态边）⇒ 两层都要有。
//
// ⚠️ 为什么第 2 层用 **AST** 而不是正则（2026-10-23 第 50 轮换掉）：
//   正则分不清「运行时 import」与「类型 import」，而且会把
//   `export function getActiveSyncBackend(): SyncBackendPort {` 里的 "export"
//   当成 re-export，从下一个 `from` 一路吞过去 —— 实测会**凭空**多出一个
//   运行时依赖（`src/sync-backend/ports.ts`，实测它是 `export type {…}`）。
//   ⇒ 改用 `tests/_helpers/moduleGraph.ts` 的 AST 静态图工具。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FIRST_SCREEN_ALLOWED_PACKAGES,
  FIRST_SCREEN_FORBIDDEN_GROUPS,
  firstScreenForbiddenReason,
  firstScreenGroupFor,
  firstScreenSpecifierViolation,
  forbiddenChunkNames,
  isForbiddenInFirstScreen,
  normalizeModuleId,
} from '@/core/firstScreenPolicy';
import { popupStaticClosure, runtimeImportSpecs } from '../_helpers/moduleGraph.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

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
    // ⚠️ 判重必须对**原始数组**做：`new Set` 自己就会去重，
    //   `assert.deepEqual(names, [...new Set(names)])` 两边永远相等 ⇒
    //   这条断言**不可能失败**（恒绿守卫 = 零检测力）。
    //   这里判的是「块名 → 禁止组」是**单射**：同一个非空块名出现在两个组里，
    //   按名字断言就会失真（一个名字同时代表两组）。
    const byChunk = new Map<string, number[]>();
    FIRST_SCREEN_FORBIDDEN_GROUPS.forEach((g, index) => {
      if (!g.chunk) return; // 空块名 = 不起块名，不参与「按名字断言」
      const owners = byChunk.get(g.chunk) ?? [];
      owners.push(index);
      byChunk.set(g.chunk, owners);
    });
    const duplicated = [...byChunk.entries()].filter(([, owners]) => owners.length > 1);
    assert.deepEqual(
      duplicated,
      [],
      '同一个块名出现在多个禁止组里 ⇒ 守卫按名字断言会失真（块名 → 禁止组必须是单射）'
    );
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

  it('首屏白名单每条都写清了「为什么允许」（空理由 = 没人知道它为什么能进首屏）', () => {
    for (const p of FIRST_SCREEN_ALLOWED_PACKAGES) {
      assert.ok(p.reason.trim().length > 10, `白名单条目「${p.package}」缺理由`);
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

  it('源码静态图里不许出现白名单之外的第三方包（新依赖进首屏的唯一兜底）', () => {
    // ⚠️ 这条是**黑名单的兜底**：黑名单只能拦住「已经有人想过」的东西，
    //   任何**新** npm 包（dayjs / chart.js / lodash …）只要被 popup 侧静态
    //   import 一下，黑名单一声不响 ⇒ 这里靠白名单兜住。
    const violations: string[] = [];
    for (const file of popupStaticClosure()) {
      for (const spec of runtimeImportSpecs(resolve(ROOT, file))) {
        const violation = firstScreenSpecifierViolation(spec);
        if (violation) {
          violations.push(`${file} → ${spec}\n    理由：${violation.reason}`);
        }
      }
    }
    assert.equal(
      violations.length,
      0,
      `popup 的静态 import 图里出现了白名单之外的第三方包：\n${violations.join('\n')}\n` +
        '修法：① 改成 `await import(...)`（动态 import 不算首屏）；' +
        '② 确认它确实该进首屏 ⇒ 在 src/core/firstScreenPolicy.ts 的 ' +
        'FIRST_SCREEN_ALLOWED_PACKAGES 里加一行并写清「为什么允许」。'
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
        '—— 只有 webdav/config（配置读写；源码 20.5KB，minify 后 gzip 约 1.8KB）是允许静态的'
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
      // ⚠️ **不许静默 skip**（2026-10-23 第 50 轮）：
      //   产物级断言是首屏准入三层里的第三层，而 CI 曾经是
      //   「先 pnpm test、后 pnpm validate（validate 里才 build）」
      //   ⇒ 干净 checkout 下 dist 根本不存在 ⇒ 这一层**每次都跳过**，
      //   而 CI 日志里只是一行 skip，看起来像「验过了」。
      //   CI 顺序已改成「先 build 再 test」；本地没构建时必须**显眼地**说一声。
      const msg =
        '⚠️ 本轮跳过了**产物级**首屏断言（dist 未构建）—— 首屏准入三层里有一层没跑。' +
        '先跑 `pnpm build` 再跑 `pnpm test`，或直接 `pnpm validate`。';
      console.error(msg);
      t.diagnostic(msg);
      t.skip(msg);
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
