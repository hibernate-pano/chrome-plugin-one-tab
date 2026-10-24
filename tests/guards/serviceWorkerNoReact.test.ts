/**
 * PERF-02：Service Worker 的静态闭包里不许有 React（2026-10-24 审计）。
 *
 * ── 这条防的具体事故 ────────────────────────────────────────────────────
 *
 * MV3 的 module service worker **每次被唤醒**（浏览器启动、alarms、任意消息）
 * 都要把它的**静态 import 闭包**读回来并解析。
 *
 * 而 SW 的源码图里 **0 个 import react / react-dom** —— 它一行 React 都不用
 * （ServiceWorkerGlobalScope 里没有 DOM）。React 是被**块级依赖**拖进去的：
 * `vite.config.ts` 原先把 `react-redux` 与 `@reduxjs/toolkit` 塞进同一块
 * （`redux-vendor`），而 **react-redux 依赖 react** ⇒ Rollup 的
 * 「手动块会吸收其依赖」规则把 `react-vendor` 一起拖进 SW 的静态闭包。
 *
 * 实测（同一份工作树的 A/B，只改分块规则）：
 *   · 改前：SW 静态闭包 **428.1KB raw / 125.1KB gzip**，含 `react-vendor`
 *     （142.96KB raw / 45.80KB gzip）；
 *   · 改后：SW 静态闭包 **288.5KB raw / 80.3KB gzip**，**不含任何 react 块**；
 *   ⇒ **−139.6KB raw / −44.8KB gzip（−32.6% / −35.8%）**。
 *
 * ⚠️ 这不是「SW 启动快了 X ms」：这些字节来自本机扩展包（不走网络），
 * V8 解析 react-vendor ≈ 1.3ms，冷启动墙钟收益在噪声内。
 * 它是**字节与解析量的账**，不是「故障」。
 *
 * ── 三层判据（每层管一件事）──────────────────────────────────────────────
 *
 *   ① **分块策略层**（永远跑）：`@reduxjs/toolkit` 与 `react-redux`
 *      **必须**分处不同的块。判据在 `src/core/chunkingPolicy.ts`（纯函数）
 *      —— 构建配置不该是「没人能测的判据」。
 *   ② **源码层**（永远跑）：SW 的静态 import 闭包里不许出现
 *      react / react-dom / react-redux 这三个**裸包名**。
 *      （有了 ① ②，产物层面的「React 不在 SW 闭包里」就是推论。）
 *   ③ **产物层**（dist 存在时跑）：直接算 `dist/service-worker.js` 的
 *      静态 import 闭包，断言里面**没有名为 react-vendor 的块**。
 *      这一层是**唯一**能看见块级依赖的那一层 ⇒ 必须真的对着产物算。
 *      dist 没构建时**显眼地**跳过（不是静默跳过）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { reduxPackagesShareChunk, vendorChunkFor } from '@/core/chunkingPolicy';
import { runtimeImportSpecs, staticClosure } from '../_helpers/moduleGraph.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = resolve(ROOT, 'dist');
const SW_ENTRY = resolve(ROOT, 'src/service-worker.ts');

/** 不许出现在 SW 闭包里的裸包名。 */
const REACT_PACKAGES = ['react', 'react-dom', 'react-redux'];

/** SW 静态闭包（仓库源码）里出现过的**裸包名**（node_modules 里的包）。 */
function barePackagesInClosure(): Set<string> {
  const closure = staticClosure(SW_ENTRY);
  const bare = new Set<string>();
  for (const file of closure) {
    for (const spec of runtimeImportSpecs(file)) {
      if (spec.startsWith('@/') || spec.startsWith('.')) continue;
      // 只取包名（`react-dom/client` ⇒ `react-dom`）
      bare.add(spec.split('/')[0]);
    }
  }
  return bare;
}

/** 产物层：算 `dist/service-worker.js` 的静态 import 闭包（文件绝对路径集合）。 */
function distStaticClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(file)) continue;
    const src = readFileSync(file, 'utf8');
    // ESM 静态 import / re-export（`import … from './x.js'`）。
    // **动态 import() 不算**：它不在 SW 的静态闭包里（MV3 干脆禁止）。
    const re = /(?:^|[\s;}])(?:import|export)\s*(?:[\s\S]*?\sfrom\s*)?["'](\.[^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      queue.push(resolve(dirname(file), m[1]));
    }
  }
  return seen;
}

describe('PERF-02：Service Worker 的静态闭包里不许有 React', () => {
  it('① @reduxjs/toolkit 与 react-redux 必须分处不同的块', () => {
    assert.equal(
      reduxPackagesShareChunk(),
      false,
      'react-redux 与 @reduxjs/toolkit 同块 ⇒ react-redux 依赖的 react 会被拖进 ' +
        'redux-vendor ⇒ Service Worker 的静态闭包被拖进整包 React（SW 一行 React 都不用）'
    );
    // 顺带钉住「react 本体」与「react-redux」也必须分开（react-redux 依赖 react）。
    assert.notEqual(
      vendorChunkFor('/repo/node_modules/react/index.js'),
      vendorChunkFor('/repo/node_modules/react-redux/dist/react-redux.mjs'),
      'react 本体与 react-redux 不能同块'
    );
  });

  it('② SW 的源码静态闭包里不出现 react / react-dom / react-redux', () => {
    const bare = barePackagesInClosure();
    for (const pkg of REACT_PACKAGES) {
      assert.ok(
        !bare.has(pkg),
        `SW 的静态闭包里出现了 ${pkg} —— SW 没有 DOM，一行 React 都不该用`
      );
    }
  });

  it('③ 产物里：service-worker.js 的静态闭包不含 react-vendor 块', t => {
    const entry = join(DIST, 'service-worker.js');
    if (!existsSync(entry)) {
      t.skip(
        'dist/ 未构建 ⇒ 产物层判据本轮跳过（源码层与分块策略层仍然生效）。' +
          'CI 会先 build 再 test（tests/guards/ciBuildBeforeTest.test.ts 守着这件事）。'
      );
      return;
    }
    const closure = distStaticClosure(entry);
    const reactChunks = [...closure]
      .map(f => f.slice(DIST.length + 1))
      .filter(name => /^react-vendor/.test(name) || /^react-redux-vendor/.test(name));
    assert.deepEqual(
      reactChunks,
      [],
      'Service Worker 的静态闭包里出现了 React 块 —— ' +
        'SW 每次被唤醒都要把这张图读回来并解析，而它一行 React 都不用'
    );
    // 前提：闭包非空（否则这条断言恒绿）。
    assert.ok(closure.size >= 1, '前提：SW 产物的静态闭包非空');
  });
});
