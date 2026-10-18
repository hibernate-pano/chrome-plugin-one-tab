// 保存失败时的「诚实度」与菜单可关闭性（2026-10-18 round 38）。
//
// 【本文件要防的回归类别】同一类病的两颗残留：
//   · WebDavSettings.handleSwitchBack：dispatch 同时改 syncBackend + syncEnabled，
//     但 saveError 时只 toast、不回滚 Redux ⇒ 界面说「还在自带存储」而内存里
//     已是 supabase + 自动同步关闭；用户下一次改任何设置都会把这份分叉盲写回磁盘。
//   · WebDavSettings.handleForget：`await dispatchSaveSettings(dispatch)` 丢弃返回值，
//     末尾无条件报「自动同步已关闭」⇒ 写盘失败时它仍开着，后台照旧按间隔醒来。
//   · HeaderDropdown：只注册了 document mousedown 外点关闭，没有 Escape；
//     而 mousedown 抢先关菜单、同一次 click 又把它翻回 true ⇒ 再点汉堡「没反应」。
//
// 【测试形态】本仓库没有 jsdom（见 tests/a11yDialogs.test.ts 头部），所以用
// 「剥注释后源码切片」断言：只允许分支自己的代码满足断言，避免别处的同名文案
// 给测试发合格证（同 tests/webdavSettingsUi.test.ts 的教训）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

const SETTINGS = stripComments(read('src/components/sync/WebDavSettings.tsx'));
const MENU = stripComments(read('src/components/layout/HeaderDropdown.tsx'));

function sliceOf(src: string, from: string, to: string): string {
  const start = src.indexOf(from);
  assert.ok(start > -1, `找不到锚点：${from}`);
  const end = src.indexOf(to, start);
  assert.ok(end > start, `找不到结束锚点：${to}`);
  return src.slice(start, end);
}

/**
 * 取 `if (<cond>) { … }` 的花括号正文（按深度配对）。
 * 不能用「到第一个 return / 到下一个锚点」那种切法：分支里嵌套着别的 if，
 * 切宽了会把分支外的代码也算进来，断言就成了给自己发合格证。
 */
function ifBranch(src: string, cond: string): string {
  return braceBody(src, cond);
}

/** 取 `anchor` 之后第一个 `{ … }` 的正文（按深度配对）。 */
function braceBody(src: string, anchor: string): string {
  const at = src.indexOf(anchor);
  assert.ok(at > -1, `找不到锚点：${anchor}`);
  const open = src.indexOf('{', at);
  assert.ok(open > -1, `${anchor} 之后应有块体`);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  assert.fail(`${anchor} 的花括号没配对`);
}

describe('handleSwitchBack：保存失败必须成对回滚 Redux', () => {
  const body = sliceOf(
    SETTINGS,
    'const handleSwitchBack = useCallback(',
    'const handleForget = useCallback('
  );

  it('保存前记下两个字段的旧值', () => {
    assert.match(body, /const prevBackend = settings\.syncBackend;/, '必须记下旧的同步方式');
    assert.match(body, /const prevEnabled = settings\.syncEnabled;/, '必须记下旧的自动同步开关');
  });

  it('saveError 分支同时回滚 syncBackend 与 syncEnabled', () => {
    const branch = ifBranch(body, 'if (saveError)');
    assert.match(branch, /dispatch\(\s*updateSettings\(\{/, '失败分支必须把 Redux 改回真值');
    assert.match(branch, /syncBackend:\s*prevBackend/, '只还原开关会在界面上留下「后端已切走」的假象');
    assert.match(branch, /syncEnabled:\s*prevEnabled/, '只还原后端会静默关掉磁盘上的自动同步');
  });

  it('回滚排在 clearSessionSecrets / invalidate 之前（配置一个字都还没动）', () => {
    const rollbackAt = body.indexOf('syncBackend: prevBackend');
    const secretsAt = body.indexOf('await clearSessionSecrets()');
    assert.ok(rollbackAt > -1 && secretsAt > -1, '锚点应存在');
    assert.ok(rollbackAt < secretsAt, '保存失败时不得继续清口令 / 清后端缓存');
    assert.ok(body.indexOf('invalidateActiveSyncBackend()') > rollbackAt, '同理不得继续 invalidate');
  });

  it('toast 同时说清两个字段恢复成什么', () => {
    const branch = ifBranch(body, 'if (saveError)');
    assert.match(branch, /同步方式已恢复为/, '必须说明同步方式回了哪一边');
    assert.match(branch, /自动同步开关已恢复为/, '必须说明开关回了开还是关');
    assert.match(branch, /'error'/, '这是失败，不能报成功');
  });

  it('两个字段进 useCallback 依赖数组（否则回滚会还原成陈旧值）', () => {
    const deps = body.slice(body.lastIndexOf('}, ['));
    assert.match(deps, /settings\.syncBackend/, 'prevBackend 的取值来源必须进依赖');
    assert.match(deps, /settings\.syncEnabled/, 'prevEnabled 的取值来源必须进依赖');
  });
});

describe('handleForget：关自动同步失败时不得假装关掉了', () => {
  const body = sliceOf(
    SETTINGS,
    'const handleForget = useCallback(',
    'const handleLock = useCallback('
  );

  it('dispatchSaveSettings 的返回值必须被接收', () => {
    assert.ok(
      !/^\s*await dispatchSaveSettings\(dispatch\);\s*$/m.test(body),
      '裸 await 丢掉了 saveError —— 那正是本缺陷的成因'
    );
    assert.match(body, /const saveError = await dispatchSaveSettings\(dispatch\);/, '必须接收错误');
  });

  it('失败分支把 Redux 回滚成磁盘真值（仍为开启）', () => {
    const branch = ifBranch(body, 'if (saveError)');
    assert.match(branch, /dispatch\(\s*updateSettings\(\{\s*syncEnabled: true\s*\}\)/, '写盘失败时开关仍是 true');
    assert.match(branch, /'error'/, '失败必须报 error');
    assert.match(branch, /未解锁/, '要告诉用户后台会停在什么状态');
  });

  it('成功 toast 不是无条件发的', () => {
    const successAt = body.indexOf("showToast('已清除本机保存的云服务信息");
    assert.ok(successAt > -1, '成功文案应保留');
    const guard = body.slice(Math.max(0, successAt - 120), successAt);
    assert.match(guard, /if\s*\(!\w+\)\s*\{/, '成功 toast 必须落在「没失败」的分支里');
    assert.match(body, /autoSyncOffFailed = true/, '失败标记要在分支里置位');
  });
});

describe('HeaderDropdown：外点用 click、Escape 可关闭', () => {
  it('外部关闭监听从 mousedown 换成 click', () => {
    assert.match(
      MENU,
      /document\.addEventListener\('click', handleClickOutside\)/,
      'click 才能让 React onClick 先跑完，同一次点击不会把菜单翻回来'
    );
    assert.match(MENU, /document\.removeEventListener\('click', handleClickOutside\)/, '清理必须成对');
    assert.ok(
      !/addEventListener\('mousedown', handleClickOutside\)/.test(MENU),
      'mousedown 会先关菜单、随后 click 又打开 —— 表现为「再点没反应」'
    );
  });

  it('外部关闭必须跳过触发按钮自己（否则同一次点击会把刚打开的菜单关掉）', () => {
    const handler = braceBody(MENU, 'const handleClickOutside = (event: MouseEvent) =>');
    // 真机回归：onClick 在 root 上先 flush ⇒ 菜单挂载 ⇒ 同一个 click 继续冒泡到
    // document，target 是汉堡按钮、不在 dropdownRef 内 ⇒ 菜单被立刻关掉（打不开）。
    assert.match(
      handler,
      /closest\?\.\('\[data-menu-trigger\]'\)|closest\?\.\('\[aria-haspopup="menu"\]'\)/,
      '必须有一条「点的是触发按钮自己」的跳过判据'
    );
    const skipAt = handler.indexOf('closest');
    const containsAt = handler.indexOf('dropdownRef.current');
    assert.ok(
      skipAt > -1 && containsAt > -1 && skipAt < containsAt,
      '跳过判据必须在 contains 判定之前生效'
    );
  });

  it('触发按钮上的 data-menu-trigger 不能被删（判据的唯一锚点）', () => {
    const HEADER = stripComments(read('src/components/layout/Header.tsx'));
    assert.match(HEADER, /data-menu-trigger/, '汉堡按钮必须保留该属性');
    // 既有守卫依赖这两个 aria 属性，判据改动不得把它们顺走。
    assert.match(HEADER, /aria-haspopup="menu"/);
    assert.match(HEADER, /aria-expanded=\{showDropdown\}/);
  });

  it('Escape 走 keydown 监听并完整清理', () => {
    const at = MENU.indexOf("addEventListener('keydown'");
    assert.ok(at > -1, '必须有键盘关闭路径（否则只剩鼠标能关）');
    const effect = MENU.slice(Math.max(0, at - 600), at + 400);
    assert.match(effect, /'Escape'/, '监听要判定 Escape');
    assert.match(effect, /onClose\(\)/, 'Escape 必须真的关菜单');
    assert.match(MENU, /removeEventListener\('keydown'/, '卸载时必须移除监听');
  });

  it('菜单语义未被改动（既有守卫断言 role="menu" 且不宣称 aria-haspopup）', () => {
    assert.match(MENU, /role="menu"/);
    assert.ok(!MENU.includes('aria-haspopup="menu"'), '容器是就地展开的 panel，不是 popup menu');
  });
});
