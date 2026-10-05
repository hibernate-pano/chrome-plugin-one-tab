// 「存得下、回不来」的回归防线（2026-10-05）。
//
// 【为什么要有这个文件】用户线上日志证实了这条链路仍在发生：
//   [normalizeTabsData] tabs_data 非数组，已从 wrapper 恢复 …
//
//   标签组 mji8xap0kh82cnj8e0k 的 1 个标签有 1 个无法还原（URL 未通过安全校验），
//   还原率 0.00 低于阈值 0.5，已跳过该组以保护云端数据不被截断回写
//
// 根因是**保存侧与还原侧各有一张互不相同的 URL 协议白名单**：
//   保存侧 isInternalUrl（domain/tabGroup/filters.ts）只拒 chrome:// /
//     chrome-extension:// / edge:// / about: → file: / blob: / devtools: 全部放行；
//   还原侧 sanitizeTabUrl（当时语义 =「可打开」）只放行 http/https/ftp/about。
//
// 于是「保存时打得开、还原时打不开」的地址存得进云端、却永远回不来。
// 再叠加还原率判据按**整组**生效，一个 3 标签的组里 2 个是 file: 就会
// 0.33 < 0.5，连同那个完全正常的 https 标签一起被整组隐藏——
// 而无回收站模型下这不可逆（云端行永不被改写，对端重写也还是同一个 URL）。
//
// 本文件钉死修复后的三条不变量。任何放宽其中一条的改动都必须先在这里变红。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

before(async () => {
  register(LOADER_PATH);
});

/** 云端真实存在过的三类地址：正常网页 / 本地文件 / 站内 blob */
const OPENABLE = 'https://example.com/paper.pdf';
const LOCAL_FILE = 'file:///Users/me/papers/thesis.pdf';
const SITE_BLOB = 'blob:https://example.com/2b3c-4d5e';
const VIEW_SOURCE = 'view-source:https://example.com';
const DANGEROUS = 'javascript:alert(1)';

describe('不变量 1：保存侧放行「打不开但该留」的地址', () => {
  it('isStorableTabUrl 放行 file: / blob: / view-source:', async () => {
    const { isStorableTabUrl } = await import('@/utils/inputValidation');
    // 这三个是用户保存时**确实打得开**的真实地址，丢掉就等于「保存不完整」
    assert.equal(isStorableTabUrl(LOCAL_FILE), true, 'file: 是本地 PDF，必须存得下');
    assert.equal(isStorableTabUrl(SITE_BLOB), true, 'blob: 是站内临时链接，必须存得下');
    assert.equal(isStorableTabUrl(VIEW_SOURCE), true);
  });

  it('isStorableTabUrl 仍然拒危险 schema（这是它唯一该拒的）', async () => {
    const { isStorableTabUrl } = await import('@/utils/inputValidation');
    assert.equal(isStorableTabUrl(DANGEROUS), false, 'javascript: 绝不能进数据库');
    assert.equal(isStorableTabUrl('data:text/html,<script>alert(1)</script>'), false);
    assert.equal(isStorableTabUrl('vbscript:msgbox(1)'), false);
  });

  it('isStorableTabUrl 拒浏览器内部页与形状非法', async () => {
    const { isStorableTabUrl } = await import('@/utils/inputValidation');
    for (const bad of [
      'chrome://extensions',
      'chrome-extension://abc/popup.html',
      'edge://settings',
      'not a url',
      '',
      null,
      undefined,
      42,
    ]) {
      assert.equal(isStorableTabUrl(bad), false, `${String(bad)} 不该被判为可存`);
    }
  });
});

describe('不变量 2：还原侧不再丢弃「打不开」的标签', () => {
  it('deserializeTab 保留 file: 并标 unopenable（修复前返回 null）', async () => {
    const { deserializeTab } = await import('@/core/tabDataCodec');
    const t = deserializeTab(
      { id: 't1', url: LOCAL_FILE, title: '我的论文', created_at: '', last_accessed: '' },
      'g1'
    );
    assert.notEqual(t, null, 'file: 必须被保留 —— 修复前这里返回 null，行被静默丢掉');
    assert.equal(t!.unopenable, true, '必须标出本设备打不开');
    assert.equal(t!.url, LOCAL_FILE, 'URL 原样保留，不被改写');
  });

  it('deserializeTab 对正常地址不标 unopenable', async () => {
    const { deserializeTab } = await import('@/core/tabDataCodec');
    const t = deserializeTab(
      { id: 't1', url: OPENABLE, title: 'A', created_at: '', last_accessed: '' },
      'g1'
    );
    assert.notEqual(t, null);
    assert.equal(t!.unopenable, undefined, '正常地址不该被标 unopenable');
  });

  it('deserializeTab 仍然拒危险 schema —— 真正的数据污染必须挡住', async () => {
    const { deserializeTab } = await import('@/core/tabDataCodec');
    for (const bad of [DANGEROUS, 'data:text/html,<script>alert(1)</script>', 'vbscript:x']) {
      const t = deserializeTab(
        { id: 't1', url: bad, title: 'x', created_at: '', last_accessed: '' },
        'g1'
      );
      assert.equal(t, null, `${bad} 必须被拒收`);
    }
  });
});

describe('不变量 3：两张协议表不再互相矛盾（单一真相源）', () => {
  it('isOpenableTabUrl 与 isStorableTabUrl 对 file: 给出相反答案，且这是刻意的', async () => {
    const { isStorableTabUrl, isOpenableTabUrl } = await import('@/utils/inputValidation');
    // 存储门放行、打开门拒收 —— 这正是修复的核心：两个问题两个答案
    assert.equal(isStorableTabUrl(LOCAL_FILE), true);
    assert.equal(isOpenableTabUrl(LOCAL_FILE), false);
  });

  it('不存在「能存但危险」的组合（存储门是危险 schema 的子集）', async () => {
    const { isStorableTabUrl, isOpenableTabUrl } = await import('@/utils/inputValidation');
    const samples = [OPENABLE, LOCAL_FILE, SITE_BLOB, VIEW_SOURCE, 'about:blank', 'ftp://h/f', 'ws://h/s'];
    for (const u of samples) {
      if (isOpenableTabUrl(u)) continue;
      // 打不开的必须至少是可存的（否则又回到「存得下回不来」）
      assert.equal(
        isStorableTabUrl(u),
        true,
        `${u} 打不开但存不下 → 正是本次修复要消灭的那类数据丢失`
      );
    }
  });

  it('sanitizeTabUrl 的语义已明确为「能不能存」（历史陷阱）', async () => {
    const { sanitizeTabUrl } = await import('@/utils/inputValidation');
    // 旧实现对 file: 返回 null —— 那正是 bug 根源
    assert.equal(sanitizeTabUrl(LOCAL_FILE), LOCAL_FILE, 'sanitizeTabUrl 现在只答「能不能存」');
    assert.equal(sanitizeTabUrl(DANGEROUS), null, '危险 schema 仍然返回 null');
  });
});

describe('不变量 4：保存链路的总门（filters）不再丢本地文件', () => {
  it('isValidTab 放行 file: / blob:，拒 javascript: 与内部页', async () => {
    const { isValidTab } = await import('@/domain/tabGroup/filters');
    const mk = (url: string) => ({ url, title: 't' }) as chrome.tabs.Tab;
    // 放行：保存时确实打得开的地址
    assert.equal(isValidTab(mk(LOCAL_FILE)), true, 'file: 必须能存进会话');
    assert.equal(isValidTab(mk(SITE_BLOB)), true);
    assert.equal(isValidTab(mk(OPENABLE)), true);
    // 拒绝：危险 schema 与浏览器自己的页面
    assert.equal(isValidTab(mk(DANGEROUS)), false);
    assert.equal(isValidTab(mk('data:text/html,<script>alert(1)</script>')), false);
    assert.equal(isValidTab(mk('chrome://extensions')), false);
    assert.equal(isValidTab(mk('edge://settings')), false);
    assert.equal(isValidTab(mk('about:blank')), false, 'about: 判内部（不保存），与协议表同答案');
  });
});

describe('回归：这组修复不能把「结构性坏行」也放进来', () => {
  it('整行是 chrome:// 内部页时，deserializeTab 全部拒收 → 交给还原率判据整组跳过', async () => {
    const { deserializeTab } = await import('@/core/tabDataCodec');
    // 模拟「有人绕过 isInternalUrl 把整行写成内部页」的历史坏行：
    // 它们的还原率会趋近 0，仍应被 MIN_RESTORABLE_TAB_RATIO 拦下整组跳过。
    const rows = [
      { id: 'a', url: 'chrome://settings', title: '', created_at: '', last_accessed: '' },
      { id: 'b', url: 'edge://flags', title: '', created_at: '', last_accessed: '' },
    ];
    const restored = rows
      .map(r => deserializeTab(r, 'g1'))
      .filter((t): t is NonNullable<typeof t> => t !== null);
    assert.equal(restored.length, 0, '内部页不该被还原出来（那会引入一条打不开的假标签）');
  });

  it('混合行（1 个正常 + 3 个内部页）还原率 0.25 < 0.5，仍会被整组跳过', async () => {
    const { deserializeTab } = await import('@/core/tabDataCodec');
    const { MIN_RESTORABLE_TAB_RATIO } = await import('@/utils/supabase/download');
    const rows = [
      { id: 'ok', url: OPENABLE, title: '', created_at: '', last_accessed: '' },
      { id: 'a', url: 'chrome://settings', title: '', created_at: '', last_accessed: '' },
      { id: 'b', url: 'edge://flags', title: '', created_at: '', last_accessed: '' },
      { id: 'c', url: 'chrome-extension://x/y.html', title: '', created_at: '', last_accessed: '' },
    ];
    const restored = rows
      .map(r => deserializeTab(r, 'g1'))
      .filter((t): t is NonNullable<typeof t> => t !== null);
    const ratio = restored.length / rows.length;
    assert.ok(
      ratio < MIN_RESTORABLE_TAB_RATIO,
      `还原率 ${ratio} 应低于阈值 ${MIN_RESTORABLE_TAB_RATIO}，从而整组跳过（保护云端不被截断回写）`
    );
  });

  it('对照组：3 个标签里 2 个是 file: 时，还原率 1.0 —— 不再被误伤整组跳过', async () => {
    const { deserializeTab } = await import('@/core/tabDataCodec');
    const rows = [
      { id: 'ok', url: OPENABLE, title: '', created_at: '', last_accessed: '' },
      { id: 'f1', url: LOCAL_FILE, title: '', created_at: '', last_accessed: '' },
      { id: 'f2', url: SITE_BLOB, title: '', created_at: '', last_accessed: '' },
    ];
    const restored = rows
      .map(r => deserializeTab(r, 'g1'))
      .filter((t): t is NonNullable<typeof t> => t !== null);
    // 修复前：只有 1 个能还原 → 0.33 < 0.5 → 整组被跳过（用户线上日志就是这个）
    // 修复后：3 个全部保留 → 1.0
    assert.equal(restored.length, 3, 'file:/blob: 必须计入还原数，否则整组被误隐藏');
    assert.equal(restored.length / rows.length, 1.0);
  });
});
