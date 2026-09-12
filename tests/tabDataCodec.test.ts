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
    const { serializeTab } = await import('@/utils/tabDataCodec');
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

  it('无印记的 tab 序列化为 null（老客户端兼容：NULL 视为最小值）', async () => {
    const { serializeTab } = await import('@/utils/tabDataCodec');
    const data = serializeTab({
      id: 't1', url: 'https://a.com', title: 'A',
      createdAt: '2026-01-01T00:00:00Z', lastAccessed: '2026-01-01T00:00:00Z',
    } as never);
    assert.equal(data.last_op_device, null);
    assert.equal(data.last_op_seq, null);
  });

  it('反序列化还原 lastOp → tab.lastOp', async () => {
    const { deserializeTab } = await import('@/utils/tabDataCodec');
    const tab = deserializeTab({
      id: 't1', url: 'https://a.com', title: 'A',
      created_at: '2026-01-01T00:00:00Z', last_accessed: '2026-01-01T00:00:00Z',
      last_op_device: 'devB', last_op_seq: 42,
    }, 'g1');
    assert.deepEqual(tab?.lastOp, { d: 'devB', s: 42 });
    assert.equal(tab?.group_id, 'g1');
  });

  it('云端行无印记字段（老数据/老客户端写入）→ lastOp 为 undefined（EMPTY_STAMP 语义）', async () => {
    const { deserializeTab } = await import('@/utils/tabDataCodec');
    const tab = deserializeTab({
      id: 't1', url: 'https://a.com', title: 'A',
      created_at: '2026-01-01T00:00:00Z', last_accessed: '2026-01-01T00:00:00Z',
    }, 'g1');
    assert.equal(tab?.lastOp, undefined);
  });

  it('往返一致：serialize → deserialize 保留印记与 isDeleted', async () => {
    const { serializeTab, deserializeTab } = await import('@/utils/tabDataCodec');
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
    const { deserializeTab } = await import('@/utils/tabDataCodec');
    const tab = deserializeTab({
      id: 't1', url: 'javascript:alert(1)', title: 'x',
      created_at: '2026-01-01T00:00:00Z', last_accessed: '2026-01-01T00:00:00Z',
    }, 'g1');
    assert.equal(tab, null);
  });

  it('loading:// 伪装 URL 带标题 key 参与去重 → 原样保留 url 与 title', async () => {
    const { deserializeTab } = await import('@/utils/tabDataCodec');
    const tab = deserializeTab({
      id: 't1', url: 'loading://page', title: 'loading tab',
      created_at: '2026-01-01T00:00:00Z', last_accessed: '2026-01-01T00:00:00Z',
    }, 'g1');
    assert.equal(tab?.url, 'loading://page');
    assert.equal(tab?.title, 'loading tab');
  });
});
