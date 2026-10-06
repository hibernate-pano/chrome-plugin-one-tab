import type { StorageDriver } from './types';

const DB_NAME = 'tabvaultpro';
const DB_VERSION = 1;
const KV_STORE = 'kv';

function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!isIndexedDbAvailable()) {
      reject(new Error('IndexedDB not available'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KV_STORE)) {
        db.createObjectStore(KV_STORE, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    // blocked：有另一个连接持有旧版本且未关闭。浏览器不会因此 resolve/reject，
    // 若不处理则 open 的 promise 永远不 settle → 上层 kvGet 永久挂起（不是失败）。
    // 这里直接判失败：挂起无法被上层感知，也无从恢复。
    request.onblocked = () => reject(new Error('IndexedDB open blocked by another connection'));
  });
}

let cachedDb: IDBDatabase | null = null;

/**
 * 单次事务的硬上限（2026-10-06）。
 *
 * 【为什么必须有】MV3 的 Service Worker 空闲约 30s 会被 Chrome 回收，
 * 浏览器**单方面**关闭 IndexedDB 连接，但 JS 变量（cachedDb）仍指向那条
 * 已死的句柄。在这种句柄上 `db.transaction()` 既不 resolve 也不 reject ——
 * 调用方的 Promise 永久挂起，既不失败也无法重试。
 *
 * 线上症状与本仓库的日志量级完全吻合：`removeTab.wait 34939ms`（≈ SW 回收
 * 时长）、清理/删除一律「点不动」，约 30s 后报协议超时。而 popup 侧的
 * 30s 超时（core/mutationProtocol）只是不等了，SW 里的挂起任务仍在，
 * 单写者队列 `running` 永远为 true —— 之后所有命令都排在它后面，整条链路死锁。
 *
 * 【为什么不是「修好它」而是「判失败」】死句柄上的请求无法被取消，也没有
 * API 能把它唤醒。唯一有效的处置是：不把挂起当挂起 —— 到点判定失败、
 * 丢弃句柄、下次调用重新 openDatabase()。一次操作失败可以重试，永久挂起不能。
 *
 * 取值：留足余量又不能撞上 popup 的 30s 协议上界，否则 UI 先超时、
 * 真相后到，用户会看到「失败了但其实成功了」。5s 远大于本地 KV 的正常耗时
 * （亚毫秒级），也远小于 SW 回收窗口。
 */
const TX_TIMEOUT_MS = 5_000;

async function getDb(): Promise<IDBDatabase> {
  if (cachedDb) {
    // 死句柄自检：连接被浏览器单方面关闭时，IDBDatabase 不发事件、也不抛错，
    // 但 close() 之后再用它建事务必然抛 InvalidStateError。这里不预判，
    // 让 runTransaction 的 catch 捕获并走同一条「丢弃句柄」路径。
    return cachedDb;
  }
  const db = await openDatabase();
  cachedDb = db;
  db.onversionchange = () => {
    // 另一个上下文要升级版本：必须让出，否则我们的连接会把它的 upgrade 卡在
    // blocked（而 blocked 的 open 永不 settle，见 openDatabase）。
    try {
      db.close();
    } catch {
      /* 已关闭则无事可做 */
    }
    if (cachedDb === db) cachedDb = null;
  };
  return db;
}

/** 丢弃缓存句柄，强制下次重新 open（死句柄与事务异常共用同一处置）。 */
function dropCachedDb(db: IDBDatabase | null): void {
  try {
    db?.close();
  } catch {
    /* close 本身失败无需处理：句柄即将被丢弃 */
  }
  if (cachedDb === null || cachedDb === db) cachedDb = null;
}

async function runTransaction<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await getDb();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      // settled 门：resolve/reject 只认第一次。
      //
      // 为什么必需：request.onsuccess 与 tx.onabort/onerror 可能**都**到达
      // （请求成功后事务在提交阶段失败、被 abort() 打断、或被看门狗 abort 引发
      // onabort）。Promise 本身会忽略第二次 settle，但 handler 里的副作用不会：
      // 看门狗路径上 resolve 之后再 onabort，会再次跑 dropCachedDb 并 reject，
      // 而 reject 里已经抛过一次 —— 表现为「一次读失败抛两个不同的错」，
      // 上层 fail-closed 逻辑会被误导。
      let settled = false;
      const settleOk = (v: T) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      const settleErr = (e: unknown) => {
        if (settled) return;
        settled = true;
        reject(e instanceof Error ? e : new Error(String(e)));
      };

      let tx: IDBTransaction;
      try {
        tx = db.transaction(KV_STORE, mode);
      } catch (e) {
        // 死句柄在这里直接抛 InvalidStateError（getDb 的自检说明不能预判）。
        // 必须立刻判失败并清句柄，否则后续每次调用都撞同一条死路。
        dropCachedDb(db);
        settleErr(e);
        return;
      }
      const store = tx.objectStore(KV_STORE);
      const request = action(store);

      request.onsuccess = () => settleOk(request.result as T);
      request.onerror = () =>
        settleErr(request.error ?? new Error('IndexedDB request failed'));
      tx.onabort = () => settleErr(tx.error ?? new Error('IndexedDB transaction aborted'));

      // 看门狗：死句柄上 request/tx 的任何事件都不会来，只能靠时间判定。
      timer = setTimeout(() => {
        if (settled) return;
        // 主动 abort 是为了让浏览器尽快释放这条事务；失败无妨（多半已是死事务）。
        try {
          tx.abort();
        } catch {
          /* 已结束/死事务，忽略 */
        }
        dropCachedDb(db);
        settleErr(
          new Error(`IndexedDB 事务超时（超过 ${TX_TIMEOUT_MS}ms 无响应，句柄可能已失效）`)
        );
      }, TX_TIMEOUT_MS);
    });
  } catch (error) {
    // 事务失败后句柄可能已进入不可用状态（连接被关、版本变更中）。
    // 丢弃缓存句柄，下次调用重新 open，避免在坏句柄上反复失败。
    dropCachedDb(db);
    throw error;
  } finally {
    // 无论成功、失败还是超时，都要拆掉定时器：漏掉会让每个成功的读都挂一个
    // 5s 的存活定时器，长会话下累积成定时器风暴。
    if (timer) clearTimeout(timer);
  }
}

export const indexedDbDriver: StorageDriver = {
  async getItem<T>(key: string): Promise<T | null> {
    // fail-closed：读失败必须抛错，不能与「键不存在」同形（都返回 null）。
    // 静默返回 null 会让上层把一次瞬时读错误当成「没有数据」——
    // 而所有写路径都是 getGroups() 的读-改-写，groups 读成 [] 时
    // 保存/删除/重命名/移动的结果会整组覆盖用户数据并回报 ok:true。
    const result = await runTransaction<any>('readonly', store => store.get(key));

    // 数据以 { key, value } 形式存入，读取时需要取出 value
    if (result && typeof result === 'object' && 'value' in result) {
      return (result as { value: T }).value;
    }

    // 兼容直接存储原始值的情况
    return result as T | null;
  },

  async setItem<T>(key: string, value: T): Promise<void> {
    await runTransaction('readwrite', store => store.put({ key, value }));
  },

  async removeItem(key: string): Promise<void> {
    await runTransaction('readwrite', store => store.delete(key));
  }
};

export { isIndexedDbAvailable };
