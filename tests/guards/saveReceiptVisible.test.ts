// 「保存成功 ⇒ 必须有一个**对用户可见**、且**不依赖任何开关**的回执」
// （2026-10-23，主审实测确认的 P0）。
//
// ── 这条守卫守的是什么（行为性质，不是字面量）────────────────────────────
//
// 缺陷本体（主审在真机核实过的代码事实链）：
//
//   1. `TabManager.saveAllTabs` 成功后调 `showNotification({...})`，**没有传 kind**
//      ⇒ 按 showNotification 的分流规则（`kind !== 'error'` ⇒ 受控）视为 success
//      ⇒ **受「显示通知提醒」开关约束**；
//   2. 默认设置 `showNotifications: false`（src/utils/storage.ts）
//      ⇒ **默认配置下，这条通知根本不发**；
//   3. 快捷键路径**明确不打开管理页**（service-worker.ts 的注释写死了这一点）
//      ⇒ 管理页那个「已保存 N」的内联反馈（Header.tsx）**这条路上没有**。
//
// ⇒ 用户按 ⌘⇧S 保存整窗 → **标签被关掉、窗口被腾空**（破坏性动作）
//   → **屏幕上零反馈**。而「我刚才那 20 个标签存到哪了？叫什么名字？」
//   正是他此刻的问题。
//
// 判据钉的是**性质**，不是字面量：
//   「保存成功 ⇒ 存在某个对用户可见的状态变化，且它**不依赖** showNotifications」
//
// 刻意**不**钉的东西（它们会把守卫变成对实现的猜测）：
//   · 徽标文本等于 '12'（那是实现细节，且截断规则可以变）；
//   · 徽标一定是 chrome.action（以后换成别的通道也该通过）；
//   · 徽标显示几秒（时长可以调）。
//
// ── 守卫的两半 ───────────────────────────────────────────────────────────
//
// 【第一半 · 真实行为】真跑 `tabManager.saveAllTabs`，用 chrome.* mock 记录
//   「用户可见的状态变化」，在**默认设置**（showNotifications: false）下断言：
//   · 至少发生了一次**不受通知开关约束**的可见变化；
//   · 且**没有**发生浏览器通知（证明这条回执走的不是通知那条路）。
//
// 【第二半 · 变异自证】把回执**摘掉**（或把回执重新绑回 showNotifications 开关），
//   守卫**必须变红**。这一半是本仓的硬要求：
//   一条没有变异自证的守卫，可能一直是绿的而什么也没守住。
//   （本仓踩过多次：见 memory「守卫钉死字面量的陷阱」）
//
// ⚠️ 为什么第一半必须**真跑**而不是读源码：
//   读源码断言「某个函数被调用了」是**弱**判据 —— 那个函数可以是空的、
//   可以传错参数、可以只在某个分支里跑。而本缺陷的实质是
//   「默认配置下用户屏幕上什么都没有」，只有真跑才知道。
//   （同款纪律见 tests/saveDroppedPinnedDisclosure.test.ts：文案与接线分开断言。）
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

/** 剥掉注释：注释里提到某个函数名不算「代码还这么做」。 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

// ─────────────────────────────────────────────────────────────────────────
// chrome.* mock
// ─────────────────────────────────────────────────────────────────────────

/**
 * 记录「用户可见的状态变化」。
 *
 * 为什么要分两类记，而不是只记通知：
 *   浏览器通知（notifications.create）**受 showNotifications 约束** ——
 *   默认关闭 ⇒ 默认配置下它根本不会发生，记它等于没记；
 *   其它通道（工具栏徽标 / 窗口标题）**不受**那个开关约束 ⇒ 它们才是
 *   「不依赖开关的可见变化」。
 *
 * ⇒ 「至少有一个非通知的可见变化」才是「不依赖开关」这个性质的判据。
 */
interface VisibleStateChange {
  /** 变化发生在哪个通道上。 */
  channel: 'notification' | 'badge';
  /** 该通道上的具体内容（徽标文本 / 通知标题）。 */
  value: string;
}

interface ChromeMock {
  /** 通知调用（受 showNotifications 约束）。 */
  notifications: Array<{ title: string; message: string }>;
  /** 徽标文本的历次赋值（**不受**任何开关约束）。 */
  badgeTexts: string[];
  /** 徽标底色的历次赋值。 */
  badgeColors: string[];
  /** 标题的历次赋值。 */
  titles: string[];
  /** chrome.alarms.create 的调用（name → when）。 */
  alarms: Array<{ name: string; when: number }>;
  /** 当前徽标文本（模拟浏览器的状态）。 */
  currentBadge: string;
}

function installChromeMock(): ChromeMock {
  const handles: ChromeMock = {
    notifications: [],
    badgeTexts: [],
    badgeColors: [],
    titles: [],
    alarms: [],
    currentBadge: '',
  };

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

  // ⚠️ 默认设置：通知**关闭**。这正是让缺陷活下来的那个默认值。
  // 守卫必须在它为 false 的前提下依然通过。
  lsData.set('user_settings', JSON.stringify({ showNotifications: false }));

  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      getManifest: () => ({
        version: 'test',
        action: { default_title: 'TapStack - 打开会话管理器' },
      }),
      getURL: (p: string) => `chrome-extension://test/${p}`,
      sendMessage: () => Promise.resolve(),
    },
    storage: {
      local: {
        async get(keys: string | string[]) {
          const out: Record<string, unknown> = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) out[k] = undefined;
          return out;
        },
        async set() { /* noop */ },
        async remove() { /* noop */ },
      },
    },
    notifications: {
      create(options: { title?: string; message?: string }) {
        handles.notifications.push({
          title: options.title ?? '',
          message: options.message ?? '',
        });
        return Promise.resolve('generated-id');
      },
    },
    action: {
      async setBadgeText(details: { text: string }) {
        handles.badgeTexts.push(details.text);
        handles.currentBadge = details.text;
      },
      async setBadgeBackgroundColor(details: { color: string }) {
        handles.badgeColors.push(details.color);
      },
      async setTitle(details: { title: string }) {
        handles.titles.push(details.title);
      },
      async getBadgeText() { return handles.currentBadge; },
    },
    alarms: {
      create(name: string, info: { when: number }) {
        handles.alarms.push({ name, when: info.when });
      },
      async clear() { return true; },
      onAlarm: { addListener() { /* noop */ } },
    },
    tabs: {
      async query() { return []; },
      async remove() { /* noop */ },
      async create() { /* noop */ },
      async update() { /* noop */ },
    },
  };

  return handles;
}

/** 造一个「看起来正常」的窗口：有 3 个可保存的标签。 */
function makeTabs(count = 3): chrome.tabs.Tab[] {
  const iso = new Date().toISOString();
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    url: `https://example.com/page-${i}`,
    title: `页面 ${i}`,
    pinned: false,
    windowId: 1,
    index: i,
    active: i === 0,
    highlighted: false,
    incognito: false,
    selected: i === 0,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    lastAccessed: Date.parse(iso),
  } as unknown as chrome.tabs.Tab));
}

/**
 * 真跑一次 saveAllTabs，返回「用户可见的状态变化」列表。
 *
 * @param showNotifications 设置里的 showNotifications（默认 false = 默认配置）
 * @param tabs               喂给 saveAllTabs 的标签（默认 3 个可保存的）
 */
/**
 * 取出测试里装的那个 `window.localStorage` 桩。
 *
 * 【为什么单独包一层】`globalThis` 上的 `window` 在 TS 里是 `unknown`
 * （`Record<string, unknown>` ⇒ 取出来是 unknown ⇒ 再点属性就报 TS2571）。
 * 这里给一个**具体的类型**，比在调用处硬转 `as unknown as {...}` 干净，
 * 也不会改动任何运行时行为。
 */
function localStorageStub(): { setItem: (key: string, value: string) => void } {
  return (
    globalThis as unknown as {
      window: { localStorage: { setItem: (key: string, value: string) => void } };
    }
  ).window.localStorage;
}

async function runSaveAndCollectVisibleChanges(
  showNotifications = false,
  tabs = makeTabs(3)
): Promise<{ changes: VisibleStateChange[]; handles: ChromeMock; result: unknown }> {
  const handles = installChromeMock();
  // 覆盖默认设置（本仓默认是 false，这里显式写出来是为了让「开关打开时
  // **也**有回执」这条断言能复用同一个函数）。
  localStorageStub().setItem('user_settings', JSON.stringify({ showNotifications }));

  const { tabManager } = await import('@/background/TabManager');
  const result = await tabManager.saveAllTabs(tabs);
  if (tabs.length > 0) {
    assert.ok(result, '三个可保存的标签应当保存成功（否则测的不是成功路径）');
  }

  const changes: VisibleStateChange[] = [];
  for (const n of handles.notifications) {
    changes.push({ channel: 'notification', value: n.title });
  }
  // 徽标：只记「非空」的赋值 —— 清空（''）不是给用户看的回执。
  for (const t of handles.badgeTexts) {
    if (t !== '') changes.push({ channel: 'badge', value: t });
  }
  return { changes, handles, result };
}

// ─────────────────────────────────────────────────────────────────────────
// 1. 行为：默认配置下必须有一个不依赖开关的可见回执
// ─────────────────────────────────────────────────────────────────────────

describe('保存成功 ⇒ 必须有不依赖「显示通知提醒」开关的可见回执', () => {
  it('默认设置（通知关闭）下保存整窗 ⇒ 有非通知的可见回执', async () => {
    const { changes, handles } = await runSaveAndCollectVisibleChanges(false);

    assert.equal(
      handles.notifications.length,
      0,
      '默认配置下确实不该发浏览器通知（通知默认关是已拍板的产品决定）—— ' +
        '这条断言是为了证明「回执不是偷偷把通知改成无条件发」'
    );

    const nonNotification = changes.filter(c => c.channel !== 'notification');
    assert.ok(
      nonNotification.length > 0,
      '默认设置下保存成功必须产生至少一个**不受通知开关约束**的可见变化' +
        '（工具栏徽标 / 窗口标题 / 其它在场凭据）。' +
        '现状：一次破坏性动作（标签被关掉、窗口被腾空）之后屏幕上零反馈 —— ' +
        '用户问「我刚才那 20 个标签存到哪了？叫什么名字？」无人应答。'
    );
  });

  it('回执必须说出「存了多少」—— 光有变化不够，要能回答用户的问题', async () => {
    const { handles } = await runSaveAndCollectVisibleChanges(false);

    const badgeValues = handles.badgeTexts.filter(t => t !== '');
    assert.ok(badgeValues.length > 0, '应当有一个非空徽标');

    // 不钉字面量「12」—— 钉的是「徽标里能读出个数」。
    // 3 个标签 ⇒ 徽标必须让人看出「3」这个量级。
    assert.ok(
      badgeValues.some(v => v.includes('3')),
      `徽标应当包含保存的个数（3 个标签 ⇒ 徽标里应有 '3'），实际徽标：${JSON.stringify(badgeValues)}`
    );
  });

  it('通知开关**打开**时也必须有回执（不能因为开关关掉就没了，也不能只有通知）', async () => {
    const { changes, handles } = await runSaveAndCollectVisibleChanges(true);

    assert.ok(
      handles.notifications.length > 0,
      '开关打开时成功通知应当照发（这是既有行为，不许被回执改掉）'
    );
    const nonNotification = changes.filter(c => c.channel !== 'notification');
    assert.ok(
      nonNotification.length > 0,
      '开关打开时**也**必须有那个不依赖开关的回执 —— ' +
        '回执不是通知的替代品，是给「通知被系统吞掉 / 用户关掉了通知」兜底的'
    );
  });

  // ── 失败路径：**不得**画成功徽标，且失败通知始终发 ────────────────────
  //
  // 为什么这条必须是**行为**断言而不是读源码比对位置：
  //   「失败早退在前、回执在后」这种源码位置断言守不住「失败时也画了徽标」
  //   这类变异 —— 只要有人在失败分支里也调一次 showSaveReceipt，位置不变，
  //   守卫照样绿，但用户会看到「已保存 3」而实际上一个都没存下（谎报成功）。
  //   ⇒ 这里真跑一次**失败**的保存，直接看 chrome.* 上发生了什么。
  //
  // 失败路径的契约（本仓既有不变式，2026-10-07 修过）：
  //   · 失败走 kind==='error' 的通道 ⇒ **永远发通知**，不受开关约束
  //     （「关掉通知」不该变成「操作失败但用户不知道」）；
  //   · 徽标是**成功**凭据 ⇒ 失败时一个都不许画，更不许覆盖上一次成功的徽标。
  it('失败路径不得画成功徽标，且失败通知必须发出（不受开关约束）', async () => {
    // 一个标签都没有 ⇒ 走「当前窗口里没有可保存的标签页」这条失败早退。
    const { handles, result } = await runSaveAndCollectVisibleChanges(
      false,
      makeTabs(0)
    );

    assert.equal(
      result,
      null,
      '一个标签都没存下 ⇒ 返回 null（调用方据此不得报「已保存」）'
    );

    const painted = handles.badgeTexts.filter(t => t !== '');
    assert.equal(
      painted.length,
      0,
      '失败路径**不得**画成功徽标 —— 没保存成却显示「已保存 N」是谎报成功，' +
        '比没有回执更糟'
    );

    assert.equal(
      handles.notifications.length,
      1,
      '失败通知必须发出（kind 为 error 时永远发，不受「显示通知提醒」约束）—— ' +
        '本条的 showNotifications 是 false'
    );
    assert.match(
      handles.notifications[0].message,
      /没有可保存的标签页/,
      '失败通知要说明失败原因'
    );
  });

  // ── 失败**不得覆盖**上一次成功的徽标 ─────────────────────────────────
  //
  // 「失败路径不能覆盖成功徽标」有两种读法，两种都要守住：
  //   ① 失败时**不许画**新徽标（上面那条守的就是它）；
  //   ② 失败时**不许擦掉**上一次成功留下的徽标 —— 那次保存是真的发生了，
  //      它的回执还是事实。擦掉它等于让用户刚看到的凭据凭空消失，
  //      「刚才到底存没存成」又变成没人能回答的问题。
  // ⇒ 真跑：先成功一次（徽标出现），再失败一次（徽标必须原样还在）。
  it('失败不得覆盖或擦掉上一次成功的徽标', async () => {
    const handles = installChromeMock();
    const { tabManager } = await import('@/background/TabManager');

    const ok = await tabManager.saveAllTabs(makeTabs(3));
    assert.ok(ok, '第一次保存应当成功');
    const afterSuccess = handles.currentBadge;
    assert.notEqual(afterSuccess, '', '第一次保存后应当有徽标');

    await tabManager.saveAllTabs(makeTabs(0));

    assert.equal(
      handles.currentBadge,
      afterSuccess,
      '失败之后徽标必须原样保留 —— 上一次保存确实发生过，它的回执仍是事实；' +
        '擦掉它会让用户「刚才到底存没存成」的问题重新没人能回答'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 接线：回执必须真的挂在「保存成功」这一步
// ─────────────────────────────────────────────────────────────────────────

describe('回执必须挂在「真的保存成功」这一步（不是挂在通知上）', () => {
  it('saveAllTabs 成功后必须调用回执通道', () => {
    const src = stripComments(read('src/background/TabManager.ts'));
    assert.match(
      src,
      /showSaveReceipt\(/,
      'saveAllTabs 的成功路径必须调用回执通道（showSaveReceipt）'
    );
  });

  it('回执通道不得被 showNotifications 开关门禁', () => {
    const src = stripComments(read('src/background/TabManager.ts'));
    // 取出 showSaveReceipt 的函数体
    const at = src.indexOf('async showSaveReceipt');
    assert.ok(at > -1, '应当能找到 showSaveReceipt');
    const body = src.slice(at, src.indexOf('\n  }', at));
    assert.doesNotMatch(
      body,
      /showNotifications/,
      '回执通道里**不得**出现 showNotifications —— ' +
        '回执的存在意义就是「不依赖那个开关」。一旦它读了那个开关，' +
        '默认配置下它就退化成和通知一样的消失。'
    );
  });

  it('「一个标签都没存下」这条失败路径不得显示成功回执', () => {
    const src = stripComments(read('src/background/TabManager.ts'));
    // 失败早退在「保存成功回执」之前 ⇒ 回执调用必须在成功路径里。
    const failAt = src.indexOf('当前窗口里没有可保存的标签页');
    const receiptAt = src.indexOf('this.showSaveReceipt(');
    assert.ok(failAt > -1, '应当能找到失败早退');
    assert.ok(receiptAt > -1, '应当能找到回执调用');
    assert.ok(
      receiptAt > failAt,
      '回执调用必须在失败早退**之后** —— 「一个都没存下」显示「已保存 N」是谎报成功'
    );
  });

  it('「保存当前标签页」这条路径也要有回执（它是同一种缺陷）', () => {
    const src = stripComments(read('src/background/TabManager.ts'));
    // saveCurrentTab 的函数体（到下一个顶层方法为止）
    const start = src.indexOf('async saveCurrentTab(');
    assert.ok(start > -1, '应当能找到 saveCurrentTab');
    const body = src.slice(start, src.indexOf('\n  /**', start));
    assert.match(
      body,
      /this\.showSaveReceipt\(/,
      '「保存当前标签页」也必须有回执 —— 快捷键 Alt+S 那条路上有**完全相同**的缺陷：' +
        '成功通知由调用方发（受默认关闭的开关约束）、且这条路不打开管理页'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. 变异自证：把回执摘掉，守卫必须变红
// ─────────────────────────────────────────────────────────────────────────

/**
 * 变异自证。
 *
 * 做法：把 `src/background/TabManager.ts` 复制到临时目录、施加变异、
 * 用**替换**的方式跑第一半的行为断言，看它是否**变红**。
 *
 * ⚠️ 为什么用「替换源文件再跑」而不是「在内存里 mock 掉」：
 *   本守卫第一半断言的是**真跑 saveAllTabs** 的可见变化。
 *   若只在内存里 mock 掉回执，测的仍是「被改过的源码」，检测力相同；
 *   但「替换文件再跑」更接近真实回归（改坏代码 ⇒ 守卫变红），
 *   且能顺带验证「守卫真的会因为实现被摘掉而失败」。
 *
 * 变异一：**摘掉回执**（把 showSaveReceipt 调用删掉）
 *   ⇒ 期望：第一半的「默认设置下有非通知可见变化」断言变红。
 *
 * 变异二：**把回执重新绑回 showNotifications 开关**
 *   ⇒ 期望：同一条断言变红（默认配置下回执消失）。
 */
describe('变异自证：摘掉回执 / 把回执绑回开关，守卫必须变红', () => {
  let workDir = '';
  let sandboxSrc = '';

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), 'tapstack-receipt-mut-'));
    sandboxSrc = join(workDir, 'src');

    // ⚠️ 为什么把整个 src/ 复制到临时目录，而不是就地改仓库里的文件：
    //   `node --test` **并行**跑各个测试文件。仓库里有别的测试文件
    //   （tests/guards/failureNotificationsAlwaysSend.test.ts 等）会 import
    //   @/background/TabManager —— 若本守卫在变异期间改了**共享的那份**，
    //   那些文件会在半路上加载到变异后的实现 ⇒ 假红（flaky），
    //   而且那个假红与本守卫要证明的事毫无关系。
    //   ⇒ 复制一份沙箱，变异只发生在沙箱里。
    cpSync(resolve(ROOT, 'src'), sandboxSrc, { recursive: true });
    // 沙箱里的别名解析器：tests/_alias-loader.mjs 用「自己所在目录的上一级」
    // 定位 src/ ⇒ 放到 <workDir>/tests/ 就正好指向 <workDir>/src。
    mkdirSync(join(workDir, 'tests'), { recursive: true });
    copyFileSync(
      resolve(ROOT, 'tests/_alias-loader.mjs'),
      join(workDir, 'tests/_alias-loader.mjs')
    );
    copyFileSync(
      resolve(ROOT, 'tests/_register-loader.mjs'),
      join(workDir, 'tests/_register-loader.mjs')
    );
    // 别名解析器要 import 'typescript' ⇒ 让沙箱能解析到 node_modules。
    symlinkSync(resolve(ROOT, 'node_modules'), join(workDir, 'node_modules'), 'dir');
  });

  after(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  /**
   * 跑一次探针（在沙箱里）。
   * @returns 是否通过 + stderr（失败时用于确认「红在目标断言上」）
   */
  function runProbe(): { ok: boolean; stderr: string } {
    const probe = join(workDir, `probe-${Math.random().toString(36).slice(2)}.mjs`);
    writeFileSync(probe, PROBE_SOURCE);
    try {
      execFileSync(process.execPath, [probe], {
        cwd: workDir,
        stdio: 'pipe',
        env: {
          ...process.env,
          NODE_OPTIONS: '--import ./tests/_register-loader.mjs',
        },
      });
      return { ok: true, stderr: '' };
    } catch (error) {
      const e = error as { stderr?: Buffer | string };
      return {
        ok: false,
        stderr: typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString() ?? ''),
      };
    }
  }

  /**
   * 施加变异并在**变异后的源码**上跑探针。
   *
   * ⚠️ 关键纪律（本仓吃过亏）：**子进程失败不等于「守卫变红」** ——
   * 探针自己写错了（import 失败、语法错）也会让子进程非零退出，
   * 那样每条变异都会「红」，守卫的检测力是**零**。
   * （同款教训见 memory「截图/探针要断言目标状态」）
   *
   * ⇒ 所以这里做**三件事**：
   *   ① **对照**：未变异的源码上，探针必须**成功**（否则探针本身是坏的）；
   *   ② 变异后探针必须失败；
   *   ③ 失败原因必须是**目标断言**（stderr 里出现预期的那句），不是别的错。
   *
   * @param mutate 变异函数；传 null 表示跑对照（不变异）
   * @param expectedFailure 探针 stderr 里必须出现的字样（证明是「目标断言」红了）
   */
  function mutationTurnsGuardRed(
    mutate: ((src: string) => string) | null,
    expectedFailure: string
  ): { controlPassed: boolean; mutationFailed: boolean; reasonMatched: boolean; stderr: string } {
    const target = join(sandboxSrc, 'background/TabManager.ts');
    const original = readFileSync(target, 'utf8');

    // ① 对照：未变异 ⇒ 探针必须成功。
    const control = runProbe();

    if (!mutate) {
      return {
        controlPassed: control.ok,
        mutationFailed: false,
        reasonMatched: false,
        stderr: control.stderr,
      };
    }

    const mutated = mutate(original);
    if (mutated === original) {
      throw new Error('变异没有生效（源码没变）—— 变异自证本身就是无效的');
    }

    try {
      // ② 变异 ⇒ 探针必须失败。
      writeFileSync(target, mutated);
      const mutatedRun = runProbe();

      // ③ 失败原因必须是目标断言。
      const reasonMatched = mutatedRun.stderr.includes(expectedFailure);

      return {
        controlPassed: control.ok,
        mutationFailed: !mutatedRun.ok,
        reasonMatched,
        stderr: mutatedRun.stderr,
      };
    } finally {
      writeFileSync(target, original);
    }
  }

  it('对照：未变异的源码上探针必须通过（否则探针本身是坏的，变异自证是假的）', () => {
    const result = mutationTurnsGuardRed(null, '控制组：本不该红');
    assert.ok(
      result.controlPassed,
      '未变异的源码上探针都跑不过 ⇒ 探针本身坏了，' +
        '后面两条「变异 ⇒ 变红」的断言将毫无检测力（它们会恒真）。\n' +
        `探针输出：\n${result.stderr}`
    );
  });

  it('变异一：摘掉回执调用 ⇒ 守卫变红（且红在目标断言上）', () => {
    const result = mutationTurnsGuardRed(
      src => src.replace(/await this\.showSaveReceipt\([^)]*\);/, '/* mutated: 回执被摘掉 */'),
      '默认配置下保存成功必须有非通知的可见回执'
    );
    assert.ok(result.controlPassed, '对照组必须通过（探针本身是好的）');
    assert.ok(
      result.mutationFailed,
      '把回执调用删掉之后守卫仍然全绿 ⇒ 这条守卫是空的（零检测力）。' +
        '守卫必须真的守住「保存成功有可见回执」这个性质。'
    );
    assert.ok(
      result.reasonMatched,
      '变异后探针确实失败了，但失败原因不是目标断言 ⇒ 那是别的错（探针坏了）。\n' +
        `探针输出：\n${result.stderr}`
    );
  });

  it('变异二：把回执绑回 showNotifications 开关 ⇒ 守卫变红（且红在目标断言上）', () => {
    const result = mutationTurnsGuardRed(
      src =>
        src.replace(
          /async showSaveReceipt\([^)]*\): Promise<void> \{/,
          'async showSaveReceipt(savedCount: number): Promise<void> {\n' +
            '      const s = await storage.getSettings();\n' +
            '      if (s.showNotifications !== true) return;'
        ),
      '默认配置下保存成功必须有非通知的可见回执'
    );
    assert.ok(result.controlPassed, '对照组必须通过（探针本身是好的）');
    assert.ok(
      result.mutationFailed,
      '把回执重新绑回 showNotifications 之后守卫仍然全绿 ⇒ ' +
        '这条守卫是空的。回执必须**不依赖**那个开关 —— ' +
        '「默认关通知」是已拍板的产品决定，而回执是给「用户关掉了通知」兜底的。'
    );
    assert.ok(
      result.reasonMatched,
      '变异后探针确实失败了，但失败原因不是目标断言 ⇒ 那是别的错（探针坏了）。\n' +
        `探针输出：\n${result.stderr}`
    );
  });

  it('变异三：在失败早退里也画徽标 ⇒ 守卫变红（谎报成功必须被抓）', () => {
    const result = mutationTurnsGuardRed(
      src =>
        src.replace(
          /if \(safeGroup\.tabs\.length === 0\) \{/,
          "if (safeGroup.tabs.length === 0) {\n" +
            "        await this.showSaveReceipt(3, '谎报的会话名');"
        ),
      '失败路径不得画成功徽标'
    );
    assert.ok(result.controlPassed, '对照组必须通过（探针本身是好的）');
    assert.ok(
      result.mutationFailed,
      '在失败早退里也画徽标之后守卫仍然全绿 ⇒ 「谎报成功」没人抓。' +
        '一个标签都没存下却显示「已保存 3」，比没有回执更糟。'
    );
    assert.ok(
      result.reasonMatched,
      '变异后探针确实失败了，但失败原因不是目标断言 ⇒ 那是别的错（探针坏了）。\n' +
        `探针输出：\n${result.stderr}`
    );
  });
});

/**
 * 变异自证用的子进程探针。
 *
 * 它跑的就是第一半那条核心断言（默认设置下必须有非通知的可见变化），
 * 但在**独立进程**里跑 ⇒ 每次都是干净的模块实例（storage 的模块级缓存、
 * mutationQueue 的模块级状态都不会互相污染）。
 */
const PROBE_SOURCE = `
import assert from 'node:assert/strict';

const lsData = new Map();
const localStorageStub = {
  get length() { return lsData.size; },
  key: (i) => [...lsData.keys()][i] ?? null,
  getItem: (k) => (lsData.has(k) ? lsData.get(k) : null),
  setItem: (k, v) => { lsData.set(k, String(v)); },
  removeItem: (k) => { lsData.delete(k); },
  clear: () => lsData.clear(),
};
globalThis.window = { localStorage: localStorageStub };
globalThis.localStorage = localStorageStub;
lsData.set('user_settings', JSON.stringify({ showNotifications: false }));

const badgeTexts = [];
let notificationCount = 0;
globalThis.chrome = {
  runtime: {
    getManifest: () => ({ version: 'test', action: { default_title: 'TapStack' } }),
    getURL: (p) => 'chrome-extension://test/' + p,
    sendMessage: () => Promise.resolve(),
  },
  storage: {
    local: {
      async get() { return {}; },
      async set() {},
      async remove() {},
    },
  },
  notifications: {
    create() { notificationCount++; return Promise.resolve('id'); },
  },
  action: {
    async setBadgeText(d) { badgeTexts.push(d.text); },
    async setBadgeBackgroundColor() {},
    async setTitle() {},
    async getBadgeText() { return badgeTexts[badgeTexts.length - 1] ?? ''; },
  },
  alarms: {
    create() {},
    async clear() { return true; },
    onAlarm: { addListener() {} },
  },
  tabs: {
    async query() { return []; },
    async remove() {},
    async create() {},
    async update() {},
  },
};

const { tabManager } = await import('@/background/TabManager');
const iso = new Date().toISOString();
const tabs = [1, 2, 3].map(i => ({
  id: i, url: 'https://example.com/p' + i, title: 'P' + i, pinned: false,
  windowId: 1, index: i - 1, active: i === 1, highlighted: false, incognito: false,
  selected: i === 1, discarded: false, autoDiscardable: true, groupId: -1,
  lastAccessed: Date.parse(iso),
}));

const saved = await tabManager.saveAllTabs(tabs);
assert.ok(saved, '保存应当成功');
assert.equal(notificationCount, 0, '默认配置下不该发通知');
const visible = badgeTexts.filter(t => t !== '');
assert.ok(visible.length > 0, '默认配置下保存成功必须有非通知的可见回执');
assert.ok(visible.some(v => v.includes('3')), '回执必须能读出存了多少个');

// ── 失败路径 ──────────────────────────────────────────────────────
// 探针也要覆盖失败路径：否则「失败时也画徽标」这类变异不会被探针看见，
// 而那正是「谎报成功」—— 用户看到「已保存 3」，实际一个都没存下。
const badgeCountBeforeFailure = badgeTexts.length;
const failed = await tabManager.saveAllTabs([]);
assert.equal(failed, null, '一个标签都没存下 ⇒ 返回 null');
assert.equal(
  badgeTexts.length,
  badgeCountBeforeFailure,
  '失败路径不得画成功徽标'
);
assert.equal(notificationCount, 1, '失败通知必须发出（不受开关约束）');
console.log('PROBE_OK');
`;
