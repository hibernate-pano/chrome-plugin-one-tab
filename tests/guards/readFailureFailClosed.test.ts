/**
 * DS-4 / DS-5（2026-10-23 数据安全审计）：读失败必须**抛**，不许编一个值出来。
 *
 * ── 缺陷本体 ──────────────────────────────────────────────────────────────
 * 两个读都把「读失败」编成了一个**看起来正常**的值：
 *
 *   · **DS-4** `storage.getFirstSyncPending()` ⇒ `catch { return false }`
 *     ⇒ 读失败被当成「归属决策已经做完」⇒ 上传闸门放行
 *     ⇒ **切库时历史会话被全量推上云**（用户从没被问过「这些会话归不归
 *     这个库」）。而「多传」是**不可回滚**的。
 *
 *   · **DS-5** `storage.getPendingUploadRegistryState()` ⇒ `catch { return clean }`
 *     （unreliable:false / gapOpen:false）⇒ 读失败被当成「登记机制是好的」
 *     ⇒ 复位判据认为「漏登记的那批已经被全量补上了」
 *     ⇒ **漏登记的改动永远不再被重试** ⇒ 那些改动静默滞留本机。
 *
 * ── 为什么不能改成「返回一个保守值」 ──────────────────────────────────────
 * 上一轮给的最小改法是 `catch { return true }`（DS-4）/
 * `catch { return { unreliable: true, gapOpen: true, gen: 0 } }`（DS-5）。
 * 方向对，但**照抄会引入新的静默失败**：
 *   · DS-4 返回 true ⇒ 进「白名单模式」，而白名单在同一个读失败下也是空集
 *     ⇒ 本轮一个都不传 ⇒ 对账看到「登记集合 = 空集」⇒ 判定「都传完了」
 *     ⇒ **清掉 pending_upload 并报「全部已同步」** ⇒ 读失败变成一次
 *     「静默的假成功」，比原来的多传更隐蔽；
 *   · DS-5 返回一个编造的 `gen` ⇒ 那份状态会被
 *     `setPendingUploadRegistryStateIfUnchanged` 拿去做 compare-and-set
 *     ⇒ 瞎填的 gen 会挡住本该发生的复位 ⇒ 状态永远卡在「不可信」。
 * ⇒ 两条都**抛**（铁律 1：读失败必须 fail-closed），与 `storage.getGroups`
 *   / `getSettings` 的既有纪律一致。
 *
 * ── 本文件钉住的三条 ──────────────────────────────────────────────────────
 * ① **行为**：读失败 ⇒ 这两个读**真的抛**（不是返回某个值）。
 * ② **行为**：读得到时行为不变（不待决就是不待决、登记干净就是干净）。
 * ③ **接线**：界面必须把「读不到」当成**第三种状态**单独说，
 *    不许把它塞进「不待决」（= 沉默）也不许塞进「待决」（= 编一个事实）。
 *
 * ── 判据形状 ──────────────────────────────────────────────────────────────
 * ① ② 用**真存储 + 注入的读失败**（`tests/_helpers/engineStorageEnv.ts`
 * 的 `failReadKeys`）⇒ 判的是**行为**，不是源码长相。
 * ③ 用源码断言（.tsx 加载不了，且这一条钉的是「有没有第三态」）。
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installEngineStorageEnv } from '../_helpers/engineStorageEnv.ts';
import { ownershipStatusUnreadableNotice } from '../../src/sync-backend/webdav/firstSyncDecision.ts';

// ⚠️ 必须在任何 `@/...` 的 import 之前装好环境桩：
// storage-kv 在**首次 import** 时决定用哪个驱动（没有 IndexedDB ⇒ 回落 localStorage）。
const env = installEngineStorageEnv();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const code = (rel: string) =>
  readFileSync(resolve(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const FIRST_SYNC_PENDING = 'webdav_first_sync_pending';
const PENDING_UPLOAD_REGISTRY_UNRELIABLE = 'pending_upload_registry_unreliable';

describe('DS-4：归属待决状态读失败必须抛（不许当成「没有待决」）', () => {
  beforeEach(() => {
    env.failReadKeys.clear();
    env.failWriteKeys.clear();
  });

  it('读失败 ⇒ 抛错', async () => {
    const { storage } = await import('../../src/utils/storage.ts');
    env.failReadKeys.add(FIRST_SYNC_PENDING);
    await assert.rejects(
      () => storage.getFirstSyncPending('scope-for-test'),
      /simulated read failure/,
      '读不到归属待决状态就必须说「读不到」—— ' +
        '当成「没有待决」⇒ 切库时历史会话被全量推上云，而「多传」不可回滚'
    );
  });

  it('读得到时行为不变（不待决就是不待决）', async () => {
    const { storage } = await import('../../src/utils/storage.ts');
    env.failReadKeys.clear();
    await storage.setFirstSyncPending(false, 'scope-for-test');
    assert.equal(await storage.getFirstSyncPending('scope-for-test'), false);
    await storage.setFirstSyncPending(true, 'scope-for-test');
    assert.equal(await storage.getFirstSyncPending('scope-for-test'), true);
  });
});

describe('DS-5：登记状态读失败必须抛（不许当成「登记是干净的」）', () => {
  beforeEach(() => {
    env.failReadKeys.clear();
    env.failWriteKeys.clear();
  });

  it('读失败 ⇒ 抛错', async () => {
    const { storage } = await import('../../src/utils/storage.ts');
    env.failReadKeys.add(PENDING_UPLOAD_REGISTRY_UNRELIABLE);
    await assert.rejects(
      () => storage.getPendingUploadRegistryState(),
      /simulated read failure/,
      '读不到登记状态就必须说「读不到」—— ' +
        '当成「登记是干净的」⇒ 漏登记的那批改动永远不会被重试'
    );
  });

  it('读得到时行为不变（干净就是干净）', async () => {
    const { storage } = await import('../../src/utils/storage.ts');
    env.failReadKeys.clear();
    await storage.setPendingUploadRegistryUnreliable(false);
    const state = await storage.getPendingUploadRegistryState();
    assert.equal(state.unreliable, false);
    assert.equal(state.gapOpen, false);
  });
});

describe('DS-4：界面必须把「读不到」当成第三种状态单独说', () => {
  const settings = code('src/components/sync/WebDavSettings.tsx');

  it('状态是三态（true / false / null=读不到），不是布尔', () => {
    assert.match(
      settings,
      /useState<boolean \| null>\(/,
      '读不到是第三种状态 —— 塞进布尔里就必然要编一个值出来'
    );
  });

  it('读失败时落到「读不到」那一态（null），不许落回「没有待决」', () => {
    const at = settings.indexOf('refreshOwnershipPending = useCallback(');
    assert.ok(at !== -1, '找不到 refreshOwnershipPending —— 守卫前提变了');
    const body = settings.slice(at, settings.indexOf('\n  }, [', at));
    assert.match(
      body,
      /catch[\s\S]{0,400}setOwnershipPending\(null\)/,
      '读失败必须落进「读不到」那一态 —— 落回 false 就是沉默'
    );
    assert.doesNotMatch(
      body,
      /catch[\s\S]{0,400}setOwnershipPending\(false\)/,
      '读失败不许落回「没有待决」—— 那会让上传停摆这件事在界面上消失'
    );
  });

  it('横幅分三种情况渲染（读不到 / 待决 / 不待决）', () => {
    assert.match(
      settings,
      /ownershipPending === null[\s\S]{0,600}ownershipStatusUnreadableNotice\(/,
      '「读不到」必须有自己的一句话，不许复用「待决」那句'
    );
  });

  it('「读不到」那句话说清三件事：读不到 / 已暂停上传 / 下一步', () => {
    const text = ownershipStatusUnreadableNotice('当前云盘');
    assert.match(text, /读不到/, '必须说「读不到」');
    assert.match(text, /暂停/, '必须说清上传已经停了（这是真的：那一轮中止了）');
    assert.match(text, /刷新|重试/, '必须给出下一步');
    assert.doesNotMatch(text, /[A-Za-z]{4,}/, '界面文案里不出现英文机器串');
  });
});
