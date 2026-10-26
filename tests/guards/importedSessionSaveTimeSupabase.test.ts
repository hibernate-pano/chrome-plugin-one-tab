/**
 * 「保存时间未知」的标记必须**跟着上云**（Supabase 侧）—— 2026-10-25 修复①。
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────────────────
 *
 * WebDAV 侧那一半在 `importedSessionSaveTime.test.ts` 里（分片往返）。
 * Supabase 侧是**另一条链路**：把一条会话写成数据库的**一行**。
 * 那条链路会拉起 SDK 客户端 ⇒ 按仓库里既有惯例（stub 环境 + `register(loader)`
 * + 动态 import）单独一个文件。
 *
 * ── 判据钉的是**行为**，不是源码长相 ──────────────────────────────────────
 *
 * `buildTabGroupRow` 是 2026-10-25 从上传流程里**抽出来的纯函数**
 * （抽之前这一行的构造内联在 `.map()` 里 ⇒ 「上传时到底带不带 `imported_at`」
 * 只能靠读源码判断 ⇒ 而「源码里出现了某段代码」= 零检测力）。
 *
 * ⇒ 守卫**真的调它**、看它返回的那一行 ⇒ 钉的是「这一行**真的**带上了那个列」。
 *
 * ── 两条要**同时**成立（缺一不可） ───────────────────────────────────────
 *
 *   ① 云端**有**那一列 ⇒ 行里**必须**有 `imported_at`。
 *      否则换一台设备下载回来，那条会话会显示成普通会话（说「保存于 …」）
 *      ⇒ **谎话在另一台设备上复活**。
 *   ② 云端**没有**那一列 ⇒ 行里**必须没有** `imported_at` 这个键。
 *      带上不存在的列会让整批 upsert 报 **42703**（unknown column）
 *      ⇒ **所有**会话卡在本地（这比说错话严重得多）。
 *
 * ⇒ 这两条必须**同时**被钉住：只钉① ⇒ 迁移没跑时整批上传失败；
 * 只钉② ⇒ 标记永远传不过去。
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import type { TabGroup } from '@/types/tab';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '../_alias-loader.mjs')
).href;

before(async () => {
  register(LOADER_PATH);
});

const NOW = '2026-10-25T08:00:00.000Z';
const MARKER = '2026-10-25T07:00:00.000Z';

const group = (over: Partial<TabGroup> = {}): TabGroup => ({
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
  // ⚠️ 整个 `over` 铺进去（不是逐个字段抄）⇒ 少写一个字段不会**悄悄丢掉**
  // （第一版逐字段抄，`lastOp` 就被吞了 ⇒ 断言红在一个与被测行为无关的地方）。
  ...over,
});

const opts = (over: { opStampSupported?: boolean; importedAtSupported?: boolean } = {}) => ({
  userId: 'user-1',
  deviceId: 'device-1',
  currentTime: NOW,
  opStampSupported: over.opStampSupported ?? true,
  importedAtSupported: over.importedAtSupported ?? true,
});

describe('Supabase 上行侧：「保存时间未知」的标记必须跟着走', () => {
  it('云端有 imported_at 列 + 会话带标记 ⇒ 那一行**必须**带上 imported_at', async () => {
    const { buildTabGroupRow } = await import('@/utils/supabase/upload');

    const row = buildTabGroupRow(group({ importedAt: MARKER }), opts({ importedAtSupported: true }));

    assert.equal(
      row.imported_at,
      MARKER,
      '标记没上云 ⇒ 换一台设备下载回来，它又变成一条「保存于导入那一刻」的普通会话'
    );
  });

  it('云端**没有** imported_at 列 ⇒ 那一行**不许**出现 imported_at 这个键', async () => {
    const { buildTabGroupRow } = await import('@/utils/supabase/upload');

    const row = buildTabGroupRow(group({ importedAt: MARKER }), opts({ importedAtSupported: false }));

    assert.equal(
      'imported_at' in row,
      false,
      '带上云端不存在的列 ⇒ 整批 upsert 报 42703（unknown column）⇒ ' +
        '**所有**会话卡在本地（比说错话严重得多）'
    );
  });

  it('会话没有标记 ⇒ 那一行**不出现** imported_at（哪怕云端有这一列）', async () => {
    const { buildTabGroupRow } = await import('@/utils/supabase/upload');

    const row = buildTabGroupRow(group(), opts({ importedAtSupported: true }));

    assert.equal(
      'imported_at' in row,
      false,
      '没有标记却写了一个 null/空值 ⇒ 云端那一行会带着「保存时间未知」的空壳回来'
    );
  });

  it('抽取不许改坏既有的行为：op-stamp 的降级口径原样保留', async () => {
    const { buildTabGroupRow } = await import('@/utils/supabase/upload');

    const withStamp = buildTabGroupRow(
      group({ importedAt: MARKER, lastOp: { d: 'dev-a', s: 7 } }),
      opts({ opStampSupported: true, importedAtSupported: true })
    );
    assert.equal(withStamp.last_op_device, 'dev-a');
    assert.equal(withStamp.last_op_seq, 7);
    assert.equal(withStamp.imported_at, MARKER);

    const withoutStamp = buildTabGroupRow(
      group({ importedAt: MARKER, lastOp: { d: 'dev-a', s: 7 } }),
      opts({ opStampSupported: false, importedAtSupported: false })
    );
    assert.equal('last_op_device' in withoutStamp, false, '缺列时整块省略（照旧）');
    assert.equal('imported_at' in withoutStamp, false, '缺列时整块省略（照旧）');
  });
});
