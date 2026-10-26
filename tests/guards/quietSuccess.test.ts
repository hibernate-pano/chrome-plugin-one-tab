/**
 * 「安静的成功」守卫（2026-10-25）—— **Task 2 类型层 + 19 处裁决 / Task 3 恢复类收口 /
 * Task 4 登记表 + 失败不得静默 + 命名空间不许误伤**。
 *
 * ── 这个守卫在防什么 ──────────────────────────────────────────────────────
 *
 * 「成功是状态，不是事件」这句话，靠自觉是守不住的 —— 写代码的人看到
 * `showToast(x, 'success')` 顺手就写了。所以本仓把这件事做成**机制**：
 *
 *   ① **类型层删掉 `'success'`** ⇒ `showToast(x, 'success')` 变成编译错误
 *      ⇒ 新代码在类型层面就撒不出成功提示（这是最硬的那道闸门）。
 *   ② **每一个出声点都经判据层裁决**（`decideFeedback`）⇒ 「说不说」不再
 *      是每个调用点自己拍脑袋，而是同一份判据。
 *
 * 本文件钉的就是这两件事：
 *   · 类型层：`ToastKind` / `ToastType` 的联合类型里**不含** `'success'`，
 *     `TYPE_LABEL` 里也没有 `success` 这个键；
 *   · 逐条裁决：19 处曾经直接报成功的地方，每一处现在的档位都是钉死的
 *     （fact ⇒ 必须经判据层、提示类型是 `'info'`；silent ⇒ 那条提示必须
 *     **不存在**，且它依赖的界面载体必须真的在）。
 *
 * ── 为什么断言必须**解析联合类型的成员** ─────────────────────────────────
 *
 * `'success'` 这个字面量在仓里同时活在**六个互不相干的命名空间**里：
 * 浏览器通知 `kind`（`service-worker.ts` / `TabManager.ts` / `iconClickAction.ts`）、
 * 就地反馈 `kind`（`Header.tsx` / `TabList.tsx` / `SearchResultList.tsx`）、
 * `InlineNoticeTone`、`AlertDialog.type`、`TabGroup.syncStatus`，
 * 外加服务端回执里那个**布尔**字段 `success: boolean`。
 * ⇒ 「文件里不含 `'success'` 三个字符」这种 blanket 写法**必然误伤**。
 * ⇒ 这里解析出联合类型的**成员**再逐个比对。
 *
 * ── Task 4 在这个文件里补上了什么 ───────────────────────────────────────
 *
 *   · **19 处裁决登记表**（`LEDGER`）：每一处曾经直接报成功的地方，
 *     现在的档位（fact / silent / 条件 fact / 常驻）、判据由哪条断言守着、
 *     判据调用有没有真的接上，全部列成 19 行钉死 —— 少一行、多一行、
 *     悄悄换一档，守卫都会红。
 *   · **失败不得被静默**：`showToast` 的 error 调用点不得少于基线 35 处、
 *     error 的时长必须为 0（不自动消失）、error 与带操作的提示都不可被挤掉。
 *   · **命名空间不许误伤**：`'success'` 在别处（浏览器通知、就地反馈、
 *     `InlineNoticeTone`、`AlertDialog.type`、`TabGroup.syncStatus` …）
 *     仍然是合法字面量 —— 守卫按命名空间逐个钉，不做 blanket 禁止。
 *   · **接线 / 退路 / 成功门**（恢复即消费那条链路）**已经钉在本文件里**
 *     （见「Task 3：恢复类播报收口」一节）：
 *     退路 —— `it('未锁定必须有退路：整组恢复与点开单标签都挂着撤销凭据')`；
 *     成功门 —— `assert.match(…, ${file}：锁定分支必须判过成功门 —— …)`；
 *     #19 锁定说明 —— `it('锁定说明的文案必须含三个要素…')`。
 *     **不再是「留给后续任务」。**
 *
 * ── 行号不是承重信息，锚点才是 ─────────────────────────────────────────
 *
 * 所有定位一律用「唯一字符串 + 周边代码」，不钉行号（行号会随别的改动漂）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

/** 去注释后的源码：注释里提到一个符号不等于生产在用它。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** 生产代码（去注释）。 */
const code = (rel: string): string => stripComments(read(rel));

// ─────────────────────────────────────────────────────────────────────────
// 类型层解析器
// ─────────────────────────────────────────────────────────────────────────

/**
 * 收齐一批文件里 `export type X = …;` 的声明（右值原样留着）。
 */
const typeDeclarations = (files: string[]): Map<string, string> => {
  const decls = new Map<string, string>();
  for (const file of files) {
    for (const m of code(file).matchAll(/export\s+type\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g)) {
      decls.set(m[1], m[2].trim());
    }
  }
  return decls;
};

/**
 * 解析一个「字符串字面量联合类型」的成员。
 *
 * 纯别名（`export type ToastType = ToastKind;`）会**跟到**它指向的那个去 ——
 * 否则 `ToastType` 会被解析成「没有成员」，断言就成了零检测力。
 */
const unionMembers = (decls: Map<string, string>, typeName: string): string[] => {
  const seen = new Set<string>();
  const resolve = (name: string): string[] => {
    if (seen.has(name)) throw new Error(`类型别名成环：${[...seen].join(' → ')} → ${name}`);
    seen.add(name);
    const rhs = decls.get(name);
    if (rhs === undefined) throw new Error(`找不到类型 ${name} 的声明`);
    if (/^[A-Za-z_$][\w$]*$/.test(rhs)) return resolve(rhs);
    return [...rhs.matchAll(/'([^']*)'|"([^"]*)"/g)].map(m => m[1] ?? m[2]);
  };
  return resolve(typeName);
};

/** 取一个对象字面量的顶层键（这里用于 `TYPE_LABEL`）。 */
const objectLiteralKeys = (src: string, name: string): string[] => {
  const decl = src.indexOf(`const ${name}:`);
  assert.notEqual(decl, -1, `找不到 ${name} 的声明`);
  const open = src.indexOf('{', decl);
  const close = src.indexOf('\n};', open);
  assert.notEqual(close, -1, `找不到 ${name} 的结尾`);
  return [...src.slice(open, close).matchAll(/^ {2}([A-Za-z_$][\w$]*)\s*:/gm)].map(m => m[1]);
};

// ─────────────────────────────────────────────────────────────────────────
// 调用点解析器（断言「那一次调用到底是什么」而不是「文件里出现过某段代码」）
// ─────────────────────────────────────────────────────────────────────────

/** 取一次调用里的实参（按顶层逗号切；字符串字面量整体算一个实参）。 */
const callArgs = (src: string, callStart: number): string[] => {
  const open = src.indexOf('(', callStart);
  assert.notEqual(open, -1, '找不到调用的左括号');
  const args: string[] = [];
  let current = '';
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (quote !== null) {
      current += ch;
      if (ch === quote && src[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      if (depth > 1) current += ch;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) {
        args.push(current.trim());
        return args;
      }
      current += ch;
      continue;
    }
    if (ch === ',' && depth === 1) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  throw new Error('调用的括号没配对');
};

/** 锚点之后那一次 `showToast(` 的**类型实参**（null = 没找到 / 不是字面量）。 */
const showToastType = (src: string, from: number): string | null => {
  const at = src.indexOf('showToast(', from);
  if (at < 0) return null;
  const literal = callArgs(src, at)[1] ?? '';
  const m = literal.match(/^['"]([^'"]+)['"]$/);
  return m ? m[1] : null;
};

/**
 * 找锚点的位置。
 *
 * ── 为什么不能靠「第几次出现」 ────────────────────────────────────────────
 * 同一个锚点在一个文件里可能有多处（`importSuccessMessage(` 在 JSON 导入与
 * OneTab 导入两处都有）。早先靠 `nth: 0` / `nth: 1` 区分 ⇒ **两段导入块一旦
 * 调换位置，两个标签就跟着互换，而守卫照样绿**（它只证明了「两个站点都在，
 * 且都经判据层、类型都是 info」，没证明**哪一个标签说的是哪一段**）。
 *
 * ⇒ 改成**按内容**挑：`mustContain` 是该站点**独有的标记**，必须出现在
 * 「锚点 → 那一次 showToast」之间那一段里。
 * ⇒ 位置换了也不怕：JSON 块里永远有 `failedGroups`、OneTab 块里永远有
 * `source: total`。
 */
const anchorIndex = (src: string, anchor: string, mustContain?: string): number => {
  let at = src.indexOf(anchor);
  while (at >= 0) {
    if (!mustContain) return at;
    const toastAt = src.indexOf('showToast(', at);
    const region = src.slice(at, toastAt < 0 ? src.length : toastAt);
    if (region.includes(mustContain)) return at;
    at = src.indexOf(anchor, at + 1);
  }
  return -1;
};

/**
 * 取 `saveFact`（保存云盘配置那条提示）三元表达式的**三支**。
 *
 * 顺序固定为：换云盘（`switchedLibrary`）→ 重存同一份云盘配置（`wasWebdav`）
 * → 其余（切到自带存储）。
 *
 * ⚠️ 为什么要单独抽出来：Ruling 12 钉的是「**纯「已保存」那一支**的 fact 为空」，
 * 而「哪一支是纯「已保存」」在源码里就长成「`wasWebdav` 那一支的字符串是空的」
 * ⇒ 必须能单独把那一支取出来看。
 */
const saveFactBranches = (): {
  switchedLibrary: string;
  wasWebdav: string;
  elseBranch: string;
} => {
  const src = code('src/components/sync/WebDavSettings.tsx');
  const m = src.match(
    /const saveFact\s*=\s*switchedLibrary\s*\?\s*([\s\S]*?)\s*:\s*wasWebdav\s*\?\s*([\s\S]*?)\s*:\s*([\s\S]*?);/,
  );
  assert.ok(m, 'saveFact 必须是三分支（switchedLibrary / wasWebdav / 其余）');
  return { switchedLibrary: m[1], wasWebdav: m[2], elseBranch: m[3] };
};

/**
 * 取 `retainedFact`（退出登录那条事实）三元的 **else 臂**源码。
 *
 * 形状与同文件里 `saveFactBranches()` 一致（**抽取**，不是正则去「看」那一臂）：
 *   `const retainedFact = localCount > 0 ? <真值臂> : <else 臂>;`
 * 抽取范围：到**语句结束**（第一个 `;`）为止 —— 只覆盖 else 臂，
 * 不把后面的语句一起切进来。
 *
 * ⚠️ 2026-10-25 修复轮 3：这一处**不能**用「`: ` 后面紧跟一个空字面量」
 * 那样的正则来判。正则只看得到**紧跟**的那个字面量，看不见它**后面还接了什么** ——
 * `: '' + '已退出登录'` 运行时 fact = `'已退出登录'`（N=0 又会出声，
 * 还拼成「已退出登录。已退出登录」），而那条正则照样命中 ⇒ 假绿。
 * ⇒ 抽出 else 臂的**整段源码**，交给 `literalOf` 读它的字面量内容
 *   （拼接会被一起读出来 ⇒ `'' + '已退出登录'` 读成 '已退出登录' ⇒ 判红）。
 */
const retainedFactElseArm = (): string => {
  const src = code('src/components/layout/HeaderDropdown.tsx');
  const start = src.indexOf('const retainedFact =');
  assert.ok(start > 0, '找不到 retainedFact 的声明');
  const m = src
    .slice(start)
    .match(
      /const retainedFact\s*=\s*localCount\s*>\s*0\s*\?\s*([\s\S]*?)\s*:\s*([\s\S]*?);/,
    );
  assert.ok(m, 'retainedFact 必须是「localCount > 0 ? 真值臂 : else 臂」的三元');
  return m[2];
};

/**
 * 取一支源码里**字符串字面量的内容**并拼起来。
 *
 * 支持的写法：`'A'`、`"A"`、`` `A` ``、以及 `'A' + 'B'` 这种拼接。
 *
 * ⚠️ 2026-10-25 修复轮 2：原先**只认单双引号** ⇒ 有人把那一支改写成
 * 模板字符串（`` `已保存` ``）时这里返回空串 ⇒「那一支必须为空」会**假绿**，
 * 而运行时其实会出声（与 F2 刚修的引号变体洞同一类）。
 * ⇒ 反引号那条分支排在前面：同一起点先按模板字符串整体吃掉，
 *   免得模板里的引号被单双引号分支切成碎片。
 */
const literalOf = (branch: string): string =>
  [...branch.matchAll(/`([^`]*)`|'([^']*)'|"([^"]*)"/g)].map(x => x[1] ?? x[2] ?? x[3]).join('');

/**
 * 接线断言（两处「条件 fact」共用这一套写法，不另造一套）。
 *
 * 钉的是「**fact 为空时那次 showToast 根本不会发生**」这条链路：
 *   ① `<fact> 的声明` → `const fb = decideFeedback` → 那一次 `showToast(` 之间，
 *      必须出现 `if (<某>.level !== 'silent')` —— 提示被**判据结果**包着；
 *   ② 弹出来的那一句必须就是这个 fact 本身，且类型是 `'info'`。
 *
 * ⚠️ 为什么必须两条一起：只断言「判据层拿得到那个 fact」是不够的 ——
 * 把 `if (fb.level !== 'silent')` 的包法去掉，空 fact 照样会出声。
 */
const assertFactWiredThroughFeedback = (
  src: string,
  factName: string,
  declAnchor: string,
  toastCall: RegExp,
): void => {
  const from = src.indexOf(declAnchor);
  assert.ok(from > 0, `找不到 ${factName} 的声明`);
  const fbAt = src.indexOf('const fb = decideFeedback', from);
  assert.ok(fbAt > from, `${factName} 必须交给判据层裁决`);
  const toastAt = src.indexOf('showToast(', fbAt);
  assert.ok(toastAt > fbAt, '判据层之后应当有一次 showToast');
  const region = src.slice(from, toastAt + 80);
  assert.match(
    region,
    /if\s*\(\s*[A-Za-z_$][\w$]*\.level\s*!==\s*'silent'\s*\)/,
    '提示必须被判据结果包着（fact 为空 ⇒ silent ⇒ 不弹）',
  );
  assert.match(
    region,
    toastCall,
    '弹出来的那句必须就是那个 fact（类型是 info）',
  );
};

// ─────────────────────────────────────────────────────────────────────────
// 一、类型层：toast 这一层不许再有 'success'
// ─────────────────────────────────────────────────────────────────────────

describe('类型层：toast 不许再有 success', () => {
  const TOAST_FILES = [
    'src/components/common/toastPolicy.ts',
    'src/components/common/Toast.tsx',
  ];

  it("ToastKind 的联合类型里不含 'success'", () => {
    const members = unionMembers(typeDeclarations(TOAST_FILES), 'ToastKind');
    assert.ok(members.length > 0, '应当能解析出 ToastKind 的成员（解析器坏了就是假绿）');
    assert.ok(
      !members.includes('success'),
      `ToastKind 里不该再有 'success'（实际成员：${members.join(' | ')}）—— ` +
        '成功是状态，不是事件',
    );
  });

  it("ToastType 的联合类型里不含 'success'", () => {
    const members = unionMembers(typeDeclarations(TOAST_FILES), 'ToastType');
    assert.ok(members.length > 0, '应当能解析出 ToastType 的成员（解析器坏了就是假绿）');
    assert.ok(
      !members.includes('success'),
      `ToastType 里不该再有 'success'（实际成员：${members.join(' | ')}）`,
    );
  });

  it("TYPE_LABEL 里没有 success 这个键（不然界面会蹦出「完成」这个药丸)", () => {
    const keys = objectLiteralKeys(read('src/components/common/Toast.tsx'), 'TYPE_LABEL');
    assert.ok(keys.length > 0, '应当能解析出 TYPE_LABEL 的键（解析器坏了就是假绿）');
    assert.ok(
      !keys.includes('success'),
      `TYPE_LABEL 里不该再有 success（实际键：${keys.join(' | ')}）`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 二、19 处裁决的登记表
// ─────────────────────────────────────────────────────────────────────────

/**
 * 判成 fact 的那几处：必须经判据层裁决、提示类型是 `'info'`。
 *
 * ⚠️ 「条件 fact」也登记在这里 —— 条件 fact 的意思是「**有那件事才说**」：
 * 事实存在 ⇒ fact（出声）；事实不存在（空）⇒ 判据层判 silent ⇒ 沉默。
 * 出声那半边的形状与无条件 fact 一样（经判据层 + `'info'`），
 * 沉默那半边由各自的专项断言钉住（见本文件后面的两条 `it`）。
 */
const FACT_SITES: Array<{
  file: string;
  anchor: string;
  /** 该站点**独有的标记**（锚点之后那一段里必须出现）—— 用来在多处锚点里挑对的那一处。 */
  mustContain?: string;
  label: string;
}> = [
  {
    file: 'src/components/layout/Header.tsx',
    anchor: 'cleanDuplicatesResultMessage(',
    label: '清理重复标签的结果（清了几个界面表达不了）',
  },
  {
    file: 'src/components/layout/HeaderDropdown.tsx',
    anchor: '不会上传到其它账号',
    label: '退出登录：**条件 fact**（本机 N>0 才说「N 个会话仍保留、不会传到别的账号」）',
  },
  {
    file: 'src/components/layout/HeaderDropdown.tsx',
    anchor: '已生成备份文件',
    label: '导出备份（含几个会话）',
  },
  {
    file: 'src/components/layout/HeaderDropdown.tsx',
    anchor: '已生成 OneTab 导出文件',
    label: '导出 OneTab（含几个会话）',
  },
  {
    file: 'src/components/layout/HeaderDropdown.tsx',
    anchor: '诊断摘要已复制',
    label: '诊断摘要已复制（剪贴板写入界面看不见）',
  },
  {
    file: 'src/components/layout/HeaderDropdown.tsx',
    anchor: 'importSuccessMessage(',
    // JSON 导入块独有的标记（OneTab 块没有 failedGroups / settingsMergeFailed）。
    mustContain: 'failedGroups',
    label: '导入 JSON 备份（导入几个 / 几个读不出来）',
  },
  {
    file: 'src/components/layout/HeaderDropdown.tsx',
    anchor: 'importSuccessMessage(',
    // OneTab 导入块独有的标记（JSON 块用 result.source / result.imported）。
    mustContain: 'source: total',
    label: '导入 OneTab（导入几个）',
  },
  {
    file: 'src/components/sync/WebDavSettings.tsx',
    anchor: '已保存，已切换到新的云盘',
    label: '保存：**条件 fact**（换云盘 / 切到自带存储两支出声；纯「已保存」那支静默）',
  },
];

/**
 * 判成 silent 的那几处：那条提示必须**不存在**，
 * 而且它依赖的界面载体必须真的在（否则「不说话」就没有依据）。
 *
 * ── 「已删掉」的正则为什么放宽了引号 ──────────────────────────────────────
 * 早先用 `/showToast\('云端已是最新'/` 这种写法：它**只认单引号**。
 * ⇒ 有人用双引号（`showToast("云端已是最新", 'info')`）或模板字符串
 * （`` showToast(`云端已是最新`, 'info') ``）把同一条提示加回来，守卫**照样绿**
 * —— 那条守卫就只剩一半牙齿。
 * ⇒ 现在一律写成 `/showToast\(\s*['"`]…/`：单引号 / 双引号 / 反引号都认，
 * 且允许换行与缩进（`showToast(\n  '云端已是最新',`）。
 *
 * ⚠️ 例外：#8「已开启自动同步」那条**不是** `showToast(` 形状 ——
 * 它钉的是**那句话本身不许再出现**（它原先被搬进 hint 当常驻属性），
 * 所以用的是裸短语匹配，本来就与引号无关。
 */
const SILENT_SITES: Array<{
  label: string;
  file: string;
  /** 必须已经不存在的提示。 */
  gone: RegExp;
  /** 界面自明的那个载体。 */
  carrier: () => void;
}> = [
  {
    label: '云端已是最新',
    file: 'src/components/layout/HeaderDropdown.tsx',
    gone: /showToast\(\s*['"`]云端已是最新/,
    carrier: () => {
      // 回执是「上次同步」那一行：探活命中也写 lastSyncTime ⇒ 那行会前进成「刚刚」。
      const engine = read('src/services/syncEngine.ts');
      const probeAt = engine.indexOf("reason: 'up_to_date'");
      assert.ok(probeAt > 0, 'syncEngine 必须有「已是最新」这条出口');
      assert.match(
        engine.slice(Math.max(0, probeAt - 800), probeAt),
        /setLastSyncTime/,
        '探活命中必须写 lastSyncTime —— 菜单那行会前进成「刚刚」，那才是回执',
      );
      assert.match(
        code('src/components/layout/HeaderDropdown.tsx'),
        /getLastSyncTime/,
        '菜单那行必须读 lastSyncTime（它就是那个回执）',
      );
    },
  },
  {
    label: '推送完成',
    file: 'src/components/sync/WebDavSettings.tsx',
    gone: /showToast\(\s*['"`]推送完成/,
    carrier: () => {
      assert.match(
        code('src/components/sync/WebDavSettings.tsx'),
        /setFirstPush\(\{\s*kind:\s*'done'/,
        'firstPush 状态机必须就地渲染「做完了」—— 那才是回执',
      );
    },
  },
  {
    label: '已从云端下载到本机',
    file: 'src/components/sync/WebDavSettings.tsx',
    gone: /showToast\(\s*['"`]已从云端下载到本机/,
    carrier: () => {
      assert.match(
        code('src/components/sync/WebDavSettings.tsx'),
        /setFirstPush\(\{\s*kind:\s*'done'/,
        'firstPush 状态机必须就地渲染「做完了」—— 那才是回执',
      );
    },
  },
  {
    label: '已切回 TapStack 云端',
    file: 'src/components/sync/WebDavSettings.tsx',
    gone: /showToast\(\s*['"`]已切回 TapStack 云端/,
    carrier: () => {
      const src = code('src/components/sync/WebDavSettings.tsx');
      assert.match(
        src,
        /syncBackend:\s*'supabase'/,
        '后端选择器必须真的切过去 —— 界面自己说得出来',
      );
      assert.match(
        src,
        /当前仍在使用 TapStack 云端/,
        '面板上那块常驻横幅必须真的写明「当前仍在使用 TapStack 云端」—— 那才是回执',
      );
    },
  },
  {
    label: '已清除本机保存的云服务信息',
    file: 'src/components/sync/WebDavSettings.tsx',
    gone: /showToast\(\s*['"`]已清除本机保存的云服务信息/,
    carrier: () => {
      const src = code('src/components/sync/WebDavSettings.tsx');
      assert.match(src, /setUsername\(''\)/, '账号输入框必须被清空 —— 那才是回执');
      assert.match(src, /setPassword\(''\)/, '口令输入框必须被清空 —— 那才是回执');
      assert.match(src, /setPassphrase\(''\)/, '加密口令输入框必须被清空 —— 那才是回执');
    },
  },
  {
    label: '已锁定（后台同步已停止）',
    file: 'src/components/sync/WebDavSettings.tsx',
    gone: /showToast\(\s*['"`]已锁定/,
    carrier: () => {
      const src = code('src/components/sync/WebDavSettings.tsx');
      assert.match(src, /setPassword\(''\)/, '口令输入框必须被清空 —— 那才是回执');
      assert.match(src, /setPassphrase\(''\)/, '加密口令输入框必须被清空 —— 那才是回执');
    },
  },
  {
    label: '已退出登录（设置页）',
    file: 'src/options/OptionsPage.tsx',
    gone: /showToast\(\s*['"`]已退出登录/,
    carrier: () => {
      const src = code('src/options/OptionsPage.tsx');
      assert.match(
        src,
        /dispatch\(signOut\(\)\)/,
        '登出必须真的执行 —— 账号区状态变了就是回执',
      );
      assert.match(
        src,
        /已登录 TapStack 云端/,
        '账号区必须真的渲染「已登录 / 尚未登录」两种形态 —— 那才是回执',
      );
      assert.match(src, /尚未登录 TapStack 云端/, '账号区必须真的渲染「已登录 / 尚未登录」两种形态');
    },
  },
  {
    label: '已开启自动同步',
    file: 'src/options/OptionsPage.tsx',
    // ⚠️ 这一条**不是** showToast 形状：它钉的是**那句话本身不许再出现**
    // （它已被搬进 hint 当常驻属性）⇒ 裸短语匹配，本来就与引号无关。
    gone: /已开启自动同步/,
    carrier: () => {
      const src = code('src/options/OptionsPage.tsx');
      assert.match(
        src,
        /关闭浏览器后需要重新输入应用密码/,
        '「关闭浏览器后需重新输入应用密码」是这条设置的常驻属性，必须写进 hint',
      );
      assert.match(
        src,
        /label="自动同步"[\s\S]{0,200}hint=\{autoSyncHint\}/,
        '那句必须挂在「自动同步」这个设置项的 hint 上（常驻说明，不是 toast）',
      );
      assert.match(
        src,
        /label="自动同步"[\s\S]{0,300}checked=\{settings\.syncEnabled\}/,
        '开关本身必须显示真实状态 —— 开关翻了就是回执',
      );
    },
  },
  {
    label: '已切回 TapStack 云端（设置页）',
    file: 'src/options/OptionsPage.tsx',
    gone: /showToast\(\s*['"`]已切回 TapStack 云端/,
    carrier: () => {
      const src = code('src/options/OptionsPage.tsx');
      assert.match(
        src,
        /syncBackend:\s*next/,
        '后端选择器必须真的切过去 —— 界面自己说得出来',
      );
      assert.match(
        src,
        /aria-checked=\{settings\.syncBackend === 'supabase'\}/,
        '选择器必须真的把「TapStack 云端」这一档标成选中 —— 那才是回执',
      );
    },
  },
];

/**
 * 一个 fact 站点的**完整判据**（登记表与逐条 `it` 共用这一份，不另造一套）。
 *
 * 钉的是两件事，缺一不可：
 *   ① 锚点 → 那一次 `showToast(` 之间**真的出现** `decideFeedback(`；
 *   ② 那一次 `showToast` 的**类型实参**是 `'info'`。
 *
 * ⚠️ 只有 ① 是零检测力：`decideFeedback(` 算了却把结果扔掉、照样
 * `showToast(x, 'success')`，① 照样绿。只有 ② 也不够：`showToast` 的类型对了，
 * 但「说不说」没人裁决 ⇒ 空 fact 照样出声。
 */
const assertFactSite = (site: { file: string; anchor: string; mustContain?: string }): void => {
  const src = code(site.file);
  const at = anchorIndex(src, site.anchor, site.mustContain);
  assert.notEqual(at, -1, `找不到锚点：${site.anchor}（${site.file}）`);
  const toastAt = src.indexOf('showToast(', at);
  assert.ok(toastAt > at, `锚点之后应当有一次 showToast：${site.anchor}`);
  assert.match(
    src.slice(at, toastAt),
    /decideFeedback\(/,
    '必须先经判据层裁决（不许凭感觉直接 showToast）',
  );
  assert.equal(
    showToastType(src, at),
    'info',
    '这条提示的类型必须是 info（不是 success）',
  );
};

/** 取 `handleDeleteAllGroups` 整个函数的源码（「删除全部」的判据只在这个函数里）。 */
const deleteAllHandlerSource = (): string => {
  const src = code('src/components/layout/HeaderDropdown.tsx');
  const start = src.indexOf('const handleDeleteAllGroups');
  assert.ok(start > 0, '找不到 handleDeleteAllGroups');
  const rest = src.slice(start);
  const end = rest.indexOf('\n  const ', 10);
  return end > 0 ? rest.slice(0, end) : rest;
};

/**
 * 取「删除全部」那处 `hiddenFact` 三元的**两臂**源码。
 *
 * 形状：`hiddenFact: deleteAllCountMatches(counts) ? <条数一致那一臂> : <对不上那一臂>;`
 *
 * ── 为什么必须**抽取**而不是正则「看」那一臂 ─────────────────────────────
 *
 * 早先这里只断言「handler 里出现过 `deleteAllCountMatches(`」+「出现过
 * `if (fb.level !== 'silent')`」+「出现过 `deleteAllSuccessMessage(`」。
 * 三条**全部**只钉住了「出现过」，**没有一条钉住两臂的顺序** ⇒
 * 把两臂对调：
 *
 *   `deleteAllCountMatches(counts) ? deleteAllSuccessMessage(counts) : undefined`
 *
 * 所有断言照样全绿，而产品行为**整个反过来**：
 *   · 条数**一致**时反而出声（又念一遍「已删除 N 个」，正是本任务要灭掉的）；
 *   · 条数**对不上**时反而沉默（该说的那个差一个字都没说）。
 *
 * ⇒ 必须把「**条数一致的那一支**」单独取出来，判它是不是「没有事实」。
 */
const deleteAllFactArms = (): { matchesArm: string; mismatchArm: string } => {
  const source = parseTsx('src/components/layout/HeaderDropdown.tsx');
  /** 这棵子树里有没有 `deleteAllCountMatches(...)` 这次调用。 */
  const mentionsCountCheck = (root: ts.Node): boolean => {
    let hit = false;
    const walk = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'deleteAllCountMatches'
      ) {
        hit = true;
      }
      if (!hit) node.forEachChild(walk);
    };
    walk(root);
    return hit;
  };
  let found: ts.ConditionalExpression | null = null;
  const visit = (node: ts.Node): void => {
    if (
      !found &&
      ts.isConditionalExpression(node) &&
      // ⚠️ 这里**不**要求条件就是那次调用：`!调(...)` / `调(...) === false` 都是
      //    等价写法，形状不同、行为相同 ⇒ 只要求条件**问到了**它。
      mentionsCountCheck(node.condition)
    ) {
      found = node;
    }
    node.forEachChild(visit);
  };
  visit(source);
  assert.ok(
    found,
    '「删除全部」那处 hiddenFact 必须问 `deleteAllCountMatches(...)`（解析器坏了就是假绿）',
  );
  const ternary = found as ts.ConditionalExpression;

  // ── 只认「哪一支对应『条数一致』」，不认写法 ────────────────────────────
  // 等价写法至少四种：
  //   `counts 匹配 ? A : B` / `!counts 匹配 ? B : A`
  //   `counts 匹配 === false ? B : A` / `counts 匹配 !== true ? B : A`
  // 前两种/后两种在**行为上完全一样**。若这里只认「条件是裸调用」，
  // 有人改成 `!deleteAllCountMatches(counts) ? … : …`（等价、甚至更好读）
  // 就会误红 —— 那正是「守卫钉长相不钉行为」（变异 ⑧ 要抓的那一类）。
  // ⇒ 数**否定次数**，用奇偶决定哪一支是「条数一致」。
  const condition = ternary.condition;
  /** 这一层是不是「取反」？（对 boolean 而言 `!x` / `x === false` / `x !== true` 同一件事） */
  const negationOf = (node: ts.Expression): { negates: boolean; operand: ts.Expression } | null => {
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      return { negates: true, operand: node.operand };
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      const right = node.right.getText(source).replace(/\s+/g, '');
      if (op === ts.SyntaxKind.EqualsEqualsEqualsToken && right === 'false') {
        return { negates: true, operand: node.left };
      }
      if (op === ts.SyntaxKind.ExclamationEqualsEqualsToken && right === 'true') {
        return { negates: true, operand: node.left };
      }
      // `x === true` / `x !== false` 不取反（同义写法，行为一样）
      if (op === ts.SyntaxKind.EqualsEqualsEqualsToken && right === 'true') {
        return { negates: false, operand: node.left };
      }
      if (op === ts.SyntaxKind.ExclamationEqualsEqualsToken && right === 'false') {
        return { negates: false, operand: node.left };
      }
    }
    return null;
  };
  let negations = 0;
  let core: ts.Expression = condition;
  for (let step = negationOf(core); step !== null; step = negationOf(core)) {
    if (step.negates) negations += 1;
    core = step.operand;
  }
  assert.ok(
    ts.isCallExpression(core) &&
      ts.isIdentifier(core.expression) &&
      core.expression.text === 'deleteAllCountMatches',
    `「删除全部」那处三元的条件必须是「条数是否一致」本身（现在是 \`${condition.getText(source)}\`）`,
  );
  const positiveWhenTrue = negations % 2 === 0;
  const trueArm = ternary.whenTrue.getText(source).replace(/\s+/g, ' ').trim();
  const falseArm = ternary.whenFalse.getText(source).replace(/\s+/g, ' ').trim();
  return {
    matchesArm: positiveWhenTrue ? trueArm : falseArm,
    mismatchArm: positiveWhenTrue ? falseArm : trueArm,
  };
};

/**
 * 这一臂是不是「**没有事实**」？
 *
 * `undefined` / `null` / `void 0` / 空字面量（`''` / `""` / `` `` ``）对判据层
 * 是同一件事：「没有界面表达不了的事实」⇒ 判成 silent。
 *
 * ⚠️ 只认**单个**字面量：`'' + '已退出登录'` 这种拼接**不算**空
 *    （运行时 fact = '已退出登录'，会出声）⇒ 判成「有事实」。
 */
const armIsEmptyFact = (text: string): boolean => {
  const t = text.trim();
  // `undefined` / `null` / `void 0` 是同一个「没有值」的三种写法。
  if (t === 'undefined' || t === 'null' || t === 'void 0') return true;
  const m = t.match(/^(['"`])([\s\S]*)\1$/);
  return m ? m[2].trim().length === 0 : false;
};

/**
 * 「删除全部」的**极性**：条数一致 ⇒ 事实为空（静默）；对不上 ⇒ 事实非空（必须说）。
 *
 * 这是本文件里唯一一处「**行为方向**」的断言 —— 前面那些钉的都是「存在 / 不存在」，
 * 这里钉的是「**哪个分支对应哪种结果**」。
 */
const assertDeleteAllPolarity = (): void => {
  const arms = deleteAllFactArms();
  assert.ok(
    armIsEmptyFact(arms.matchesArm),
    `条数一致的那一支必须是「没有事实」（undefined / 空）—— 现在是 \`${arms.matchesArm}\`：` +
      '一致时反而出声 = 又念一遍界面已经说得出的结果；对不上时反而沉默 = 该说的差没说',
  );
  assert.ok(
    !armIsEmptyFact(arms.mismatchArm),
    `条数对不上的那一支必须带上那个事实 —— 现在是 \`${arms.mismatchArm}\`：` +
      '对不上时沉默 = 界面永远表达不了的那个差被吞了',
  );
  assert.match(
    arms.mismatchArm,
    /deleteAllSuccessMessage\(/,
    '条数对不上的那一支必须用同一份文案函数（不许另写一句）',
  );
};

/** 一个 silent 站点的**完整判据**：那条提示不存在 **且** 界面载体真的在。 */
const assertSilentSite = (site: { file: string; gone: RegExp; carrier: () => void }): void => {
  assert.doesNotMatch(
    code(site.file),
    site.gone,
    '这条提示已经不该存在了 —— 结果在界面自明，说出来只是重复念一遍',
  );
  site.carrier();
};

describe('19 处裁决：判成 fact 的必须经判据层、提示是 info', () => {
  for (const site of FACT_SITES) {
    it(site.label, () => assertFactSite(site));
  }

  // ── 退出登录：唯一一处「fact 本身可能为空」的站点 ─────────────────────
  //
  // 「本机 N 个会话仍保留、不会上传到其它账号」是界面表达不了的**事实**；
  // 而「已退出登录」本身是**结果**（账号区已经变成未登录了）⇒ 不该说。
  //
  // ⇒ 本机有会话 ⇒ 说出那个事实（且**逐字**沿用原句）；
  // ⇒ 本机 0 个会话 ⇒ 没有事实 ⇒ 沉默（与设置页那处「已退出登录」删除一致：
  //    同一个动作在两个地方必须一个口径）。
  //
  // ⚠️ 这就是「**条件 fact**」（2026-10-25 审阅后 Ruling 11 定案）：
  // 事实存在才出声，不是「无条件 fact」。
  it('退出登录：**条件 fact** —— 本机有会话才说那个事实（0 个会话 ⇒ 沉默）', async () => {
    const src = code('src/components/layout/HeaderDropdown.tsx');
    assert.match(
      src,
      /localCount\s*>\s*0\s*\?[^;]*不会上传到其它账号/,
      '「本机会话仍保留」这个事实必须以「本机有会话」为前提（有会话才说）',
    );
    // ⚠️ 2026-10-25 修复轮 2 / 3：这条 else 臂的断言**换过两次写法**，
    // 两次都被「看不见拼接」的同类假绿钻了空子：
    //   ① 修复轮 1：只覆盖**真值臂**（`[^;]*` 跨过那句短语后就不再看 else 臂）
    //      ⇒ 填回 `: '已退出登录'` 照样全绿；
    //   ② 修复轮 2：改成「`: ` 后面**紧跟**一个空字面量」的匹配
    //      ⇒ 看不见那个空字面量**后面还接了什么**：
    //      `: '' + '已退出登录'`（运行时 fact = '已退出登录'）照样命中。
    //
    // ⇒ 修复轮 3 改成**抽取** else 臂的整段源码，再用 `literalOf` 读它的字面量
    //   （拼接会被一起读出来 ⇒ `'' + '已退出登录'` 读成 '已退出登录' ⇒ 判红）。
    //
    //   （空串 / 空双引号 / 空模板 / undefined 都是「没有事实」，
    //     判据层对它们的处理完全一样 ⇒ 都算数，不把等价写法判成红。）
    assert.equal(
      literalOf(retainedFactElseArm()),
      '',
      'N=0 那一支（else 臂）的 fact 必须是空的 —— 有内容就会在「没有盲区」时重新出声',
    );
    assert.match(
      src,
      /hiddenFact:\s*retainedFact/,
      '判据层拿到的必须是那个事实本身（0 个会话时它是空 ⇒ 判成 silent）',
    );
    assert.match(
      src,
      /showToast\(`已退出登录。\$\{retainedFact\}`/,
      '说出口的那句必须逐字沿用原句（不得改写文案）',
    );
    // ⚠️ 2026-10-25 修复轮 2：光钉「判据层拿得到那个 fact」**不够** ——
    // 把 `if (fb.level !== 'silent')` 的包法去掉，空 fact 照样会出声。
    // ⇒ 复用同文件里「保存」那条 it 的接线断言写法（同一个助手，不另造一套）。
    assertFactWiredThroughFeedback(
      src,
      'retainedFact',
      'const retainedFact =',
      /showToast\(\s*`已退出登录。\$\{retainedFact\}`\s*,\s*'info'/,
    );
    // 「空 fact ⇒ 沉默」必须由**判据层本体**保证（不是调用点自己拍脑袋）。
    const { decideFeedback } = await import('@/core/feedbackPolicy');
    assert.equal(
      decideFeedback({ visibility: 'self-evident', hiddenFact: '' }).level,
      'silent',
      'N=0 那一支的 fact 是空串 ⇒ 判据层必须判成 silent（一个字都不说）',
    );
  });

  // ── 保存：三支里只有两支是「条件 fact」，纯「已保存」那支静默 ───────────
  //
  // ⚠️ 2026-10-25 审阅后 Ruling 12 定案：
  //   · 换云盘 ⇒ 装着「用户要做的下一步」⇒ 出声；
  //   · 切到自带存储 ⇒ 同上 ⇒ 出声；
  //   · **重存同一份云盘配置** ⇒ 原本只有「已保存」两个字，那是**纯结果播报**
  //     （库没变、值都还在界面里 ⇒ 界面自明）⇒ **静默**。
  //
  // 静默的实现方式：那一支的 **fact 留空** ⇒ 判据层规则②（`hiddenFact` 非空
  // 才算「有一件界面看不见的事」）不命中 ⇒ 落到规则④ ⇒ silent ⇒ 不出声。
  it('保存：**条件 fact** —— 纯「已保存」那一支静默，另两支（换云盘 / 切自带存储）出声', async () => {
    const src = code('src/components/sync/WebDavSettings.tsx');
    const branches = saveFactBranches();

    // ① 纯「已保存」那一支（`wasWebdav` = 重存同一份云盘配置）⇒ fact 必须为空
    assert.equal(
      literalOf(branches.wasWebdav),
      '',
      '「重存同一份云盘配置」那一支的 fact 必须是空的 —— 「已保存」是纯结果播报，界面自明 ⇒ 不出声',
    );
    // ② 另两支装着「用户要做的下一步」⇒ 必须非空（不许把三支一起清空）
    assert.notEqual(
      literalOf(branches.switchedLibrary),
      '',
      '换云盘那一支必须说出「用户要做的下一步」',
    );
    assert.notEqual(literalOf(branches.elseBranch), '', '切到自带存储那一支必须说出「用户要做的下一步」');

    // ③ 「空 fact ⇒ 沉默」由**判据层本体**保证（真判据层，不是这里自己判断）
    const { decideFeedback } = await import('@/core/feedbackPolicy');
    assert.equal(
      decideFeedback({ visibility: 'self-evident', hiddenFact: '' }).level,
      'silent',
      '空 fact 必须被判据层判成 silent —— 否则「不出声」就没有依据',
    );

    // ④ 接线：提示被判据结果包着 ⇒ fact 为空时那次 showToast 根本不会发生
    //   （与「退出登录」那条 it **共用同一个助手**，不另造一套写法）
    assertFactWiredThroughFeedback(
      src,
      'saveFact',
      'const saveFact =',
      /showToast\(\s*saveFact\s*,\s*'info'\s*\)/,
    );
  });
});

describe('19 处裁决：判成 silent 的那条提示必须不存在（且载体在）', () => {
  for (const site of SILENT_SITES) {
    it(site.label, () => assertSilentSite(site));
  }
});

describe('19 处裁决：删除全部的条数对不上时必须说出来', () => {
  it('判据：实际删的数与确认的数一致吗', async () => {
    const { deleteAllCountMatches } = await import('@/components/layout/deleteAllMessages');
    assert.equal(
      deleteAllCountMatches({ deletedCount: 7, confirmedCount: 7 }),
      true,
      '一致 ⇒ 列表空了就是回执，不必再说',
    );
    assert.equal(
      deleteAllCountMatches({ deletedCount: 7, confirmedCount: 8 }),
      false,
      '实际比确认的少 ⇒ 界面看不见这个差，必须说出来',
    );
    assert.equal(
      deleteAllCountMatches({ deletedCount: 0, confirmedCount: 8 }),
      false,
      '一个都没删 ⇒ 界面看不见，必须说出来',
    );
    assert.equal(
      deleteAllCountMatches({ deletedCount: 9, confirmedCount: 8 }),
      false,
      '实际比确认的多 ⇒ 界面看不见这个差，必须说出来',
    );
  });

  it('接线：提示被判据结果包着，且用的是同一份文案函数', () => {
    const handler = deleteAllHandlerSource();
    assert.match(handler, /deleteAllCountMatches\(/, '必须先判「实际删的数与确认的数一致吗」');
    assert.match(handler, /decideFeedback\(/, '必须经判据层裁决');
    assert.match(
      handler,
      /if\s*\(\s*[A-Za-z_$][\w$]*\.level\s*!==\s*'silent'\s*\)/,
      '提示必须被判据结果包着（一致时沉默，不一致时说话）',
    );
    assert.match(handler, /deleteAllSuccessMessage\(/, '文案仍由同一份文案函数产出');
    assert.equal(
      showToastType(handler, handler.indexOf('deleteAllSuccessMessage(')),
      'info',
      '这条提示的类型必须是 info（不是 success）',
    );
    // ⚠️ 上面四条只钉住了「出现过」，**没有一条钉住两臂的顺序** ⇒
    //    把「一致 ⇒ 空事实 / 对不上 ⇒ 有事实」对调，行为整个反过来而守卫全绿。
    // ⇒ 这里必须单独钉住**极性**。
    assertDeleteAllPolarity();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 四、Task 3：恢复类播报收口（锁定静默 / 锁定说明常驻 / 解锁静默）
// ══════════════════════════════════════════════════════════════════════════
//
// ── 这一节在防什么 ────────────────────────────────────────────────────────
//
// 「成功是状态，不是事件」落到恢复这条链上，是四件事：
//
//   ① **锁定组恢复 ⇒ 静默**：锁定组从不被消费 ⇒ 恢复后那张卡还在原地
//      ⇒ 界面自明 ⇒ 不必再说一遍「已打开 N 个标签页…仍保留在列表中」。
//   ② **锁定说明 ⇒ 常驻**：锁定改的是「恢复之后这个会话还在不在」这条
//      本产品**唯一**会被说反的规则 ⇒ 这句话必须**随时可查** ⇒ 它住在
//      卡片上（`lockDisclosureText`），而不是一条会消失的 toast。
//   ③ **解锁 ⇒ 静默**：那行消失本身就是反馈。
//   ④ **撤销提示 ⇒ 中性**：带退路的提示仍然要有，但不再庆祝。
//
// ⚠️ **静默不等于「把失败也删掉」**：成功门（`success !== true` 的判定）
//    与失败路径的出声**一个字都不许动** —— 静默的是「成功」，
//    「打不开」仍然必须明说（否则「点了没反应」与「已打开」分不出来）。
//
// ⚠️ **不许只断言「没有提示」**：那是零检测力（把整条分支删掉也照样绿）。
//    ⇒ 下面每一条静默断言都**同时**钉住它的**根据**：
//      · 锁定组从不被消费（`consumeSession` 早退）⇒ 所以「卡片还在」；
//      · 锁定分支不删行 ⇒ 所以「那条记录还在」；
//      · 成功门仍在 + 失败路径出声 ⇒ 所以「静默的是成功，不是失败」。
//
// ── 定位一律用「唯一字符串 + 周边代码」，不钉行号 ──────────────────────────

const TAB_GROUP = 'src/components/tabs/TabGroup.tsx';
const SEARCH_LIST = 'src/components/search/SearchResultList.tsx';

/**
 * 解析一个 .tsx 源文件（按 TSX 解析，JSX 与泛型都不会误判）。
 *
 * ── 2026-10-25 修复轮 1：**先剥注释再解析** ─────────────────────────────
 *
 * 原来直接解析原始源码 ⇒ AST 的 `getText()` 会把注释一起带出来 ⇒
 * 本文件那几条 `assert.match(分支, /showRestoreError\(/)` /
 * `doesNotMatch(分支, /showToast\(/)` 理论上能被**注释里的同形文本**满足或误伤
 * （本仓「守卫钉的是注释不是行为」那一类假绿）。
 *
 * 剥注释后再解析，结构不变（顶层语句数、`handleOpenTab` / `consumeSession` /
 * `handleToggleLock` 这些声明都还在 —— 已实测），但判据只看**真的会跑的代码**。
 */
const parseTsx = (rel: string): ts.SourceFile =>
  ts.createSourceFile(
    rel,
    stripComments(read(rel)),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

/**
 * 找出某个调用（可按**整段调用文本**里的标记再筛一层）。
 *
 * 用 AST 而不是正则：正则看不见「实参里套了一个模板串」这种情况，
 * 而这里要判的恰恰是「那一次调用到底传了什么」。
 */
const findCall = (
  source: ts.SourceFile,
  callee: string,
  marker?: string,
): ts.CallExpression | null => {
  let found: ts.CallExpression | null = null;
  const visit = (node: ts.Node): void => {
    if (
      !found &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === callee
    ) {
      if (!marker || node.getText(source).includes(marker)) found = node;
    }
    node.forEachChild(visit);
  };
  visit(source);
  return found;
};

/** 收集一棵子树里某个名字的所有调用。 */
const callsIn = (node: ts.Node, callee: string): ts.CallExpression[] => {
  const out: ts.CallExpression[] = [];
  const visit = (current: ts.Node): void => {
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      current.expression.text === callee
    ) {
      out.push(current);
    }
    current.forEachChild(visit);
  };
  visit(node);
  return out;
};

/** 一个节点**最近的那层 if 祖先**。 */
const enclosingIf = (node: ts.Node): ts.IfStatement | null => {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isIfStatement(current)) return current;
    current = current.parent;
  }
  return null;
};

/** 一个节点**所有** if 祖先的条件文本（由内到外）。 */
const ifConditions = (node: ts.Node): string[] => {
  const out: string[] = [];
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isIfStatement(current)) {
      out.push(current.expression.getText(current.getSourceFile()));
    }
    current = current.parent;
  }
  return out;
};

/** 一个节点所在的那个函数体（箭头函数 / 函数表达式 / 函数声明）。 */
const enclosingFunction = (node: ts.Node): ts.Node | null => {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current) ||
      ts.isFunctionDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
};

/** 某个变量的**初始化表达式节点**（找不到返回 null）。 */
const initializerOf = (source: ts.SourceFile, name: string): ts.Expression | null => {
  let found: ts.Expression | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      found = node.initializer;
    }
    node.forEachChild(visit);
  };
  visit(source);
  return found;
};

/** 这个调用是不是被赋给了某个变量？那个变量叫什么。 */
const assignedNameOf = (source: ts.SourceFile, call: ts.CallExpression): string | null => {
  let found: string | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer === call
    ) {
      found = node.name.text;
    }
    node.forEachChild(visit);
  };
  visit(source);
  return found;
};

/** 某个名字有没有出现在 JSX 表达式里（= 它被渲染出来了）。 */
const jsxUses = (source: ts.SourceFile, name: string): boolean => {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      !found &&
      ts.isJsxExpression(node) &&
      node.expression &&
      node.expression.getText(source).includes(name)
    ) {
      found = true;
    }
    node.forEachChild(visit);
  };
  visit(source);
  return found;
};

/**
 * 这个表达式是不是（直接或经一个局部变量）**那个事实**。
 *
 * 允许两种写法（都是等价的）：
 *   · `hiddenFact: moveEmptiesSessionMessage({…})`（直接调用）
 *   · `hiddenFact: moveFact`（先落到局部变量上）
 *
 * ⚠️ 不能只看「文本里出现了那个名字」—— 注释里也可能出现 ⇒ 假绿。
 */
const refersTo = (source: ts.SourceFile, expr: ts.Expression, callee: string): boolean => {
  if (expr.getText(source).includes(callee)) return true;
  if (ts.isIdentifier(expr)) {
    const init = initializerOf(source, expr.text);
    if (init) return init.getText(source).includes(callee);
  }
  return false;
};

/**
 * 抽出 `handleOpenTab` 里 `if (group.isLocked) { … }` 这一支的源码。
 *
 * 用括号配平而不是正则截断：分支里有嵌套的回调（`.then(() => {…})`），
 * 正则会在第一个 `}` 处就停下，截出来的不是完整的分支。
 * （实现照抄 tests/restoreFeedbackHonesty.test.ts 的同名助手。）
 */
const extractLockedBranch = (src: string): string | null => {
  const fnStart = src.indexOf('const handleOpenTab');
  if (fnStart < 0) return null;
  const guardAt = src.indexOf('if (group.isLocked)', fnStart);
  if (guardAt < 0) return null;
  const open = src.indexOf('{', guardAt);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
};

/**
 * 抽 `handleOpenTab` 里 `if (group.isLocked) { … }` 那一支的**语法节点**。
 *
 * 与 `extractLockedBranch`（文本版）的区别：文本版只能做「有没有出现过」这种
 * 包含判断；要判「**成功门那一支**里有没有出声」就必须拿到 AST ——
 * 那一支的边界只有解析器知道（缩进与括号在文本里会骗人）。
 *
 * 实现：找到 `handleOpenTab` 的初始化箭头函数 → 在它的**第一层语句**里找
 * `if (group.isLocked)` → 返回那个 `IfStatement` 的 then 分支。
 */
const extractLockedBranchNode = (source: ts.SourceFile): ts.Statement | null => {
  const init = initializerOf(source, 'handleOpenTab');
  if (!init) return null;
  // 两种声明形状都要认：`useCallback((tab) => {…})`（列表页）与裸箭头函数（搜索页）。
  const fn: ts.ArrowFunction | ts.FunctionExpression | null = ts.isArrowFunction(init)
    ? init
    : ts.isFunctionExpression(init)
      ? init
      : ts.isCallExpression(init)
        ? ((init.arguments.find(arg => ts.isArrowFunction(arg)) as ts.ArrowFunction | undefined) ??
          null)
        : null;
  if (!fn || !ts.isBlock(fn.body)) return null;
  for (const statement of fn.body.statements) {
    if (!ts.isIfStatement(statement)) continue;
    // ⚠️ 条件必须**恰好**是 `group.isLocked`。
    //    早先写的是 `/group\s*\.\s*isLocked/`（包含匹配）⇒ 先命中的是
    //    `if (!guard.tryAcquire(tab.id, group.isLocked))` 那个去重守卫
    //    （它只是**传了** group.isLocked 当参数）⇒ 取到的不是锁定分支。
    //    症状：搜索页那条「成功门判到失败的那一支里必须真的出声」报
    //    「锁定分支必须判过成功门」—— 红在一个正确的实现上。
    const cond = statement.expression.getText(source).replace(/\s+/g, '');
    if (cond === 'group.isLocked') return statement.thenStatement;
  }
  return null;
};

/** 某个调用是不是「走错误通道」（第三个实参里 `type: 'error'`）。 */
const isErrorTypeOption = (call: ts.CallExpression): boolean => {
  const arg = call.arguments[2];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return false;
  return arg.properties.some(
    property =>
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === 'type' &&
      ts.isStringLiteral(property.initializer) &&
      property.initializer.text === 'error',
  );
};

describe('Task 3：锁定组恢复静默（但成功门与失败出口一个字都没动）', () => {
  for (const file of [TAB_GROUP, SEARCH_LIST]) {
    it(`${file}：点开单标签的锁定分支静默`, () => {
      // 剥注释后再抽分支：注释里的 `showRestoreError(` / `showToast(` 不算数
      // （2026-10-25 修复轮 1 —— 否则守卫钉的是注释，不是行为）。
      const src = code(file);
      const branch = extractLockedBranch(src);
      assert.ok(branch, `${file}：应能找到 handleOpenTab 里的锁定分支`);
      assert.doesNotMatch(
        branch,
        /showToast\(|showRestoreSuccessMessage|showConsumeToast/,
        `${file}：锁定分支必须静默 —— 锁定组从不被消费 ⇒ 那条记录还在 ⇒ 界面自明`,
      );
    });

    it(`${file}：锁定分支的成功门与失败出口仍在（静默的是成功，不是失败）`, () => {
      // 剥注释后再抽分支：注释里的 `showRestoreError(` / `showToast(` 不算数
      // （2026-10-25 修复轮 1 —— 否则守卫钉的是注释，不是行为）。
      const src = code(file);
      const branch = extractLockedBranch(src);
      assert.ok(branch, `${file}：应能找到 handleOpenTab 里的锁定分支`);
      assert.match(
        branch,
        /success\s*!==\s*true|success\s*===\s*false/,
        `${file}：锁定分支必须判过成功门 —— SW 拒开时界面不许谎报「已打开」`,
      );
      assert.match(
        branch,
        /showRestoreError\(/,
        `${file}：锁定分支的失败路径必须出声（打不开必须明说，记录原样保留）`,
      );
    });

    it(`${file}：成功门**判到失败的那一支**里必须真的出声（不只是分支里某处有 showRestoreError）`, () => {
      // ── 2026-10-25 Task 4：这条守卫补的是「上一条的零检测力」──────────────
      //
      // 上一条只断言「锁定分支里出现过 `showRestoreError(`」。而锁定分支里
      // **有两处**失败出口（TabGroup：成功门那一支 + `.catch` 那一支；
      // SearchResultList：只有成功门那一支）⇒ 把**成功门那一支**的
      // `showRestoreError` 删掉，上一条照样绿（另一处还在），
      // 而 SW 拒开时界面就变成「点了没反应」—— 正是本守卫要防的那件事。
      //
      // ⇒ 用 AST 找到那层判 `success` 的 `if`，断言**它的 then 分支**里
      //   真的调了 `showRestoreError`（失败路径与成功门是同一个 if 的两半）。
      const source = parseTsx(file);
      const branch = extractLockedBranchNode(source);
      assert.ok(branch, `${file}：应能找到 handleOpenTab 里的锁定分支`);

      let gate: ts.IfStatement | null = null;
      const visit = (node: ts.Node): void => {
        if (
          !gate &&
          ts.isIfStatement(node) &&
          /success\s*!==\s*true|success\s*===\s*false/.test(node.expression.getText(source))
        ) {
          gate = node;
        }
        node.forEachChild(visit);
      };
      visit(branch!);
      assert.ok(gate, `${file}：锁定分支必须判过成功门 —— SW 拒开时界面不许谎报「已打开」`);

      const thenCalls = callsIn((gate as ts.IfStatement).thenStatement, 'showRestoreError');
      assert.ok(
        thenCalls.length > 0,
        `${file}：成功门判到失败时，那一支里必须真的出声 —— 打不开必须明说（记录原样保留）`,
      );
    });

    it(`${file}：锁定分支不删行（那条记录还在 ⇒ 所以不必说）`, () => {
      // 剥注释后再抽分支：注释里的 `showRestoreError(` / `showToast(` 不算数
      // （2026-10-25 修复轮 1 —— 否则守卫钉的是注释，不是行为）。
      const src = code(file);
      const branch = extractLockedBranch(src);
      assert.ok(branch, `${file}：应能找到 handleOpenTab 里的锁定分支`);
      assert.doesNotMatch(
        branch,
        /deleteTabAndSync/,
        `${file}：锁定分支不许删记录（锁定 = 组内不发生删除）`,
      );
    });
  }

  it('锁定 ⇒ 卡片还在：consumeSession 对锁定组**真的早退**（return，不 dispatch 删除）', () => {
    // ── 2026-10-25 修复轮 1：这条守卫原来抓不住真正的破口 ──────────────────
    //
    // 原实现有三处漏：
    //   ① 只用 `src.indexOf('\n  };', at)` 切函数体 —— 那个锚点在 TabGroup.tsx 里
    //      匹配不到 `consumeSession` 的真实结尾（真实结尾是 4 空格 `    };`），
    //      切出来的其实是「从 consumeSession 到文件末尾」⇒ `deleteAt > lockAt`
    //      会被这段范围里**任何**一处 `dispatch(deleteGroup(` 满足。
    //   ② 从没断言早退那一支**真的 return** —— 把 `return;` 删掉，锁定组于是
    //      穿透到 `dispatch(deleteGroup(group.id))`（**锁定组真的会被消费**），
    //      三条断言照样全绿。
    //   ③ 早退那一支用 `body.indexOf('}', lockAt)` 切 —— 那是**代码里第一个 `}`**，
    //      不是这一支的结尾。
    //
    // ⇒ 现在全部改用 AST：取 `consumeSession` 的**函数节点**，再看它函数体里
    //   那层 `if (group.isLocked)` 的**那一支**（then 分支），断言它末尾有
    //   `return;`，且这一支里没有任何 `dispatch(...)`。
    const source = parseTsx(TAB_GROUP);
    const fn = initializerOf(source, 'consumeSession');
    assert.ok(fn, '应能找到 consumeSession');
    assert.ok(
      ts.isArrowFunction(fn!),
      'consumeSession 必须还是一个函数（不然下面取不到它的函数体）',
    );
    const fnBody = (fn as ts.ArrowFunction).body;
    assert.ok(ts.isBlock(fnBody), 'consumeSession 必须是块体（要能 return）');

    // 函数体里**第一层**的那个 `if (group.isLocked)`
    const lockIf = fnBody.statements.find(
      (statement): statement is ts.IfStatement =>
        ts.isIfStatement(statement) &&
        /group\s*\.\s*isLocked/.test(statement.expression.getText(source)),
    );
    assert.ok(lockIf, '锁定早退必须还在（锁定组恢复后卡片还在）');

    // ① 早退那一支**真的 return**（这一条才是「卡片还在」的根据）
    const thenText = lockIf!.thenStatement.getText(source);
    assert.match(
      thenText,
      /\breturn\b/,
      '锁定那一支必须**真的 return** —— 少了它，锁定组会穿透到下面的 dispatch，' +
        '锁定组就真的会被消费（那正是「卡片还在」这条根据的破口）',
    );
    assert.doesNotMatch(
      thenText,
      /dispatch\(/,
      '锁定那一支不许有 dispatch（一条记录都不删）',
    );

    // ② 删除调用必须在 if **之外**（也就是「锁定那一支走不到它」）
    //
    // 用 AST 祖先链判，不用文本包含：文本包含会被「同一段源码出现两次」
    // 或「注释里也写了这句」骗过去。
    const deleteCalls = callsIn(fnBody, 'dispatch');
    assert.ok(deleteCalls.length > 0, '未锁定那条必须真的 dispatch 删除（否则恢复 = 不消费）');
    for (const call of deleteCalls) {
      let ancestor: ts.Node | undefined = call.parent;
      while (ancestor && ancestor !== fnBody) {
        assert.notEqual(
          ancestor,
          lockIf!.thenStatement,
          'dispatch 不许落在锁定那一支里 —— 锁定组恢复后卡片必须还在',
        );
        ancestor = ancestor.parent;
      }
    }

    // ③ 删除还必须排在锁定早退**之后** —— 顺序本身就是判据。
    //
    // 只判「删除不在锁定那一支里」是不够的：把 `dispatch(deleteGroup(group.id))`
    // 提到 `if (group.isLocked)` **之前**，锁定组照样会被消费（早退永远走不到），
    // 而上面那几条断言全都还是绿的（它们只问「在不在 then 支里」）。
    // ⇒ 用 AST 的位置（`getStart` / `getEnd`）钉顺序，不用文本 indexOf：
    //   文本在注释 / 同形片段上会骗人。
    for (const call of deleteCalls) {
      assert.ok(
        call.getStart(source) > lockIf!.getEnd(),
        '删除必须在锁定早退之后 —— 提到前面就意味着锁定组会被消费',
      );
    }
  });

  for (const file of [TAB_GROUP, SEARCH_LIST]) {
    it(`${file}：整组恢复的成功播报经判据层裁决（锁定 ⇒ 空 fact ⇒ 静默）`, async () => {
      // ── 2026-10-25 终审修复：门从「组件手写 if」搬进判据层 ────────────────
      //
      // 原实现是 `if (!group.isLocked) showConsumeToast(...)` —— 组件自己
      // 拍脑袋决定「说不说」，绕过了规格 §4.3 要求的那道判据层。
      // 现在改成 `decideFeedback(...)` + `if (fb.level !== 'silent')`：
      //   锁定 ⇒ 卡片还在（界面自明）⇒ 空 fact ⇒ 判据层判 silent；
      //   未锁定 ⇒ 那条记录已被消费、界面说不出来 ⇒ fact。
      //
      // ⚠️ 这里**不用正则钉三元的形状**（本分支已被「正则看不见拼接和模板串」
      //    坑过两次）：抽 AST 节点，用 `literalOf()` 读字面量内容、
      //    用 `refersTo()` 认「来源是哪个文案函数」。
      const source = parseTsx(file);
      const call = findCall(source, 'showConsumeToast', 'restoreGroupSuccessMessage');
      assert.ok(call, `${file}：整组恢复的成功播报必须还在（未锁定那条）`);

      // ① 「说不说」真的交给了判据层：同一个回包处理函数里有一次
      //    `decideFeedback({ … hiddenFact: <fact> … })`，且结果落在变量上。
      const fn = enclosingFunction(call!);
      assert.ok(fn, `${file}：那条播报必须在一个回包处理函数里`);
      const decisions = callsIn(fn!, 'decideFeedback');
      assert.equal(
        decisions.length,
        1,
        `${file}：整组恢复必须恰有一次判据层裁决（组件不许自己判「说不说」）`,
      );
      const decision = decisions[0]!;
      const decisionInput = decision.arguments[0];
      assert.ok(
        decisionInput && ts.isObjectLiteralExpression(decisionInput),
        `${file}：判据层必须收到一个对象（visibility / hiddenFact）`,
      );
      const propertyInitializer = (name: string): ts.Expression | null => {
        const property = (decisionInput as ts.ObjectLiteralExpression).properties.find(
          candidate =>
            ts.isPropertyAssignment(candidate) &&
            ts.isIdentifier(candidate.name) &&
            candidate.name.text === name,
        );
        return property && ts.isPropertyAssignment(property) ? property.initializer : null;
      };
      const visibility = propertyInitializer('visibility');
      assert.ok(visibility, `${file}：判据层必须显式说明结果可不可见`);
      assert.equal(
        literalOf(visibility!.getText(source)),
        'self-evident',
        `${file}：结果（卡片消失 / 窗口开了）界面自明 —— visibility 必须说对`,
      );
      const hiddenFact = propertyInitializer('hiddenFact');
      assert.ok(hiddenFact, `${file}：判据层必须拿到那条界面说不出来的事实`);

      // ② fact 的来源必须随锁定态分叉：**锁定 ⇒ 空**（判据层判 silent），
      //    未锁定 ⇒ 就是那句恢复成功文案（非空 ⇒ 判据层判 fact）。
      //    `hiddenFact` 直接写三元、或先落到变量上再传，两种写法都认。
      const factInit = ts.isIdentifier(hiddenFact!)
        ? initializerOf(source, hiddenFact!.text) ?? hiddenFact!
        : hiddenFact!;
      assert.ok(
        ts.isConditionalExpression(factInit),
        `${file}：fact 必须按「锁没锁」分叉（锁定那条卡片还在 ⇒ 空事实）`,
      );
      const conditional = factInit as ts.ConditionalExpression;
      assert.equal(
        conditional.condition.getText(source).replace(/\s+/g, ''),
        'group.isLocked',
        `${file}：分叉条件必须是 group.isLocked（不是别的开关）`,
      );
      // ⚠️ 这一条**不能**用 `literalOf(...) === ''` 单独判 —— literalOf 对
      // **不含引号字面量**的表达式（例如一个变量名）也返回 '' ⇒ 把锁定臂写成
      // `: lockedSay`（lockedSay = '已恢复，该会话仍保留在列表中'）会让这条断言假绿，
      // 而锁定组会重新出声。实测：那种写法下 9 个相关守卫文件**全绿**。
      // ⇒ 锁定臂必须是真的空字面量。变量中转、拼接、模板占位一律判红。
      const whenTrue = conditional.whenTrue;
      const isEmptyLiteral =
        (ts.isStringLiteral(whenTrue) ||
          ts.isNoSubstitutionTemplateLiteral(whenTrue)) &&
        whenTrue.text === '';
      const isVoidish =
        (ts.isIdentifier(whenTrue) && whenTrue.text === 'undefined') ||
        (ts.isVoidExpression(whenTrue) &&
          ts.isNumericLiteral(whenTrue.expression) &&
          whenTrue.expression.text === '0');
      assert.ok(
        isEmptyLiteral || isVoidish,
        `${file}：锁定 ⇒ fact 必须为空 —— 只认真的空字面量（'' / "" / \`\` / undefined / void 0）；`
          + '变量中转或拼接会让锁定组重新出声 ⇒ 一律判红',
      );
      const { restoreGroupSuccessMessage } = await import(
        '@/components/tabs/restoreFeedbackCopy'
      );
      assert.notEqual(
        restoreGroupSuccessMessage(1, false),
        '',
        '文案函数必须产出非空事实（空字符串会被判据层判成 silent）',
      );
      assert.ok(
        refersTo(source, conditional.whenFalse, 'restoreGroupSuccessMessage'),
        `${file}：未锁定 ⇒ fact 必须是那句恢复成功文案（非空 ⇒ 判据层判 fact）`,
      );

      // ③ 播报真的被**判据结果**包着 —— 不是「算了一下就扔掉」。
      const assignedName = assignedNameOf(source, decision);
      assert.ok(assignedName, `${file}：判据结果必须落在一个变量上（后续要拿它做门）`);
      const guard = enclosingIf(call!);
      assert.ok(guard, `${file}：那条播报必须在判据结果的条件分支里`);
      assert.equal(
        guard!.expression.getText(source).replace(/\s+/g, ''),
        `${assignedName}.level!=='silent'`,
        `${file}：播报只许在判据结果不是 silent 时发生（fact 为空 ⇒ 不弹）`,
      );
      assert.ok(
        decision.getStart(source) < call!.getStart(source),
        `${file}：必须先裁决、再播报（判据结果不可能来自后面）`,
      );

      // ④ 撤销凭据一个字都不许丢（不可逆消费的唯一退路）。
      const spec = call!.arguments[1];
      assert.ok(
        spec && ts.isObjectLiteralExpression(spec),
        `${file}：整组恢复那条必须挂上撤销凭据（不可逆的删除必须有退路）`,
      );
      assert.match(
        spec!.getText(source),
        /\bgroup\b/,
        `${file}：撤销凭据必须带消费前的整组快照（{ group }）`,
      );
    });

    it(`${file}：「部分成功」那条仍在条件之外、照旧出声（锁定组也必须知道）`, () => {
      const source = parseTsx(file);
      const call = findCall(source, 'showConsumeToast', '在当前设备无法打开');
      assert.ok(
        call,
        `${file}：「部分成功」那条提示必须还在 —— 「有 N 个打不开」界面表达不了`,
      );
      assert.ok(
        isErrorTypeOption(call!),
        `${file}：「部分成功」那条必须走错误通道（部分成功不是全成功）`,
      );
      for (const cond of ifConditions(call!)) {
        assert.doesNotMatch(
          cond,
          /isLocked/,
          `${file}：「部分成功」那条不许被锁定条件包住 —— 锁定组也必须知道有打不开的`,
        );
      }
    });

    it(`${file}：成功门仍在（判过 success 才可能走到那条成功播报）`, () => {
      const source = parseTsx(file);
      const call = findCall(source, 'showConsumeToast', 'restoreGroupSuccessMessage');
      assert.ok(call, `${file}：整组恢复的成功播报必须还在`);
      const fn = enclosingFunction(call!);
      assert.ok(fn, `${file}：那条播报必须在一个回包处理函数里`);
      const fnText = fn!.getText(source);
      // 判据取「**播报之前**的那段源码」—— 不能拿整段找（注释里也可能出现
      // success 这个词 ⇒ 那样判出来的是「某处出现过」，不是「先判后播」）。
      const beforeToast = fnText.slice(0, call!.getStart(source) - fn!.getStart(source));
      const gateAt = beforeToast.search(/success\s*!==\s*true|success\s*===\s*false/);
      assert.ok(gateAt >= 0, `${file}：回包必须显式判过 success`);
      // 失败路径必须出声（整组恢复这条路历史上走的是 showDeleteError，
      // 单标签那条走 showRestoreError —— 两个都算「失败在说话」）。
      assert.match(
        fnText,
        /show(?:Restore|Delete)Error\(/,
        `${file}：失败路径必须出声（打不开必须明说，记录原样保留）`,
      );
    });
  }

  it('未锁定必须有退路：整组恢复与点开单标签都挂着撤销凭据', () => {
    for (const file of [TAB_GROUP, SEARCH_LIST]) {
      const source = parseTsx(file);
      const groupCall = findCall(source, 'showConsumeToast', 'restoreGroupSuccessMessage');
      assert.ok(groupCall, `${file}：整组恢复的成功播报必须还在`);
      const groupSpec = groupCall!.arguments[1];
      assert.ok(
        groupSpec && ts.isObjectLiteralExpression(groupSpec),
        `${file}：整组恢复那条必须挂上撤销凭据（不可逆的删除必须有退路）`,
      );
      const singleCall = findCall(source, 'showConsumeToast', 'openSingleTabSuccessMessage');
      assert.ok(singleCall, `${file}：点开单标签那条播报必须还在`);
      const singleSpec = singleCall!.arguments[1];
      assert.ok(
        singleSpec && ts.isObjectLiteralExpression(singleSpec),
        `${file}：点开单标签那条必须挂上撤销凭据`,
      );
      const specText = singleSpec.getText(source);
      assert.match(specText, /consumedTabId/, `${file}：凭据必须指明被消费的是哪一条`);
      assert.match(
        specText,
        /consumedIndex/,
        `${file}：撤销必须把标签插回原来的位置，不是追加到末尾`,
      );
    }
  });
});

describe('Task 3：锁定说明常驻在卡片上 + 解锁静默', () => {
  it('锁定说明的文案必须含三个要素（说清状态 / 后果 / 界面不会告诉你的那条）', async () => {
    const { lockDisclosureText } = await import('@/components/tabs/lockFeedbackCopy');
    const text = lockDisclosureText(true);
    assert.ok(text, '锁定时必须有那行说明');
    assert.match(text, /已锁定/, '① 必须说清状态');
    assert.match(
      text,
      /恢复后.*保留.*列表/,
      '② 必须说清「恢复后保留在列表」（锁定唯一改变的那条规则）',
    );
    assert.match(
      text,
      /不参与.*清理重复标签/,
      '③ 必须说清不参与「清理重复标签」',
    );
    assert.match(
      text,
      /拖到别的会话/,
      '③ 必须说清不可拖到别的会话（README:43 承诺过，界面不会告诉你）',
    );
    assert.equal(
      lockDisclosureText(false),
      null,
      '未锁定不渲染那行（那行消失就是「已解锁」的反馈）',
    );
  });

  it('那行说明必须真的渲染在卡片上（不是算了不用）', () => {
    const source = parseTsx(TAB_GROUP);
    const call = findCall(source, 'lockDisclosureText');
    assert.ok(call, 'TabGroup 必须用 lockDisclosureText 驱动那行说明');
    assert.equal(
      call!.arguments[0]?.getText(source),
      'group.isLocked',
      '那行说明必须按「这个会话锁没锁」渲染',
    );
    const name = assignedNameOf(source, call!);
    assert.ok(name, '那行说明的结果必须先落到一个变量上');
    assert.ok(
      jsxUses(source, name!),
      '那行说明必须真的渲染出来（算了不用 = 没有那行）',
    );
  });

  it('锁定 / 解锁的切换处只许播失败，不许播成功', () => {
    const source = parseTsx(TAB_GROUP);
    const handler = initializerOf(source, 'handleToggleLock');
    assert.ok(handler, '应能找到 handleToggleLock');
    const toasts = callsIn(handler!, 'showToast');
    assert.ok(toasts.length > 0, '切换锁定的失败路径必须仍然出声（失败是事件）');
    for (const call of toasts) {
      const type = call.arguments[1];
      assert.ok(
        type && ts.isStringLiteral(type) && type.text === 'error',
        '锁定/解锁的切换处只许播失败（成功那一句改由卡片常驻行承担）',
      );
    }
  });

  it('旧的「锁定/解锁」toast 文案已经没了（改由卡片常驻行承担）', () => {
    // 剥注释后再判：这两个文件的**注释里**本来就会提到 `lockToggleMessage`
    // （「原先这里调的是 lockToggleMessage」）⇒ 拿原始源码判 `doesNotMatch`
    // 会被注释**误伤**成假红（2026-10-25 修复轮 1）。
    assert.doesNotMatch(
      code(TAB_GROUP),
      /lockToggleMessage/,
      '锁定提示不再是一条 toast（它常驻在卡片上）',
    );
    assert.doesNotMatch(
      code('src/components/tabs/lockFeedbackCopy.ts'),
      /lockToggleMessage/,
      'lockToggleMessage 必须删掉（两个分支都不再需要它）',
    );
  });
});

describe('Task 3：新增的 fact 站点都必须经判据层裁决', () => {
  const FACT_SITES_NEW: Array<{ file: string; copy: string; toast: string }> = [
    {
      file: TAB_GROUP,
      copy: 'openSingleTabSuccessMessage',
      toast: 'showConsumeToast',
    },
    {
      file: TAB_GROUP,
      copy: 'moveEmptiesSessionMessage',
      toast: 'showRestoreSuccessMessage',
    },
    {
      file: SEARCH_LIST,
      copy: 'openSingleTabSuccessMessage',
      toast: 'showConsumeToast',
    },
    {
      file: SEARCH_LIST,
      copy: 'restoreAllSearchSuccessMessage',
      toast: 'showConsumeToast',
    },
  ];

  for (const site of FACT_SITES_NEW) {
    it(`${site.file}：${site.copy} 那条必须经 decideFeedback 裁决`, () => {
      const source = parseTsx(site.file);
      const copyCall = findCall(source, site.copy);
      assert.ok(copyCall, `${site.file}：应能找到那一句事实的出处（${site.copy}）`);
      const fn = enclosingFunction(copyCall!);
      assert.ok(fn, `${site.file}：那一句事实必须在一个函数体里`);

      // ① 判据层拿到的必须就是那一句事实本身。
      const decideCalls = callsIn(fn!, 'decideFeedback');
      assert.ok(
        decideCalls.length > 0,
        `${site.file}：那一次播报必须先经判据层裁决（不许凭感觉直接播）`,
      );
      const fbCall = decideCalls[0];
      const fbObj = fbCall.arguments.find(arg => ts.isObjectLiteralExpression(arg));
      assert.ok(fbObj, `${site.file}：判据层必须拿到那个事实本身（hiddenFact）`);
      let hiddenFactExpr: ts.Expression | null = null;
      for (const prop of (fbObj as ts.ObjectLiteralExpression).properties) {
        if (
          ts.isPropertyAssignment(prop) &&
          ts.isIdentifier(prop.name) &&
          prop.name.text === 'hiddenFact'
        ) {
          hiddenFactExpr = prop.initializer;
        }
      }
      assert.ok(hiddenFactExpr, `${site.file}：判据层必须拿到那个事实本身（hiddenFact）`);
      assert.ok(
        refersTo(source, hiddenFactExpr!, site.copy),
        `${site.file}：hiddenFact 必须是那一句事实（不是别的）`,
      );

      // ② 那一次播报必须被「判据结果不是静默」包着。
      const toastCalls = callsIn(fn!, site.toast);
      assert.ok(toastCalls.length > 0, `${site.file}：应能找到那一次播报`);
      const toastCall = toastCalls[0];
      assert.ok(
        decideCalls[0].getStart(source) < toastCall.getStart(source),
        `${site.file}：判据层必须在播报之前`,
      );
      // ③ 播出来的那一句必须就是那一句事实。
      const toastArg = toastCall.arguments[0];
      assert.ok(
        toastArg && refersTo(source, toastArg, site.copy),
        `${site.file}：那一次播报必须播的就是那一句事实`,
      );
      const guard = enclosingIf(toastCall);
      assert.ok(
        guard,
        `${site.file}：那一次播报必须被判据结果包着（fact 为空 ⇒ silent ⇒ 不播）`,
      );
      const cond = guard!.expression.getText(source).replace(/\s+/g, '');
      assert.match(
        cond,
        /\.level!=='silent'/,
        `${site.file}：那一次播报必须被「判据结果不是静默」包着（实际条件：${cond}）`,
      );
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 五、Task 4 Step 1：19 处裁决的**显式登记表**
// ══════════════════════════════════════════════════════════════════════════
//
// ── 这一节在防什么 ────────────────────────────────────────────────────────
//
// 上面那三节把 19 处**逐个**钉了一遍，但它们分散在四个 `describe` 里，
// 「到底有几处、每处是哪一档」这件事本身**没有任何一处**被钉住。
// ⇒ 两个后果：
//   ① 有人**悄悄加回来**第 20 处 `showToast(..., 'info')` 成功播报 ⇒ 全绿
//      （它不违反任何一条既有断言：那些断言只钉「登记过的那几处」）；
//   ② 有人把某一处**从表里删掉** ⇒ 那条 `it` 跟着消失 ⇒ 全绿
//      （`node:test` 不会因为「少了一个 `it`」而红）。
//
// ⇒ 这一节是一张**显式登记表**：19 行，每行写死「文件 + 锚点 + 裁决档 + 判据」，
//   并断言「表里恰好 19 行」「每一行的档位与数量都钉死」。
//   上面那几节的逐条 `it` 负责**逐条判**，这一节负责**不许增减、不许改档**。
//
// ── 为什么这张表里不放「行号」──────────────────────────────────────────────
//
// 行号会随别的改动漂（Task 3 就把 `TabGroup.tsx` 的锁定分支整体挪过一次）。
// 锚点是**语义唯一串**（一句文案 / 一个函数名），它跟着行为走，不跟着排版走。
//
// ── 19 行的来源 ───────────────────────────────────────────────────────────
//
// 规格 §5.1 的 19 处 `success` 直接调用（`docs/superpowers/specs/2026-10-25-quiet-success-design.md`）。
// 其中 #19（`TabGroup.tsx` 的锁定说明）由 Task 3 改成**卡片常驻行**
// （`lockDisclosureText`）⇒ 本表把它登记成「常驻」档，并钉住「常驻载体真的在」。

/** 裁决档。`fact` / `silent` 是规格 §5.1 的两种主档；`conditional` / `persistent` 见下。 */
type Ruling = 'fact' | 'silent' | 'conditional' | 'persistent';

interface LedgerRow {
  /** 规格 §5.1 的序号（1–19）—— 这是**对外编号**，删行/换行会在这里露馅。 */
  readonly index: number;
  readonly ruling: Ruling;
  /** 人读的一句话（报告与失败信息里用）。 */
  readonly label: string;
  /** 这一行钉在哪（每条都返回 void；失败时 assert 抛错）。 */
  readonly check: () => void;
}

/**
 * 取 `restoreFeedbackCopy.ts` 里某个导出函数的**函数体文本**（箭头函数块体）。
 *
 * ⚠️ 用 AST 取，不用正则：`restoreGroupSuccessMessage` 的函数体里有嵌套模板串
 * （`${opened}。该会话已${restoreOutcomePhrase(false)}…`）—— 正则会在第一个
 * `${` 或第一个 `;` 处停下，切出来的不是完整函数体。
 */
const exportedFunctionBody = (rel: string, name: string): string => {
  const source = parseTsx(rel);
  const init = initializerOf(source, name);
  assert.ok(init, `${rel}：找不到 ${name} 的声明`);
  assert.ok(ts.isArrowFunction(init!), `${rel}：${name} 必须是箭头函数`);
  return (init as ts.ArrowFunction).body.getText(source);
};

/** `src/` 下全部 .ts / .tsx（递归）。 */
function allSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(resolve(ROOT, dir))) {
      const rel = `${dir}/${entry}`;
      const stat = statSync(resolve(ROOT, rel));
      if (stat.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(rel);
    }
  };
  walk('src');
  return out;
}

const LEDGER: readonly LedgerRow[] = [
  {
    index: 1,
    ruling: 'fact',
    label: 'Header.tsx 清理重复标签的结果（清了几个界面表达不了）',
    check: () =>
      assertFactSite({
        file: 'src/components/layout/Header.tsx',
        anchor: 'cleanDuplicatesResultMessage(',
      }),
  },
  {
    index: 2,
    ruling: 'silent',
    label: 'HeaderDropdown.tsx 云端已是最新（回执是菜单那行 lastSyncTime）',
    check: () => {
      // ⚠️ 与 SILENT_SITES 里那条**同口径**：不许只看「没有 showToast」——
      // 探活命中也写 lastSyncTime 才是「不说话」的依据。
      const engine = read('src/services/syncEngine.ts');
      const probeAt = engine.indexOf("reason: 'up_to_date'");
      assert.ok(probeAt > 0, 'syncEngine 必须有「已是最新」这条出口');
      assert.match(
        engine.slice(Math.max(0, probeAt - 800), probeAt),
        /setLastSyncTime/,
        '探活命中必须写 lastSyncTime —— 菜单那行会前进成「刚刚」，那才是回执',
      );
      assert.match(
        code('src/components/layout/HeaderDropdown.tsx'),
        /getLastSyncTime/,
        '菜单那行必须读 lastSyncTime（它就是那个回执）',
      );
      assert.doesNotMatch(
        code('src/components/layout/HeaderDropdown.tsx'),
        /showToast\(\s*['"`]云端已是最新/,
        '这条提示已经不该存在了 —— 结果在界面自明，说出来只是重复念一遍',
      );
    },
  },
  {
    index: 3,
    ruling: 'conditional',
    label: 'HeaderDropdown.tsx 退出登录：本机 N>0 才说「不会上传到其它账号」',
    check: () => {
      const src = code('src/components/layout/HeaderDropdown.tsx');
      assert.match(
        src,
        /localCount\s*>\s*0\s*\?[^;]*不会上传到其它账号/,
        '「本机会话仍保留」这个事实必须以「本机有会话」为前提（有会话才说）',
      );
      assert.equal(
        literalOf(retainedFactElseArm()),
        '',
        'N=0 那一支（else 臂）的 fact 必须是空的 —— 有内容就会在「没有盲区」时重新出声',
      );
      assert.match(
        src,
        /hiddenFact:\s*retainedFact/,
        '判据层拿到的必须是那个事实本身（0 个会话时它是空 ⇒ 判成 silent）',
      );
      assertFactWiredThroughFeedback(
        src,
        'retainedFact',
        'const retainedFact =',
        /showToast\(\s*`已退出登录。\$\{retainedFact\}`\s*,\s*'info'/,
      );
    },
  },
  {
    index: 4,
    ruling: 'conditional',
    label: 'HeaderDropdown.tsx 删除全部：条数一致才静默，对不上必须说',
    check: () => {
      const handler = deleteAllHandlerSource();
      assert.match(handler, /deleteAllCountMatches\(/, '必须先判「实际删的数与确认的数一致吗」');
      assert.match(
        handler,
        /if\s*\(\s*[A-Za-z_$][\w$]*\.level\s*!==\s*'silent'\s*\)/,
        '提示必须被判据结果包着（一致时沉默，不一致时说话）',
      );
      assert.match(handler, /deleteAllSuccessMessage\(/, '文案仍由同一份文案函数产出');
      assert.equal(
        showToastType(handler, handler.indexOf('deleteAllSuccessMessage(')),
        'info',
        '这条提示的类型必须是 info（不是 success）',
      );
      // 极性：一致 ⇒ 空事实（静默）；对不上 ⇒ 有事实（必须说）。
      // 少了这一条，把两臂对调后守卫照样全绿，而行为整个反过来。
      assertDeleteAllPolarity();
    },
  },
  {
    index: 5,
    ruling: 'fact',
    label: 'HeaderDropdown.tsx 导出备份（含几个会话）',
    check: () =>
      assertFactSite({
        file: 'src/components/layout/HeaderDropdown.tsx',
        anchor: '已生成备份文件',
      }),
  },
  {
    index: 6,
    ruling: 'fact',
    label: 'HeaderDropdown.tsx 导出 OneTab（含几个会话）',
    check: () =>
      assertFactSite({
        file: 'src/components/layout/HeaderDropdown.tsx',
        anchor: '已生成 OneTab 导出文件',
      }),
  },
  {
    index: 7,
    ruling: 'fact',
    label: 'HeaderDropdown.tsx 诊断摘要已复制（剪贴板写入界面看不见）',
    check: () =>
      assertFactSite({
        file: 'src/components/layout/HeaderDropdown.tsx',
        anchor: '诊断摘要已复制',
      }),
  },
  {
    index: 8,
    ruling: 'fact',
    label: 'HeaderDropdown.tsx 导入 JSON 备份（导入几个 / 几个读不出来）',
    check: () =>
      assertFactSite({
        file: 'src/components/layout/HeaderDropdown.tsx',
        anchor: 'importSuccessMessage(',
        // JSON 导入块独有的标记（OneTab 块没有 failedGroups / settingsMergeFailed）。
        mustContain: 'failedGroups',
      }),
  },
  {
    index: 9,
    ruling: 'fact',
    label: 'HeaderDropdown.tsx 导入 OneTab（导入几个）',
    check: () =>
      assertFactSite({
        file: 'src/components/layout/HeaderDropdown.tsx',
        anchor: 'importSuccessMessage(',
        // OneTab 导入块独有的标记（JSON 块用 result.source / result.imported）。
        mustContain: 'source: total',
      }),
  },
  {
    index: 10,
    ruling: 'conditional',
    label: 'WebDavSettings.tsx 保存：换云盘 / 切自带存储出声，纯「已保存」静默',
    check: () => {
      const branches = saveFactBranches();
      assert.equal(
        literalOf(branches.wasWebdav),
        '',
        '「重存同一份云盘配置」那一支的 fact 必须是空的 —— 「已保存」是纯结果播报，界面自明 ⇒ 不出声',
      );
      assert.notEqual(
        literalOf(branches.switchedLibrary),
        '',
        '换云盘那一支必须说出「用户要做的下一步」',
      );
      assert.notEqual(
        literalOf(branches.elseBranch),
        '',
        '切到自带存储那一支必须说出「用户要做的下一步」',
      );
      const src = code('src/components/sync/WebDavSettings.tsx');
      assertFactWiredThroughFeedback(
        src,
        'saveFact',
        'const saveFact =',
        /showToast\(\s*saveFact\s*,\s*'info'\s*\)/,
      );
    },
  },
  {
    index: 11,
    ruling: 'silent',
    label: 'WebDavSettings.tsx 推送完成（firstPush 状态机就地渲染）',
    check: () => {
      assert.match(
        code('src/components/sync/WebDavSettings.tsx'),
        /setFirstPush\(\{\s*kind:\s*'done'/,
        'firstPush 状态机必须就地渲染「做完了」—— 那才是回执',
      );
      assert.doesNotMatch(
        code('src/components/sync/WebDavSettings.tsx'),
        /showToast\(\s*['"`]推送完成/,
        '这条提示已经不该存在了 —— 结果在界面自明，说出来只是重复念一遍',
      );
    },
  },
  {
    index: 12,
    ruling: 'silent',
    label: 'WebDavSettings.tsx 已从云端下载到本机（同上）',
    check: () => {
      assert.match(
        code('src/components/sync/WebDavSettings.tsx'),
        /setFirstPush\(\{\s*kind:\s*'done'/,
        'firstPush 状态机必须就地渲染「做完了」—— 那才是回执',
      );
      assert.doesNotMatch(
        code('src/components/sync/WebDavSettings.tsx'),
        /showToast\(\s*['"`]已从云端下载到本机/,
        '这条提示已经不该存在了 —— 结果在界面自明，说出来只是重复念一遍',
      );
    },
  },
  {
    index: 13,
    ruling: 'silent',
    label: 'WebDavSettings.tsx 已切回 TapStack 云端（选择器 + 常驻横幅）',
    check: () => {
      const src = code('src/components/sync/WebDavSettings.tsx');
      assert.match(src, /syncBackend:\s*'supabase'/, '后端选择器必须真的切过去 —— 界面自己说得出来');
      assert.match(
        src,
        /当前仍在使用 TapStack 云端/,
        '面板上那块常驻横幅必须真的写明「当前仍在使用 TapStack 云端」—— 那才是回执',
      );
      assert.doesNotMatch(
        src,
        /showToast\(\s*['"`]已切回 TapStack 云端/,
        '这条提示已经不该存在了 —— 结果在界面自明，说出来只是重复念一遍',
      );
    },
  },
  {
    index: 14,
    ruling: 'silent',
    label: 'WebDavSettings.tsx 已清除本机保存的云服务信息（表单被清空）',
    check: () => {
      const src = code('src/components/sync/WebDavSettings.tsx');
      assert.match(src, /setUsername\(''\)/, '账号输入框必须被清空 —— 那才是回执');
      assert.match(src, /setPassword\(''\)/, '口令输入框必须被清空 —— 那才是回执');
      assert.match(src, /setPassphrase\(''\)/, '加密口令输入框必须被清空 —— 那才是回执');
      assert.doesNotMatch(
        src,
        /showToast\(\s*['"`]已清除本机保存的云服务信息/,
        '这条提示已经不该存在了 —— 结果在界面自明，说出来只是重复念一遍',
      );
    },
  },
  {
    index: 15,
    ruling: 'silent',
    label: 'WebDavSettings.tsx 已锁定（口令输入框被清空）',
    check: () => {
      const src = code('src/components/sync/WebDavSettings.tsx');
      assert.match(src, /setPassword\(''\)/, '口令输入框必须被清空 —— 那才是回执');
      assert.match(src, /setPassphrase\(''\)/, '加密口令输入框必须被清空 —— 那才是回执');
      assert.doesNotMatch(
        src,
        /showToast\(\s*['"`]已锁定/,
        '这条提示已经不该存在了 —— 结果在界面自明，说出来只是重复念一遍',
      );
    },
  },
  {
    index: 16,
    ruling: 'silent',
    label: 'OptionsPage.tsx 已退出登录（账号区状态变了）',
    check: () => {
      const src = code('src/options/OptionsPage.tsx');
      assert.match(src, /dispatch\(signOut\(\)\)/, '登出必须真的执行 —— 账号区状态变了就是回执');
      assert.match(
        src,
        /已登录 TapStack 云端/,
        '账号区必须真的渲染「已登录 / 尚未登录」两种形态 —— 那才是回执',
      );
      assert.match(src, /尚未登录 TapStack 云端/, '账号区必须真的渲染「已登录 / 尚未登录」两种形态');
      assert.doesNotMatch(
        src,
        /showToast\(\s*['"`]已退出登录/,
        '这条提示已经不该存在了 —— 结果在界面自明，说出来只是重复念一遍',
      );
    },
  },
  {
    index: 17,
    ruling: 'silent',
    label: 'OptionsPage.tsx 已开启自动同步（开关翻了 + 后半句搬进 hint）',
    check: () => {
      const src = code('src/options/OptionsPage.tsx');
      assert.match(
        src,
        /关闭浏览器后需要重新输入应用密码/,
        '「关闭浏览器后需重新输入应用密码」是这条设置的常驻属性，必须写进 hint',
      );
      assert.match(
        src,
        /label="自动同步"[\s\S]{0,200}hint=\{autoSyncHint\}/,
        '那句必须挂在「自动同步」这个设置项的 hint 上（常驻说明，不是 toast）',
      );
      assert.match(
        src,
        /label="自动同步"[\s\S]{0,300}checked=\{settings\.syncEnabled\}/,
        '开关本身必须显示真实状态 —— 开关翻了就是回执',
      );
      // ⚠️ 这一条**不是** showToast 形状：它钉的是那句话本身不许再出现。
      assert.doesNotMatch(
        src,
        /已开启自动同步/,
        '这条提示已经不该存在了 —— 结果在界面自明，说出来只是重复念一遍',
      );
    },
  },
  {
    index: 18,
    ruling: 'silent',
    label: 'OptionsPage.tsx 已切回 TapStack 云端（选择器状态变了）',
    check: () => {
      const src = code('src/options/OptionsPage.tsx');
      assert.match(src, /syncBackend:\s*next/, '后端选择器必须真的切过去 —— 界面自己说得出来');
      assert.match(
        src,
        /aria-checked=\{settings\.syncBackend === 'supabase'\}/,
        '选择器必须真的把「TapStack 云端」这一档标成选中 —— 那才是回执',
      );
      assert.doesNotMatch(
        src,
        /showToast\(\s*['"`]已切回 TapStack 云端/,
        '这条提示已经不该存在了 —— 结果在界面自明，说出来只是重复念一遍',
      );
    },
  },
  {
    index: 19,
    ruling: 'persistent',
    label: 'TabGroup.tsx 锁定说明：从 toast 改成卡片常驻行（Task 3）',
    check: () => {
      // ── 「常驻」档的两半 ────────────────────────────────────────────────
      // ① 旧的 toast 文案与出口都**没了**（`lockToggleMessage` 两个分支都不再需要）；
      // ② 新的载体**真的在**：`lockDisclosureText` 存在、且真的渲染在卡片上
      //    （只断言「没有 toast」是零检测力 —— 把整行删掉也照样绿）。
      assert.doesNotMatch(
        code(TAB_GROUP),
        /lockToggleMessage/,
        '锁定提示不再是一条 toast（它常驻在卡片上）',
      );
      assert.doesNotMatch(
        code('src/components/tabs/lockFeedbackCopy.ts'),
        /lockToggleMessage/,
        'lockToggleMessage 必须删掉（两个分支都不再需要它）',
      );
      const source = parseTsx(TAB_GROUP);
      const call = findCall(source, 'lockDisclosureText');
      assert.ok(call, 'TabGroup 必须用 lockDisclosureText 驱动那行说明');
      assert.equal(
        call!.arguments[0]?.getText(source),
        'group.isLocked',
        '那行说明必须按「这个会话锁没锁」渲染',
      );
      const name = assignedNameOf(source, call!);
      assert.ok(name, '那行说明的结果必须先落到一个变量上');
      assert.ok(jsxUses(source, name!), '那行说明必须真的渲染出来（算了不用 = 没有那行）');
    },
  },
];

describe('Task 4 登记表：19 处裁决，一处不多一处不少', () => {
  it('登记表恰好 19 行，且序号是 1–19（不许悄悄删行 / 换行）', () => {
    assert.equal(
      LEDGER.length,
      19,
      `登记表必须恰好 19 行（实际 ${LEDGER.length} 行）—— 少一行 = 那一处裁决失去了守卫`,
    );
    assert.deepEqual(
      LEDGER.map(row => row.index),
      Array.from({ length: 19 }, (_, i) => i + 1),
      '序号必须是 1–19 且不重不漏（对应规格 §5.1 的 19 处 success 调用）',
    );
  });

  it('档位分布被钉死：6 fact / 9 silent / 3 条件 fact / 1 常驻（共 19）', () => {
    // ── 这张分布表就是「裁决漂移」的探针 ────────────────────────────────
    // 有人把一处 fact 悄悄改成 silent（少说一句话），或者把一处 silent
    // 改成 fact（多说一句废话）⇒ 下面的 deepEqual 立刻红。
    //
    // 6 fact = #1 清理重复 + #5/#6/#7 导出备份 / 导出 OneTab / 诊断摘要 + #8/#9 两处导入。
    // 9 silent = #2 + #11–#18。
    // 3 条件 fact = #3 退出登录 / #4 删除全部 / #10 保存（出声那半边的形状与 fact 一样，
    //   但「什么时候出声」另由各行的 `check` 钉住 ⇒ 单列一档，不重复计入 fact）。
    // 1 常驻 = #19 锁定说明（Task 3 改成卡片常驻行）。
    const tally: Record<Ruling, number> = { fact: 0, silent: 0, conditional: 0, persistent: 0 };
    for (const row of LEDGER) tally[row.ruling] += 1;
    assert.deepEqual(
      tally,
      { fact: 6, silent: 9, conditional: 3, persistent: 1 },
      '档位分布漂了 —— 19 处裁决的档位是定过案的（规格 §5.1 / Ruling 11 / Ruling 12 / §5.3）',
    );
    // 四档加起来必须还是 19（防止有人加一档又减一档、总数没变但内容变了）。
    assert.equal(
      tally.fact + tally.silent + tally.conditional + tally.persistent,
      19,
      '四档加起来必须还是 19',
    );
  });

  for (const row of LEDGER) {
    it(`#${row.index} [${row.ruling}] ${row.label}`, () => row.check());
  }

  // ── brief 的两行样板：`openSingleTabSuccessMessage(` / `restoreGroupSuccessMessage(` ──
  //
  // 这两处**不在规格 §5.1 的 19 处里**（它们是 §5.2「恢复类 11 处播报」的收口，
  // 由 Task 3 改成「只剩未锁定」）⇒ 不占 19 行的编号，但 brief 要求它们也进登记表。
  // ⇒ 单列成两行**附加行**，钉「只剩未锁定」这件事。
  it('附加：openSingleTabSuccessMessage 只剩「未锁定」（锁定那句已删、TabGroup 锁定分支不含它）', () => {
    // ① 文案函数里**不含**「仍保留在会话中」——锁定版那句随死分支一起删了。
    //    用 `exportedFunctionBody` **抽取**函数体再判（正则钉不到「函数体的范围」）。
    const singleBody = exportedFunctionBody(
      'src/components/tabs/restoreFeedbackCopy.ts',
      'openSingleTabSuccessMessage',
    );
    assert.doesNotMatch(
      singleBody,
      /仍保留在会话中/,
      '点开单标签的文案里不该再有「仍保留在会话中」——锁定版那句已随死分支删除',
    );
    // ② TabGroup 的锁定分支里**不含**它（锁定分支必须整条静默）。
    const lockedBranch = extractLockedBranch(code(TAB_GROUP));
    assert.ok(lockedBranch, `${TAB_GROUP}：应能找到 handleOpenTab 里的锁定分支`);
    assert.doesNotMatch(
      lockedBranch!,
      /openSingleTabSuccessMessage/,
      `${TAB_GROUP}：锁定分支不许出现点开单标签的成功文案（锁定路径整条静默）`,
    );
  });

  it('附加：restoreGroupSuccessMessage 只剩「未锁定」（且 inCurrentWindow 参数仍在）', () => {
    const groupBody = exportedFunctionBody(
      'src/components/tabs/restoreFeedbackCopy.ts',
      'restoreGroupSuccessMessage',
    );
    assert.doesNotMatch(
      groupBody,
      /仍保留在列表/,
      '整组恢复的文案里不该再有「仍保留在列表」——锁定版那句已随死分支删除',
    );
    // ⚠️ 参数名 `inCurrentWindow` **仍在**（brief 的样板要求）。
    //    这条钉的是「开在哪个窗口必须由调用方告诉」这件事——参数没了，
    //    文案就只能猜一个（历史上猜错过，见 restoreWindowWording）。
    const source = parseTsx('src/components/tabs/restoreFeedbackCopy.ts');
    const init = initializerOf(source, 'restoreGroupSuccessMessage');
    assert.ok(init && ts.isArrowFunction(init), 'restoreGroupSuccessMessage 必须还是箭头函数');
    const paramNames = (init as ts.ArrowFunction).parameters.map(p => p.name.getText(source));
    assert.deepEqual(
      paramNames,
      ['tabCount', 'inCurrentWindow'],
      '签名必须仍是 (tabCount, inCurrentWindow) —— 「开在哪个窗口」必须由调用方告诉，不许猜',
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 六、Task 4 Step 2：失败**不得**被静默
// ══════════════════════════════════════════════════════════════════════════
//
// ── 这一节在防什么 ────────────────────────────────────────────────────────
//
// 「安静的成功」这个动作最容易犯的错，是**顺手把失败也一起静音了** ——
// 删掉一条 `showToast(..., 'success')` 的同一把刀，很容易连它下面那条
// `showToast(..., 'error')` 一起切掉。那不是「安静」，那是**哑巴**：
// 用户点了没反应、以为成功了、数据没了。
//
// ⇒ 三条不变式（规格 §6.2 第 7 条 + Global Constraints）：
//   ① error 型调用点数**不许减少**（基线 35，Task 2 之前的实测值）；
//   ② error 且调用方没指定时长 ⇒ **常驻**（不许被改回 3 秒自动消失）；
//   ③ error 与**带动作**的提示**不许被后来的提示静默挤掉**（退路与失败都不许丢）。

/** 全仓 `showToast(...)` 调用点的类型实参（AST 解析，不吃注释、不吃字符串里的巧合）。 */
const showToastCalls = (): Array<{ file: string; type: string | null }> => {
  const out: Array<{ file: string; type: string | null }> = [];
  for (const file of allSourceFiles()) {
    const source = ts.createSourceFile(
      file,
      stripComments(read(file)),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'showToast'
      ) {
        const arg = node.arguments[1];
        const literal =
          arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))
            ? arg.text
            : null;
        out.push({ file, type: literal });
      }
      node.forEachChild(visit);
    };
    visit(source);
  }
  return out;
};

describe('Task 4：判据层的 fact 档必须真的存在（不然「说事实」全哑）', () => {
  // ── 为什么这条归在 Task 4 ────────────────────────────────────────────────
  //
  // 上面 19 处里，8 处靠判据层判成 `fact` 才出声。而 `decideFeedback` 的
  // 规则②（`hiddenFact` 非空 ⇒ fact）就是那条通路本身：
  //   · 把规则②删掉 ⇒ 非空 fact 会掉到规则④ ⇒ **全部判成 silent**
  //     ⇒ 那 8 处一句话都不说，而本文件里**没有一条**断言会红
  //     （逐条 `it` 只钉「接线在」「类型是 info」，钉不到「判据层会不会判 fact」）。
  //
  // ⇒ 这里直接钉判据层的**三档输出**，三档缺一不可。
  it('有非空 fact ⇒ fact（规则②）；没有 fact 且结果自明 ⇒ silent（规则④）', async () => {
    const { decideFeedback } = await import('@/core/feedbackPolicy');
    const withFact = decideFeedback({
      visibility: 'self-evident',
      hiddenFact: '清了 3 个重复标签',
    });
    assert.equal(
      withFact.level,
      'fact',
      '有非空 fact 时必须判成 fact —— 这一档没了，「清掉了几个」这类界面表达不了的事就全哑了',
    );
    assert.match(withFact.reason, /规则②/, '必须命中规则②（判据要能自述命中了哪一条）');
    const withoutFact = decideFeedback({ visibility: 'self-evident' });
    assert.equal(withoutFact.level, 'silent', '没有 fact 且结果自明 ⇒ 沉默');
    assert.match(withoutFact.reason, /规则④/, '必须命中规则④');
    // 空 / 纯空白不算「有一件事」（否则空 fact 会出声，条件 fact 的两处静默就失效）
    for (const blank of ['', '   ', '\n']) {
      assert.equal(
        decideFeedback({ visibility: 'self-evident', hiddenFact: blank }).level,
        'silent',
        `空白 fact（${JSON.stringify(blank)}）必须判成 silent —— 没有事实就没有话可说`,
      );
    }
  });
});

describe('Task 4：失败不得被静默', () => {
  it('全仓 error 型 showToast 调用点 ≥ 35（Task 2 之前的基线）', () => {
    // ⚠️ 这是**下限**不是等式：以后新增失败提示应该让它变大，不该变小。
    //    基线来源：Task 2 动手前实测 `error 35 / success 19 / warning 7 / info 5 / 动态 6`。
    //    口径：AST 解析 `showToast(` 的**第二个实参**，只认字符串字面量
    //    （变量 / 三元 / 模板插值算「动态」，不计入 error）—— 与规格 §4.2 的统计同口径。
    const calls = showToastCalls();
    assert.ok(calls.length > 0, '应当能解析出 showToast 调用（解析器坏了就是假绿）');
    const errorCalls = calls.filter(call => call.type === 'error');
    assert.ok(
      errorCalls.length >= 35,
      `error 型 showToast 只剩 ${errorCalls.length} 处（基线 35）—— ` +
        '「安静的成功」删的是成功播报，不是失败出口；少了就说明有失败被顺手静音了',
    );
  });

  it('error 且调用方没指定时长 ⇒ 常驻（不许被改回自动消失）', async () => {
    const { resolveToastDuration } = await import('@/components/common/toastPolicy');
    assert.equal(
      resolveToastDuration('error', 3000, false),
      0,
      '错误提示必须常驻（0 = 不自动消失）—— 一闪而过的失败等于没说过',
    );
  });

  it('error 与带动作的提示都不会被后来的提示静默挤掉', async () => {
    const { isEvictable } = await import('@/components/common/toastQueuePolicy');
    assert.equal(
      isEvictable({ hasAction: false, isError: true }),
      false,
      '错误提示不许被静默挤掉（「失败始终会通知」是本仓的对外承诺）',
    );
    assert.equal(
      isEvictable({ hasAction: true, isError: false }),
      false,
      '带动作的提示不许被静默挤掉（那是「恢复即消费」的唯一退路）',
    );
    // 自证这条判据不是「一律不可挤」：普通信息类提示**必须**可挤掉，
    // 否则队列一旦满了就再也进不来新提示（那是另一种坏）。
    assert.equal(
      isEvictable({ hasAction: false, isError: false }),
      true,
      '普通提示必须可挤掉 —— 否则队列满了就再也进不来新提示',
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 七、Task 4 Step 3：命名空间不许误伤
// ══════════════════════════════════════════════════════════════════════════
//
// ── 这一节在防什么 ────────────────────────────────────────────────────────
//
// `'success'` 这个字面量在本仓同时活在**六个互不相干的命名空间**里（见文件头）。
// 本次只删 toast 那一层。如果哪天有人「顺手统一一下」，把 `AlertDialog.type`
// 或 `TabGroup.syncStatus` 里的 `'success'` 也删了 —— 那是**误伤**：
//   · `AlertDialog.type = 'success'` 是**弹窗**的语气，不是 toast；
//   · `TabState.syncStatus = 'success'` 是**同步状态机**的一个状态。
//
// ⇒ 这两处必须**仍然有** `'success'`。它们的存在正是「闸门是命名空间限定的、
//   不是 blanket」的证明 —— 也是 §类型层 那三条断言没有变成 blanket grep 的证据。

describe('Task 4：闸门是命名空间限定的（不许误伤别的 success）', () => {
  it("AlertDialog 的 type 里仍然有 'success'（弹窗语气，不是 toast）", () => {
    const source = parseTsx('src/components/common/AlertDialog.tsx');
    let members: string[] | null = null;
    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node) && node.name.text === 'AlertDialogProps') {
        for (const member of node.members) {
          if (
            ts.isPropertySignature(member) &&
            member.name &&
            ts.isIdentifier(member.name) &&
            member.name.text === 'type' &&
            member.type
          ) {
            members = member.type
              .getText(source)
              .split('|')
              .map(part => part.trim().replace(/^['"]|['"]$/g, ''));
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(source);
    assert.ok(members, 'AlertDialogProps 必须还有 type 这个属性（找不到 = 解析器坏了）');
    assert.ok(
      (members as string[]).includes('success'),
      `AlertDialog.type 里必须仍然有 'success'（实际成员：${(members as string[]).join(' | ')}）—— ` +
        '它是**弹窗**的语气，不是 toast；删掉它就是误伤',
    );
  });

  it("TabState.syncStatus 里仍然有 'success'（同步状态机，不是 toast）", () => {
    const source = parseTsx('src/types/tab.ts');
    let members: string[] | null = null;
    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node) && node.name.text === 'TabState') {
        for (const member of node.members) {
          if (
            ts.isPropertySignature(member) &&
            member.name &&
            ts.isIdentifier(member.name) &&
            member.name.text === 'syncStatus' &&
            member.type
          ) {
            members = member.type
              .getText(source)
              .split('|')
              .map(part => part.trim().replace(/^['"]|['"]$/g, ''));
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(source);
    assert.ok(members, 'TabState.syncStatus 必须还在（找不到 = 解析器坏了）');
    assert.ok(
      (members as string[]).includes('success'),
      `TabState.syncStatus 里必须仍然有 'success'（实际成员：${(members as string[]).join(' | ')}）—— ` +
        '它是**同步状态机**的一个状态，不是 toast；删掉它就是误伤',
    );
  });

  it("「安静的成功」只删了 toast 那一层：别的命名空间里的 'success' 一处都没少", () => {
    // ⚠️ 这条**不是** blanket grep（Global Constraints 明令禁止）：
    //    它断言的是「那几处**仍然在**」，方向与 blanket 相反 —— blanket 会
    //    因为「别处还有 success」而误报，这条只在「别处被删空了」时才红。
    //
    // 三处必须仍在的（本次**不该动**的命名空间）：
    //   · 浏览器通知 kind —— `TabManager.ts` / `service-worker.ts` 的 showNotification 分流
    //   · 就地反馈 kind —— `Header.tsx` / `TabList.tsx` / `SearchResultList.tsx`
    //   · `InlineNoticeTone` —— `InlineNotice.tsx`
    // （`AlertDialog.type` / `TabState.syncStatus` 由上面两条 AST 断言钉住。）
    //
    // ⚠️ 一律**抽取类型/属性的成员**再判，不钉 `kind: 'success'` 这种字面长相：
    //    浏览器通知那个 `kind` 是**属性签名**（`kind?: 'success' | 'info' | 'error'`），
    //    就地反馈那个是**对象字面量的值**（`kind: 'success'`）—— 两种形状，
    //    一个正则必然漏掉一种（本仓「正则钉形状」那一类假绿）。
    const typeMembers = (rel: string, typeName: string): string[] => {
      const source = parseTsx(rel);
      let members: string[] | null = null;
      const visit = (node: ts.Node): void => {
        if (ts.isTypeAliasDeclaration(node) && node.name.text === typeName) {
          members = node.type
            .getText(source)
            .split('|')
            .map(part => part.trim().replace(/^['"]|['"]$/g, ''));
        }
        node.forEachChild(visit);
      };
      visit(source);
      assert.ok(members, `${rel}：找不到类型 ${typeName}（解析器坏了就是假绿）`);
      return members as string[];
    };

    assert.ok(
      typeMembers('src/components/common/InlineNotice.tsx', 'InlineNoticeTone').includes('success'),
      "InlineNoticeTone 里必须仍然有 'success' —— 那是就地提示的语气，不是 toast",
    );
    // 浏览器通知：`service-worker.ts` 那个参数的类型联合 + 默认值。
    // 这一处**没有**具名类型别名（是参数上的内联联合）⇒ 用 AST 抽参数声明再判。
    const swKindMembers = (): string[] => {
      const source = parseTsx('src/service-worker.ts');
      let members: string[] | null = null;
      const visit = (node: ts.Node): void => {
        if (
          ts.isParameter(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === 'kind' &&
          node.type &&
          ts.isUnionTypeNode(node.type)
        ) {
          members = node.type.types
            .map(part => part.getText(source).replace(/^['"]|['"]$/g, ''));
        }
        node.forEachChild(visit);
      };
      visit(source);
      assert.ok(members, 'service-worker.ts：找不到 showNotification 的 kind 参数（解析器坏了就是假绿）');
      return members as string[];
    };
    assert.ok(
      swKindMembers().includes('success'),
      `浏览器通知的 kind 里必须仍然有 'success'（实际：${swKindMembers().join(' | ')}）—— ` +
        '那是通知分流，不是 toast',
    );

    // `TabManager.ts` 那个 `kind` 是**对象类型里的属性签名**
    // （`kind?: 'success' | 'info' | 'error';`），既不是类型别名也不是内联参数
    // ⇒ 上面两种解析器都够不着 ⇒ 单独抽属性签名的联合成员。
    //
    // ⚠️ 这里**不能**走 `parseTsx`：那个解析器先剥注释再解析，而本仓的
    //    `stripComments` 有一条已知缺陷 —— 它把**模板串里的 `//`** 也当注释
    //    （`src/background/TabManager.ts:469` 的 `` `${u.protocol}//${u.host}` ``
    //    就是这一类）⇒ 剥完那一行的收尾反引号被吃掉 ⇒ 模板串从那里开始不闭合
    //    ⇒ **后面所有 AST 节点报废**（`showNotification` 的 `kind` 正好在它后面）。
    //    ⇒ 这里解析**原始源码**（TS 自己会处理注释），再把抽出来的成员文本单独去注释。
    const tabManagerKindMembers = (): string[] => {
      const source = ts.createSourceFile(
        'src/background/TabManager.ts',
        read('src/background/TabManager.ts'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      let members: string[] | null = null;
      const visit = (node: ts.Node): void => {
        if (
          !members &&
          ts.isPropertySignature(node) &&
          node.name &&
          ts.isIdentifier(node.name) &&
          node.name.text === 'kind' &&
          node.type &&
          ts.isUnionTypeNode(node.type)
        ) {
          members = node.type.types.map(part =>
            stripComments(part.getText(source)).replace(/^['"]|['"]$/g, ''),
          );
        }
        node.forEachChild(visit);
      };
      visit(source);
      assert.ok(
        members,
        'TabManager.ts：找不到 showNotification 的 kind 属性签名（解析器坏了就是假绿）',
      );
      return members as string[];
    };
    assert.ok(
      tabManagerKindMembers().includes('success'),
      `TabManager.ts 浏览器通知的 kind 里必须仍然有 'success'（实际：${tabManagerKindMembers().join(' | ')}）—— ` +
        '那是通知分流，不是 toast',
    );

    /** 某个文件里「作为对象字面量值出现的 `kind: 'success'`」有几处。 */
    const kindValueCount = (rel: string): number => {
      const source = parseTsx(rel);
      let count = 0;
      const visit = (node: ts.Node): void => {
        if (
          ts.isPropertyAssignment(node) &&
          node.name &&
          ts.isIdentifier(node.name) &&
          node.name.text === 'kind' &&
          ts.isStringLiteralLike(node.initializer) &&
          node.initializer.text === 'success'
        ) {
          count += 1;
        }
        node.forEachChild(visit);
      };
      visit(source);
      return count;
    };
    for (const file of [
      'src/components/layout/Header.tsx',
      'src/components/tabs/TabList.tsx',
      'src/components/search/SearchResultList.tsx',
    ]) {
      assert.ok(
        kindValueCount(file) > 0,
        `${file}：就地反馈的 kind 里必须仍然有 'success' —— 那是页内提示，不是 toast`,
      );
    }
  });
});
