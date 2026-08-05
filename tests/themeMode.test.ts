// S3 §2：resolveThemeMode 纯函数单测。
//
// 行为契约（spec §2.2）：
// - 'dark' / 'light' 不管系统，永远返回自己
// - 'auto' 跟随 systemDark：true → 'dark', false → 'light'
//
// 这把 ThemeContext 里"mode + system → 实际主题"那一段逻辑抽出来，
// 单测覆盖矩阵，不依赖 jsdom / matchMedia / React。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveThemeMode } from '../src/utils/themeUtils.ts';

describe('resolveThemeMode', () => {
  it('mode="dark" + 系统亮 → 始终 dark', () => {
    assert.equal(resolveThemeMode('dark', false), 'dark');
  });

  it('mode="light" + 系统暗 → 始终 light（用户选择压倒系统）', () => {
    assert.equal(resolveThemeMode('light', true), 'light');
  });

  it('mode="auto" 跟随系统：暗→dark / 亮→light', () => {
    assert.equal(resolveThemeMode('auto', true), 'dark');
    assert.equal(resolveThemeMode('auto', false), 'light');
  });
});