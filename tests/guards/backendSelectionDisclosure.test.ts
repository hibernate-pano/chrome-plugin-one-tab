// 设置页的后端选择卡必须披露「定时拉取默认关闭」（2026-10-23 审计 WC-10）。
//
// ── 这个文件防的具体事故 ──────────────────────────────────────────────────
//
// 「同步」其实是**两件**事：
//   · **上传**：每次本地保存 / 重命名 / 删除都会安排一次延迟上传
//     （`syncEngine.scheduleUpload` **不检查** `syncEnabled`）⇒ 一直都在发生；
//   · **定时拉取**：后台轮询 alarm 只在 `settings.syncEnabled === true` 时注册
//     ⇒ **默认关闭**（`DEFAULT_SETTINGS.syncEnabled === false`，见 utils/storage.ts）。
//
// 设置页的后端选择卡上写的是「需要登录，跨设备自动同步」——
// 这句话让人以为「登录 = 一直在同步」。于是：
//   新用户换到第二台设备登录 → 登录那一下会拉一次（看到了），
//   但**两台设备都开着**时，第一台存的东西不会自动出现在第二台。
// 他会得出「这产品同步不可靠」的结论，而真相只是：定时拉取默认关着。
//
// README:50、商店页、引导、以及菜单里的 `autoPullStatusView` 都写了这一句
// ⇒ 设置页是唯一漏掉的那个出口（它恰恰是新用户配置同步时盯着看的那块）。
//
// ── 判据钉什么 ────────────────────────────────────────────────────────────
//
// 钉**语义**（这块卡有没有说「定时拉取默认关闭」），不钉整句中文；
// 并钉住**事实来源**（开关的默认值），默认值一改守卫就红，提醒重新评估。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const OPTIONS = read('src/options/OptionsPage.tsx');
const STORAGE = read('src/utils/storage.ts');
const README = read('README.md');

/** 去掉注释 —— 只看**会被渲染出来**的东西。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

const OPTIONS_CODE = stripComments(OPTIONS);

/**
 * 某张后端卡的**副标题**（用户点选前看到的那行小字）。
 *
 * 按「这张卡是哪个后端」定位（`aria-checked={settings.syncBackend === '…'}`），
 * 而不是按行号或按标题文字：行号会随文件改动漂移，而标题文字可能出现在别处。
 */
function backendCardSubtitle(backend: 'supabase' | 'webdav'): string {
  const marker = `aria-checked={settings.syncBackend === '${backend}'}`;
  const idx = OPTIONS_CODE.indexOf(marker);
  assert.ok(idx > 0, `设置页里找不到「${backend}」那张后端卡`);
  const after = OPTIONS_CODE.slice(idx, idx + 800);
  const m = after.match(/className="mt-0\.5[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(m, `找不到「${backend}」那张卡的副标题`);
  return m[1];
}

describe('WC-10 · 事实来源：定时拉取默认关闭', () => {
  it('设置里的自动同步开关默认是关的', () => {
    assert.match(
      STORAGE,
      /syncEnabled:\s*false/,
      '事实来源变了：定时拉取不再默认关闭 —— 下面那几条判据要重新评估'
    );
  });
});

describe('WC-10 · 设置页的后端选择卡必须披露默认状态', () => {
  it('「TapStack 云端」那张卡必须说「定时拉取默认关闭」', () => {
    const subtitle = backendCardSubtitle('supabase');
    assert.match(
      subtitle,
      /定时拉取/,
      `后端卡的副标题没有提「定时拉取」—— 用户无从知道还有这么一件事：${subtitle}`
    );
    assert.match(
      subtitle,
      /默认关闭/,
      `后端卡的副标题没有说默认状态：${subtitle}`
    );
  });

  it('那一半不能被「跨设备自动同步」顶掉（上传 ≠ 定时拉取）', () => {
    const subtitle = backendCardSubtitle('supabase');
    assert.match(
      subtitle,
      /需要登录/,
      `副标题仍然必须说清「需要登录」：${subtitle}`
    );
    assert.match(
      subtitle,
      /跨设备自动同步/,
      `副标题仍然必须说清「跨设备自动同步」：${subtitle}`
    );
  });

  it('README 也这么说（两处口径一致）', () => {
    assert.match(
      README,
      /定时拉取|后台定时拉取/,
      'README 不再提定时拉取 —— 两处口径要对齐'
    );
    assert.match(
      README,
      /默认关闭/,
      'README 不再说定时拉取默认关闭 —— 两处口径要对齐'
    );
  });
});
