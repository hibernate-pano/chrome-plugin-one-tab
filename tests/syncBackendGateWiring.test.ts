// 「同步前置条件门禁」的生产接线（2026-10-14，真机 E2E 挖出来的洞）。
//
// ── 背景 ────────────────────────────────────────────────────────────────
// `ensureAuthenticated` 原本只问「你有没有 Supabase 账号」。WebDAV 用户没有账号，
// 于是 upload/download 两条路径都在门禁处直接 return「用户未登录」，
// 永远走不到锁定后端抛的「去重新解锁」。
//
// ── 为什么单测层抓不到，只能靠接线断言 ────────────────────────────────
// 门禁本身的单测（authGuard.test.ts）能证明「backendId=webdav 时放行」；
// 但**生产调用点漏传 backendId** 时，两层各自都对、行为却退回旧 bug。
// 实测：删掉 syncEngine 里的两处 backendId，authGuard 7 条 + syncEngine 6 条
// 全部照样绿。接线漏了，两层单测都看不见 —— 只能对源码结构下断言。
// （仓库同惯例：deadCodeGuards / gateScripts / a11yLists。）
//
// 断言的是「实参真的传了」，不是「附近出现过」：后者会被注释里的同名文字命中。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};
void register(
  pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')).href
);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

/** 取出 `ensureAuthenticated({ ... })` 的实参对象文本（花括号配平）。 */
function authGuardCall(src: string): string[] {
  const out: string[] = [];
  let idx = 0;
  for (;;) {
    const at = src.indexOf('ensureAuthenticated({', idx);
    if (at < 0) return out;
    let depth = 0;
    let i = src.indexOf('{', at);
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(start, i + 1));
    idx = i + 1;
  }
}

describe('syncEngine：门禁调用必须显式传 backendId', () => {
  const src = read('src/services/syncEngine.ts');

  it('两处 ensureAuthenticated 调用都在（upload + download）', () => {
    const calls = authGuardCall(src);
    assert.equal(calls.length, 2, '少一处意味着某条同步路径没有门禁，或多了一处重复');
  });

  it('每一处都把 backendId 传给门禁（漏传 ⇒ WebDAV 用户看到「用户未登录」）', () => {
    const calls = authGuardCall(src);
    for (const [i, call] of calls.entries()) {
      assert.match(
        call,
        /backendId\s*:\s*await readConfiguredBackendId\(\)/,
        `第 ${i + 1} 处 ensureAuthenticated 漏传 backendId —— ` +
          '自带存储用户会在这里被当成「未登录」，走不到锁定后端的可读错误'
      );
    }
  });

  it('门禁必须直读设置，不能读模块缓存（缓存是 SW 启动那一刻的旧值）', () => {
    // 读缓存 = getActiveSyncBackendId()。它在用户改完设置、SW 未重启时仍是旧值，
    // 于是 WebDAV 用户被当成「未登录」—— 正是真机 E2E 抓到的那个洞。
    const calls = authGuardCall(read('src/services/syncEngine.ts'));
    for (const [i, call] of calls.entries()) {
      assert.match(
        call,
        /backendId\s*:\s*await readConfiguredBackendId\(\)/,
        `第 ${i + 1} 处门禁读了模块缓存而非当前设置`
      );
      assert.ok(
        !/getActiveSyncBackendId\(/.test(call),
        `第 ${i + 1} 处门禁用了 getActiveSyncBackendId()（缓存），必须改成直读设置`
      );
    }
  });

  it('不得硬编码后端 id（换后端后门禁要跟着变）', () => {
    const src2 = read('src/services/syncEngine.ts');
    assert.ok(
      !/ensureAuthenticated\(\{[^}]*backendId\s*:\s*['"]webdav['"]/.test(src2),
      '硬编码 webdav 会让切回 Supabase 的用户跳过账号检查'
    );
  });
});

describe('门禁语义：后端自己回答「是否就绪」', () => {
  const guard = read('src/core/authGuard.ts');

  it('webdav 直接放行到后端层（前置条件由后端自己判）', () => {
    assert.match(
      guard,
      /backendId\s*===\s*['"]webdav['"][\s\S]{0,40}return\s+true/,
      '自带存储必须放行；不可用时由锁定后端抛可读错误'
    );
  });

  it('未传 backendId 时回落 Supabase 语义（不得变成无条件放行）', () => {
    // 漏传是「新增调用点忘了传」，此时应退回最保守的既有行为。
    // 若这里写成 `if (deps.backendId !== 'supabase') return true`，漏传就会放行。
    const body = guard.slice(guard.indexOf('export async function ensureAuthenticated'));
    const webdavBranch = body.match(/backendId\s*===\s*['"]webdav['"][\s\S]{0,60}/);
    assert.ok(webdavBranch, '缺少 webdav 分支');
    assert.ok(
      !/backendId\s*!==\s*['"]supabase['"]/.test(body),
      '不得用「不等于 supabase 就放行」的写法：漏传 backendId 时会变成放行'
    );
  });
});
