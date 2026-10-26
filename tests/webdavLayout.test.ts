// 远端文件布局与编解码测试（2026-10-13，阶段 1）。
//
// 这一层决定「用户的数据以什么形状落在他自己的云盘上」，所以断言的重点是：
//   · 路径拼接的安全性（id 白名单、防穿越）
//   · manifest 解析的「null ≠ 空库」这个关键区别
//   · 编解码的往返保真与宽容解析（云盘文件会被手动改坏）
//
// 变异验证口径（改坏实现必须变红）：
//   · 把 parseManifest 的版本校验删掉 ⇒ 「高版本拒绝」红
//   · 把 parseManifest 解析失败改成返回 emptyManifest() ⇒ 「坏 manifest 必须 null」红
//   · 把 assertSafeId 的白名单放宽成「非空」⇒ 「非法 id 拒绝」红
//   · 把 encodeGroup 的 unopenable 过滤删掉（改成直接摊开 tab）⇒ 「不上云字段」红
//   · 把 serializeManifest 的排序删掉 ⇒ 「稳定输出」红
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MANIFEST_VERSION,
  assertSafeId,
  decodeGroup,
  emptyManifest,
  encodeGroup,
  legacyPathDiffers,
  legacyShardDir,
  legacyShardPath,
  makeEncryptedEnvelope,
  makePlainEnvelope,
  parseEnvelope,
  parseManifest,
  serializeEnvelope,
  serializeManifest,
  shardDir,
  shardPath,
} from '@/sync-backend/webdav/layout';
import type { TabGroup } from '@/types/tab';

const NOW = '2026-10-13T10:00:00.000Z';

function makeGroup(over: Partial<TabGroup> = {}): TabGroup {
  return {
    id: 'a1b2c3d4-0000-4000-8000-000000000000',
    name: '工作会话',
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    lastOp: { d: 'dev-1', s: 7 },
    tabs: [
      {
        id: 't1',
        url: 'https://example.com/a',
        title: '示例',
        createdAt: NOW,
        lastAccessed: NOW,
        pinned: false,
      },
    ],
    ...over,
  };
}

describe('分片路径', () => {
  it('按 id 前一位分子目录（摊薄坚果云的「每 30 分钟 600 次请求」上限）', () => {
    // ⚠️ 2026-10-26：位数从 2 位改成 1 位。
    // 理由不是「1 位更整齐」，是**限额倒推**：
    //   一次全量扫描的请求数 = 1（列 groups/）+ 前缀目录数；
    //   2 位 ⇒ ≤ 257 次 ⇒ 巡检每 5 分钟一次 ⇒ 30 分钟内 6 次 = 1542 次
    //        ⇒ 撞坚果云「每 30 分钟 600 次」⇒ 503 ⇒ 同步停摆 6 小时；
    //   1 位 ⇒ ≤ 17 次 ⇒ 同样的巡检频率下有 35 次的余量。
    assert.equal(shardPath('a1b2c3d4'), 'groups/a/a1b2c3d4.json');
    assert.equal(shardPath('f0e9d8c7'), 'groups/f/f0e9d8c7.json');
  });

  it('旧布局（2 位前缀）仍然算得出路径 —— 老库不能变成隐形数据', () => {
    // 2026-10-13 ~ 2026-10-26 之间建的库，分片都在 2 位前缀目录里。
    // 改布局不能让那些会话对所有设备隐形 ⇒ 旧路径必须仍然可拼。
    assert.equal(legacyShardPath('a1b2c3d4'), 'groups/a1/a1b2c3d4.json');
    assert.equal(legacyShardDir('a1b2c3d4'), 'groups/a1');
    assert.equal(shardDir('a1b2c3d4'), 'groups/a');
  });

  it('两条路径相同时不得当成「两份」（否则同一个文件被数两次）', () => {
    // id 只有 1 位时，前 1 位 == 前 2 位 ⇒ 两条路径是同一个文件。
    // 把它们当成两份 ⇒ 同一个分片被裁决一次、被当成冗余副本删一次。
    assert.equal(legacyPathDiffers('a'), false);
    assert.equal(legacyShardPath('a'), shardPath('a'));
    assert.equal(legacyPathDiffers('a1'), true);
  });

  it('非法 id 一律拒绝（它会被拼进 URL）', () => {
    for (const bad of ['../x', 'a/b', '', '中文', 'a b', 'x'.repeat(129), 'a.b']) {
      assert.throws(() => shardPath(bad), /不合法/, `应拒绝：${JSON.stringify(bad)}`);
      assert.throws(() => legacyShardPath(bad), /不合法/, `应拒绝：${JSON.stringify(bad)}`);
    }
  });

  it('正常 UUID 与下划线/连字符必须放行（不误伤既有 id）', () => {
    for (const ok of ['a1b2', 'ABC-123', 'x_y', 'crypto.randomUUID 的形状'.replace(/[^A-Za-z0-9_-]/g, '')]) {
      assert.doesNotThrow(() => assertSafeId(ok), `不应拒绝：${ok}`);
    }
  });
});

describe('manifest 解析：null 与「空库」必须分得开', () => {
  it('正常 manifest 往返', () => {
    const m = {
      v: MANIFEST_VERSION as 1,
      generatedAt: NOW,
      encrypted: true,
      shards: [
        { id: 'g1', updatedAt: NOW, etag: '"e1"', lastOp: { d: 'd', s: 1 } },
        { id: 'g2', updatedAt: NOW, isDeleted: true },
      ],
    };
    const parsed = parseManifest(serializeManifest(m));
    assert.equal(parsed?.shards.length, 2);
    assert.equal(parsed?.encrypted, true);
    assert.equal(parsed?.shards.find(s => s.id === 'g1')?.etag, '"e1"');
    assert.equal(parsed?.shards.find(s => s.id === 'g2')?.isDeleted, true);
  });

  it('根本解析不出来 → null（**不是**空库）', () => {
    // 这个区别是数据安全的：null ⇒ 调用方走重建/放弃本轮；
    // 当成空库 ⇒ 云端"清空" ⇒ 本地被合并清空 ⇒ 无回收站不可逆。
    assert.equal(parseManifest('{ broken'), null);
    assert.equal(parseManifest('null'), null);
    assert.equal(parseManifest('[]'), null);
    assert.equal(parseManifest(''), null);
  });

  it('格式版本不认识 → null（不用旧代码读新格式）', () => {
    const body = JSON.stringify({ v: 2, generatedAt: NOW, encrypted: true, shards: [] });
    assert.equal(parseManifest(body), null);
    // 畸形版本值同样不可信（不是「大于才拒」）
    assert.equal(parseManifest(JSON.stringify({ v: '1', generatedAt: NOW, shards: [] })), null);
    assert.equal(parseManifest(JSON.stringify({ v: 0, generatedAt: NOW, shards: [] })), null);
  });

  it('shards 非法（不是数组）→ null', () => {
    assert.equal(parseManifest(JSON.stringify({ v: 1, generatedAt: NOW, shards: {} })), null);
  });

  it('单个坏分片被跳过，不拖垮整份 manifest', () => {
    const body = JSON.stringify({
      v: 1,
      generatedAt: NOW,
      encrypted: false,
      shards: [{ id: 'good', updatedAt: NOW }, { id: '../evil', updatedAt: NOW }, { nope: 1 }, null, 'x'],
    });
    const parsed = parseManifest(body);
    assert.equal(parsed?.shards.length, 1);
    assert.equal(parsed?.shards[0].id, 'good');
  });

  it('空 shards 数组是合法的（用户确实还没有会话）', () => {
    const m = emptyManifest(true, NOW);
    assert.equal(parseManifest(serializeManifest(m))?.shards.length, 0);
  });

  it('落点 loc 往返：老索引（没写 loc）解析成「新布局」，写明 legacy 的保持 legacy', () => {
    // 「读哪一份」必须由索引说了算 —— 索引与内容不同源 ⇒ 静默的数据覆盖。
    const m = {
      v: MANIFEST_VERSION as 1,
      generatedAt: NOW,
      encrypted: false,
      shards: [
        { id: 'g1', updatedAt: NOW },
        { id: 'g2', updatedAt: NOW, loc: 'legacy' as const },
        { id: 'g3', updatedAt: NOW, loc: '新布局' as unknown as 'legacy' },
      ],
    };
    const parsed = parseManifest(serializeManifest(m));
    assert.equal(parsed?.shards.find(s => s.id === 'g1')?.loc, undefined);
    assert.equal(parsed?.shards.find(s => s.id === 'g2')?.loc, 'legacy');
    // 认不出来的 loc 值不许被当成 legacy（那会读错文件）
    assert.equal(parsed?.shards.find(s => s.id === 'g3')?.loc, undefined);
  });

  it('输出稳定：内容相同则字符串逐字相同（用于「要不要 PUT」的廉价判据）', () => {
    const a = serializeManifest({
      v: 1,
      generatedAt: NOW,
      encrypted: true,
      shards: [
        { id: 'zz', updatedAt: NOW },
        { id: 'aa', updatedAt: NOW },
      ],
    });
    const b = serializeManifest({
      v: 1,
      generatedAt: NOW,
      encrypted: true,
      shards: [
        { id: 'aa', updatedAt: NOW },
        { id: 'zz', updatedAt: NOW },
      ],
    });
    assert.equal(a, b, 'shards 顺序不同不应产生不同输出');
  });
});

describe('会话编解码', () => {
  it('往返保真：名字/标签/锁定/印记都回来', () => {
    const g = makeGroup({ isLocked: true });
    const back = decodeGroup(encodeGroup(g));
    assert.equal(back?.id, g.id);
    assert.equal(back?.name, g.name);
    assert.equal(back?.isLocked, true);
    assert.deepEqual(back?.lastOp, { d: 'dev-1', s: 7 });
    assert.equal(back?.tabs.length, 1);
    assert.equal(back?.tabs[0].url, 'https://example.com/a');
  });

  it('退役字段 displayOrder：既不写进分片、也不被解出来（两条后端形状对齐）', () => {
    // 2026-10-20 审计 A-10：它从来没有任何读取方，却让 WebDAV 侧解出来的形状
    // 与 Supabase 侧（从不上传）不一致。断言的是**行为**：
    //   · 老用户内存里可能还带着这个键（类型已删、存量数据仍在）⇒ 不许写出去
    //   · 老分片里可能还带着这个键 ⇒ 解码后不许再冒出来
    const legacy = { ...makeGroup(), displayOrder: 7 };
    const encoded = encodeGroup(legacy as TabGroup) as Record<string, unknown>;
    assert.ok(!('displayOrder' in encoded), '退役字段不应再写进远端分片');

    const back = decodeGroup({ ...encoded, displayOrder: 7 });
    assert.ok(back, '多余字段不该让整条会话解不出来');
    assert.ok(!('displayOrder' in back), '退役字段不应再被解出来');
  });

  it('unopenable 不上云（它是「本设备的判断」，传出去会污染对端）', () => {
    const g = makeGroup();
    g.tabs[0].unopenable = true;
    const encoded = encodeGroup(g);
    const tabs = encoded.tabs as Array<Record<string, unknown>>;
    assert.ok(!('unopenable' in tabs[0]), 'unopenable 不应被写进远端文件');
    // 但它不该影响本地解码后的形状（解码侧不产生该字段）
    assert.equal(decodeGroup(encoded)?.tabs[0].unopenable, undefined);
  });

  it('纯 UI 态字段（syncStatus）不进远端', () => {
    // openedAt 已随 1.24.1「点开即消费」删除（字段本身不存在，无需再断言排除）。
    const g = makeGroup();
    g.tabs[0].syncStatus = 'synced';
    const tabs = encodeGroup(g).tabs as Array<Record<string, unknown>>;
    assert.ok(!('syncStatus' in tabs[0]));
  });

  it('宽容解析：tabs 不是数组时保留会话（会话丢失比标签少更糟）', () => {
    const back = decodeGroup({ id: 'g1', name: 'n', tabs: 'oops' });
    assert.ok(back, '整条会话不应因 tabs 形状坏而消失');
    assert.deepEqual(back?.tabs, []);
  });

  it('宽容解析：缺 id 或 id 非法 → null（无法定位的实体不能入库）', () => {
    assert.equal(decodeGroup({ name: 'no id' }), null);
    assert.equal(decodeGroup({ id: '../x', name: 'evil' }), null);
    assert.equal(decodeGroup(null), null);
    assert.equal(decodeGroup('string'), null);
  });

  it('宽容解析：单个坏标签被剔除，其余保留', () => {
    const back = decodeGroup({
      id: 'g1',
      name: 'n',
      tabs: [
        { url: 'https://ok.example', title: 'ok' },
        { title: '没有 url' },
        null,
        { url: '' },
      ],
    });
    assert.equal(back?.tabs.length, 1);
    assert.equal(back?.tabs[0].url, 'https://ok.example');
  });

  it('宽容解析：缺字段回落到确定的默认值，而不是 undefined 满天飞', () => {
    const back = decodeGroup({ id: 'g1' });
    assert.equal(back?.name, 'Untitled');
    assert.equal(back?.isLocked, false);
    assert.equal(back?.createdAt, new Date(0).toISOString());
    assert.deepEqual(back?.tabs, []);
  });
});

describe('落盘外壳：加密与明文必须可区分（不能靠猜）', () => {
  it('加密外壳往返', () => {
    const env = makeEncryptedEnvelope({ v: 1, salt: 'c2FsdA==', data: 'ZGF0YQ==' });
    const parsed = parseEnvelope(serializeEnvelope(env));
    assert.equal(parsed?.kind, 'encrypted');
    if (parsed?.kind === 'encrypted') assert.equal(parsed.enc.salt, 'c2FsdA==');
  });

  it('明文外壳往返（用户选了不加密）', () => {
    const parsed = parseEnvelope(serializeEnvelope(makePlainEnvelope({ id: 'g1' })));
    assert.equal(parsed?.kind, 'plain');
    if (parsed?.kind === 'plain') assert.deepEqual(parsed.plain, { id: 'g1' });
  });

  it('enc 与 plain 同时存在或同时缺失 → null（不做猜测式解析）', () => {
    // 猜测式解析会把「口令输错」和「文件本来就是明文」混成同一件事，
    // 用户会得到「口令错误」却怎么改都不对。
    assert.equal(parseEnvelope(JSON.stringify({ v: 1 })), null);
    assert.equal(
      parseEnvelope(JSON.stringify({ v: 1, enc: { v: 1, salt: 'a', data: 'b' }, plain: {} })),
      null
    );
  });

  it('损坏/版本不符 → null', () => {
    assert.equal(parseEnvelope('{ broken'), null);
    assert.equal(parseEnvelope(JSON.stringify({ v: 2, plain: 1 })), null);
    assert.equal(parseEnvelope(JSON.stringify({ v: 1, enc: { v: 9, salt: 'a', data: 'b' } })), null);
    assert.equal(parseEnvelope(JSON.stringify({ v: 1, enc: { v: 1, salt: 1, data: 'b' } })), null);
  });
});

