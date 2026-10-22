/**
 * 空态的次级出口：**点了会发生什么**，必须是一条可断言的事实（2026-10-23 审计 R-12）。
 *
 * ── 缺陷本体 ──────────────────────────────────────────────────────────────
 * 第 42 轮给空态加了四个次级出口（登录 / 从云端恢复 / 打开设置 / 导入数据），
 * 方向是对的（空态是「你的会话在别处」这件事唯一的澄清窗口），
 * 但**一个断言都没有**：
 *
 *   · `onOpenAuth?.('login')` —— 宿主没传这个回调时，可选调用让它变成
 *     **什么都不做**：用户点「登录 TapStack 云端」，界面零变化、零提示，
 *     他只会以为按钮坏了；
 *   · `requestImport()` 没有订阅者时返回 false —— 那一格**会**出声（已有兜底），
 *     但没有任何测试钉住「它必须出声」。
 *
 * ⇒ 「四个按钮点了会发生什么」这件事，全靠人读源码。
 *
 * ── 这条守卫钉的是**不变量**，不是四个按钮的文案 ──────────────────────────
 *
 *   **每个出口，要么触发一个可观察的状态变化，
 *     要么明确地什么都不做、并且出声说明它此刻用不了。**
 *
 * 没有第三条路。这条不变量收敛在 `core/emptyStateExits.ts`（纯函数）里，
 * 于是「点了会发生什么」从「只能读源码」变成「喂一组假 deps，看它调了谁」。
 *
 * ── 三层，缺一层都不够 ───────────────────────────────────────────────────
 *
 * ① **判据层**（纯函数）：出口集合（后端 × 登录态）与执行语义。
 * ② **渲染层**：真的把空态渲染一遍，看**已登录**的用户看到的是哪几个出口
 *    （审计点名的形状：「已登录用户看到登录按钮」）。
 * ③ **接线层**：组件把每个出口接到了哪个 IO 上 —— 数据流判据，
 *    追到**终端 API**（平台 API / 模块导出 / 组件 prop / React 状态 setter），
 *    不钉局部变量名（改个名不该让守卫变红）。
 *
 * ── 为什么接线层只能追数据流、不能「点一下」 ────────────────────────────
 * 本仓没有 DOM 环境（无 jsdom / happy-dom / @testing-library），
 * `react-dom/server` 渲染不出可点的按钮 ⇒ 点击链**跑不了**。
 * 于是这一层退一步用数据流：追到终端 API 就收手
 * （平台 API 与模块导出是**接口**，不是实现细节）。
 *
 * ── 还有第四层：冷启动那一两秒 ────────────────────────────────────────────
 * 上面三层钉的是「**给定登录态**时，界面给对出口」。
 * 但登录态本身在冷启动时是**慢慢补上**的 ⇒ 补之前的那一帧，
 * 已登录的老用户会看到「登录 TapStack 云端」（审计点名的形状）。
 * 这一层钉的是「缓存里的登录态必须**立刻**进 store」
 * （`AuthProvider` 的数据流判据）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { renderTabList } from '../_helpers/tabListHarness.ts';
import { runEmptyStateExit } from '@/core/emptyStateExits';
import type { EmptyStateAction } from '@/core/emptyStateExits';
import {
  EMPTY_STATE_ACTION_HINT,
  EMPTY_STATE_ACTION_LABEL,
  EMPTY_STATE_EXIT_UNAVAILABLE,
  resolveEmptyStateActions,
} from '@/components/tabs/emptyStateActions';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const ALL_ACTIONS: EmptyStateAction[] = ['login', 'download', 'options', 'import'];

// ─────────────────────────────────────────────────────────────────────────
// ① 判据层：出口集合
// ─────────────────────────────────────────────────────────────────────────

describe('判据层：出口集合必须与（后端 × 登录态）一致', () => {
  it('自带存储：给「打开设置」，不给「登录」也不给「从云端恢复」', () => {
    const actions = resolveEmptyStateActions({ syncBackend: 'webdav', isAuthenticated: false });
    assert.ok(actions.includes('options'), '自带存储的用户要能在设置页填地址与解锁');
    assert.ok(!actions.includes('login'), '自带存储没有 TapStack 账号 ⇒ 「登录」对他毫无意义');
    assert.ok(!actions.includes('download'), '没有账号就没有「TapStack 云端」可拉');
  });

  it('云端未登录：给「登录」，不给「从云端恢复」', () => {
    const actions = resolveEmptyStateActions({ syncBackend: 'supabase', isAuthenticated: false });
    assert.ok(actions.includes('login'), '未登录的云端用户必须先登录（登录成功会自动拉回）');
    assert.ok(!actions.includes('download'), '还没登录就让他「从云端恢复」⇒ 点了必然失败');
  });

  it('云端已登录：给「从云端恢复」，**不给**「登录」', () => {
    const actions = resolveEmptyStateActions({ syncBackend: 'supabase', isAuthenticated: true });
    assert.ok(actions.includes('download'), '已登录的用户要能直接把云端会话拉回来');
    assert.ok(
      !actions.includes('login'),
      '已经登录了还给他一个「登录」按钮 ⇒ 那是一条错路（点了会让他重新登录一遍）'
    );
  });

  it('每个出口都要有可见文字与补充说明（不许出现一个空按钮）', () => {
    for (const action of ALL_ACTIONS) {
      assert.ok(
        (EMPTY_STATE_ACTION_LABEL[action] ?? '').trim().length > 0,
        `出口 ${action} 必须有可见文字`
      );
      assert.ok(
        (EMPTY_STATE_ACTION_HINT[action] ?? '').trim().length > 0,
        `出口 ${action} 必须有补充说明（它会改变用户对「我的数据在哪」的判断）`
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ② 渲染层：真的把空态渲染一遍
// ─────────────────────────────────────────────────────────────────────────

describe('渲染层：空态渲染出来的出口必须与判据层一致', () => {
  const cases: Array<{ name: string; syncBackend: 'supabase' | 'webdav'; isAuthenticated: boolean }> = [
    { name: '云端已登录', syncBackend: 'supabase', isAuthenticated: true },
    { name: '云端未登录', syncBackend: 'supabase', isAuthenticated: false },
    { name: '自带存储', syncBackend: 'webdav', isAuthenticated: false },
  ];

  for (const testCase of cases) {
    it(`${testCase.name}：渲染出来的出口 == 判据层给出的出口`, async () => {
      const rendered = await renderTabList({
        groups: [],
        syncBackend: testCase.syncBackend,
        isAuthenticated: testCase.isAuthenticated,
      });
      const expected = resolveEmptyStateActions({
        syncBackend: testCase.syncBackend,
        isAuthenticated: testCase.isAuthenticated,
      });
      assert.deepEqual(
        [...rendered.exitActions].sort(),
        [...expected].sort(),
        `界面渲染出来的出口必须与判据层一致（当前渲染：${rendered.exitActions.join('、') || '一个都没有'}）`
      );
    });
  }

  it('已登录的云端用户**看不到**「登录」按钮（审计点名的那个形状）', async () => {
    const rendered = await renderTabList({
      groups: [],
      syncBackend: 'supabase',
      isAuthenticated: true,
    });
    assert.ok(
      !rendered.exitActions.includes('login'),
      '已登录用户看到「登录」按钮 ⇒ 那是一条错路'
    );
    assert.ok(
      rendered.exitActions.includes('download'),
      '已登录用户必须能看到「从云端恢复会话」'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ③ 执行层：点了会发生什么
// ─────────────────────────────────────────────────────────────────────────

/** 造一组「会记账的」假 deps。 */
function makeDeps(overrides: { requestImportResult?: boolean } = {}) {
  const calls = {
    openAuth: 0,
    openOptions: 0,
    restoreFromCloud: 0,
    requestImport: 0,
    notify: [] as string[],
  };
  const deps = {
    openAuth: () => {
      calls.openAuth++;
    },
    openOptions: () => {
      calls.openOptions++;
    },
    restoreFromCloud: () => {
      calls.restoreFromCloud++;
    },
    requestImport: () => {
      calls.requestImport++;
      return overrides.requestImportResult ?? true;
    },
    unavailableMessage: (action: EmptyStateAction) => `出口 ${action} 此刻不可用`,
    notifyUnavailable: (message: string) => {
      calls.notify.push(message);
    },
  };
  return { calls, deps };
}

describe('执行层：每个出口要么真的做了事，要么出声说明', () => {
  it('登录出口：宿主接上了 ⇒ 真的打开登录', () => {
    const { calls, deps } = makeDeps();
    const outcome = runEmptyStateExit('login', deps);
    assert.equal(calls.openAuth, 1, '必须真的调用登录能力');
    assert.equal(outcome.kind, 'handled');
    assert.equal(calls.notify.length, 0, '做成了事就不该再出声抱怨');
  });

  it('登录出口：宿主**没**接上 ⇒ 必须出声说明（不许静默无反应）', () => {
    const { calls, deps } = makeDeps();
    const outcome = runEmptyStateExit('login', { ...deps, openAuth: undefined });
    assert.equal(calls.openAuth, 0, '没接上就不该有登录动作');
    assert.equal(outcome.kind, 'unavailable', '这个出口此刻做不到 ⇒ 必须承认');
    assert.equal(calls.notify.length, 1, '必须出声一次（点了没反应也没提示是本仓明令禁止的失败形态）');
    assert.ok(calls.notify[0].trim().length > 0, '出声必须有一句能看的话');
  });

  it('从云端恢复出口：真的发起恢复', () => {
    const { calls, deps } = makeDeps();
    const outcome = runEmptyStateExit('download', deps);
    assert.equal(calls.restoreFromCloud, 1, '必须真的发起云端恢复');
    assert.equal(outcome.kind, 'handled');
  });

  it('设置出口：真的打开设置页', () => {
    const { calls, deps } = makeDeps();
    const outcome = runEmptyStateExit('options', deps);
    assert.equal(calls.openOptions, 1, '必须真的打开设置页');
    assert.equal(outcome.kind, 'handled');
  });

  it('导入出口：有订阅者 ⇒ 真的导入', () => {
    const { calls, deps } = makeDeps({ requestImportResult: true });
    const outcome = runEmptyStateExit('import', deps);
    assert.equal(calls.requestImport, 1, '必须真的请求导入');
    assert.equal(outcome.kind, 'handled');
    assert.equal(calls.notify.length, 0, '做成了事就不该再出声');
  });

  it('导入出口：没有订阅者 ⇒ 必须出声说明', () => {
    const { calls, deps } = makeDeps({ requestImportResult: false });
    const outcome = runEmptyStateExit('import', deps);
    assert.equal(calls.requestImport, 1, '必须真的问过「有没有订阅者」');
    assert.equal(outcome.kind, 'unavailable', '没人接这个请求 ⇒ 点了不会有任何反应');
    assert.equal(calls.notify.length, 1, '必须出声（点了没反应也没提示是本仓明令禁止的失败形态）');
    assert.ok(calls.notify[0].trim().length > 0, '出声必须有一句能看的话');
  });

  it('说明文案是空白时，也必须有一句话（不许出声出一片空白）', () => {
    const { calls, deps } = makeDeps();
    const outcome = runEmptyStateExit('import', {
      ...deps,
      requestImport: () => false,
      unavailableMessage: () => '   ',
    });
    assert.equal(calls.notify.length, 1, '必须出声');
    assert.ok(
      calls.notify[0].trim().length > 0,
      '说明为空 ⇒ 判据层必须补一句兜底（否则「出声」变成一句空话）'
    );
    assert.equal(outcome.kind, 'unavailable');
  });

  it('各出口的「不可用」说明不能是一句通用话（每条路要告诉用户还能去哪）', () => {
    const messages = ALL_ACTIONS.map(
      action => (EMPTY_STATE_EXIT_UNAVAILABLE[action] ?? '').trim()
    );
    for (const [index, message] of messages.entries()) {
      assert.ok(
        message.length > 0,
        `出口 ${ALL_ACTIONS[index]} 不可用时必须有一句能看的话（不能出声出一片空白）`
      );
    }
    assert.ok(
      new Set(messages).size > 1,
      '四个出口的替代路径各不相同（登录走右上角菜单、恢复走「从云端刷新数据」、' +
        '设置页要手动打开、导入走菜单）—— 共用一句通用话等于没告诉用户还能去哪'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ④ 接线层：每个出口接到了哪个 IO（数据流，追到终端 API）
// ─────────────────────────────────────────────────────────────────────────

/** 一个「终端」：数据流追到这里就收手了。 */
interface Terminal {
  /** 终端的名字（平台 API / 模块导出 / 组件 prop / 状态 setter）。 */
  name: string;
  /** 第一个字面量参数（协议 op 之类）。 */
  firstArg?: string;
}

/** 一个文件里的接线结构。 */
interface ExitWiring {
  /** deps 每个属性 → 它追到的终端。 */
  terminals: Record<string, Terminal[]>;
  /** 文件里 `useState` 的 setter 名字（= 可见反馈的落点）。 */
  stateSetters: Set<string>;
  /** 组件的 props 名字（= 宿主传进来的能力）。 */
  propNames: Set<string>;
}

/**
 * 解析 TabList 的空态出口接线（纯函数：吃源码文本，吐结构）。
 *
 * 追法：从 `runEmptyStateExit(action, deps)` 的第二个参数出发，
 * 对每个属性沿**本地函数**追一跳，收集终端：
 *   · 带点的调用（`chrome.runtime.openOptionsPage`）⇒ 平台 API，直接收手；
 *   · 模块导入的符号（`sendSyncCommand`）⇒ 模块导出，直接收手；
 *   · 组件 prop（`onOpenAuth`）⇒ 宿主能力，直接收手；
 *   · 本地函数 ⇒ 追进它的定义再收手（所以改个局部变量名不会让守卫变红）。
 */
function analyzeExitWiring(source: string): ExitWiring {
  const file = ts.createSourceFile('TabList.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  const importedNames = new Set<string>();
  const localDeclarations = new Map<string, ts.Node>();
  const stateSetters = new Set<string>();
  const propNames = new Set<string>();
  const parameterNames = new Set<string>();

  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings) {
      const bindings = statement.importClause.namedBindings;
      if (ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) importedNames.add(element.name.text);
      }
    }
  }

  // 收集：本地声明（含 useState 的 setter）、函数参数名。
  const visitDeclarations = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        localDeclarations.set(node.name.text, node.initializer);
      } else if (ts.isArrayBindingPattern(node.name) && node.initializer) {
        // `const [值, 设值] = useState(...)` —— 第二个起才是「设值」那一族。
        if (/^useState\b/.test(node.initializer.getText(file))) {
          node.name.elements.forEach((element, index) => {
            if (
              index > 0 &&
              ts.isBindingElement(element) &&
              ts.isIdentifier(element.name)
            ) {
              stateSetters.add(element.name.text);
            }
          });
        }
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      localDeclarations.set(node.name.text, node);
    }
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node)) &&
      node.parameters
    ) {
      for (const parameter of node.parameters) {
        if (ts.isIdentifier(parameter.name)) parameterNames.add(parameter.name.text);
      }
    }
    node.forEachChild(visitDeclarations);
  };
  visitDeclarations(file);

  // 组件 props（第一个函数参数解构出来的名字）—— 宿主传进来的能力。
  const collectProps = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isArrowFunction(node.initializer)
    ) {
      const first = node.initializer.parameters[0];
      if (first && ts.isObjectBindingPattern(first.name)) {
        for (const element of first.name.elements) {
          if (ts.isIdentifier(element.name)) propNames.add(element.name.text);
        }
      }
    }
    node.forEachChild(collectProps);
  };
  collectProps(file);

  // 找 `runEmptyStateExit(action, deps)` 的第二个参数。
  let depsNode: ts.Node | undefined;
  const findCall = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'runEmptyStateExit' &&
      node.arguments.length >= 2
    ) {
      depsNode = node.arguments[1];
    }
    node.forEachChild(findCall);
  };
  findCall(file);

  const terminals: Record<string, Terminal[]> = {};

  /** 沿本地函数追一跳，收集终端。 */
  const collectTerminals = (node: ts.Node, seen: Set<string>): Terminal[] => {
    const found: Terminal[] = [];
    /** 把一个「被引用到的名字」变成终端（必要时追进本地定义）。 */
    const resolveReference = (name: string, literal: string | undefined): void => {
      if (name.includes('.')) {
        found.push({ name, firstArg: literal });
        return;
      }
      if (importedNames.has(name)) {
        found.push({ name, firstArg: literal });
        return;
      }
      if (stateSetters.has(name)) {
        // 状态 setter = 可见反馈的落点 ⇒ 到此收手（再追下去只会追到 useState）。
        found.push({ name });
        return;
      }
      if (localDeclarations.has(name) && !seen.has(name)) {
        seen.add(name);
        const declaration = localDeclarations.get(name);
        if (declaration) declaration.forEachChild(visit);
        return;
      }
      // 既不是本地声明也不是导入 ⇒ 组件 prop 或全局对象。
      found.push({ name, firstArg: literal });
    };

    const visit = (current: ts.Node): void => {
      if (ts.isCallExpression(current)) {
        const callee = current.expression.getText(file);
        const firstArg = current.arguments[0];
        const literal = firstArg && ts.isStringLiteral(firstArg) ? firstArg.text : undefined;
        resolveReference(callee, literal);
        return;
      }
      if (ts.isIdentifier(current)) {
        const parent = current.parent;
        const isPropertyName =
          (ts.isPropertyAccessExpression(parent) && parent.name === current) ||
          (ts.isPropertyAssignment(parent) && parent.name === current);
        if (!isPropertyName && !parameterNames.has(current.text)) {
          resolveReference(current.text, undefined);
        }
        return;
      }
      current.forEachChild(visit);
    };
    visit(node);
    return found;
  };

  if (depsNode) {
    const collectProperties = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        for (const property of node.properties) {
          if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
          const key = property.name.text;
          terminals[key] = collectTerminals(property.initializer, new Set());
        }
      }
      node.forEachChild(collectProperties);
    };
    collectProperties(depsNode);
  }

  return { terminals, stateSetters, propNames };
}

describe('接线层：每个出口必须接到它该接的那个 IO', () => {
  const wiring = analyzeExitWiring(read('src/components/tabs/TabList.tsx'));

  const terminalNames = (key: string): string[] =>
    (wiring.terminals[key] ?? []).map(terminal => terminal.name);

  it('登录出口 ⇒ 接到宿主的登录能力（组件 prop）', () => {
    assert.ok(
      terminalNames('openAuth').some(name => wiring.propNames.has(name)),
      `登录出口必须接到组件 prop（宿主传进来的登录能力），当前接到：${terminalNames('openAuth').join('、')}`
    );
  });

  it('设置出口 ⇒ 接到浏览器的设置页 API', () => {
    assert.ok(
      terminalNames('openOptions').includes('chrome.runtime.openOptionsPage'),
      `设置出口必须打开浏览器的设置页（chrome.runtime.openOptionsPage），当前接到：${terminalNames('openOptions').join('、')}`
    );
  });

  it('从云端恢复出口 ⇒ 追到同步协议的 download 操作', () => {
    const terminals = wiring.terminals['restoreFromCloud'] ?? [];
    assert.ok(
      terminals.some(
        terminal => terminal.name === 'sendSyncCommand' && terminal.firstArg === 'download'
      ),
      `从云端恢复必须走同步协议的 download 操作（sendSyncCommand('download', …)），` +
        `当前追到：${terminals.map(t => `${t.name}(${t.firstArg ?? ''})`).join('、')}`
    );
  });

  it('导入出口 ⇒ 接到导入请求', () => {
    assert.ok(
      terminalNames('requestImport').includes('requestImport'),
      `导入出口必须请求导入（components/layout/importRequest 的 requestImport），当前接到：${terminalNames('requestImport').join('、')}`
    );
  });

  it('「做不到」的说明 ⇒ 落到可见的状态上（不是只喊一嗓子）', () => {
    const terminals = wiring.terminals['notifyUnavailable'] ?? [];
    assert.ok(
      terminals.some(terminal => wiring.stateSetters.has(terminal.name)),
      `「这个出口此刻用不了」必须落到界面上的可见反馈（一个 useState 的 setter），` +
        `当前追到：${terminals.map(t => t.name).join('、')}`
    );
  });

  it('各出口的 IO 互不重叠（接串了就等于一个出口点了做别的事）', () => {
    const keys = ['openAuth', 'openOptions', 'restoreFromCloud', 'requestImport'];
    for (const left of keys) {
      for (const right of keys) {
        if (left === right) continue;
        const shared = terminalNames(left).filter(name => terminalNames(right).includes(name));
        assert.deepEqual(
          shared,
          [],
          `「${left}」与「${right}」接到了同一个 IO（${shared.join('、')}）—— ` +
            '接串了就等于点一个出口做别的事'
        );
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ⑤ 冷启动：缓存里的登录态必须**立刻**进 store
// ─────────────────────────────────────────────────────────────────────────

/** AuthProvider 冷启动的接线结构。 */
interface ColdStartWiring {
  /** 缓存登录态在**正常路径**上有没有被 dispatch 进 store。 */
  dispatchedOnNormalPath: boolean;
  /** 被 dispatch 的用户是不是缓存里那个。 */
  usesCachedUser: boolean;
}

/**
 * 解析 AuthProvider 的冷启动接线（纯函数：吃源码文本，吐结构）。
 *
 * 找两件事：
 *   ① 哪个变量是从 `authCache.getAuthState()` 读出来的（缓存登录态的持有者）；
 *   ② `dispatch(setFromCache({ user: … }))` 有没有把**那个变量**的用户送进 store，
 *      以及它发生在**正常路径**上还是只在 `catch` 分支里。
 *
 * 为什么必须区分「正常路径」与「catch 分支」：
 * 服务端不可用（402）时早就按缓存保留登录态了 —— 那条路早就有了；
 * 缺的是**正常冷启动**路径上的那一次。
 */
function analyzeColdStartWiring(source: string): ColdStartWiring {
  const file = ts.createSourceFile(
    'AuthProvider.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );

  const cachedVarNames = new Set<string>();
  const findCachedVars = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      node.initializer.getText(file).includes('authCache.getAuthState()')
    ) {
      cachedVarNames.add(node.name.text);
    }
    node.forEachChild(findCachedVars);
  };
  findCachedVars(file);

  let dispatchedOnNormalPath = false;
  let usesCachedUser = false;

  const isFunctionLike = (node: ts.Node): boolean =>
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node);

  /**
   * `inErrorHandler` = 当前位置在**错误处理回调**里。
   *
   * 两种形状都算：
   *   · `catch (e) { … }`（语句级的 catch 子句）；
   *   · `.catch(err => { … })`（Promise 的拒绝回调）——
   *     仓库里「服务端 402 ⇒ 按缓存恢复登录态」那一条就长在这个形状里。
   *
   * 为什么必须把它们分开：**那条 402 分支早就有了**（它本来就是「服务端不可用
   * 时保留登录态」的正确做法），而缺的是**正常冷启动**路径上的那一次。
   * 两者在源码里长得几乎一样 ⇒ 判据必须能区分「错误处理路上」与「正常路上」。
   */
  const findDispatches = (node: ts.Node, inErrorHandler: boolean): void => {
    if (ts.isCatchClause(node)) {
      findDispatches(node.block, true);
      return;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'catch'
    ) {
      for (const argument of node.arguments) {
        if (isFunctionLike(argument)) findDispatches(argument, true);
        else findDispatches(argument, inErrorHandler);
      }
      findDispatches(node.expression, inErrorHandler);
      return;
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(file) === 'dispatch' &&
      node.arguments.length === 1 &&
      ts.isCallExpression(node.arguments[0]) &&
      node.arguments[0].expression.getText(file) === 'setFromCache'
    ) {
      const payload = node.arguments[0].arguments[0];
      if (payload && ts.isObjectLiteralExpression(payload)) {
        for (const property of payload.properties) {
          if (
            !ts.isPropertyAssignment(property) ||
            !ts.isIdentifier(property.name) ||
            property.name.text !== 'user'
          ) {
            continue;
          }
          const initializer = property.initializer;
          if (
            ts.isPropertyAccessExpression(initializer) &&
            ts.isIdentifier(initializer.expression) &&
            cachedVarNames.has(initializer.expression.text)
          ) {
            usesCachedUser = true;
            if (!inErrorHandler) dispatchedOnNormalPath = true;
          }
        }
      }
    }
    node.forEachChild(child => findDispatches(child, inErrorHandler));
  };
  findDispatches(file, false);

  return { dispatchedOnNormalPath, usesCachedUser };
}

describe('冷启动：缓存里的登录态必须立刻进 store（否则空态先显示错的那个出口）', () => {
  it('AuthProvider 必须在**正常路径**上把缓存里的用户 dispatch 进 store', () => {
    const wiring = analyzeColdStartWiring(
      read('src/components/app/AuthProvider.tsx')
    );
    assert.ok(
      wiring.usesCachedUser,
      '缓存里的用户必须被送进 store（dispatch(setFromCache({ user: 缓存里的用户 }))）—— ' +
        '不送进去，Redux 里的 isAuthenticated 就恒为 false（authSlice 的初值）'
    );
    assert.ok(
      wiring.dispatchedOnNormalPath,
      '这一次 dispatch 必须发生在**正常冷启动路径**上 —— ' +
        '只有 catch 分支（服务端 402 不可用）里有是不够的：' +
        '正常冷启动时登录态要等网络回包才补上，' +
        '那一两秒里已登录的老用户看到的是「登录 TapStack 云端」而不是「从云端恢复会话」'
    );
  });
});
