// versionHelper 测试：钉死版本号递增、displayOrder 分配等核心数据完整性不变量。
//
// 这些函数被 updateGroup / displayOrder 流程深度使用，错误的版本号语义
// 会导致 syncEngine 的 mergeTabGroups 误判「云端更新」或「本地更新」。
// 因此纯函数测试覆盖完整，零妥协。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

const NOW = '2026-06-04T08:00:00.000Z';

function makeGroup(version: number | undefined = 1): any {
  return {
    id: 'g-1',
    name: 'Test',
    tabs: [],
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    version,
  };
}

before(async () => {
  register(LOADER_PATH);
});

describe('versionHelper: incrementVersion', () => {
  it('从 version=1 → 2', async () => {
    const { incrementVersion } = await import('@/utils/versionHelper');
    const g = makeGroup(1);
    assert.equal(incrementVersion(g), 2);
  });

  it('version=undefined 视为 1，递增到 2', async () => {
    const { incrementVersion } = await import('@/utils/versionHelper');
    const g = makeGroup(undefined);
    assert.equal(incrementVersion(g), 2, 'undefined version 应被视为 1');
  });

  it('从 version=42 → 43', async () => {
    const { incrementVersion } = await import('@/utils/versionHelper');
    const g = makeGroup(42);
    assert.equal(incrementVersion(g), 43);
  });

  it('不修改原对象', async () => {
    const { incrementVersion } = await import('@/utils/versionHelper');
    const g = makeGroup(5);
    const before = JSON.stringify(g);
    incrementVersion(g);
    assert.equal(JSON.stringify(g), before, 'incrementVersion 应该是纯函数，不修改入参');
  });
});

describe('versionHelper: updateGroupWithVersion', () => {
  it('升级版本号 + 更新时间', async () => {
    const { updateGroupWithVersion } = await import('@/utils/versionHelper');
    const g = makeGroup(3);
    const updated = updateGroupWithVersion(g, { name: 'Renamed' });
    assert.equal(updated.version, 4);
    assert.equal(updated.name, 'Renamed');
    assert.notEqual(updated.updatedAt, NOW, 'updatedAt 应该被刷新');
  });

  it('additionalFields 覆盖原始字段', async () => {
    const { updateGroupWithVersion } = await import('@/utils/versionHelper');
    const g = makeGroup(1);
    const updated = updateGroupWithVersion(g, { id: 'new-id' });
    assert.equal(updated.id, 'new-id', 'additionalFields 应能覆盖 id');
    assert.equal(updated.version, 2);
  });

  it('不提供 additionalFields 时仅升级版本', async () => {
    const { updateGroupWithVersion } = await import('@/utils/versionHelper');
    const g = makeGroup(7);
    const updated = updateGroupWithVersion(g);
    assert.equal(updated.version, 8);
    assert.equal(updated.id, g.id);
    assert.equal(updated.name, g.name);
  });

  it('version=undefined 视为 1', async () => {
    const { updateGroupWithVersion } = await import('@/utils/versionHelper');
    const g = makeGroup(undefined);
    const updated = updateGroupWithVersion(g);
    assert.equal(updated.version, 2);
  });

  it('不修改原对象（返回新对象）', async () => {
    const { updateGroupWithVersion } = await import('@/utils/versionHelper');
    const g = makeGroup(1);
    const beforeVersion = g.version;
    const beforeUpdatedAt = g.updatedAt;
    updateGroupWithVersion(g, { name: 'New' });
    assert.equal(g.version, beforeVersion, '原对象 version 不变');
    assert.equal(g.updatedAt, beforeUpdatedAt, '原对象 updatedAt 不变');
  });
});

describe('versionHelper: updateDisplayOrder', () => {
  it('分配连续 displayOrder 从 0 开始', async () => {
    const { updateDisplayOrder } = await import('@/utils/versionHelper');
    const groups = [
      { ...makeGroup(1), id: 'a' },
      { ...makeGroup(1), id: 'b' },
      { ...makeGroup(1), id: 'c' },
    ];
    const updated = updateDisplayOrder(groups);
    assert.deepEqual(
      updated.map(g => g.displayOrder),
      [0, 1, 2]
    );
  });

  it('升级所有组的 version', async () => {
    const { updateDisplayOrder } = await import('@/utils/versionHelper');
    const groups = [
      { ...makeGroup(5), id: 'a' },
      { ...makeGroup(10), id: 'b' },
    ];
    const updated = updateDisplayOrder(groups);
    assert.equal(updated[0].version, 6);
    assert.equal(updated[1].version, 11);
  });

  it('空数组返回空数组', async () => {
    const { updateDisplayOrder } = await import('@/utils/versionHelper');
    assert.deepEqual(updateDisplayOrder([]), []);
  });

  it('不修改原对象', async () => {
    const { updateDisplayOrder } = await import('@/utils/versionHelper');
    const groups = [{ ...makeGroup(1), id: 'a', displayOrder: 99 }];
    const before = JSON.stringify(groups);
    updateDisplayOrder(groups);
    assert.equal(JSON.stringify(groups), before);
  });
});

describe('versionHelper: initializeVersionFields', () => {
  it('初始化缺失的 version 和 displayOrder', async () => {
    const { initializeVersionFields } = await import('@/utils/versionHelper');
    const g = { ...makeGroup(undefined), displayOrder: undefined };
    delete g.version;
    const init = initializeVersionFields(g, 5);
    assert.equal(init.version, 1);
    assert.equal(init.displayOrder, 5);
  });

  it('保留已有的 version 和 displayOrder', async () => {
    const { initializeVersionFields } = await import('@/utils/versionHelper');
    const g = { ...makeGroup(3), displayOrder: 7 };
    const init = initializeVersionFields(g, 99);
    assert.equal(init.version, 3, '已存在 version 不覆盖');
    assert.equal(init.displayOrder, 7, '已存在 displayOrder 不覆盖');
  });

  it('version 缺失 + displayOrder 缺失 → 用 index', async () => {
    const { initializeVersionFields } = await import('@/utils/versionHelper');
    const g: any = {
      id: 'g-1',
      name: 'Test',
      tabs: [],
      createdAt: NOW,
      updatedAt: NOW,
      isLocked: false,
    };
    delete g.version;
    delete g.displayOrder;
    const init = initializeVersionFields(g, 42);
    assert.equal(init.version, 1);
    assert.equal(init.displayOrder, 42);
  });
});
