// 导出 → 重新导入的往返回归（2026-10-06）。
//
// 【为什么补这个文件】导入链路此前**零往返覆盖**：
// tests/localStorageFreshness.test.ts 只钉「导入与后台同步的竞态」（交 SW 串行化），
// 而「用户导出一份备份、几个月后导回来」这条真实路径没有任何用例。
// 于是两个真实缺陷长期无人发现：
//
//   1) **空组污染**：sanitizeUrl 会丢弃危险/不可存储的 tab（javascript:、data:，
//      以及 1.22.11 那版口径下的 file:/blob:）。一个组若全部 tab 都被丢弃，
//      就留下 tabs: [] 的空壳卡在列表里 —— 用户刚导入完就看到凭空多出的
//      「空会话」，表现为「导入坏了」。要等下次云端下载的 dropEmptyGroups 才清掉。
//   2) **file: 往返丢失**：本地 PDF / blob 链接是开发者与研究者的常态。
//      1.22.11 的 sanitizeTabUrl 只放行 http/https/ftp/about/loading，
//      导出的 JSON 含 file:// → 导回来时被静默丢弃，数据永久丢失且无提示。
//      当前版已改成「可存储即保留」（isStorableTabUrl），本用例把该契约钉住，
//      防止有人把口径改回「可打开」。
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Tab, TabGroup } from '@/types/tab';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};
const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

before(async () => {
  register(LOADER_PATH);
});

const NOW = '2026-10-06T10:00:00.000Z';
const OLD = '2026-01-01T00:00:00.000Z';
const STAMP = { d: 'devTest', s: 7 };

function mkTab(id: string, over: Partial<Tab> = {}): Tab {
  return {
    id,
    url: `https://e.com/${id}`,
    title: id,
    favicon: '',
    createdAt: OLD,
    lastAccessed: OLD,
    pinned: false,
    ...over,
  };
}

function mkGroup(id: string, tabs: Tab[], over: Partial<TabGroup> = {}): TabGroup {
  return {
    id,
    name: `g-${id}`,
    tabs,
    createdAt: OLD,
    updatedAt: OLD,
    version: 1,
    isLocked: false,
    ...over,
  };
}

/** 递增 id 生成器（applyImportGroups 的依赖注入点）。 */
function seqIds(prefix = 'new'): () => string {
  let i = 0;
  return () => `${prefix}${++i}`;
}

describe('导入：清洗后变空的组不得落进列表（空壳卡）', () => {
  it('组内全部 tab 都被 sanitize 丢弃时，该组不进导入结果', async () => {
    const { applyImportGroups } = await import('@/core/mutationOps');
    const { sanitizeTabUrl } = await import('@/utils/inputValidation');

    const incoming = [
      mkGroup('all-bad', [
        mkTab('x', { url: 'javascript:alert(1)' }),
        mkTab('y', { url: 'data:text/html,<h1>x</h1>' }),
      ]),
      mkGroup('good', [mkTab('z', { url: 'https://ok.example.com' })]),
    ];

    const { groups, imported } = applyImportGroups(
      [],
      incoming,
      { genId: seqIds(), sanitizeUrl: sanitizeTabUrl },
      NOW,
      STAMP
    );

    assert.equal(imported.length, 1, '空壳组不得进 imported（否则 UI 会渲染一张空会话卡）');
    assert.equal(imported[0].name, 'g-good');
    assert.equal(groups.length, 1);
    assert.ok(
      groups.every(g => g.tabs.length > 0),
      '导入结果里不得残留任何零标签的组'
    );
  });

  it('组内部分 tab 被丢弃时，组保留剩下的标签（不得整组丢弃）', async () => {
    const { applyImportGroups } = await import('@/core/mutationOps');
    const { sanitizeTabUrl } = await import('@/utils/inputValidation');

    const { imported } = applyImportGroups(
      [],
      [mkGroup('mixed', [mkTab('bad', { url: 'javascript:alert(1)' }), mkTab('ok')])],
      { genId: seqIds(), sanitizeUrl: sanitizeTabUrl },
      NOW,
      STAMP
    );

    assert.equal(imported.length, 1, '还有可用标签的组必须保留');
    assert.equal(imported[0].tabs.length, 1);
    assert.equal(imported[0].tabs[0].url, 'https://e.com/ok');
  });

  it('锁定的空壳组同样被剔除（锁定保护内容，零标签无内容可保护）', async () => {
    const { applyImportGroups } = await import('@/core/mutationOps');
    const { sanitizeTabUrl } = await import('@/utils/inputValidation');

    const { imported } = applyImportGroups(
      [],
      [mkGroup('locked-empty', [mkTab('x', { url: 'javascript:alert(1)' })], { isLocked: true })],
      { genId: seqIds(), sanitizeUrl: sanitizeTabUrl },
      NOW,
      STAMP
    );

    assert.equal(imported.length, 0, '锁定 + 零标签 = 空壳，不进列表');
  });
});

describe('往返：导出的数据重新导入不得丢内容', () => {
  it('https 与 file: 标签都能原样往返（本地 PDF 是真实场景）', async () => {
    const { applyImportGroups } = await import('@/core/mutationOps');
    const { sanitizeTabUrl } = await import('@/utils/inputValidation');

    // 这份「导出」里的 file:// 在 1.22.11 口径下会被丢掉 —— 契约已改为可存储即保留。
    const exported = [
      mkGroup('web', [mkTab('a', { url: 'https://example.com/doc' })]),
      mkGroup('local', [mkTab('p', { url: 'file:///Users/me/paper.pdf', title: '论文' })]),
    ];

    const { imported } = applyImportGroups(
      [],
      exported,
      { genId: seqIds(), sanitizeUrl: sanitizeTabUrl },
      NOW,
      STAMP
    );

    assert.equal(imported.length, 2, '两组都应保留');
    const urls = imported.flatMap(g => g.tabs.map(t => t.url)).sort();
    assert.deepEqual(
      urls,
      ['file:///Users/me/paper.pdf', 'https://example.com/doc'],
      'file: 不得在往返中被丢弃（否则本地 PDF 永久丢失且无提示）'
    );
  });

  it('往返后 id 全部换新（避免与现有会话撞 id 覆盖数据）', async () => {
    const { applyImportGroups } = await import('@/core/mutationOps');
    const { sanitizeTabUrl } = await import('@/utils/inputValidation');

    const exported = [mkGroup('orig', [mkTab('t-orig'), mkTab('t-orig-2')])];
    const { groups, imported } = applyImportGroups(
      [mkGroup('existing', [mkTab('keep-me')])],
      exported,
      { genId: seqIds('imp'), sanitizeUrl: sanitizeTabUrl },
      NOW,
      STAMP
    );

    assert.notEqual(imported[0].id, 'orig', '组 id 必须换新');
    const importedTabIds = imported[0].tabs.map(t => t.id);
    assert.ok(
      importedTabIds.every(id => !id.startsWith('t-orig')),
      'tab id 也必须换新'
    );
    // 现有会话一个都不能少（这正是 1.22.1 修过的「导入与后台同步撞车丢数据」）
    assert.ok(
      groups.some(g => g.id === 'existing' && g.tabs.some(t => t.url === 'https://e.com/keep-me')),
      '导入不得覆盖或丢弃现有会话'
    );
  });

  it('OneTab 文本往返保留全部标签（解析→格式化→再解析）', async () => {
    const { parseOneTabFormat, formatToOneTabFormat } = await import('@/core/oneTabFormatParser');

    const original = [
      mkGroup('g1', [
        mkTab('a', { url: 'https://a.example.com', title: '页面 A' }),
        mkTab('b', { url: 'https://b.example.com', title: '页面 B' }),
      ]),
      mkGroup('g2', [mkTab('c', { url: 'https://c.example.com', title: '页面 C' })]),
    ];

    const text = formatToOneTabFormat(original);
    const reparsed = parseOneTabFormat(text);

    assert.equal(reparsed.length, 2, '两个会话都应解析回来');
    const urls = reparsed.flatMap(g => g.tabs.map(t => t.url)).sort();
    assert.deepEqual(urls, [
      'https://a.example.com',
      'https://b.example.com',
      'https://c.example.com',
    ]);
  });

  it('标题里含分隔符 | 时往返不丢标签', async () => {
    const { parseOneTabFormat, formatToOneTabFormat } = await import('@/core/oneTabFormatParser');

    // OneTab 格式用 `URL | 标题` 分隔，标题里带 | 是真实存在的边界。
    const original = [
      mkGroup('g1', [mkTab('a', { url: 'https://x.example.com', title: 'A | B' })]),
    ];
    const text = formatToOneTabFormat(original);
    const reparsed = parseOneTabFormat(text);

    assert.equal(reparsed[0].tabs.length, 1, '标题含 | 不得把一条标签拆成两条或整条丢掉');
    assert.equal(reparsed[0].tabs[0].url, 'https://x.example.com');
    assert.equal(reparsed[0].tabs[0].title, 'A | B');
  });

  it('危险协议的标签在 OneTab 导入时被丢弃，但其余标签不受牵连', async () => {
    const { parseOneTabFormat } = await import('@/core/oneTabFormatParser');

    const parsed = parseOneTabFormat(
      ['javascript:alert(1) | 恶意', 'https://ok.example.com | 正常'].join('\n')
    );
    assert.equal(parsed[0].tabs.length, 1, '危险协议整行丢弃，其余保留');
    assert.equal(parsed[0].tabs[0].url, 'https://ok.example.com');
  });
});
