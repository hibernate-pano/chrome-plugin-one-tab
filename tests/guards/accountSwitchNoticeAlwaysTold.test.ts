/**
 * 换账号提示必须**一定**有人告诉用户（2026-10-23 审计 R-4）。
 *
 * ── 这条缺陷是什么 ──────────────────────────────────────────────────────
 * 「本机还剩 N 个会话属于上一个账号」这条提示是**持久**的：它存在归属记录里
 * （utils/authCache.ts 的独立键 `local_account_scope`），而不是某个内存变量
 * ⇒ 用户在登录后立刻关掉弹窗，它也不会丢。
 *
 * 但「持久」不等于「有人告诉」：它原先**只有**一个消费者 ——
 * `restoreAfterLogin` 的 finally 里那个 **400ms 的 setTimeout**。
 * ⇒ 用户在登录后 400ms 内关掉弹窗 ⇒ setTimeout 随页面一起消失 ⇒
 *   提示**永远没人告知**（它还在那儿，但没人去取）⇒ 违反「不许静默」。
 *
 * ── 这道守卫盯什么 ─────────────────────────────────────────────────────
 * ① **必须有一个「不等计时器」的消费者**：全仓里调用
 *    `deliverAccountSwitchNotice`（或 `consumeAccountSwitchNotice`）的地方，
 *    至少有一处**不在 setTimeout 回调里** —— 也就是说，提示的发出不依赖
 *    「页面还活着再等 400ms」。
 * ② **消费即清空 ⇒ 只发一次**：重复消费同一条提示，第二次拿不到
 *    （否则会出现两条一样的提示）。
 * ③ **提示是持久的**：清掉提示只清 `pendingNotice` 这一个字段，
 *    **不动**归属记录里的 `ownerUserId` / `foreignOwners`
 *    （归属事实必须活过提示 —— 提示说完了，归属还得继续用）。
 *
 * ── 判据为什么不钉字面量 ───────────────────────────────────────────────
 * 判据钉的是**结构事实**（「有一个消费者不在 setTimeout 里」「消费一次就
 * 没了」「清提示不动归属」），不是「某个文件里出现过某个串」。
 * ⇒ 等价改写（把 setTimeout 换成 requestIdleCallback、把消费点搬进别的
 *   组件、把提示文本换掉）**照样绿**；真把「非计时器消费者」删掉**一定红**。
 *
 * ── 自证检测力 ────────────────────────────────────────────────────────
 * A. 把那个「非计时器消费者」删掉（源码层面）⇒ 判据必须报「没有非计时器消费者」；
 * B. 消费即清空被改成「只读不清」⇒ 行为用例必须红（提示会发两次）。
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '../_alias-loader.mjs')
).href;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = join(ROOT, 'src');

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

/** 消费入口的名字（提示的发出/取用都从这里走）。 */
const CONSUMERS = ['deliverAccountSwitchNotice', 'consumeAccountSwitchNotice'];

interface CallSite {
  file: string;
  /** 这个调用点是不是在 setTimeout（或 setInterval）回调里。 */
  insideTimer: boolean;
}

/**
 * 找出全仓里所有「消费提示」的调用点，并标出哪些**依赖计时器**。
 *
 * ⚠️ 判据是「**至少有一个调用点不在计时器回调里**」，不是「某个文件里
 * 出现过某个函数名」—— 后者正是本条缺陷当初漏网的形状。
 *
 * ⚠️ 消费入口**自己的实现**（deliver 内部调 consume）不算「消费者」：
 * 它是同一条链路上的下游，不是第二条通道。
 *
 * @param overrides 覆盖某些文件的源码（自证检测力用：喂改过的源码）。
 */
function findNoticeConsumers(overrides?: Map<string, string>): CallSite[] {
  const sites: CallSite[] = [];
  for (const file of listSourceFiles(SRC)) {
    const rel = file.replace(ROOT + '/', '');
    const source = overrides?.get(rel) ?? readFileSync(file, 'utf-8');
    if (!CONSUMERS.some(name => source.includes(name))) continue;
    const src = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      /\.(tsx?)$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const visit = (
      n: ts.Node,
      insideTimer: boolean,
      insideConsumerImpl: boolean
    ): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        CONSUMERS.includes(n.expression.text)
      ) {
        // 定义本身不算调用点；消费入口的实现内部也不算（那是同一条链路）。
        const isDefinition =
          ts.isFunctionDeclaration(n.parent) ||
          (ts.isVariableDeclaration(n.parent) &&
            ts.isIdentifier(n.parent.name) &&
            n.parent.name.text === n.expression.text);
        if (!isDefinition && !insideConsumerImpl) {
          sites.push({ file: rel, insideTimer });
        }
      }
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        (n.expression.text === 'setTimeout' || n.expression.text === 'setInterval')
      ) {
        for (const arg of n.arguments) {
          if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
            visit(arg, true, insideConsumerImpl);
          }
        }
        return; // 计时器回调内部单独走一遍（insideTimer=true）
      }
      // 消费入口的函数体内部：不算独立消费者。
      const isConsumerImpl =
        (ts.isFunctionDeclaration(n) && CONSUMERS.includes(n.name?.text ?? '')) ||
        (ts.isVariableDeclaration(n) &&
          ts.isIdentifier(n.name) &&
          CONSUMERS.includes(n.name.text) &&
          n.initializer !== undefined);
      n.forEachChild(child => visit(child, insideTimer, insideConsumerImpl || isConsumerImpl));
    };
    visit(src, false, false);
  }
  return sites;
}

/** 从源码里删掉「非计时器消费者」的调用点（自证检测力用）。 */
function removeNonTimerConsumers(source: string): string {
  // 只认**不在** setTimeout 里的调用点。
  const src = ts.createSourceFile('analyze.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const removals: Array<{ start: number; end: number }> = [];
  const visit = (n: ts.Node, insideTimer: boolean): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      CONSUMERS.includes(n.expression.text) &&
      !insideTimer
    ) {
      const isDefinition =
        ts.isFunctionDeclaration(n.parent) ||
        (ts.isVariableDeclaration(n.parent) &&
          ts.isIdentifier(n.parent.name) &&
          n.parent.name.text === n.expression.text);
      if (!isDefinition) {
        removals.push({ start: n.getStart(), end: n.getEnd() });
      }
    }
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      (n.expression.text === 'setTimeout' || n.expression.text === 'setInterval')
    ) {
      for (const arg of n.arguments) {
        if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) visit(arg, true);
      }
      return;
    }
    n.forEachChild(child => visit(child, insideTimer));
  };
  visit(src, false);
  let out = source;
  for (const r of removals.reverse()) {
    out = out.slice(0, r.start) + 'undefined /* 消费者被摘掉 */' + out.slice(r.end);
  }
  return out;
}

describe('R-4：换账号提示必须有人告诉用户（不许靠计时器）', () => {
  it('必须有一个**不等计时器**的消费者（提示不依赖「页面还活着再等 400ms」）', () => {
    const sites = findNoticeConsumers();
    assert.ok(
      sites.length > 0,
      '全仓必须有地方消费「待告知的换账号提示」—— 没有消费者 ⇒ 提示永远没人告诉'
    );
    const nonTimer = sites.filter(s => !s.insideTimer);
    assert.ok(
      nonTimer.length > 0,
      '换账号提示必须有一个**不等计时器**的消费者' +
        `（当前消费者：${sites.map(s => `${s.file}${s.insideTimer ? '（计时器里）' : ''}`).join('、')}）` +
        '—— 只有一个 setTimeout 消费者的话，用户在它触发前关掉弹窗就永远没人被告知（违反「不许静默」）'
    );
  });

  it('自证检测力：把「非计时器消费者」删掉，判据必须看得见', () => {
    const provider = join(SRC, 'components/app/AuthProvider.tsx');
    const rel = provider.replace(ROOT + '/', '');
    const source = readFileSync(provider, 'utf-8');
    const withoutConsumer = removeNonTimerConsumers(source);
    assert.notEqual(withoutConsumer, source, '前提没成立：源码里找不到可摘掉的消费者');

    // 摘掉之后，全仓剩下的消费者应当**全部**在计时器里。
    const sites = findNoticeConsumers(new Map([[rel, withoutConsumer]]));
    const nonTimer = sites.filter(s => !s.insideTimer);
    assert.equal(
      nonTimer.length,
      0,
      '判据失效：非计时器消费者被摘掉后仍应识别出「没有非计时器消费者」' +
        `（当前非计时器消费者：${nonTimer.map(s => s.file).join('、')}）`
    );
  });
});

describe('R-4：消费即清空（只发一次）+ 归属事实活过提示', () => {
  before(() => {
    register(LOADER_PATH);
  });

  beforeEach(() => {
    // chrome.storage.local 桩
    const data = new Map<string, unknown>();
    (globalThis as Record<string, unknown>).chrome = {
      storage: {
        local: {
          get: async (k: string | string[]) => {
            const keys = Array.isArray(k) ? k : [k];
            const out: Record<string, unknown> = {};
            for (const key of keys) if (data.has(key)) out[key] = data.get(key);
            return out;
          },
          set: async (obj: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(obj)) data.set(k, v);
          },
          remove: async (k: string) => void data.delete(k),
        },
        onChanged: { addListener: () => undefined, removeListener: () => undefined },
      },
      runtime: { getManifest: () => ({ version: 'test' }) },
    };
  });

  it('同一条提示只会被消费一次（第二次拿不到 ⇒ 不会发两条一样的提示）', async () => {
    const { accountScopeStore } = await import('@/utils/authCache');
    const { consumeAccountSwitchNotice } = await import('@/components/auth/restoreAfterLogin');

    await accountScopeStore.write({
      ownerUserId: 'user-b',
      foreignOwners: { 'g-a': 'user-a' },
      pendingNotice: { text: '本机还有 1 个会话属于上一个账号', previousUserId: 'user-a', residualCount: 1, at: Date.now() },
    });

    const first = await consumeAccountSwitchNotice();
    assert.notEqual(first, null, '前提：第一次必须消费得到提示');
    assert.equal(first?.text, '本机还有 1 个会话属于上一个账号');

    const second = await consumeAccountSwitchNotice();
    assert.equal(
      second,
      null,
      '同一条提示只会被消费一次（消费即清空）—— 否则会发两条一样的提示'
    );
  });

  it('清掉提示**不动**归属事实（ownerUserId / foreignOwners 必须留着）', async () => {
    const { accountScopeStore } = await import('@/utils/authCache');
    const { consumeAccountSwitchNotice } = await import('@/components/auth/restoreAfterLogin');

    await accountScopeStore.write({
      ownerUserId: 'user-b',
      foreignOwners: { 'g-a': 'user-a' },
      pendingNotice: { text: '本机还有 1 个会话属于上一个账号', previousUserId: 'user-a', residualCount: 1, at: Date.now() },
    });

    await consumeAccountSwitchNotice();

    const record = await accountScopeStore.read();
    assert.equal(record?.ownerUserId, 'user-b', '归属账号不许被提示消费带走');
    assert.deepEqual(
      record?.foreignOwners,
      { 'g-a': 'user-a' },
      '归属事实不许被提示消费带走 —— 提示说完了，账号闸门还得继续用'
    );
    assert.equal(record?.pendingNotice, null, '提示本身必须被清掉（只发一次）');
  });
});
