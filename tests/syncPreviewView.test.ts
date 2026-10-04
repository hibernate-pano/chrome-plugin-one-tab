// 同步预览弹窗展示层：净变化格式 + 源码结构（对齐/主题/同名不重复）。
// 环境桩沿用 syncOverwriteGuard.test.ts：syncPreviewView 依赖 @/ 别名，
// 必须在 register(loader) 之后动态 import。
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};
const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

const viewSource = readFileSync(
  new URL('../src/components/sync/syncPreviewView.tsx', import.meta.url),
  'utf8'
);

let formatDelta: typeof import('../src/components/sync/syncPreviewView.tsx').formatDelta;

before(async () => {
  register(LOADER_PATH, import.meta.url);
  ({ formatDelta } = await import('../src/components/sync/syncPreviewView.tsx'));
});

describe('formatDelta：净变化的可读格式', () => {
  it('增加 → +N（绿色）', () => {
    const d = formatDelta(3);
    assert.equal(d.text, '+3');
    assert.match(d.toneClass, /emerald/);
  });

  it('减少 → −N（红色，用真减号而非连字符）', () => {
    const d = formatDelta(-5);
    assert.equal(d.text, '−5');
    assert.ok(!d.text.includes('-'), '不应使用 ASCII 连字符做减号');
    assert.match(d.toneClass, /rose/);
  });

  it('不变 → ±0（中性色）', () => {
    const d = formatDelta(0);
    assert.equal(d.text, '±0');
    assert.match(d.toneClass, /slate/);
  });
});

describe('预览卡片结构：对齐 / 主题 / 数据量正确', () => {
  it('数字块带 tabular-nums（等宽数字，多卡片对齐不跳动）', () => {
    assert.match(viewSource, /tabular-nums/);
  });

  it('颜色用主题类（含 dark: 变体），不再用内联固定色', () => {
    assert.match(viewSource, /dark:text-emerald-400/);
    assert.match(viewSource, /dark:text-rose-400/);
    assert.doesNotMatch(viewSource, /backgroundColor: '#f9fafb'/, '不应再有写死的浅色背景（暗色主题下发糊）');
    assert.doesNotMatch(viewSource, /color: colorPalette\./, '不应再依赖内联 color palette');
  });

  it('「操作前 → 预计」用 beforeCount/afterCount，数据量取自真实 summary', () => {
    assert.match(viewSource, /summary\.beforeCount/);
    assert.match(viewSource, /summary\.afterCount/);
    assert.match(viewSource, /summary\.afterCount\s*-\s*summary\.beforeCount/);
  });

  it('示例名限长且带 title（避免名字撑破卡片高度、对齐被破坏）', () => {
    assert.match(viewSource, /MAX_VISIBLE_NAMES/);
    assert.match(viewSource, /title=\{`\$\{label\}/);
    assert.match(viewSource, /truncate/);
  });
});
