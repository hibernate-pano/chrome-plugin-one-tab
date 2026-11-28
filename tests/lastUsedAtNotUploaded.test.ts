/**
 * 「本机使用时间**绝不跟着会话上云**」的守卫（v1.33）。
 *
 * ── 为什么这条不能只靠「我们没把字段塞进 TabGroup」──────────────────────
 *
 * 会话是**整体快照**上云的：Supabase 侧 `buildTabGroupRow` 把一条 `TabGroup`
 * 写成数据库的一行，WebDAV 侧 `encodeGroup` 把它写成一个分片文件。
 * 两条路径都是**字段白名单**（不是展开 `...group`）——本文件要钉住的就是
 * 这个白名单**真的把多出来的字段挡在门外**。
 *
 * 判据不是「源码里没有 lastUsedAt」——那是零检测力（字段可能从别处混进来）。
 * 这里**真的塞一个** `lastUsedAt` 进会话对象，真的调两个序列化函数，
 * 再看序列化结果里有没有它。将来谁把白名单改成展开写法，这条立刻红。
 *
 * ── 为什么这个不变量值得一道守卫 ─────────────────────────────────────────
 *
 * 「使用时间」说的是**这台设备上**发生过什么。它一旦上云并参与合并：
 *   · 另一台设备会看到一条**它这儿从没发生过**的使用记录；
 *   · 它还会被合并回本机、覆盖真实值 —— 而用户没有任何入口去纠正它。
 * ⇒ 一句话在两个设备上同时为真，是「本机记录」这个设计能成立的前提。
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import type { TabGroup } from '../src/types/tab.ts';

// 最小浏览器环境：Supabase 模块在导入期会碰 storage 相关单例。
const lsData = new Map<string, string>();
(globalThis as Record<string, unknown>).window = {
  localStorage: {
    get length(): number {
      return lsData.size;
    },
    key: (index: number): string | null => [...lsData.keys()][index] ?? null,
    getItem: (key: string): string | null => lsData.get(key) ?? null,
    setItem: (key: string, value: string): void => void lsData.set(key, String(value)),
    removeItem: (key: string): void => void lsData.delete(key),
    clear: (): void => void lsData.clear(),
  },
};
(globalThis as Record<string, unknown>).localStorage = (
  globalThis as unknown as { window: { localStorage: unknown } }
).window.localStorage;

let buildTabGroupRow: typeof import('../src/utils/supabase/upload.ts').buildTabGroupRow;
let encodeGroup: typeof import('../src/sync-backend/webdav/layout.ts').encodeGroup;

before(async () => {
  ({ buildTabGroupRow } = await import('../src/utils/supabase/upload.ts'));
  ({ encodeGroup } = await import('../src/sync-backend/webdav/layout.ts'));
});

const NOW = '2026-11-27T08:00:00.000Z';
/** 一个绝不会与真实时间戳混淆的标记。 */
const LEAK_MARKER = '2001-02-03T04:05:06.000Z';

/**
 * 造一条**偷偷带着** `lastUsedAt` 的会话。
 *
 * 用 `as` 把它塞进 `TabGroup` 之外的类型里：这是刻意的 —— 本守卫要证明的
 * 就是「哪怕字段真的混进来了，序列化白名单也把它挡掉」。
 */
const groupWithInjectedLastUsedAt = (): TabGroup =>
  ({
    id: 'g1',
    name: '会话',
    tabs: [
      {
        id: 't1',
        url: 'https://a.example/one',
        title: '一',
        favicon: '',
        createdAt: NOW,
        lastAccessed: NOW,
        pinned: false,
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    // 注入点（真实代码路径不会这么做；这里是「白名单挡得住吗」的反证）。
    lastUsedAt: LEAK_MARKER,
  }) as unknown as TabGroup;

const assertNoLeak = (label: string, serialized: unknown): void => {
  const json = JSON.stringify(serialized);
  assert.equal(
    json.includes('lastUsedAt'),
    false,
    `${label} 里出现了 lastUsedAt —— 本机使用时间绝不能跟着会话上云`
  );
  assert.equal(
    json.includes(LEAK_MARKER),
    false,
    `${label} 里出现了使用时间标记 ${LEAK_MARKER} —— 它会跑到别的设备上，而那句话在那边是假的`
  );
};

describe('上行载荷 · Supabase 行不带 lastUsedAt', () => {
  it('buildTabGroupRow 的整行序列化结果里没有 lastUsedAt', () => {
    const row = buildTabGroupRow(groupWithInjectedLastUsedAt(), {
      userId: 'user-1',
      deviceId: 'device-1',
      currentTime: NOW,
      opStampSupported: true,
      importedAtSupported: true,
    });
    assertNoLeak('buildTabGroupRow 的返回值', row);
  });

  it('云端缺列（两种降级形态）时也不带', () => {
    const row = buildTabGroupRow(groupWithInjectedLastUsedAt(), {
      userId: 'user-1',
      deviceId: 'device-1',
      currentTime: NOW,
      opStampSupported: false,
      importedAtSupported: false,
    });
    assertNoLeak('buildTabGroupRow（降级形态）的返回值', row);
  });
});

describe('上行载荷 · WebDAV 分片不带 lastUsedAt', () => {
  it('encodeGroup 的整份分片序列化结果里没有 lastUsedAt', () => {
    const shard = encodeGroup(groupWithInjectedLastUsedAt());
    assertNoLeak('encodeGroup 的返回值', shard);
  });

  it('反证：白名单本身不是「什么都过滤」—— 会话的常规字段必须在', () => {
    // 如果 encodeGroup 返回空对象，上面的「没有 lastUsedAt」就毫无意义。
    const shard = encodeGroup(groupWithInjectedLastUsedAt());
    assert.equal(shard.id, 'g1');
    assert.equal(shard.name, '会话');
    assert.equal(Array.isArray(shard.tabs), true);
  });
});
