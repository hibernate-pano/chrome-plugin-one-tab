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

/** 第 n 次出现某个锚点的位置（-1 = 没有）。 */
const nthIndexOf = (src: string, needle: string, nth: number): number => {
  let at = -1;
  for (let i = 0; i <= nth; i += 1) {
    at = src.indexOf(needle, at + 1);
    if (at < 0) return -1;
  }
  return at;
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

/** 判成 fact 的那几处：必须经判据层裁决、提示类型是 `'info'`。 */
const FACT_SITES: Array<{ file: string; anchor: string; nth?: number; label: string }> = [
  {
    file: 'src/components/layout/Header.tsx',
    anchor: 'cleanDuplicatesResultMessage(',
    label: '清理重复标签的结果（清了几个界面表达不了）',
  },
  {
    file: 'src/components/layout/HeaderDropdown.tsx',
    anchor: '不会上传到其它账号',
    label: '退出登录：本机 N 个会话仍保留、不会传到别的账号',
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
    nth: 0,
    label: '导入 JSON 备份（导入几个 / 几个读不出来）',
  },
  {
    file: 'src/components/layout/HeaderDropdown.tsx',
    anchor: 'importSuccessMessage(',
    nth: 1,
    label: '导入 OneTab（导入几个）',
  },
  {
    file: 'src/components/sync/WebDavSettings.tsx',
    anchor: '已保存，已切换到新的云盘',
    label: '已保存并切到新云盘（含用户要做的下一步）',
  },
];

/**
 * 判成 silent 的那几处：那条提示必须**不存在**，
 * 而且它依赖的界面载体必须真的在（否则「不说话」就没有依据）。
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
    gone: /showToast\('云端已是最新'/,
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
    gone: /showToast\('推送完成'/,
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
    gone: /showToast\('已从云端下载到本机'/,
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
    gone: /showToast\('已切回 TapStack 云端/,
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
    gone: /showToast\('已清除本机保存的云服务信息/,
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
    gone: /showToast\('已锁定/,
    carrier: () => {
      const src = code('src/components/sync/WebDavSettings.tsx');
      assert.match(src, /setPassword\(''\)/, '口令输入框必须被清空 —— 那才是回执');
      assert.match(src, /setPassphrase\(''\)/, '加密口令输入框必须被清空 —— 那才是回执');
    },
  },
  {
    label: '已退出登录（设置页）',
    file: 'src/options/OptionsPage.tsx',
    gone: /showToast\('已退出登录'/,
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
    gone: /showToast\('已切回 TapStack 云端/,
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
      const at = nthIndexOf(src, site.anchor, site.nth ?? 0);
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
  it('退出登录：本机有会话才说那个事实（0 个会话 ⇒ 沉默）', () => {
    const src = code('src/components/layout/HeaderDropdown.tsx');
    assert.match(
      src,
      /localCount\s*>\s*0\s*\?[^;]*不会上传到其它账号/,
      '「本机会话仍保留」这个事实必须以「本机有会话」为前提（有会话才说）',
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
