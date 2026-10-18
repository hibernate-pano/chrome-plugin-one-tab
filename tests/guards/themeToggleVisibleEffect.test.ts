// 标题栏的主题按钮：点一下必须看得见变化，且三处声明同源（2026-10-18）。
//
// 【本文件要防的回归类别】`themeMode` 有三个取值（light / dark / auto），
// 拿它做**二元**判断必然把 auto 归错边。原实现 `themeMode === 'light' ? 'dark' : 'light'`
// 把 auto 归进「非 light」⇒「跟随系统 + 系统为浅色」（= 出厂默认设置）时算出 'light'：
// 配色不变（ThemeContext 只按 currentTheme 切 html.dark）、图标不变、tooltip 不变
// ⇒ 屏幕上一个像素都没动，用户以为按钮坏了；而设置已被静默改成「浅色」，
// 此后系统切深色也不再跟随。同一个错误分类还让「系统深色 + auto」时图标显示太阳。
//
// 为什么用源码结构断言：组件是 .tsx（node:test 只做类型剥离、不转译 JSX），
// 本仓对组件类不变式一律读源码断言（a11yDialogs / lockedTabDeleteGuard 同惯例）。
// 行为面由真机 dist 探针把关（/tmp/one-tab-loop/verify-round16.mjs：改前点一下 document
// 仍无 dark 类，改后立刻变深色且 aria-label 同步）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** 去注释后的源码：注释里会引用旧写法与取值说明，不能参与断言。 */
function code(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const SRC = code('src/components/layout/SimpleThemeToggle.tsx');

describe('主题按钮：切换依据是屏幕上实际生效的配色', () => {
  it('不得用 themeMode 做二元判断（它有 auto 三值，必然归错边）', () => {
    assert.ok(
      !/themeMode/.test(SRC),
      '这个组件不该再读 themeMode —— 需要「现在屏幕上是什么配色」时请用 currentTheme'
    );
  });

  it('唯一真值是 currentTheme 派生的 isDark', () => {
    assert.match(
      SRC,
      /const isDark\s*=\s*currentTheme\s*===\s*'dark'/,
      'icon / tooltip / aria / 目标模式必须同源于 currentTheme 派生的一个布尔量'
    );
  });

  it('切换目标与当前可见配色相反（第一下必须有可见变化）', () => {
    assert.match(
      SRC,
      /setThemeMode\(\s*isDark\s*\?\s*'light'\s*:\s*'dark'\s*\)/,
      '点击后要变成「与当前可见配色相反」的那个模式，否则 auto 下第一下等于没点'
    );
  });

  it('三处声明（tooltip / 无障碍名 / 图标）都取自同一个 isDark', () => {
    assert.match(SRC, /const nextModeLabel\s*=\s*isDark\s*\?/, 'tooltip 文案要按当前配色说');
    assert.match(SRC, /content=\{nextModeLabel\}/, 'tooltip 必须用上面那份按配色算出来的文案');
    assert.match(SRC, /const nextModeAriaLabel\s*=\s*isDark\s*\?/, '无障碍名要按当前配色说');
    assert.match(SRC, /aria-label=\{nextModeAriaLabel\}/, '无障碍名必须用上面那份按配色算出来的文案');
    assert.match(SRC, /\{isDark\s*\?\s*<MoonIcon\s*\/>/, '图标要画当前配色（深色就该是月亮）');
  });
});
