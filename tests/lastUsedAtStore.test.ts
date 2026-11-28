/**
 * 「最近使用」本机记录的行为守卫（v1.33）。
 *
 * ── 它守的是什么 ──────────────────────────────────────────────────────────
 *
 * `src/storage-kv/lastUsedAtStore.ts` 是「最近使用」排序与时间位的**唯一**
 * 数据源。它有三条一旦破掉就在用户那里变成「数据丢了」的纪律：
 *
 *   ① **落点必须是独立键** `last_used_at`（不能碰 `tab_groups`）——
 *      碰了 `tab_groups` 就等于把本机使用时间塞进会话快照，它会跟着上传、
 *      跟着合并、跑到别的设备上，而那句话在别的设备上是**假的**；
 *   ② **读-改-写 + 单写者串行**：两条记录不能互相覆盖（一次点击可能连着
 *      记两条：锁定组恢复 + 某个标签）；
 *   ③ **读不出来就不写**：读失败那一轮如果照着内存空表写回去，就会把
 *      「读不出来但真实存在」的旧记录全部抹掉。
 *
 * 这三条**都只能从行为上看**（读源码看不出「会不会抹掉」），所以本文件
 * 真的装一份 localStorage、真的调 `recordSessionUsed` / `loadLastUsedAt`，
 * 再看落盘的那份字节。
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ─────────────────────────────────────────────────────────────────────────
// 0. 最小存储环境（必须在**导入被测模块之前**挂好）
// ─────────────────────────────────────────────────────────────────────────
//
// storageAdapter 在模块初始化时挑驱动：有 indexedDB → IndexedDB；否则
// 回退 window.localStorage。Node 测试里没有 IndexedDB，但我们显式删掉它，
// 免得将来 Node 版本自带一个导致这份用例静默走另一条驱动。
delete (globalThis as Record<string, unknown>).indexedDB;
delete (globalThis as Record<string, unknown>).chrome; // 不走扩展迁移路径

const lsData = new Map<string, string>();

/** 可注入读失败（模拟「存储存在但读不了」，见文件头纪律③）。 */
let failReads = false;

const localStorageStub = {
  get length(): number {
    return lsData.size;
  },
  key: (index: number): string | null => [...lsData.keys()][index] ?? null,
  getItem: (key: string): string | null => {
    if (failReads) throw new Error('模拟：本地存储读取失败');
    return lsData.has(key) ? (lsData.get(key) as string) : null;
  },
  setItem: (key: string, value: string): void => {
    lsData.set(key, String(value));
  },
  removeItem: (key: string): void => {
    lsData.delete(key);
  },
  clear: (): void => {
    lsData.clear();
  },
};

(globalThis as Record<string, unknown>).window = { localStorage: localStorageStub };
(globalThis as Record<string, unknown>).localStorage = localStorageStub;

let store: typeof import('../src/storage-kv/lastUsedAtStore.ts');
let STORAGE_KEYS: typeof import('../src/storage-kv/keys.ts').STORAGE_KEYS;

before(async () => {
  store = await import('../src/storage-kv/lastUsedAtStore.ts');
  ({ STORAGE_KEYS } = await import('../src/storage-kv/keys.ts'));
});

/** 读出落盘的原始使用记录（`null` = 这个键不存在）。 */
const persisted = (): Record<string, string> | null => {
  const raw = lsData.get('last_used_at');
  return raw === undefined ? null : (JSON.parse(raw) as Record<string, string>);
};

beforeEach(() => {
  lsData.clear();
  failReads = false;
  store.__resetLastUsedAtForTests();
});

// ─────────────────────────────────────────────────────────────────────────
// 1. 落点：独立键，绝不碰 tab_groups
// ─────────────────────────────────────────────────────────────────────────

describe('落点 · 使用记录只写独立键 last_used_at', () => {
  it('键名就是 STORAGE_KEYS.LAST_USED_AT（= last_used_at）', () => {
    assert.equal(STORAGE_KEYS.LAST_USED_AT, 'last_used_at');
  });

  it('记一次使用 ⇒ 落盘到 last_used_at，且**不碰** tab_groups', async () => {
    // 先在 tab_groups 里放一份「用户会话」，用来证明它一个字节都没动。
    const groupsBefore = JSON.stringify([{ id: 'g1', name: '会话' }]);
    lsData.set('tab_groups', groupsBefore);

    await store.recordSessionUsed('g1', '2026-11-27T10:00:00.000Z');

    assert.deepEqual(persisted(), { g1: '2026-11-27T10:00:00.000Z' });
    assert.equal(
      lsData.get('tab_groups'),
      groupsBefore,
      '使用记录绝不能写进 tab_groups（它会跟着会话快照上云）'
    );
  });

  it('多次记录是读-改-写：旧记录不许被「只有一个 id」覆盖掉', async () => {
    await store.recordSessionUsed('g1', '2026-11-27T10:00:00.000Z');
    await store.recordSessionUsed('g2', '2026-11-27T11:00:00.000Z');

    assert.deepEqual(persisted(), {
      g1: '2026-11-27T10:00:00.000Z',
      g2: '2026-11-27T11:00:00.000Z',
    });
  });

  it('同一个会话再记一次 ⇒ 时间被刷新（不是保留第一次）', async () => {
    await store.recordSessionUsed('g1', '2026-11-01T10:00:00.000Z');
    await store.recordSessionUsed('g1', '2026-11-27T10:00:00.000Z');

    assert.deepEqual(persisted(), { g1: '2026-11-27T10:00:00.000Z' });
  });

  it('并发记录不许互相盖掉（单写者串行）', async () => {
    // 同一次点击可能连着触发两条记录（锁定组恢复 + 某个标签）。
    await Promise.all([
      store.recordSessionUsed('a', '2026-11-27T10:00:00.000Z'),
      store.recordSessionUsed('b', '2026-11-27T10:00:01.000Z'),
      store.recordSessionUsed('c', '2026-11-27T10:00:02.000Z'),
    ]);

    assert.deepEqual(persisted(), {
      a: '2026-11-27T10:00:00.000Z',
      b: '2026-11-27T10:00:01.000Z',
      c: '2026-11-27T10:00:02.000Z',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 读回来：脏值被丢弃、内存快照稳定可订阅
// ─────────────────────────────────────────────────────────────────────────

describe('读回 · 只接受「非空 id + 可解析时间」', () => {
  it('磁盘上的脏值被丢弃，合法记录照常读进内存', async () => {
    lsData.set(
      'last_used_at',
      JSON.stringify({
        good: '2026-11-27T10:00:00.000Z',
        badTime: '不是时间戳',
        emptyTime: '',
        numberTime: 42,
        '': '2026-11-27T10:00:00.000Z',
      })
    );

    await store.loadLastUsedAt();

    assert.deepEqual(store.getLastUsedAtSnapshot(), {
      good: '2026-11-27T10:00:00.000Z',
    });
  });

  it('非法 groupId / 非法时间不会被写进去', async () => {
    await store.recordSessionUsed('   ', '2026-11-27T10:00:00.000Z');
    await store.recordSessionUsed('g1', '不是时间戳');

    assert.equal(persisted(), null, '什么都不该落盘');
    assert.deepEqual(store.getLastUsedAtSnapshot(), {});
  });

  it('快照引用稳定：没变化时返回同一个对象（useSyncExternalStore 的要求）', async () => {
    await store.recordSessionUsed('g1', '2026-11-27T10:00:00.000Z');
    const first = store.getLastUsedAtSnapshot();
    assert.equal(store.getLastUsedAtSnapshot(), first);
    await store.recordSessionUsed('g2', '2026-11-27T11:00:00.000Z');
    assert.notEqual(store.getLastUsedAtSnapshot(), first, '有新记录时必须换引用（否则界面不重渲染）');
  });

  it('订阅者在记录变化时被通知，取消订阅后不再收到', async () => {
    let calls = 0;
    const unsubscribe = store.subscribeLastUsedAt(() => {
      calls += 1;
    });
    await store.recordSessionUsed('g1', '2026-11-27T10:00:00.000Z');
    assert.equal(calls, 1, '记录变化必须通知订阅者');
    unsubscribe();
    await store.recordSessionUsed('g2', '2026-11-27T11:00:00.000Z');
    assert.equal(calls, 1, '取消订阅后不得再收到通知');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. 失败方向：读不出来就不写（纪律③）
// ─────────────────────────────────────────────────────────────────────────

describe('失败方向 · 读不出来时绝不落盘（免得抹掉真实存在的旧记录）', () => {
  it('读失败 ⇒ 本轮不写；磁盘上的旧记录原封不动', async () => {
    const existing = { old: '2026-11-01T10:00:00.000Z' };
    lsData.set('last_used_at', JSON.stringify(existing));

    // 复位内存（模拟冷启动：还不知道磁盘上有什么）后让读失败。
    store.__resetLastUsedAtForTests();
    failReads = true;

    await store.recordSessionUsed('new', '2026-11-27T10:00:00.000Z');

    assert.deepEqual(
      persisted(),
      existing,
      '读失败的一轮如果照内存空表写回去，就把读不出来的旧记录全抹了'
    );
    assert.deepEqual(
      store.getLastUsedAtSnapshot(),
      { new: '2026-11-27T10:00:00.000Z' },
      '内存仍要立刻反映用户刚做的动作（界面照常排序）'
    );
  });

  it('读失败之后下一次成功加载会把磁盘旧值合并进来（内存值优先）', async () => {
    lsData.set('last_used_at', JSON.stringify({ old: '2026-11-01T10:00:00.000Z' }));
    store.__resetLastUsedAtForTests();
    failReads = true;
    await store.recordSessionUsed('new', '2026-11-27T10:00:00.000Z');

    failReads = false;
    const ok = await store.loadLastUsedAt();

    assert.equal(ok, true, '下一次读成功时必须重试成功');
    assert.deepEqual(store.getLastUsedAtSnapshot(), {
      old: '2026-11-01T10:00:00.000Z',
      new: '2026-11-27T10:00:00.000Z',
    });
  });
});
