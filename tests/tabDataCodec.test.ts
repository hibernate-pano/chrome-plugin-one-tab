// tab ↔ TabData 编解码（纯函数）：阶段二·§5.3 的 tab 级操作印记
// （lastOp = { d: deviceId, s: seq }）必须随 tabs_data JSON 上云往返，
// 否则云端 tab 恒为 EMPTY_STAMP，跨设备单 tab 删除的墓碑打不过任何
// 本地副本（tie 判本地赢）→ 删除意图不传播、设备间永久分叉。
// 2026-09-12 审计实证（纯函数探针 + 双实例 e2e 场景推演）。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
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

before(async () => {
  register(LOADER_PATH);
});

describe('tabDataCodec: tab 印记上云往返', () => {
  it('序列化携带 lastOp（device + seq 双字段）', async () => {
    const { serializeTab } = await import('@/core/tabDataCodec');
    const tab = {
      id: 't1', url: 'https://a.com', title: 'A',
      createdAt: '2026-01-01T00:00:00Z', lastAccessed: '2026-01-01T00:00:00Z',
      pinned: true, isDeleted: true,
      lastOp: { d: 'devB', s: 42 },
    };
    const data = serializeTab(tab as never);
    assert.equal(data.last_op_device, 'devB');
    assert.equal(data.last_op_seq, 42);
    assert.equal(data.is_deleted, true);
    assert.equal(data.pinned, true);
  });

  it('无印记的 tab 不写 stamp 键（省出网字节），且与「显式 null」对读者完全等价', async () => {
    const { serializeTab, deserializeTab } = await import('@/core/tabDataCodec');
    const tab = {
      id: 't1', url: 'https://a.com', title: 'A',
      createdAt: '2026-01-01T00:00:00Z', lastAccessed: '2026-01-01T00:00:00Z',
    };
    const data = serializeTab(tab as never);

    // 写侧：恒为 null / false 的键根本不出现（每条标签省 62 B 上云）。
    assert.equal('last_op_device' in data, false);
    assert.equal('last_op_seq' in data, false);
    assert.equal('pinned' in data, false);

    // 读侧：「缺省」与「显式 null / false」必须读出**逐字相同**的 Tab ——
    // 这是省略写法对老客户端仍然安全的**全部**依据
    // （老版本的 deserializeTab 判据是
    //  `typeof data.last_op_seq === 'number' && data.last_op_device`，
    //  缺省与 null 都落不到那个判据上）。
    const omitted = deserializeTab(data, 'g1');
    const legacyNull = deserializeTab(
      { ...data, last_op_device: null, last_op_seq: null, pinned: false },
      'g1'
    );
    assert.deepEqual(
      omitted,
      legacyNull,
      '省略写法与「显式 null」必须对读者完全等价 —— ' +
        '否则老客户端读新写入的行就会丢印记'
    );
    assert.equal(omitted?.lastOp, undefined);
    assert.equal(omitted?.pinned, false);
  });

  it('每条标签的上云字节有上限（防止恒 null 字段被加回来）', async () => {
    const { serializeTab } = await import('@/core/tabDataCodec');
    // 10 条典型标签（nanoid 21 字符 / 中文标题 / favicon URL）。
    const tabs = Array.from({ length: 10 }, (_, i) => ({
      id: 'V1StGXR8_Z5jdHi6B-myT',
      url: `https://www.example${i}.com/some/article/path?ref=nav`,
      title: '示例站点的页面标题 — 一个比较长的标题',
      favicon: `https://www.google.com/s2/favicons?domain=example${i}.com&sz=32`,
      createdAt: '2026-10-23T08:00:00.000Z',
      lastAccessed: '2026-10-23T08:30:00.000Z',
      pinned: false,
    }));
    const bytes = Buffer.byteLength(JSON.stringify(tabs.map(serializeTab)), 'utf8');
    // 实测：省掉恒 null 字段后 ≈ 310 B/条（省之前 372 B/条）。
    // 阈值取实测值 +5% 抖动余量 —— 「谁把 null 字段加回来」这条必须红，
    // 而「标题多两个字」不该红。
    assert.ok(
      bytes <= 10 * 326,
      `10 条标签的 tabs_data 明文应 ≤ 3260 B（实测 ${bytes} B）—— ` +
        '超出说明有恒 null / 恒 false 的字段被写回去了：' +
        '出网量按字节计费，这类字段是纯浪费'
    );
  });

  it('反序列化还原 lastOp → tab.lastOp', async () => {
    const { deserializeTab } = await import('@/core/tabDataCodec');
    const tab = deserializeTab({
      id: 't1', url: 'https://a.com', title: 'A',
      created_at: '2026-01-01T00:00:00Z', last_accessed: '2026-01-01T00:00:00Z',
      last_op_device: 'devB', last_op_seq: 42,
    }, 'g1');
    assert.deepEqual(tab?.lastOp, { d: 'devB', s: 42 });
    assert.equal(tab?.group_id, 'g1');
  });

  it('云端行无印记字段（老数据/老客户端写入）→ lastOp 为 undefined（EMPTY_STAMP 语义）', async () => {
    const { deserializeTab } = await import('@/core/tabDataCodec');
    const tab = deserializeTab({
      id: 't1', url: 'https://a.com', title: 'A',
      created_at: '2026-01-01T00:00:00Z', last_accessed: '2026-01-01T00:00:00Z',
    }, 'g1');
    assert.equal(tab?.lastOp, undefined);
  });

  it('往返一致：serialize → deserialize 保留印记与 isDeleted', async () => {
    const { serializeTab, deserializeTab } = await import('@/core/tabDataCodec');
    const original = {
      id: 't1', url: 'https://a.com/x', title: 'A',
      createdAt: '2026-01-01T00:00:00Z', lastAccessed: '2026-01-02T00:00:00Z',
      pinned: false, isDeleted: true,
      lastOp: { d: 'devA', s: 7 },
    };
    const tab = deserializeTab(serializeTab(original as never), 'g9');
    assert.equal(tab?.id, 't1');
    assert.equal(tab?.url, 'https://a.com/x');
    assert.equal(tab?.isDeleted, true);
    assert.deepEqual(tab?.lastOp, { d: 'devA', s: 7 });
  });

  it('危险协议（javascript:）→ 反序列化返回 null（云端污染防线保留）', async () => {
    const { deserializeTab } = await import('@/core/tabDataCodec');
    const tab = deserializeTab({
      id: 't1', url: 'javascript:alert(1)', title: 'x',
      created_at: '2026-01-01T00:00:00Z', last_accessed: '2026-01-01T00:00:00Z',
    }, 'g1');
    assert.equal(tab, null);
  });

  it('loading:// 伪装 URL 带标题 key 参与去重 → 原样保留 url 与 title', async () => {
    const { deserializeTab } = await import('@/core/tabDataCodec');
    const tab = deserializeTab({
      id: 't1', url: 'loading://page', title: 'loading tab',
      created_at: '2026-01-01T00:00:00Z', last_accessed: '2026-01-01T00:00:00Z',
    }, 'g1');
    assert.equal(tab?.url, 'loading://page');
    assert.equal(tab?.title, 'loading tab');
  });
});
