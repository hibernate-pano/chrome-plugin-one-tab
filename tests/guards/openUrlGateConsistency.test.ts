// 「打开」路径的门禁一致性（2026-10-05）。
//
// 【本文件要防的回归类别】2026-10-05 拆开 URL 三道门时引入了��类 bug：
// `sanitizeTabUrl` 的语义从「能不能打开」收窄为「能不能**存**」，而**调用点
// 没有全部跟着改**。凡是「把 URL 交给 chrome.tabs.create」的地方都必须用
// isOpenableTabUrl，用 sanitizeTabUrl 会让 file:/blob: 漏过去。
//
// 实际后果（已修）：恢复一个含 file:///… 的会话时，URL 通过了 SW 的过滤，
// 然后 chrome.tabs.create 拿到它 —— 扩展没有 file:// 访问权限，Chrome 打开
// 一个错误页或拒绝，**整个 Promise.all 批处理**因此 reject，用户看到的是
// 「恢复失败」或「恢复出来的会话有坏标签」，完全查不出原因。
// 而数据其实一直好好地待在会话里（这正是 7.2 修复的目的）。
//
// 所以本文件按**源码结构**钉死：每一个「要交给浏览器导航」的位置必须用
// isOpenableTabUrl，且不得出现 sanitizeTabUrl。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

/** 剥注释，避免注释里提到旧类名/旧函数名造成误判 */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('打开路径：service-worker 的消息分支', () => {
  it('OPEN_TAB 用 isOpenableTabUrl（不是 sanitizeTabUrl）', () => {
    const src = code('src/service-worker.ts');
    const start = src.indexOf("case 'OPEN_TAB'");
    assert.ok(start !== -1, '应能找到 OPEN_TAB 分支');
    const branch = src.slice(start, src.indexOf("case 'OPEN_TABS'"));
    assert.match(
      branch,
      /isOpenableTabUrl\(rawUrl\)/,
      'OPEN_TAB 要把 URL 交给 chrome.tabs.create，必须用「能不能打开」的门'
    );
    assert.ok(
      !/sanitizeTabUrl\(/.test(branch),
      'OPEN_TAB 不得用 sanitizeTabUrl —— 它的语义是「能不能存」，会放行 file:/blob:'
    );
  });

  it('OPEN_TAB 区分两种拒绝原因（危险协议 vs 本设备打不开）', () => {
    const src = code('src/service-worker.ts');
    const start = src.indexOf("case 'OPEN_TAB'");
    const branch = src.slice(start, src.indexOf("case 'OPEN_TABS'"));
    // 两者对用户的含义完全不同：一个是「这个地址有风险」，一个是「地址没问题但本机打不开」
    assert.match(
      branch,
      /isStorableTabUrl\(rawUrl\)\s*\?/,
      '应当按 isStorableTabUrl 区分「危险协议」与「存得下但打不开」，给用户不同的提示'
    );
  });

  it('OPEN_TABS（批量）同样用 isOpenableTabUrl', () => {
    const src = code('src/service-worker.ts');
    const start = src.indexOf("case 'OPEN_TABS'");
    assert.ok(start !== -1, '应能找到 OPEN_TABS 分支');
    const branch = src.slice(start, start + 3000);
    assert.match(branch, /isOpenableTabUrl\(/, '批量恢复必须过滤掉打不开的 URL');
    assert.ok(
      !/sanitizeTabUrl\(/.test(branch),
      '批量恢复不得用 sanitizeTabUrl —— 会把 file:/blob: 一起放进 chrome.tabs.create'
    );
  });

  it('批量路径会统计并回传跳过数（不能静默丢弃）', () => {
    const src = code('src/service-worker.ts');
    const start = src.indexOf("case 'OPEN_TABS'");
    const branch = src.slice(start, start + 3000);
    assert.match(branch, /skippedUnopenable/, '必须把「跳过了几个」回传给 UI');
    assert.match(
      branch,
      /skippedUnopenable/,
      '跳过数非 0 时不能报 success 就完事 —— 那是对没发生的事报成功'
    );
  });
});

describe('打开路径：TabManager', () => {
  it('openTab 有「本设备打不开」的兜底提示', () => {
    const src = code('src/background/TabManager.ts');
    const start = src.indexOf('async openTab(');
    assert.ok(start !== -1);
    const body = src.slice(start, start + 1500);
    assert.match(
      body,
      /isOpenableTabUrl\(/,
      'openTab 必须先判「能不能打开」——它是所有打开路径的最后一道兜底'
    );
    assert.match(
      body,
      /showNotification\(/,
      '打不开时要给用户明确通知，而不是静默 return（用户会以为点了没反应）'
    );
  });

  it('批量恢复的两个方法由调用方保证已过滤（不在 TabManager 里重复过滤）', () => {
    // 说明：TabManager.openTabsInNewWindow / InCurrentWindow 接收的是
    // Tab[]（含完整实体，不是 {url,pinned}），在里面重新过滤需要判断
    // unopenable 标记；而过滤责任放在 service-worker 的消息入口更合适
    // （那是唯一的外部入口）。这里断言入口确实做了过滤。
    const src = code('src/service-worker.ts');
    assert.match(
      src,
      /openTabsInNewWindow\(safeTabs\)/,
      '批量恢复必须传已过滤的 safeTabs'
    );
    assert.match(src, /openTabsInCurrentWindow\(safeTabs\)/);
  });
});

describe('存储路径：用「能不能存」的门（与打开路径相反）', () => {
  it('deserializeTab 用 isStorableTabUrl（它决定数据是否被丢弃）', () => {
    const src = code('src/core/tabDataCodec.ts');
    assert.match(
      src,
      /isStorableTabUrl\(data\.url\)/,
      'deserializeTab 的判断是「这个 URL 能不能进数据库」，用存储门'
    );
    assert.match(
      src,
      /isOpenableTabUrl\(url\)/,
      '同时要用打开门算出 unopenable 标记（供 UI 降级显示）'
    );
  });

  it('保存链路（TabManager.saveAllTabs / import）用存储门', () => {
    const src = code('src/background/TabManager.ts');
    // 保存时 file:/blob: 应该被留下（用户保存时确实打得开）
    assert.match(
      src,
      /sanitizeTabUrl\(t\.url\)/,
      '保存链路的消毒用的是 sanitizeTabUrl（= 能不能存），file: 必须能存下'
    );
  });

  it('isValidTab = 协议门 + 内部页门（两道串联）', () => {
    const src = code('src/domain/tabGroup/filters.ts');
    const start = src.indexOf('export const isValidTab');
    assert.ok(start !== -1);
    const body = src.slice(start, start + 400);
    assert.match(body, /isStorableTabUrl\(/, 'isValidTab 要过协议门');
    assert.match(body, /isInternalUrl\(/, 'isValidTab 还要过内部页门');
  });
});
