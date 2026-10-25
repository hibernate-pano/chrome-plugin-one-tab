/**
 * 「安静的成功」守卫（2026-10-25）—— **Task 2：类型层 + 19 处裁决**。
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
 * ── 本文件不覆盖什么（留给后续任务） ─────────────────────────────────────
 *
 *   · 接线 / 退路 / 成功门（恢复即消费那条链路）⇒ Task 3 / Task 4；
 *   · `TabGroup.tsx` 的锁定说明 toast（#19）⇒ **Task 3** 把它改成
 *     卡片常驻行 —— 本任务对它**先不动**，因此这里也不钉它的现状。
 *
 * ── 行号不是承重信息，锚点才是 ─────────────────────────────────────────
 *
 * 所有定位一律用「唯一字符串 + 周边代码」，不钉行号（行号会随别的改动漂）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

describe('19 处裁决：判成 fact 的必须经判据层、提示是 info', () => {
  for (const site of FACT_SITES) {
    it(site.label, () => {
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
    });
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
    it(site.label, () => {
      assert.doesNotMatch(
        code(site.file),
        site.gone,
        '这条提示已经不该存在了 —— 结果在界面自明，说出来只是重复念一遍',
      );
      site.carrier();
    });
  }
});

describe('19 处裁决：删除全部的条数对不上时必须说出来', () => {
  /** 取 handleDeleteAllGroups 整个函数的源码（判据只在这个函数里）。 */
  const handlerSource = (): string => {
    const src = code('src/components/layout/HeaderDropdown.tsx');
    const start = src.indexOf('const handleDeleteAllGroups');
    assert.ok(start > 0, '找不到 handleDeleteAllGroups');
    const rest = src.slice(start);
    const end = rest.indexOf('\n  const ', 10);
    return end > 0 ? rest.slice(0, end) : rest;
  };

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
    const handler = handlerSource();
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

/** 解析一个 .tsx 源文件（按 TSX 解析，JSX 与泛型都不会误判）。 */
const parseTsx = (rel: string): ts.SourceFile =>
  ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

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
      const src = read(file);
      const branch = extractLockedBranch(src);
      assert.ok(branch, `${file}：应能找到 handleOpenTab 里的锁定分支`);
      assert.doesNotMatch(
        branch,
        /showToast\(|showRestoreSuccessMessage|showConsumeToast/,
        `${file}：锁定分支必须静默 —— 锁定组从不被消费 ⇒ 那条记录还在 ⇒ 界面自明`,
      );
    });

    it(`${file}：锁定分支的成功门与失败出口仍在（静默的是成功，不是失败）`, () => {
      const src = read(file);
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

    it(`${file}：锁定分支不删行（那条记录还在 ⇒ 所以不必说）`, () => {
      const src = read(file);
      const branch = extractLockedBranch(src);
      assert.ok(branch, `${file}：应能找到 handleOpenTab 里的锁定分支`);
      assert.doesNotMatch(
        branch,
        /deleteTabAndSync/,
        `${file}：锁定分支不许删记录（锁定 = 组内不发生删除）`,
      );
    });
  }

  it('锁定 ⇒ 卡片还在：consumeSession 对锁定组早退（不 dispatch 删除）', () => {
    const src = read(TAB_GROUP);
    const at = src.indexOf('const consumeSession = () => {');
    assert.ok(at > 0, '应能找到 consumeSession');
    const body = src.slice(at, src.indexOf('\n  };', at));
    const lockAt = body.indexOf('if (group.isLocked)');
    const deleteAt = body.indexOf('dispatch(deleteGroup(');
    assert.ok(lockAt >= 0, '锁定早退必须还在（锁定组恢复后卡片还在）');
    assert.ok(
      deleteAt > lockAt,
      '锁定早退必须排在删除之前 —— 这才是「卡片还在」的根据',
    );
    // 早退那一支里不许有 dispatch
    const early = body.slice(lockAt, body.indexOf('}', lockAt));
    assert.doesNotMatch(
      early,
      /dispatch\(/,
      '锁定那一支必须直接返回（一条记录都不删）',
    );
  });

  for (const file of [TAB_GROUP, SEARCH_LIST]) {
    it(`${file}：整组恢复的成功播报被「未锁定」条件包着`, () => {
      const source = parseTsx(file);
      const call = findCall(source, 'showConsumeToast', 'restoreGroupSuccessMessage');
      assert.ok(call, `${file}：整组恢复的成功播报必须还在（未锁定那条）`);
      const guard = enclosingIf(call!);
      assert.ok(
        guard,
        `${file}：那条播报必须在条件分支里 —— 锁定组必须静默`,
      );
      const cond = guard!.expression.getText(source).replace(/\s+/g, '');
      assert.ok(
        cond === '!group.isLocked' || cond === 'group.isLocked===false',
        `${file}：那条播报必须被「未锁定」包着（实际条件：${cond}）`,
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
    assert.doesNotMatch(
      read(TAB_GROUP),
      /lockToggleMessage/,
      '锁定提示不再是一条 toast（它常驻在卡片上）',
    );
    assert.doesNotMatch(
      read('src/components/tabs/lockFeedbackCopy.ts'),
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
