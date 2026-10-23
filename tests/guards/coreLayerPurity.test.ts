/**
 * 「判据层（src/core）不许反向依赖 IO 层」的守卫（2026-10-23 第 50 轮）。
 *
 * ── 这条守卫钉的是什么 ────────────────────────────────────────────────────
 * `src/core` 被约定为**纯判据层**：不碰 chrome.* / IndexedDB / 网络，
 * 判据要能拿到 node:test 里**无浏览器直测**。
 *
 * 2026-10-23 实测发现一处方向反了：
 *   `src/core/syncDecision.ts` → `import { checkDeleteFailsafe } from '../sync-backend/failsafe'`
 * —— 判据层 import 了 IO 层。方向反了的后果不是「今天就报错」，而是：
 *   · 以后在 `src/sync-backend/` 下加任何带 IO 的东西，
 *     只要 core 顺着这条边 import，就会被拖进判据层的静态图；
 *   · core 的判据就测不了了（node:test 里没有 chrome.*）；
 *   · 谁在用判据、谁在用 IO，从 import 边上分不出来 ⇒ 以后想收口时无据可依。
 * ⇒ 实现搬到 `src/core/deleteFailsafe.ts`；旧路径 `src/sync-backend/failsafe.ts`
 *   **连同转发垫片一起删掉**（不留 re-export —— 垫片留着，调用方就会漂回去）。
 *
 * ── 两条规则 ──────────────────────────────────────────────────────────────
 *   **① 依赖方向**：`src/core/**` 的**运行时** import 不得落在
 *      `src/sync-backend/**` / `src/background/**` / `src/store/**`。
 *      ⚠️ **类型** import 除外（`import type { X } from '../store/y'`
 *      编译后消失，不是运行时依赖）。
 *   **② 浏览器全局**：`src/core/**` 不得直接碰 `chrome.*` / `document` / `window`，
 *      除非在 `KNOWN_CORE_BROWSER_GLOBALS` 里**登记并写清理由**。
 *
 * ── 为什么第 ② 条要有「登记」而不是一刀切 ────────────────────────────────
 * 有两处**已知**的边界，它们不是「忘了收口」，而是**收口方式不同**：
 *   · `src/core/mutationProtocol.ts`：默认 sender 就是 `chrome.runtime.sendMessage`
 *     —— 但它是**可注入的默认实现**（`sendMutation(cmd, sender)`），
 *     node:test 注入假 sender 就能直测。把它挪出 core 只会让人以为
 *     「判据层不许有 chrome.*」等于「不许有默认实现」，
 *     而注入点已经存在 ⇒ **不挪，登记**。
 *   · `src/core/runtimeRealm.ts`：`typeof document === 'undefined'`
 *     —— 只**探测**当前 realm，不读写任何浏览器状态。
 *     「我在不在 service worker 里」必须在判据层就地判断 ⇒ **登记**。
 *   · `src/core/workerSafePreload.ts`：构建期代码生成器，
 *     产出的**字符串**里有 document/window。
 *     它不是运行时访问全局 ⇒ AST 看不见那些标识符 ⇒ **天然不触发**，
 *     不需要登记（登记了反而是给未来的读者添噪声）。
 *
 * 登记项本身也要被守：**理由太短 ⇒ 红**、**文件不存在 ⇒ 红**、
 * **文件已经不再碰那个全局 ⇒ 红**（登记不许变成没人看的坟场）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';

import { sourceFiles } from '../_helpers/facadeLoading.ts';
import { REPO_ROOT, resolveModuleSpec, runtimeImportSpecs } from '../_helpers/moduleGraph.ts';

/** IO 层目录（判据层不许 import 它们）。 */
const IO_LAYER_PREFIXES = ['src/sync-backend/', 'src/background/', 'src/store/'];

/**
 * `src/core/**` 里**已知**的浏览器全局触碰点，以及各自的理由。
 *
 * ⚠️ 这张表只登记「**有意为之**」的例外。新增条目必须写清理由，
 * 不许「先放着再说」—— 登记表只涨不跌就会变成没人看的坟场。
 */
const KNOWN_CORE_BROWSER_GLOBALS: Record<string, string> = {
  'src/core/mutationProtocol.ts':
    '默认 sender 就是 chrome.runtime.sendMessage —— 但它是**可注入的默认实现**' +
    '（sendMutation/sendSyncCommand 都接受 sender 参数，node:test 注入假 sender 就能直测）。' +
    '把它挪出 core 只会让人以为「判据层不许有 chrome.*」等于「不许有默认实现」，' +
    '而注入点已经存在 ⇒ 不挪，登记。',
  'src/core/runtimeRealm.ts':
    '只**探测**当前 realm（typeof document === "undefined"），不读写任何浏览器状态：' +
    '它要回答的是「我在不在 service worker 里」—— 这必须在判据层就地判断，' +
    '挪出去反而会让人以为判据可以随便在页面侧跑。',
};

/** 仓库根相对路径（正斜杠）。 */
function rel(file: string): string {
  return relative(REPO_ROOT, file).replace(/\\/g, '/');
}

/** `src/core/**` 下的全部源文件（绝对路径）。 */
function coreFiles(): string[] {
  const prefix = resolve(REPO_ROOT, 'src/core') + '/';
  return sourceFiles().filter(f => f.startsWith(prefix));
}

/**
 * 这个文件里**直接**碰到的浏览器全局（`chrome.*` / `document` / `window`）。
 *
 * 用 AST 而不是正则：注释里提到 `chrome.storage` 不算「碰了」，
 * 而 `foo.window`（属性名）也不是全局 window。
 */
function browserGlobalHits(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const hits = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'chrome'
    ) {
      hits.add(`chrome.${node.name.text}`);
      node.forEachChild(visit);
      return;
    }
    if (ts.isIdentifier(node) && (node.text === 'document' || node.text === 'window')) {
      const parent = node.parent;
      const isPositionOnly =
        (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (parent && ts.isPropertyAssignment(parent) && parent.name === node) ||
        (parent && ts.isMethodDeclaration(parent) && parent.name === node) ||
        (parent && ts.isParameter(parent) && parent.name === node) ||
        (parent && ts.isVariableDeclaration(parent) && parent.name === node) ||
        (parent && ts.isBindingElement(parent) && parent.name === node) ||
        (parent && ts.isShorthandPropertyAssignment(parent) && parent.name === node);
      if (!isPositionOnly) hits.add(node.text);
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return [...hits];
}

describe('判据层（src/core）的依赖方向', () => {
  it('src/core/** 的运行时 import 不得落在 IO 层（类型 import 除外）', () => {
    const offenders: string[] = [];
    for (const file of coreFiles()) {
      for (const spec of runtimeImportSpecs(file)) {
        const target = resolveModuleSpec(spec, file);
        if (!target) continue; // 裸包名 = node_modules，不是本仓的层
        const targetRel = rel(target);
        if (IO_LAYER_PREFIXES.some(prefix => targetRel.startsWith(prefix))) {
          offenders.push(`${rel(file)} → ${spec}（→ ${targetRel}）`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'src/core（判据层）不许 import IO 层：\n' +
        offenders.join('\n') +
        '\n判据层要能在 node:test 里无浏览器直测；反向依赖会把 IO 拖进判据的静态图。' +
        '修法：把实现搬到 src/core/（判据就该住在判据层），并把旧路径连同转发垫片一起删掉' +
        '（见 src/core/deleteFailsafe.ts）。'
    );
  });

  it('判据层确实住在 src/core（这条守卫本身没扫错目录）', () => {
    const files = coreFiles();
    assert.ok(files.length > 10, `src/core 下只找到 ${files.length} 个文件 —— 守卫扫错目录了`);
    assert.ok(
      files.some(f => rel(f) === 'src/core/syncDecision.ts'),
      'src/core/syncDecision.ts 不在扫描范围里 —— 守卫失效'
    );
  });
});

describe('判据层（src/core）里的浏览器全局', () => {
  it('不许直接碰 chrome.* / document / window（除非已登记并写清理由）', () => {
    const offenders: string[] = [];
    for (const file of coreFiles()) {
      const hits = browserGlobalHits(file);
      if (hits.length === 0) continue;
      if (rel(file) in KNOWN_CORE_BROWSER_GLOBALS) continue;
      offenders.push(`${rel(file)} → ${hits.join(', ')}`);
    }
    assert.deepEqual(
      offenders,
      [],
      'src/core（判据层）里出现了未登记的浏览器全局：\n' +
        offenders.join('\n') +
        '\n判据层要在 node:test 里无浏览器直测 ⇒ 浏览器全局要么挪走，要么在 ' +
        'KNOWN_CORE_BROWSER_GLOBALS 里登记并写清「为什么可以留」。'
    );
  });

  it('登记项说得清理由、文件还在、而且那个理由仍然成立', () => {
    for (const [file, why] of Object.entries(KNOWN_CORE_BROWSER_GLOBALS)) {
      assert.ok(why.trim().length > 10, `${file} 的登记理由太短（空理由 = 没人知道为什么可以留）`);
      const abs = resolve(REPO_ROOT, file);
      assert.ok(existsSync(abs), `登记的文件不存在：${file}`);
      const hits = browserGlobalHits(abs);
      assert.ok(
        hits.length > 0,
        `${file} 已经不再碰浏览器全局了 ⇒ 登记项过期，请删掉（登记表只涨不跌就会变成没人看的坟场）`
      );
    }
  });
});
