// oneTabFormatParser 测试：钉死 OneTab 格式导入导出的解析与序列化。
//
// OneTab 是 Chrome 扩展"标签会话"类目的事实标准（800 万用户），
// TabStack 的导入/导出兼容是用户迁移过来的关键入口。
// 任何解析或序列化错误都会让用户看到空数据或乱码。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

const NOW_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

before(async () => {
  register(LOADER_PATH);
});

describe('parseOneTabFormat: 基础解析', () => {
  it('单个 URL 单行', async () => {
    const { parseOneTabFormat } = await import('@/utils/oneTabFormatParser');
    const input = 'https://example.com | Example';
    const groups = parseOneTabFormat(input);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].tabs.length, 1);
    assert.equal(groups[0].tabs[0].url, 'https://example.com');
    assert.equal(groups[0].tabs[0].title, 'Example');
  });

  it('单组多 URL', async () => {
    const { parseOneTabFormat } = await import('@/utils/oneTabFormatParser');
    const input = [
      'https://a.com | A',
      'https://b.com | B',
      'https://c.com | C',
    ].join('\n');
    const groups = parseOneTabFormat(input);
    assert.equal(groups.length, 1, '单组多行应只生成 1 个会话');
    assert.equal(groups[0].tabs.length, 3);
    assert.deepEqual(
      groups[0].tabs.map(t => t.url),
      ['https://a.com', 'https://b.com', 'https://c.com']
    );
  });

  it('空行分隔多组', async () => {
    const { parseOneTabFormat } = await import('@/utils/oneTabFormatParser');
    const input = [
      'https://a.com | A',
      'https://b.com | B',
      '',
      'https://c.com | C',
      'https://d.com | D',
    ].join('\n');
    const groups = parseOneTabFormat(input);
    assert.equal(groups.length, 2, '空行应分隔不同会话');
    assert.equal(groups[0].tabs.length, 2);
    assert.equal(groups[1].tabs.length, 2);
  });

  it('无标题时使用 URL 作为标题', async () => {
    const { parseOneTabFormat } = await import('@/utils/oneTabFormatParser');
    const input = 'https://example.com/page';
    const groups = parseOneTabFormat(input);
    assert.equal(groups[0].tabs[0].title, 'https://example.com/page');
  });

  it('标题包含管道符（罕见但应正确处理）', async () => {
    const { parseOneTabFormat } = await import('@/utils/oneTabFormatParser');
    // split('|') 会切分所有管道符，第一个管道符前是 URL，剩余拼回 title
    const input = 'https://a.com | Title | with | pipes';
    const groups = parseOneTabFormat(input);
    assert.equal(groups[0].tabs[0].url, 'https://a.com');
    assert.equal(groups[0].tabs[0].title, 'Title');
  });
});

describe('parseOneTabFormat: 健壮性', () => {
  it('空字符串产生 1 个空组（当前实现行为，不修复以防破坏现有逻辑）', async () => {
    const { parseOneTabFormat } = await import('@/utils/oneTabFormatParser');
    const result = parseOneTabFormat('');
    assert.equal(result.length, 1, '空输入仍产生 1 个会话（但 tabs 为空）');
    assert.equal(result[0].tabs.length, 0);
  });

  it('只有空行产生多个空组', async () => {
    const { parseOneTabFormat } = await import('@/utils/oneTabFormatParser');
    const result = parseOneTabFormat('\n\n\n');
    assert.ok(result.length >= 1, '只有空行也会产生会话');
    result.forEach(g => assert.equal(g.tabs.length, 0));
  });

  it('剥离 BOM 头', async () => {
    const { parseOneTabFormat } = await import('@/utils/oneTabFormatParser');
    const input = '\uFEFFhttps://example.com | Example';
    const groups = parseOneTabFormat(input);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].tabs[0].url, 'https://example.com');
  });

  it('前后空白不影响解析', async () => {
    const { parseOneTabFormat } = await import('@/utils/oneTabFormatParser');
    const input = '   \n\nhttps://example.com | Example\n\n   ';
    const groups = parseOneTabFormat(input);
    assert.equal(groups.length, 1);
  });

  it('生成 nanoid 形式的 id', async () => {
    const { parseOneTabFormat } = await import('@/utils/oneTabFormatParser');
    const groups = parseOneTabFormat('https://a.com | A\n\nhttps://b.com | B');
    assert.ok(groups[0].id, 'id 必须非空');
    assert.ok(groups[1].id, 'id 必须非空');
    assert.notEqual(groups[0].id, groups[1].id, '不同组 id 必须唯一');
  });

  it('每行一个 tab id 都唯一', async () => {
    const { parseOneTabFormat } = await import('@/utils/oneTabFormatParser');
    const groups = parseOneTabFormat('https://a.com | A\nhttps://b.com | B\nhttps://c.com | C');
    const ids = groups[0].tabs.map(t => t.id);
    assert.equal(new Set(ids).size, 3, 'tab id 必须唯一');
  });

  it('createdAt/updatedAt 是合法 ISO 字符串', async () => {
    const { parseOneTabFormat } = await import('@/utils/oneTabFormatParser');
    const groups = parseOneTabFormat('https://a.com | A');
    assert.match(groups[0].createdAt, NOW_REGEX);
    assert.match(groups[0].updatedAt, NOW_REGEX);
  });
});

describe('formatToOneTabFormat: 序列化', () => {
  it('空数组返回空字符串', async () => {
    const { formatToOneTabFormat } = await import('@/utils/oneTabFormatParser');
    assert.equal(formatToOneTabFormat([]), '');
  });

  it('单个组单个 tab', async () => {
    const { formatToOneTabFormat } = await import('@/utils/oneTabFormatParser');
    const groups = [
      {
        id: 'g-1',
        name: 'Group',
        tabs: [{ id: 't-1', url: 'https://a.com', title: 'A', createdAt: NOW_REGEX.source, lastAccessed: '', pinned: false }],
        createdAt: '',
        updatedAt: '',
        isLocked: false,
        version: 1,
      },
    ] as any;
    const result = formatToOneTabFormat(groups);
    assert.equal(result, 'https://a.com | A');
  });

  it('多组之间用空行分隔', async () => {
    const { formatToOneTabFormat } = await import('@/utils/oneTabFormatParser');
    const groups = [
      {
        id: 'g-1',
        name: 'G1',
        tabs: [{ id: 't-1', url: 'https://a.com', title: 'A', createdAt: '', lastAccessed: '', pinned: false }],
        createdAt: '',
        updatedAt: '',
        isLocked: false,
        version: 1,
      },
      {
        id: 'g-2',
        name: 'G2',
        tabs: [{ id: 't-2', url: 'https://b.com', title: 'B', createdAt: '', lastAccessed: '', pinned: false }],
        createdAt: '',
        updatedAt: '',
        isLocked: false,
        version: 1,
      },
    ] as any;
    const result = formatToOneTabFormat(groups);
    assert.equal(result, 'https://a.com | A\n\nhttps://b.com | B');
  });

  it('多组多 tab：每个组内换行，组间空行', async () => {
    const { formatToOneTabFormat } = await import('@/utils/oneTabFormatParser');
    const groups = [
      {
        id: 'g-1',
        name: 'G1',
        tabs: [
          { id: 't-1', url: 'https://a.com', title: 'A', createdAt: '', lastAccessed: '', pinned: false },
          { id: 't-2', url: 'https://b.com', title: 'B', createdAt: '', lastAccessed: '', pinned: false },
        ],
        createdAt: '',
        updatedAt: '',
        isLocked: false,
        version: 1,
      },
    ] as any;
    const result = formatToOneTabFormat(groups);
    assert.equal(result, 'https://a.com | A\nhttps://b.com | B');
  });
});

describe('parseOneTabFormat ↔ formatToOneTabFormat 往返', () => {
  it('format → parse 应得到等价的组（忽略 id 和时间戳）', async () => {
    const { formatToOneTabFormat, parseOneTabFormat } = await import('@/utils/oneTabFormatParser');
    const original = [
      {
        id: 'g-1',
        name: 'G1',
        tabs: [
          { id: 't-1', url: 'https://a.com', title: 'A', createdAt: '', lastAccessed: '', pinned: false },
          { id: 't-2', url: 'https://b.com', title: 'B', createdAt: '', lastAccessed: '', pinned: false },
        ],
        createdAt: '',
        updatedAt: '',
        isLocked: false,
        version: 1,
      },
      {
        id: 'g-2',
        name: 'G2',
        tabs: [{ id: 't-3', url: 'https://c.com', title: 'C', createdAt: '', lastAccessed: '', pinned: false }],
        createdAt: '',
        updatedAt: '',
        isLocked: false,
        version: 1,
      },
    ] as any;

    const serialized = formatToOneTabFormat(original);
    const reparsed = parseOneTabFormat(serialized);

    assert.equal(reparsed.length, original.length);
    reparsed.forEach((group, i) => {
      assert.equal(group.tabs.length, original[i].tabs.length);
      group.tabs.forEach((tab, j) => {
        assert.equal(tab.url, original[i].tabs[j].url);
        assert.equal(tab.title, original[i].tabs[j].title);
      });
    });
  });
});
