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
      // 2026-10-18 B 组：门禁必须拿到一个**判过 null 的**变量，而不是把
      // `await readConfiguredBackendId()` 直接灌进去（null 会落进
      // `=== 'webdav'` 的假分支 ⇒ 去查 Supabase session ⇒ 复现 2026-10-14
      // 的症状）。所以形状放宽到「本地变量」，判别力改由下面两条担：
      //   · 变量必须真的来自 readConfiguredBackendId；
      //   · 实参不得是 await 直灌（见 next）。
      assert.match(
        call,
        /backendId\s*:\s*(await readConfiguredBackendId\(\)|[A-Za-z_$][\w$]*)/,
        `第 ${i + 1} 处 ensureAuthenticated 漏传 backendId —— ` +
          '自带存储用户会在这里被当成「未登录」，走不到锁定后端的可读错误'
      );
    }
  });

  it('backendId 不得是 await 直灌：null 必须先被判掉再进传门禁', () => {
    // M2 的形状判据。readConfiguredBackendId 的 null 表示「读不到设置」，
    // 它流进门禁后 `deps.backendId === 'webdav'` 为 false ⇒ 走
    // restoreAuth() 查 Supabase 账号 ⇒ WebDAV 用户看到「用户未登录」，
    // 且永远到不了锁定后端那句「去重新解锁」—— 正是 2026-10-14 修掉的症状。
    const calls = authGuardCall(src);
    for (const [i, call] of calls.entries()) {
      assert.doesNotMatch(
        call,
        /backendId\s*:\s*await readConfiguredBackendId\(\)/,
        `第 ${i + 1} 处把可能为 null 的读法直灌门禁 —— 必须先赋值、判 null、提前 return`
      );
    }
  });

  it('null 的提前返回必须排在门禁之前（否则 null 照样流进去）', () => {
    const guards = [...src.matchAll(/ensureAuthenticated\(\{/g)].map(m => m.index!);
    assert.equal(guards.length, 2, 'upload/download 两处门禁');
    for (const g of guards) {
      // 每处门禁之前的 400 字符里必须有「=== null」+ 提前 return；
      // 不得有「先调门禁、后判 null」的写法（那就是 null 仍然流进去）。
      //
      // ⚠️ 2026-10-22：这里的「400 字符」窗口原先是**魔数**（钉写法、不钉语义）：
      // 门禁与「=== null」之间的**注释一长**，窗口就被顶破，而它想表达的
      // 语义（null 的提前 return 排在门禁**之前**）**一个字都没变**。
      // （2026-10-22 加了「云端项目被限制」的闸门处理，注释多了 20 行。）
      //
      // 改成钉**语义**：从**所属函数**的起点看到门禁调用为止，这一段里必须
      // 出现「=== null」+ 提前 return。这样无论中间写多少注释，判据都在；
      // 而「先调门禁、后判 null」的写法仍然会被抓到（那时函数起点到门禁
      // 之间根本没有「=== null」）。
      const fnStart = Math.max(
        src.lastIndexOf('async upload(', g),
        src.lastIndexOf('async downloadAndMerge(', g),
      );
      assert.ok(fnStart !== -1 && fnStart < g, '应能定位门禁所属的函数');
      const region = src.slice(fnStart, g);
      assert.match(
        region,
        /=== null[\s\S]{0,600}?return \{/,
        'null 提前 return 必须排在对应门禁之前（排在后面等于先查账号再判断）'
      );
    }
  });

  it('门禁必须直读设置，不能读模块缓存（缓存是 SW 启动那一刻的旧值）', () => {
    // 读缓存 = getActiveSyncBackendId()。它在用户改完设置、SW 未重启时仍是旧值，
    // 于是 WebDAV 用户被当成「未登录」—— 正是真机 E2E 抓到的那个洞。
    const code = read('src/services/syncEngine.ts');
    const calls = authGuardCall(code);
    for (const [i, call] of calls.entries()) {
      assert.match(
        call,
        /backendId\s*:\s*(await readConfiguredBackendId\(\)|[A-Za-z_$][\w$]*)/,
        `第 ${i + 1} 处门禁实参不是当前设置的值`
      );
      // 这条才是「不能读缓存、必须真读配置」的判据，且与「中间变量」写法无关：
      // 中间变量的来源在下面那条「不得是 await 直灌」+ 本组的前置断言里查。
      assert.ok(
        !/getActiveSyncBackendId\(/.test(call),
        `第 ${i + 1} 处门禁用了 getActiveSyncBackendId()（缓存），必须改成直读设置`
      );
    }
    // 实参变量必须真的来自直读设置（否则「放宽成变量」就成了漏洞：
    // 传一个从别处取来的 id 也能过上面的形状检查）。
    for (const name of new Set(
      calls.map(c => (c.match(/backendId\s*:\s*([A-Za-z_$][\w$]*)/) ?? [])[1]).filter(Boolean)
    )) {
      assert.match(
        code,
        new RegExp(`const\\s+${name}\\s*=\\s*await readConfiguredBackendId\\(\\)`),
        `${name} 不是 readConfiguredBackendId() 的真值 —— 门禁可能拿到过期或猜测的 id`
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

  it('backendId 必须收 null（读不到设置是本仓唯一的第三态）', () => {
    // 类型层判据：readConfiguredBackendId 自 2026-10-18 起会返回 null，
    // 而门禁仍按「不是 webdav 就查账号」处理 null（保守方向）。
    assert.match(
      guard,
      /backendId\?\s*:\s*['"]supabase['"]\s*\|\s*['"]webdav['"]\s*\|\s*null/,
      'backendId 类型未跟上 null —— 调用点会把「读不到」当成「读到 supabase」'
    );
  });
});

// ── 2026-10-18 B 组：读不到设置 ≠ 读到了 supabase ──────────────────────────
//
// `readConfiguredBackendId` 的 catch 曾返回 'supabase'，于是「读失败」与
// 「用户真的选了 TapStack 云端」从上层完全不可区分 —— 而这两者的正确动作
// 正好相反（一个该中止本轮，一个该去查账号）。修法是把 catch 的返回值
// 改成 null（三态），并让每个调用点显式判它。
describe('B 组：null 是「无法回答」，每个调用点都必须显式判', () => {
  const engine = read('src/services/syncEngine.ts');
  const bg = read('src/background/backgroundSync.ts');
  const settings = read('src/components/sync/WebDavSettings.tsx');
  const idx = read('src/sync-backend/index.ts');
  const STRIP = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('readConfiguredBackendId 的返回类型含 null，catch 里 return null', () => {
    assert.match(
      idx,
      /export async function readConfiguredBackendId\(\)\s*:\s*Promise<SyncBackendId \| null>/,
      '返回类型必须含 null —— 「读不到」不是「读到了 supabase」'
    );
    const body = STRIP(idx).slice(
      STRIP(idx).indexOf('export async function readConfiguredBackendId()')
    );
    const catchPart = body.slice(body.indexOf('catch ('));
    assert.match(
      catchPart,
      /return null;/,
      'catch 必须 return null：return "supabase" 会把读失败伪装成「用户选了云端」'
    );
  });

  it('downloadAndMerge / upload：判 null 后提前 return，且排在门禁之前', () => {
    for (const [fn, needle] of [
      ['async downloadAndMerge(', "reason: 'backend_unknown'"],
      ['async upload(', '读不到本机设置，已中止同步'],
    ] as const) {
      const start = engine.indexOf(fn);
      assert.ok(start > 0, `找不到 ${fn}`);
      const guardAt = engine.indexOf('ensureAuthenticated({', start);
      const nullAt = engine.indexOf('=== null', start);
      assert.ok(nullAt > start && nullAt < guardAt, `${fn} 的 null 分支必须排在门禁之前`);
      assert.match(
        engine.slice(nullAt, guardAt),
        new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `${fn} 必须以「中止本轮 + 独立机器码/人话」回吐，不能让 null 进门禁`
      );
    }
  });

  it('suppressFullUpload 的判据是 !== "supabase"：读不到时保持抑制', () => {
    // M1。=== 'webdav' 在 null 时为 false ⇒ 抑制关闭 ⇒ 上传清单退回全量 ⇒
    // 归属待决期的历史会话被整批推上用户云盘（2026-10-18 P1#4 禁的多传）。
    // 判据本身的行为断言在 tests/backendUnknownFailClosed.test.ts 的
    // decideSuppressFullUpload 组（那里能跑真值组合）；这里只钉「那个纯函数
    // 真的被 upload 用上了」—— 否则纯函数可能只是一份没人调用的死代码。
    assert.match(
      engine,
      /const\s+suppressFullUpload\s*=\s*decideSuppressFullUpload\(\{/,
      'upload 必须用 decideSuppressFullUpload 的结果，不得自己手写字面判据'
    );
    const fn = engine.slice(engine.indexOf('export function decideSuppressFullUpload'));
    // 从函数体开头取，不能从 `\n}` 切 —— 参数对象的右花括号就长这样（第一版栽过）。
    const fnBody = fn.slice(fn.indexOf('): boolean {'));
    assert.match(
      fnBody,
      /configuredBackendId\s*!==\s*['"]supabase['"]/,
      '抑制判据必须是 `!== "supabase"`：null（读不到）时保持抑制'
    );
    assert.doesNotMatch(
      fnBody,
      /configuredBackendId\s*===\s*['"]webdav['"]/,
      '不得用 `=== "webdav"`：读不到设置时它会关闭抑制，恢复「多传」路径'
    );
  });

  it('后台轮询：null 必须中止本轮，而不是落进 !== "webdav" 去查账号', () => {
    const at = bg.indexOf('const backendId = await readConfiguredBackendId()');
    assert.ok(at > 0, '找不到后台轮询的后端读点');
    const nullAt = bg.indexOf('=== null', at);
    const query = bg.indexOf("backendId !== 'webdav'", at);
    assert.ok(nullAt > at && nullAt < query, 'null 分支必须排在「查 Supabase 账号」之前');
    assert.match(
      bg.slice(nullAt, query),
      /kind:\s*['"]failed['"]/,
      '读不到设置是真实故障（计入退避、下轮重试），不是「未登录」的让路'
    );
  });

  it('设置页推送闸门：null 单独一句「读不到同步设置」，不与「不是自带存储」混说', () => {
    // ⚠️ 先 strip 再取下标：注释被抹掉后字符数变了，用原文下标切 strip 串
    // 会错位（本文件第一版栽在这里，症状是断言莫名其妙地红）。
    const body = STRIP(settings);
    const start = body.indexOf('const runPush = useCallback');
    assert.ok(start > 0, '找不到 runPush');
    const region = body.slice(start);
    const nullAt = region.indexOf('if (effective === null)');
    const otherAt = region.indexOf("if (effective !== 'webdav')");
    assert.ok(nullAt > 0 && otherAt > 0, 'runPush 内必须同时有 null 分支与 webdav 分支');
    assert.ok(
      nullAt < otherAt,
      'null 分支必须排在「不是自带存储」之前 —— 排在后面会先报「请去保存」'
    );
    assert.match(
      region.slice(nullAt, otherAt),
      /读不到同步设置/,
      'null 必须有自己的提示（读失败与「没保存设置」要给用户不同的下一步）'
    );
    assert.match(region.slice(nullAt, otherAt), /return;/,
      'null 分支必须自己 return，不得落到下面的上传调用');
  });
});
