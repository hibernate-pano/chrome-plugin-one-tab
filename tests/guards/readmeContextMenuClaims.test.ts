// README 描述的右键菜单必须与**真正注册的菜单项**一致（2026-10-23 审计 WC-11）。
//
// ── 这个文件防的具体事故 ──────────────────────────────────────────────────
//
// README 曾经写「右键菜单的『保存整窗』」—— 而 `service-worker.ts` 里
// **根本没有注册过这么一项**。真正注册的只有四项：
//
//   ① 打开标签管理器           （扩展图标上下文）
//   ② 保存此标签页并关闭       （网页 / 标签标题上下文）
//   ③ 保存当前标签页并关闭     （扩展图标上下文）
//   ④ 保存其他标签并关闭       （扩展图标上下文）
//
// 后果：读者按 README 去找「保存整窗」，找不到 ⇒ 以为功能不存在。
// 而且**最容易误读的是第 ④ 项** —— 名字里的「其他」很容易被当成「整窗」，
// 实际它**不含当前那个标签**（存的是当前窗口里除活动标签以外的其它标签）。
// 这一句不说清，用户会以为它把整个窗口都收进去了。
//
// ── 判据钉什么 ────────────────────────────────────────────────────────────
//
// **从实现里现场读**菜单项标题（不钉死中文清单）：注册了什么，README 就得写什么；
// README 里引用的每个菜单项名，都必须是真注册过的那一个
// （白名单只有界面上的按钮文案 `saveAndCloseLabel`）。
// ⇒ 菜单改了、README 忘了改（或反过来），都会红。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { saveAndCloseLabel } from '@/components/layout/saveActionCopy';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const SW = read('src/service-worker.ts');
const README = read('README.md');

/**
 * 真正注册了的右键菜单项标题（从 `chrome.contextMenus.create` 现场读）。
 *
 * ⚠️ 必须排除那个**探测**用的 create（`supportsTabContext` 里的 PROBE_ID）：
 * 它建完立刻 remove，只是用来问一句「这个浏览器支持 tab 上下文吗」，
 * 不是用户能看到的菜单项。
 */
function registeredMenuTitles(): string[] {
  const titles: string[] = [];
  for (const m of SW.matchAll(/chrome\.contextMenus\.create\(\{([\s\S]*?)\n\s*\}\);/g)) {
    if (m[1].includes('PROBE_ID')) continue;
    const t = m[1].match(/title:\s*'([^']+)'/);
    if (t) titles.push(t[1]);
  }
  return titles;
}

/** README 里讲「保存路径」的那一行（右键菜单的说法都在这一行）。 */
function readmeSavePathLine(): string {
  const line = README.split('\n').find(l => l.includes('保存路径'));
  assert.ok(line, 'README 缺少「保存路径」说明');
  return line;
}

describe('WC-11 · 事实来源：真正注册的右键菜单项', () => {
  it('注册了四项，且没有「保存整窗」这种项', () => {
    const titles = registeredMenuTitles();
    assert.ok(
      titles.length >= 4,
      `读到的菜单项只有 ${titles.length} 个（${titles.join('、')}）—— 取法需要重新核对`
    );
    assert.ok(
      !titles.some(t => /整窗/.test(t)),
      `右键菜单里居然有一项叫「${titles.find(t => /整窗/.test(t))}」—— ` +
        'README 曾经照着它编了一个不存在的功能'
    );
  });

  it('「保存其他标签」确实不含当前那个标签（事实，不是措辞）', () => {
    assert.match(
      SW,
      /allTabs\.filter\(t => t\.id !== activeTabId\)/,
      '事实来源变了：「保存其他标签并关闭」现在也把当前标签存进去了 —— ' +
        'README 与商店页关于「不含当前那个标签」的说法都要重新核对'
    );
  });
});

describe('WC-11 · README 必须写对右键菜单', () => {
  it('每一个真注册过的菜单项，README 都要提到', () => {
    const line = readmeSavePathLine();
    for (const title of registeredMenuTitles()) {
      assert.ok(
        line.includes(title),
        `README 的「保存路径」那行没有提到真注册过的菜单项「${title}」—— ` +
          '读者按文档找不到那个入口'
      );
    }
  });

  it('README 引用的每个「…」菜单项名都必须真的注册过', () => {
    const line = readmeSavePathLine();
    const known = new Set([...registeredMenuTitles(), saveAndCloseLabel]);
    const quoted = [...line.matchAll(/「([^」]+)」/g)].map(m => m[1]);
    assert.ok(quoted.length > 0, '「保存路径」那行里一个「…」都没有 —— 取法需要重新核对');
    for (const q of quoted) {
      assert.ok(
        known.has(q),
        `README 引用了不存在的菜单项「${q}」—— ` +
          `真正注册的是：${[...known].join('、')}`
      );
    }
  });

  it('必须说清「保存其他标签并关闭」不含当前那个标签', () => {
    const line = readmeSavePathLine();
    const clause = line
      .split(/[；;。]/)
      .map(s => s.trim())
      .find(s => s.includes('保存其他标签并关闭') && /不含|不包括|不包含/.test(s));
    assert.ok(
      clause,
      'README 必须说清「保存其他标签并关闭」**不含当前那个标签**—— ' +
        '名字里的「其他」太容易被读成「整窗」'
    );
    assert.match(
      clause,
      /当前/,
      `那一句必须点明「不含的是当前那个标签」：${clause}`
    );
  });
});
