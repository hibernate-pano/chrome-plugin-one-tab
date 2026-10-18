/**
 * 同步后端解析必须只有**一个**出口（回归锁）。
 *
 * ── 为什么有这条锁（2026-10-18）─────────────────────────────────────────
 * 曾经有两个"读设置决定用哪个后端"的函数并存：
 *   · `primeSyncBackend()` —— 生产路径，fail-closed，写 `lastResolution`，出声
 *   · `resolveConfiguredBackend()` —— 零调用的副本，catch 静默、不写
 *     `lastResolution`、缺 `lockedKind`
 * 副本的 docblock 还写着「存储异常 ⇒ 回落 Supabase，绝不抛错」，与它自己的
 * 函数体方向相反 —— 文档在指挥下一个人犯已修过的错，且没有测试锁住。
 *
 * ── 为什么不把副本修好 ─────────────────────────────────────────────────
 * 修好它要补 logError、补 lockedKind、重写 docblock、再加一条 severity 测试，
 * 代码量大于删除，而用户可见收益为 0（它零调用）。已删除。
 *
 * ── 测试形态说明 ─────────────────────────────────────────────────────
 * 本仓库没有 jsdom / happy-dom / @testing-library（见 tests/a11yDialogs.test.ts
 * 顶部），也不允许为此装依赖。而"某符号在源码里不存在"天生是文本断言 ——
 * 对这类**结构不变量**，源码断言是唯一正确的形态（没有可运行的行为能证明
 * "某个名字没被定义"）。
 *
 * ── 变异验证（cp 备份 → 改坏 → 必须红 → cp 恢复，严禁 git checkout）──
 *   · 粘回 resolveConfiguredBackend → T1/T2 红
 *   · 去掉 ensureBackendPrimed 的 export → T3 红
 *   · primeSyncBackend 的 `.catch(() => ({...}))` 里换成 SupabaseBackendAdapter → T4 红
 *   · 同一个 `.catch` 里删掉 lockedKind → T5 红
 *   （T4 第一版的窗口只有 700 字符、且只认 `catch {` 花括号形式，对真实代码里
 *    `.catch(() => ({...}))` 这条唯一的回落点**完全盲**。不是"没红所以测试弱"，
 *    是变异根本没落在被测对象上。已改成按 catch 体的括号配平取窗口 + 认两种形式。）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC_DIR = new URL('../src/', import.meta.url).pathname;
const INDEX_SRC = readFileSync(new URL('../src/sync-backend/index.ts', import.meta.url), 'utf8');

/** 递归收集 src/ 下的 .ts/.tsx（不碰 node_modules，src 里本来也没有）。 */
function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectSourceFiles(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** 剥掉注释，避免"注释里提了一嘴"满足断言（本仓库踩过这个坑）。 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * 取出所有 catch 处理块的源码，两种形态都要认：
 *   ① `catch { ... }` / `catch (e) { ... }`      —— 语句形式
 *   ② `.catch(() => ({ ... }))` / `.catch(e => ...)` —— 表达式形式
 * 第二种是真实代码里唯一的回落点，只认第一种会让 T4 变成永远绿的空断言。
 */
function catchBodies(code: string): string[] {
  const bodies: string[] = [];

  // ① 语句形式：从 `catch` 后的 `{` 起做括号配平。
  for (const m of code.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{/g)) {
    const start = m.index! + m[0].length;
    let depth = 1;
    let i = start;
    while (i < code.length && depth > 0) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') depth--;
      i++;
    }
    bodies.push(code.slice(start, i - 1));
  }

  // ② 表达式形式：`.catch(` 之后的实参到匹配的右括号。
  for (const m of code.matchAll(/\.catch\s*\(/g)) {
    const start = m.index! + m[0].length;
    let depth = 1;
    let i = start;
    while (i < code.length && depth > 0) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') depth--;
      i++;
    }
    bodies.push(code.slice(start, i - 1));
  }

  return bodies;
}

test('T1: src/ 里不再有 resolveConfiguredBackend（零调用的劣化副本已删除）', () => {
  const files = collectSourceFiles(SRC_DIR);
  // 先断言扫描真的发生了，否则"0 命中"可能只是因为没扫到任何文件。
  assert.ok(files.length > 50, `扫描到的源文件太少（${files.length}），递归收集可能坏了`);
  const offenders = files.filter(f => stripComments(readFileSync(f, 'utf8')).includes('resolveConfiguredBackend'));
  assert.deepEqual(
    offenders.map(f => f.slice(SRC_DIR.length)),
    [],
    'resolveConfiguredBackend 又出现了 —— 它是 primeSyncBackend 的劣化副本，不该复活'
  );
});

test('T2: 指向 sync-backend 解析入口的注释不再提 resolveConfiguredBackend', () => {
  // overrideBackend 的 docblock 曾经写"生产走 resolveConfiguredBackend() 读设置"，
  // 那是删除前的事实。注释必须指向真实入口，否则下一个人会去找一个不存在的函数。
  const idx = INDEX_SRC.indexOf('let overrideBackend');
  assert.ok(idx > -1, '找不到 overrideBackend 声明（锚点漂了）');
  const docblock = INDEX_SRC.slice(Math.max(0, idx - 500), idx);
  assert.ok(
    docblock.includes('primeSyncBackend'),
    `overrideBackend 的注释应指向 primeSyncBackend，实际：${docblock.slice(-200)}`
  );
  assert.ok(!docblock.includes('resolveConfiguredBackend'), 'overrideBackend 的注释仍在指向已删除的函数');
});

test('T3: 删除没过头 —— 后端解析的公开出口仍在', () => {
  for (const name of [
    'export async function primeSyncBackend',
    'export async function ensureBackendPrimed',
    'export async function readConfiguredBackendId',
    'export async function refreshBackendResolutionOnly',
  ]) {
    assert.ok(INDEX_SRC.includes(name), `后端解析入口被误删了：${name}`);
  }
});

test('T4: 没有任何 catch 分支回落 Supabase（fail-closed 不变量）', () => {
  // 两个方向都要抓：
  //   exactly  —— catch 体里直接构造 Supabase 适配器（最明显的回落）
  //   returned —— catch 体把 Supabase 相关的 backend 变量 return / 赋给
  //               activeBackend（换个体面的写法也躲不过）
  const code = stripComments(INDEX_SRC);
  const bodies = catchBodies(code);
  // 先证明抓到了足够的样本，否则下面的循环可能一个都没跑（空断言）。
  assert.ok(
    bodies.length >= 4,
    `只提取到 ${bodies.length} 个 catch 体，提取逻辑可能失效（真实代码里远多于 4 个）`
  );
  for (const body of bodies) {
    assert.ok(
      !/new\s+SupabaseBackendAdapter\s*\(/.test(body),
      `某个 catch 分支回落 Supabase 了（fail-closed 不变量被破坏）：…${body.slice(0, 240)}`
    );
  }
});

test('T5: 读不到设置的那两条 catch 必须带 lockedKind（不能靠中文正则兜底）', () => {
  // lockedKind 缺失时，backendStatus.classifyBackendResolution 只能靠
  // /读不到/ 之类的措辞猜回 'error' —— 那是把判定绑在文案上，改个标点就静默失效。
  const code = stripComments(INDEX_SRC);
  const bodies = catchBodies(code);
  const readFailureBodies = bodies.filter(b => b.includes('读不到同步设置'));
  assert.ok(
    readFailureBodies.length >= 2,
    `应至少有两处「读不到同步设置」的兜底（primeSyncBackend 与 refreshBackendResolutionOnly），实际 ${readFailureBodies.length}`
  );
  for (const body of readFailureBodies) {
    assert.ok(
      body.includes('lockedKind'),
      `「读不到同步设置」的兜底缺 lockedKind，UI 只能靠中文措辞猜：…${body.slice(0, 240)}`
    );
    assert.ok(body.includes('error'), `lockedKind 应是 'error'（存储读不出来属最严重档）：…${body.slice(0, 240)}`);
  }
});
