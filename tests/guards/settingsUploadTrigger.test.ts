// 守卫：读设置**不许**排上传 —— 只有「设置真的写到了盘上」才排。
//
// ── 缺陷（2026-10-22 审计）──────────────────────────────────────────────
//
// autoSyncMiddleware 的判据是 `action.type.startsWith('settings/')`。
// `loadSettings` 是 createAsyncThunk，它 dispatch 的
// `settings/loadSettings/{pending,fulfilled}` 都以 `settings/` 开头 ⇒
// **每一次读设置**都被当成「设置变了」，排一次上传。
//
// 读设置不是罕见事件，它是常态：管理器页每次打开（MainApp 挂载）、
// 后台每一轮轮询（backgroundSync）、设置页与顶栏菜单挂载，各一次。
//
// 后果链（每一环都验过）：scheduleUpload → SW 的 syncEngine.scheduleUpload
// → **不带 changedGroupIds** ⇒ 没有增量白名单 ⇒ 这一轮是**全量上传**
// → 出站流量（Supabase 按 egress 计费；backgroundSync 自己的注释写着
// 「自动同步每轮都是出站流量，60s 全量轮询是配额见底的主因」）。
//
// ── 这个守卫钉的是什么 ─────────────────────────────────────────────────
//
// 不是「某几个字符串不许出现」那种字面量守卫（那种守卫会在正确改动面前
// 误报 —— 见 memory「守卫钉死字面量的陷阱」）。这里钉**两条不变量**，
// 而判据集合由 settingsSlice.ts **现场解析**出来：
//
//   ① 覆盖全部写类：凡是「真的把设置写到了盘上」的 action，判据必须触发；
//   ② 排除全部读类：凡是没写盘的 action，判据必须不触发。
//
// 「写盘」的判定不看名字，看**实现体里有没有写设置的那一通调用**
// （storage.setSettings —— storage.ts 自己说它是「所有设置写入的唯一漏斗」）。
// 于是：将来加一个**读类** thunk，这里一个字都不用改，守卫也不会误伤它；
//       将来加一个**写类** thunk，守卫会要求判据跟着改（漏了就红）。
//
// ── 三层 ───────────────────────────────────────────────────────────────
//
//   L1 行为层：真 store + 真中间件 + 真 thunk ⇒ 断言「读不排、写才排」。
//       这一层是**变异敏感**的：把中间件改回前缀匹配，它立刻变红。
//   L2 推导层：解析 settingsSlice.ts ⇒ 推出写类/读类 ⇒ 断言判据覆盖它们。
//   L3 自证层：同一个检查器对「前缀匹配」判据必须报错 ⇒ 证明 L2 不是空转。
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isSettingsUploadTrigger, SETTINGS_UPLOAD_TRIGGER_ACTION_TYPES } from '@/core/settingsUploadTrigger';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

// ── 运行时桩（必须在 import storage 之前就位）────────────────────────────
const lsData = new Map<string, string>();
const localStorageStub = {
  get length() { return lsData.size; },
  key: (i: number) => [...lsData.keys()][i] ?? null,
  getItem: (k: string) => (lsData.has(k) ? (lsData.get(k) as string) : null),
  setItem: (k: string, v: string) => { lsData.set(k, String(v)); },
  removeItem: (k: string) => { lsData.delete(k); },
  clear: () => lsData.clear(),
};
(globalThis as Record<string, unknown>).window = { localStorage: localStorageStub };
(globalThis as Record<string, unknown>).localStorage = localStorageStub;

/** 发给 SW 的消息（用来断言「到底排了几次上传」）。 */
const sent: Array<Record<string, unknown>> = [];
(globalThis as Record<string, unknown>).chrome = {
  runtime: {
    id: 'test-extension-id',
    sendMessage: async (msg: unknown) => {
      sent.push(msg as Record<string, unknown>);
      return { ok: true };
    },
    getURL: (p: string) => `chrome-extension://test-extension-id/${p}`,
  },
  storage: {
    local: {
      get: async () => ({}),
      set: async () => undefined,
      remove: async () => undefined,
    },
    onChanged: { addListener: () => undefined, removeListener: () => undefined },
  },
};

async function buildStore() {
  const { configureStore } = await import('@reduxjs/toolkit');
  const slice = await import('@/store/slices/settingsSlice');
  const { autoSyncMiddleware } = await import('@/store/middleware/autoSyncMiddleware');
  return configureStore({
    reducer: { settings: slice.default },
    middleware: gdm => gdm().concat(autoSyncMiddleware),
  });
}

let store: Awaited<ReturnType<typeof buildStore>>;
let slice: typeof import('@/store/slices/settingsSlice');

/** 中间件排出去的上传调度（只认 SYNC/scheduleUpload 这一种）。 */
function scheduleUploads(): Array<Record<string, unknown>> {
  return sent.filter(
    m => m.type === 'SYNC' && (m.data as { op?: string } | undefined)?.op === 'scheduleUpload'
  );
}

before(async () => {
  store = await buildStore();
  slice = await import('@/store/slices/settingsSlice');
  // 先读一次：让 slice 的 settingsReadState 变成 'ok'（saveSettings 的 fail-closed
  // 门禁要求「读到过真值」才允许写）。这一次的读本身也不该排上传 —— L1 会单独验。
  await store.dispatch(slice.loadSettings());
  sent.length = 0;
});

// ══════════════════════════════════════════════════════════════════════════
// L1 行为层：真 store + 真中间件 + 真 thunk
// ══════════════════════════════════════════════════════════════════════════
describe('L1 读设置不排上传，写盘成功才排', () => {
  it('dispatch(loadSettings()) 一个上传都不排', async () => {
    sent.length = 0;
    await store.dispatch(slice.loadSettings());
    assert.equal(
      scheduleUploads().length,
      0,
      '读设置被当成了「设置变了」⇒ 排了一次上传。读设置在管理器页每次打开、' +
        '后台每轮轮询都会发生，每一次都是一次没有增量白名单的全量上传（出站流量）。'
    );
  });

  it('dispatch(saveSettings()) 成功后排且只排一次', async () => {
    sent.length = 0;
    await store.dispatch(slice.saveSettings());
    const uploads = scheduleUploads();
    assert.equal(
      uploads.length,
      1,
      `写盘成功必须排一次上传（实际 ${uploads.length} 次）`
    );
    assert.equal(
      (uploads[0].data as { delayMs?: number }).delayMs,
      3000,
      '上传调度仍然是 3 秒去抖（去抖时长是既有契约，不在本守卫范围内）'
    );
  });

  it('reducer 单独 dispatch 不排上传（reducer 只改内存里的 state，不落盘）', async () => {
    sent.length = 0;
    store.dispatch(slice.setThemeMode('dark'));
    store.dispatch(slice.setSessionSort('name'));
    store.dispatch(slice.updateSettings({ showTabCount: true }));
    assert.equal(
      scheduleUploads().length,
      0,
      'reducer 不写盘 ⇒ 不是「设置真的变了」⇒ 不该排上传。' +
        'UI 上每个 reducer 后面都跟着一次 dispatchSaveSettings，那一次才是写盘点。'
    );
  });

  it('写盘失败（rejected）不排上传', async () => {
    sent.length = 0;
    // rejected 的真实形状（RTK 会带 error）——这里手工派发同形状的 action。
    store.dispatch({
      type: 'settings/saveSettings/rejected',
      payload: undefined,
      error: { message: '模拟写盘失败' },
    });
    assert.equal(
      scheduleUploads().length,
      0,
      '写盘失败 ⇒ 设置根本没变 ⇒ 不该排上传'
    );
  });

  it('写盘在途（pending）不排上传（此刻盘上还是旧值）', async () => {
    sent.length = 0;
    store.dispatch({ type: 'settings/saveSettings/pending' });
    assert.equal(
      scheduleUploads().length,
      0,
      'pending 时写盘还没发生 ⇒ 排上传等于上传一份还没落盘的设置'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// L2 推导层：从 settingsSlice.ts 现场解析出「写类 / 读类」，再断言判据
// ══════════════════════════════════════════════════════════════════════════

interface DerivedAction {
  /** action 的确切 type */
  type: string;
  /** 判据对它应当返回 true 吗 */
  shouldTrigger: boolean;
  /** 为什么（失败时的报错文案） */
  why: string;
}

/** 去掉注释但**保留字符串字面量**（类型前缀要从字符串里取），并用等长空格顶替 ⇒ 下标不变。 */
function stripComments(src: string): string {
  const blank = (m: string) => ' '.repeat(m.length);
  return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

/** 从 idx 往后找下一个「顶格声明」的下标（列 0 的 const/let/function/export）。 */
function endOfTopLevelDeclaration(src: string, idx: number): number {
  const rest = src.slice(idx);
  const m = /^(?:export\s+)?(?:const|let|var|function|async function|class)\b/m.exec(rest);
  return m ? idx + m.index : src.length;
}

/** 取 `marker` 起始的那个大括号块（按花括号配平）。 */
function extractBlock(src: string, marker: string): string {
  const at = src.indexOf(marker);
  if (at < 0) return '';
  let depth = 0;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return '';
}

/**
 * 推导 slice 里所有与设置相关的 action 及其应有结论。
 *
 * 「写盘」只看实现体里有没有写设置的那一通调用（storage.setSettings ——
 * storage.ts 自称「所有设置写入的唯一漏斗」），**不看名字**：
 * 于是「load」「refresh」这类读类 thunk 无论叫什么都不会被误判成写类。
 */
function deriveActions(src: string): DerivedAction[] {
  const out: DerivedAction[] = [];

  // ── thunk ────────────────────────────────────────────────────────────
  const thunkRe = /createAsyncThunk\b/g;
  let m: RegExpExecArray | null;
  while ((m = thunkRe.exec(src)) !== null) {
    const start = m.index;
    const q1 = src.indexOf("'", start);
    const q2 = q1 < 0 ? -1 : src.indexOf("'", q1 + 1);
    if (q1 < 0 || q2 < 0) continue;
    const base = src.slice(q1 + 1, q2);
    const body = src.slice(start, endOfTopLevelDeclaration(src, start));
    const writes = /\.setSettings\s*\(/.test(body);
    const reads = /\.getSettings\s*\(/.test(body);
    const kind = writes ? '写盘' : reads ? '只读' : '与设置读写无关';
    out.push({
      type: `${base}/fulfilled`,
      shouldTrigger: writes,
      why: `${kind}的 thunk —— fulfilled ${writes ? '才是写盘成功的信号' : '不代表设置变了'}`,
    });
    out.push({
      type: `${base}/pending`,
      shouldTrigger: false,
      why: 'pending 时写盘还没发生（此刻排上传 = 上传一份还没落盘的设置）',
    });
    out.push({
      type: `${base}/rejected`,
      shouldTrigger: false,
      why: 'rejected = 写盘失败 ⇒ 设置根本没变',
    });
  }

  // ── reducer ──────────────────────────────────────────────────────────
  const exported = /export const \{([\s\S]*?)\}\s*=\s*settingsSlice\.actions;?/.exec(src);
  if (exported) {
    const names = [...exported[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*,/gm)].map(x => x[1]);
    const block = extractBlock(src, 'reducers: {');
    const defRe = new RegExp(`\\n\\s+(${names.join('|')})\\s*:`, 'g');
    const defs = [...block.matchAll(defRe)].map(x => ({
      name: x[1],
      at: x.index ?? 0,
    }));
    defs.sort((a, b) => a.at - b.at);
    defs.forEach((d, i) => {
      const end = i + 1 < defs.length ? defs[i + 1].at : block.length;
      const body = block.slice(d.at, end);
      const writes = /\.setSettings\s*\(/.test(body);
      out.push({
        type: `settings/${d.name}`,
        shouldTrigger: writes,
        why: writes
          ? '这个 reducer 自己写盘 ⇒ 它就是写盘点'
          : 'reducer 只改 Redux state（slice 自己的注释：「只改 Redux state，落盘走 dispatchSaveSettings」）',
      });
    });
  }

  return out;
}

/** 判据与推导结论的差异（空 = 一致）。 */
function violationsFor(
  criterion: (t: unknown) => boolean,
  expected: DerivedAction[]
): string[] {
  const out: string[] = [];
  for (const e of expected) {
    const actual = criterion(e.type);
    if (actual !== e.shouldTrigger) {
      out.push(
        `${e.type}：期望${e.shouldTrigger ? '触发' : '不触发'}，实际${actual ? '触发' : '不触发'}` +
          `（${e.why}）`
      );
    }
  }
  return out;
}

const SLICE_SRC = stripComments(read('src/store/slices/settingsSlice.ts'));

describe('L2 判据必须覆盖全部写类、排除全部读类（集合由 settingsSlice.ts 现场推导）', () => {
  const expected = deriveActions(SLICE_SRC);

  it('推导器确实推导出了东西（防空转：解析器坏了就会「零违规」地通过）', () => {
    assert.ok(
      expected.length >= 20,
      `推导出的 action 太少（${expected.length} 个）—— 解析器多半没匹配上`
    );
    assert.ok(
      expected.some(e => e.type === 'settings/loadSettings/fulfilled'),
      '没推导出 loadSettings 的 lifecycle action —— 解析器没认出 thunk'
    );
    assert.ok(
      expected.some(e => e.type === 'settings/setThemeMode'),
      '没推导出 reducer —— 解析器没认出 export const { ... } = settingsSlice.actions'
    );
  });

  it('判据与推导结论完全一致', () => {
    const violations = violationsFor(isSettingsUploadTrigger, expected);
    assert.deepEqual(
      violations,
      [],
      `判据与「设置Slice 实际会发出哪些 action」不一致：\n${violations.join('\n')}`
    );
  });

  it('判据里的每一条都必须是 slice 真的会发出的写盘点（不许有打错字的白名单条目）', () => {
    const writers = new Set(expected.filter(e => e.shouldTrigger).map(e => e.type));
    assert.ok(writers.size >= 1, '推导器没推出任何写盘点 —— 解析器多半坏了');
    for (const t of SETTINGS_UPLOAD_TRIGGER_ACTION_TYPES) {
      assert.ok(
        writers.has(t),
        `白名单里的 ${t} 不是 slice 会发出的写盘点 —— 写错字了（白名单里死条目 ` +
          '不会报错，只会让真正的写盘点漏排）'
      );
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// L3 自证层：同一个检查器对「前缀匹配」判据必须报错 ⇒ 证明 L2 不是空转
// ══════════════════════════════════════════════════════════════════════════
describe('L3 守卫自带自证', () => {
  it('把判据退化成前缀匹配，L2 的检查器必须报错（否则这个守卫没有检测力）', () => {
    const prefixCriterion = (t: unknown) =>
      typeof t === 'string' && t.startsWith('settings/');
    const violations = violationsFor(prefixCriterion, deriveActions(SLICE_SRC));
    assert.ok(
      violations.length > 0,
      '前缀匹配竟然通过了检查 ⇒ 推导器或检查器坏了（守卫会变成永远绿）'
    );
    assert.ok(
      violations.some(v => v.includes('loadSettings')),
      `前缀匹配理应在读类动作上被抓到，实际抓到的是：${violations.join(' | ')}`
    );
  });

  it('中间件本身不再用前缀匹配（接线层：判据只能来自纯函数模块）', () => {
    const middlewareSrc = stripComments(
      read('src/store/middleware/autoSyncMiddleware.ts')
    );
    assert.ok(
      !/startsWith\(\s*['"]settings\//.test(middlewareSrc),
      '中间件里又出现了 settings/ 前缀匹配 —— 那是这次缺陷的原始形态'
    );
    assert.match(
      middlewareSrc,
      /isSettingsUploadTrigger\(/,
      '中间件必须走纯函数判据（core/settingsUploadTrigger.ts），判据才有单测与守卫'
    );
  });
});
