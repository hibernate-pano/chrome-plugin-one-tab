/**
 * 弹窗**打开时**不许加载 Supabase SDK（2026-10-23 第 47 轮）。
 *
 * ── 这个缺陷的形状 ────────────────────────────────────────────────────────
 * 用户点开弹窗只想看**本机会话列表**。而挂载时核一次登录态，会把**整条
 * Supabase SDK** 拉下来（SDK ≈58KB gzip + 门面 ≈16KB gzip ≈ **75KB**）——
 * 这 75KB 跟他要干的事毫无关系，却**每次开弹窗都付一次**。
 *
 * ⇒ 修法：把「核」搬到 **service worker**（SW 侧的 SDK 是**静态依赖**，
 * 已经在扩展包里 ⇒ **零下载**），弹窗只发一条消息问「核完了吗」。
 *
 * ── 为什么这条守卫是**结构**的，而不是「跑一次看看」 ────────────────────
 * 仓库里没有 DOM 测试环境（组件测试是 `react-dom/server` 的 SSR 渲染，
 * `useEffect` 在 SSR 里不跑）⇒ 「挂载时到底加载了什么」**测不出来**。
 * 而这个缺陷的形态恰恰是：**编译期合法、类型全绿、界面照常能看**，
 * 只有「打开弹窗时网络面板里多出两个 chunk」才看得出来。
 *
 * ⇒ 能提前发现的唯一办法，是把「弹窗的**挂载路径**上不许出现会加载 SDK 的调用」
 * 写成一条**每次跑测试都会检查**的规则。
 *
 * ── 判据怎么算出来（不手写清单） ─────────────────────────────────────────
 * ① 全仓算出「**会加载 Supabase 门面**」的符号集合（`tests/_helpers/facadeLoading.ts`）：
 *    从「函数体里真的 `import('@/utils/supabaseFacade')`」的那些**根**出发，
 *    沿调用往外推 —— 同文件的局部函数（**哪怕它没被导出**）、跨文件的 import
 *    绑定、类的方法。
 * ② 全仓算出弹窗的**静态 import 闭包**（`tests/_helpers/moduleGraph.ts`，
 *    AST 判定，不是正则）。
 * ③ 对闭包里的每个文件，算出「**挂载时真正会跑的代码**」：
 *    模块顶层 + `useEffect`/`useLayoutEffect`/`useMemo` 的回调，
 *    再沿**本文件的局部调用**跟进去。
 * ④ 那条路径上不许出现「会加载门面的符号」的调用。
 *
 * ⚠️ **事件处理器不在判据范围内**（`onClick` 里的代码是**点击时**才跑）：
 * 「用户点了『去登录』才加载 SDK」是设计要的 —— 判据要是把它也禁了，
 * 就等于逼着实现把登录功能删掉。
 *
 * ⚠️ 危险集是**算出来的**，不是抄出来的 ⇒ 有人给门面加载器改个名、
 * 或者新加一条会加载它的导出路径，危险集会自动跟着变。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  FACADE_MODULE,
  facadeLoadingSymbols,
} from '../_helpers/facadeLoading.ts';
import {
  moduleBindings,
  moduleSymbols,
  popupStaticClosure,
  REPO_ROOT,
  resolveModuleSpec,
  SRC_ROOT,
} from '../_helpers/moduleGraph.ts';
import { mountFacadeCalls } from '../_helpers/mountPath.ts';

const SRC = SRC_ROOT;

/** 某个 import 进来的符号危不危险（用它**自己那个文件**的危险集判）。 */
function isDangerousImport(
  targetFile: string,
  importedName: string,
  danger: Map<string, Set<string>>,
): boolean {
  return danger.get(targetFile)?.has(importedName) === true;
}

describe('弹窗打开时不许加载 Supabase SDK', () => {
  it('危险集算出来了（不是空集 —— 空集说明这套算法坏了，守卫会变成永远绿）', () => {
    const danger = facadeLoadingSymbols();
    const all = [...danger.values()].flatMap(s => [...s]);
    assert.ok(
      all.length > 0,
      '「会加载 Supabase 门面的导出符号」算出来是空的 —— 算法坏了，' +
        '这条守卫会变成永远绿（比没有守卫更坏）。'
    );
    assert.ok(
      all.includes('loadSupabaseFacade'),
      '根源加载器 `loadSupabaseFacade` 必须在危险集里'
    );
  });

  it('危险集推得够远（不只是那个根 —— 否则守卫抓不到真正的调用点）', () => {
    // ⚠️ 这是「算法有没有长出肌肉」的判据。
    // `authSlice.ts` 的 `loadSupabaseAuth` **没有导出**，但它才是真正
    // 加载门面的那一步 —— 只看导出符号的话推不到 `getCurrentUser`，
    // 于是「弹窗不许加载 SDK」这条守卫会变成空壳（改回去了也不红）。
    const danger = facadeLoadingSymbols();
    const authSlice = resolve(SRC, 'store/slices/authSlice.ts');
    const symbols = moduleSymbols(authSlice);
    const names = danger.get(authSlice) ?? new Set();

    assert.ok(
      symbols.has('loadSupabaseAuth'),
      '前提没成立：authSlice 里应该有一个未导出的 `loadSupabaseAuth` ' +
        '（它才是真正调用门面的那一步）'
    );
    assert.ok(
      names.has('loadSupabaseAuth'),
      '未导出的局部函数也必须进危险集 —— 只看导出符号 ⇒ 守卫是空壳'
    );
    assert.ok(
      names.has('getCurrentUser'),
      '「核登录态」那个 thunk 必须进危险集 —— 它才是弹窗当初会加载 SDK 的那个调用点'
    );
  });

  it('弹窗的静态 import 闭包里没有门面模块（静态依赖 ⇒ 一定会下载）', () => {
    const closure = popupStaticClosure();
    const facade = resolve(SRC, 'utils/supabaseFacade.ts');
    const offenders: string[] = [];
    for (const rel of closure) {
      const abs = resolve(REPO_ROOT, rel);
      const binds = moduleBindings(abs);
      for (const [, binding] of binds) {
        if (binding.module !== FACADE_MODULE) continue;
        const target = resolveModuleSpec(binding.module, abs);
        if (target === facade) offenders.push(`${rel} → ${binding.module}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      '弹窗的静态 import 图里不许直接 import 门面 —— ' +
        '静态依赖会在**打开弹窗时**就把整条 SDK 拉下来。\n' +
        '取门面统一走 `utils/supabaseRuntime`（页面动态加载 / SW 静态注册）。'
    );
  });

  it('弹窗的挂载路径上不许出现「会加载门面的调用」', () => {
    const danger = facadeLoadingSymbols();
    const closure = popupStaticClosure();
    const offenders: string[] = [];

    for (const rel of closure) {
      const abs = resolve(REPO_ROOT, rel);
      const calls = mountFacadeCalls(abs, danger, (target, imported) =>
        isDangerousImport(target, imported, danger),
      );
      for (const c of calls) {
        offenders.push(`${rel}: ${c.callee} —— ${c.why}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      '弹窗**打开时**就会加载 Supabase SDK：\n' +
        offenders.join('\n') +
        '\n\n用户点开弹窗只想看本机会话列表，这 75KB 跟他要干的事毫无关系，' +
        '却**每次开弹窗都付一次**。\n' +
        '核登录态请交给 service worker（SW 侧 SDK 是静态依赖 ⇒ 零下载）：' +
        '`requestAuthStatus()`（src/utils/authStatusChannel.ts）。'
    );
  });

  it('弹窗必须经由那条通道核登录态（不许自己核）', () => {
    const provider = resolve(SRC, 'components/app/AuthProvider.tsx');
    const binds = moduleBindings(provider);
    const channel = [...binds.entries()].find(
      ([, b]) => b.module === '@/utils/authStatusChannel',
    );
    assert.ok(
      channel,
      '弹窗必须经由 `requestAuthStatus`（src/utils/authStatusChannel.ts）核登录态 —— ' +
        '自己核就意味着要加载 Supabase 门面。'
    );
  });

  it('后台那条通道在位（SW 必须处理 AUTH_STATUS）', () => {
    const sw = resolve(SRC, 'service-worker.ts');
    const text = readFileSync(sw, 'utf8');
    assert.match(
      text,
      /case\s+'AUTH_STATUS'/,
      'service worker 必须处理 AUTH_STATUS（弹窗把「核登录态」交给它）'
    );
    assert.match(
      text,
      /readAuthStatus\(/,
      'service worker 必须真的去核（readAuthStatus），不许只回一个常量'
    );
  });
});

describe('那条通道：失败时必须抛，不许静默当成「没登录」', () => {
  it('SW 给了结果 ⇒ 原样带回来', async () => {
    const { requestAuthStatus } = await import('@/utils/authStatusChannel.ts');
    const status = await requestAuthStatus(async () => ({
      ok: true,
      status: { kind: 'authenticated', user: { id: 'u1', email: 'a@example.com' } },
    }));
    assert.equal(status.kind, 'authenticated');
    assert.equal(status.user?.id, 'u1');
  });

  it('SW 明确报错 ⇒ **抛**（调用方按「不知道」处理，不许当成「没登录」）', async () => {
    const { requestAuthStatus } = await import('@/utils/authStatusChannel.ts');
    await assert.rejects(
      () => requestAuthStatus(async () => ({ ok: false, error: '后台没回包' })),
      /后台没回包/,
      '这条通道断了必须抛 —— 静默返回「没登录」会让用户在一闪之间被说成没登录'
    );
  });

  it('SW 压根没回包 ⇒ **抛**', async () => {
    const { requestAuthStatus } = await import('@/utils/authStatusChannel.ts');
    await assert.rejects(
      () => requestAuthStatus(async () => undefined),
      /后台没有回包/,
      '没有回包必须抛 —— 静默当成「没登录」是一句谎'
    );
  });

  it('SW 回了 ok 但没给判定结果 ⇒ **抛**', async () => {
    const { requestAuthStatus } = await import('@/utils/authStatusChannel.ts');
    await assert.rejects(() => requestAuthStatus(async () => ({ ok: true })));
  });
});
