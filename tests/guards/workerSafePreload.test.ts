// worker 安全的 preload 助手（2026-10-23）—— 守卫。
//
// ── 这条守卫钉的是什么 ────────────────────────────────────────────────────
// vite 给「含字面量动态 import 的 chunk」注入 `__vitePreload`，
// 它第一件事就是读 `document.getElementsByTagName('link')`。
// MV3 的 module service worker **没有 document** ⇒
// 只要 worker 侧跑一次「目标块有静态依赖的动态 import」，
// 就是 `ReferenceError: document is not defined`。
//
// 本仓 2026-10-14 踩过一次，绕法是「SW 里不许用动态 import」，
// 代价是**弹窗首屏必须静态下载整条云端栈**。首屏瘦身把动态 import 请回来
// ⇒ 助手必须先被修成 worker 安全的（实现见 src/core/workerSafePreload.ts）。
//
// 判据分三层：
//   1. **生成出来的代码在 worker 里能跑**（没有 document 也不炸）——
//      这才是本轮真正修的那条。
//   2. **生成出来的代码在页面里行为不变**（仍然插 modulepreload link）——
//      否则「修 SW」会变成「悄悄把页面的预加载优化关掉」。
//   3. **产物里那个 DOM 访问前面确实有 worker 闸门**（防构建配置被改回去）。
//
// ⚠️ 第 2 层为什么要单独钉：第 1 层只保证「不炸」，
// 一个「直接 return baseModule()、永远不插 link」的退化实现也能过第 1 层
// ⇒ 那等于把页面的下载瀑布放回来（首屏变慢），而没有任何测试会红。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildWorkerSafePreloadCode } from '@/core/workerSafePreload';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** 与 vite.config.ts 里的取值口径一致（相对 base + modulepreload polyfill）。 */
const OPTIONS = {
  scriptRel: "'modulepreload'",
  assetsURL: 'function(dep, importerUrl) { return new URL(dep, importerUrl).href }',
} as const;

interface PreloadHelperModule {
  __vitePreload: (
    base: () => Promise<unknown>,
    deps?: string[],
    importerUrl?: string
  ) => Promise<unknown>;
}

/**
 * 生成助手代码并落成一个临时 .mjs，以便**真的 import 它**。
 *
 * 为什么要绕这一圈：直接在测试里 eval 出来的字符串只能测「文本长这样」，
 * 测不了「import 之后调用会不会炸」—— 而后者才是这次的缺陷本身。
 */
async function loadHelper(): Promise<PreloadHelperModule> {
  const dir = mkdtempSync(join(tmpdir(), 'tapstack-preload-'));
  const file = join(dir, 'helper.mjs');
  // vite 在 renderChunk 阶段把 `__VITE_IS_MODERN__` 换成 `true`（es 产物）。
  // 这里照做，否则单测里会撞上那个占位符。
  const code = buildWorkerSafePreloadCode(OPTIONS).replace(/__VITE_IS_MODERN__/g, 'true');
  writeFileSync(file, code, 'utf8');
  const mod = (await import(pathToFileURL(file).href)) as unknown as PreloadHelperModule;
  return mod;
}

describe('worker 安全的 preload 助手', () => {
  it('worker 里（没有 document）不炸，且照样把模块加载出来', async () => {
    const { __vitePreload } = await loadHelper();
    assert.equal(typeof globalThis.document, 'undefined', '测试前提：node 里没有 document');
    const result = await __vitePreload(
      async () => ({ ok: true }),
      ['./supabase-vendor-abc.js'],
      'https://example.invalid/chunk.js'
    );
    assert.deepEqual(result, { ok: true });
  });

  it('worker 里加载失败时，错误照常抛给调用方（不能被静默吞掉）', async () => {
    const { __vitePreload } = await loadHelper();
    await assert.rejects(
      () =>
        __vitePreload(
          async () => {
            throw new Error('加载失败');
          },
          ['./x.js'],
          'https://example.invalid/c.js'
        ),
      /加载失败/
    );
  });

  it('页面里（有 document）仍然会插 modulepreload link —— 不能把预加载优化悄悄关掉', async () => {
    const { __vitePreload } = await loadHelper();
    const appended: any[] = [];
    const fakeDoc = {
      getElementsByTagName: () => [],
      querySelector: () => null,
      createElement: () => ({
        rel: '',
        as: '',
        crossOrigin: '',
        href: '',
        setAttribute() {},
        addEventListener() {},
      }),
      head: {
        appendChild(el: unknown) {
          appended.push(el);
        },
      },
    };
    const dispatched: unknown[] = [];
    (globalThis as any).document = fakeDoc;
    (globalThis as any).window = { dispatchEvent: (e: unknown) => dispatched.push(e) };
    try {
      const result = await __vitePreload(
        async () => ({ ok: true }),
        ['./supabase-vendor-abc.js'],
        'https://example.invalid/chunk.js'
      );
      assert.deepEqual(result, { ok: true });
      assert.equal(appended.length, 1, '页面里必须插一个 link（预加载优化还在）');
      assert.equal(appended[0].rel, 'modulepreload');
      assert.equal(appended[0].as, 'script');
      assert.equal(
        appended[0].href,
        'https://example.invalid/supabase-vendor-abc.js',
        'link 的 href 必须按 assetsURL 解析成绝对地址'
      );
    } finally {
      delete (globalThis as any).document;
      delete (globalThis as any).window;
    }
  });

  it('产物里那个 DOM 访问前面确实有 worker 闸门', () => {
    const dist = resolve(ROOT, 'dist');
    if (!existsSync(dist)) return; // dist 未构建：本条跳过（源码级判据仍然生效）
    let checked = 0;
    for (const name of readdirSync(dist)) {
      if (!name.endsWith('.js')) continue;
      const src = readFileSync(join(dist, name), 'utf8');
      const domAt = src.indexOf('getElementsByTagName');
      if (domAt < 0) continue;
      checked++;
      const guardAt = src.indexOf('typeof document');
      assert.ok(
        guardAt >= 0 && guardAt < domAt,
        `${name} 里有 DOM 访问（getElementsByTagName）却没有前置的 ` +
          '`typeof document` 闸门 ⇒ service worker 里会抛 document is not defined'
      );
    }
    assert.ok(checked > 0, 'dist 里一个带 DOM 访问的产物都没有 —— 判据失效了（构建产物变了？）');
  });
});
