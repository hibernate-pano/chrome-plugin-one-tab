// S2 存储 KV 收敛：MIGRATION_SCAN_KEYS 必须覆盖全部会落盘的键。
//
// 【本文件是恢复的守卫】2026-10-16 瘦身删掉整份 tests/storageKvConvergence.test.ts
// 时，这条断言一起被删。审计用变异证明：把 MIGRATION_SCAN_KEYS 从
// `[...Object.values(STORAGE_KEYS), ...]` 改成 `.filter(k => k !== 'pending_delete_ids')`
// 后，全量 1046 个测试依旧全绿 —— 而 pending_delete_ids 是跨设备删除广播队列，
// 在 chrome.storage → KV 迁移中漏掉它，老用户的「离线删除意图」会在升级时静默
// 蒸发，云端活跃行无人服从 → 对端下次合并整组复活（v1.22.0 起无回收站）。
//
// 2026-10-07 P1-7 的原缺陷：MIGRATION_KEYS 是一张**手抄的 9 项子集**，
// 而 STORAGE_KEYS 当时已有 16 项。漏掉的 pending_delete_ids / device_seq /
// last_upload_time 等键会让 v1.21.x 直升的老用户静默丢数据。修法是把扫描键改为
// 由 STORAGE_KEYS 全量派生；本文件钉死这个不变量，新增业务键漏迁会直接红。
//
// 原文件其余部分（键字面值快照、双路径转发、SecureStorage 清单等）依赖已删除的
// 模块与键（PRODUCT_EVENTS / PERF_SPANS / supabase 改线冒烟），未恢复。
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

describe('S2 键常量单源', () => {
  it('MIGRATION_KEYS 与 STORAGE_KEYS/LEGACY_KEYS 同源（值相等且引用同一单源）', async () => {
    const { STORAGE_KEYS, MIGRATION_KEYS, MIGRATION_SCAN_KEYS, LEGACY_KEYS } =
      await import('@/storage-kv/keys');

    // 迁移扫描必须覆盖每一个会落盘的 STORAGE_KEYS —— 这才是「不分叉」的可执行定义。
    const storageKeyValues = Object.values(STORAGE_KEYS);
    for (const key of storageKeyValues) {
      assert.ok(
        MIGRATION_SCAN_KEYS.includes(key),
        `STORAGE_KEYS 的 ${key} 不在 MIGRATION_SCAN_KEYS 里 —— ` +
          '该键在 chrome.storage → KV 迁移中会被漏掉。新增业务键后请确认派生表已跟上。'
      );
    }

    // 且必须包含全部历史键名（只存在于 chrome.storage 的旧键）。
    for (const key of Object.values(LEGACY_KEYS)) {
      assert.ok(
        MIGRATION_SCAN_KEYS.includes(key),
        `LEGACY_KEYS 的 ${key} 不在 MIGRATION_SCAN_KEYS 里 —— 存量数据会变孤儿`
      );
    }

    // 反向：扫描表不得凭空引入不存在的键（防止把无关键也搬一遍）。
    const allKnown = new Set<string>([...storageKeyValues, ...Object.values(LEGACY_KEYS)]);
    const invented = MIGRATION_SCAN_KEYS.filter(k => !allKnown.has(k));
    assert.deepEqual(
      invented,
      [],
      `MIGRATION_SCAN_KEYS 混入了未登记的键：${invented.join(', ')}。` +
        '新增键必须先进 STORAGE_KEYS 或 LEGACY_KEYS。'
    );

    // 别名表本身仍须同源引用（非各自手写字符串）。
    assert.equal(MIGRATION_KEYS.tabGroups, STORAGE_KEYS.GROUPS);
    assert.equal(MIGRATION_KEYS.migrationFlags, STORAGE_KEYS.MIGRATION_FLAGS);
    assert.equal(MIGRATION_KEYS.deviceId, LEGACY_KEYS.DEVICE_ID);
    assert.equal(MIGRATION_KEYS.legacyDeviceId, LEGACY_KEYS.LEGACY_DEVICE_ID);
    assert.equal(MIGRATION_KEYS.legacyTabGroups, LEGACY_KEYS.LEGACY_TAB_GROUPS);
    assert.equal(MIGRATION_KEYS.tabGroupPrefix, LEGACY_KEYS.TAB_GROUP_PREFIX);
  });
});
