// P1-5 · 乐观写失败回滚回归测试（纯 reducer，无 chrome / 无 SW）。
//
// 背景：重命名 / 锁定 / 收藏 / 备注四条路径都是「先乐观改 Redux，再 sendMutation」，
// 而 sendMutation 失败时没有任何一层把 Redux 改回去。后果不是"提示少了"，
// 而是 UI 显示的值与 storage 里的值永久分叉，且此后无人收敛（loadGroups 只在回环触发）：
//   - 锁定：UI 显示已锁定、storage 未锁定 → 自动清理/删除保护按 storage 判据执行，
//           用户刚锁上的会话会被当普通组清掉。
//   - 备注/收藏：UI 显示已保存，关掉弹窗就没了。
//   - 重命名：UI 名字与 storage 名字不一致，version/updatedAt 还被乐观 bump 过，
//           下次同步合并会把 storage 的旧名当陈旧版本丢掉。
//
// 本文件锁定三件事：
//  1) 失败时 reducer 用 thunk 带回来的快照精确还原（name+version+updatedAt / isLocked / 偏好字段）；
//  2) 还原只碰本次写过的字段，不顺手覆盖并发写入的其他字段；
//  3) 组已不存在时不复活会话。
// 断言口径：storage 侧不变（seed 即 storage 真值），因此「redux 还原后 == seed」即两端一致。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbHciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};
const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

before(async () => {
  await register(LOADER_PATH);
});

const NOW = '2026-10-01T00:00:00.000Z';

function makeGroup(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `group-${id}`,
    tabs: [
      {
        id: `${id}-t1`,
        url: `https://example.com/${id}`,
        title: `tab ${id}`,
        favicon: '',
        createdAt: NOW,
        lastAccessed: NOW,
        pinned: false,
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    isFavorite: false,
    notes: '',
    version: 3,
    ...overrides,
  };
}

async function makeStore(seeds: ReturnType<typeof makeGroup>[] = []) {
  const { configureStore } = await import('@reduxjs/toolkit');
  const { default: tabReducer, setGroups } = await import('@/store/slices/tabSlice');
  const store = configureStore({ reducer: { tabs: tabReducer } });
  if (seeds.length > 0) store.dispatch(setGroups(seeds as never));
  return store;
}

const slice = () => import('@/store/slices/tabSlice');
const helpers = () => import('@/store/slices/tabSliceHelpers');

const groupOf = (store: { getState: () => { tabs: { groups: { id: string }[] } } }, id: string) =>
  store.getState().tabs.groups.find(g => g.id === id) as
    | { name: string; isLocked: boolean; isFavorite: boolean; notes?: string; version: number; updatedAt: string }
    | undefined;

// ── 重命名 ────────────────────────────────────────────────────────────────
describe('P1-5 重命名写失败：乐观新名字必须收回', () => {
  it('rejected 带快照 → name/version/updatedAt 全部还原到 storage 真值', async () => {
    const { updateGroupNameAndSync, updateGroupName } = await slice();
    const seed = makeGroup('g');
    const store = await makeStore([seed]);

    // 乐观更新照常发生（thunk 内部就是先 dispatch 它）
    store.dispatch(updateGroupName({ groupId: 'g', name: '新名字' }));
    assert.equal(groupOf(store, 'g')?.name, '新名字');

    // 模拟 thunk 在写入前抓的快照 + sendMutation 失败走 rejectWithValue
    const snapshot = { name: seed.name, isLocked: false, version: seed.version, updatedAt: seed.updatedAt };
    store.dispatch(
      updateGroupNameAndSync.rejected(
        null,
        'R1',
        { groupId: 'g', name: '新名字' },
        { groupId: 'g', snapshot }
      )
    );

    const g = groupOf(store, 'g');
    assert.equal(g?.name, seed.name, '名字必须回到 storage 真值');
    assert.equal(g?.version, seed.version, 'version 必须一起还原：残留高版本会让下次合并丢掉 storage 的旧名');
    assert.equal(g?.updatedAt, seed.updatedAt, 'updatedAt 必须一起还原');
  });

  it('回滚不误伤并发写入的 isLocked（快照里的 isLocked 是发起时的旧值）', async () => {
    const { updateGroupNameAndSync, updateGroupName } = await slice();
    // storage 此刻已锁定（用户在重命名在途时锁了组），Redux 也已锁定
    const seed = makeGroup('g', { isLocked: true });
    const store = await makeStore([seed]);
    store.dispatch(updateGroupName({ groupId: 'g', name: '新名字' }));

    // 快照是重命名发起时抓的：那时还没锁，isLocked=false
    store.dispatch(
      updateGroupNameAndSync.rejected(
        null,
        'R2',
        { groupId: 'g', name: '新名字' },
        { groupId: 'g', snapshot: { name: seed.name, isLocked: false, version: 3, updatedAt: NOW } }
      )
    );

    const g = groupOf(store, 'g');
    assert.equal(g?.name, seed.name, '名字照旧回滚');
    assert.equal(g?.isLocked, true, '重命名回滚不得把用户后来的锁定改回去');
  });

  it('组已被删除时不复活会话（snapshot 无处可落）', async () => {
    const { updateGroupNameAndSync } = await slice();
    const store = await makeStore([makeGroup('g')]);

    store.dispatch(
      updateGroupNameAndSync.rejected(
        null,
        'R3',
        { groupId: 'gone', name: 'x' },
        { groupId: 'gone', snapshot: { name: 'x', isLocked: false, version: 1, updatedAt: NOW } }
      )
    );
    assert.equal(store.getState().tabs.groups.length, 1, '回滚不得凭空造出会话');
  });
});

// ── 锁定 ──────────────────────────────────────────────────────────────────
describe('P1-5 锁定写失败：UI 不得停留在“已锁定”而 storage 未锁定', () => {
  it('rejected 带快照 → isLocked 还原为 storage 真值', async () => {
    const { toggleGroupLockAndSync, toggleGroupLock } = await slice();
    const seed = makeGroup('g', { isLocked: false });
    const store = await makeStore([seed]);

    store.dispatch(toggleGroupLock('g'));
    assert.equal(groupOf(store, 'g')?.isLocked, true, '乐观锁定先于写入生效');

    store.dispatch(
      toggleGroupLockAndSync.rejected(
        null,
        'L1',
        'g',
        { groupId: 'g', snapshot: { name: seed.name, isLocked: false, version: 3, updatedAt: NOW } }
      )
    );

    assert.equal(
      groupOf(store, 'g')?.isLocked,
      false,
      '锁定回滚必须生效：UI 说锁了、storage 说没锁，用户刚锁的会话会被自动清理当成普通组删掉'
    );
  });

  it('反向同理：解锁写失败要回到“已锁定”（否则保护被静默解除）', async () => {
    const { toggleGroupLockAndSync, toggleGroupLock } = await slice();
    const store = await makeStore([makeGroup('g', { isLocked: true })]);

    store.dispatch(toggleGroupLock('g'));
    assert.equal(groupOf(store, 'g')?.isLocked, false);

    store.dispatch(
      toggleGroupLockAndSync.rejected(
        null,
        'L2',
        'g',
        { groupId: 'g', snapshot: { name: 'group-g', isLocked: true, version: 3, updatedAt: NOW } }
      )
    );
    assert.equal(groupOf(store, 'g')?.isLocked, true);
  });
});

// ── 收藏 / 备注 ───────────────────────────────────────────────────────────
describe('P1-5 收藏/备注写失败：只还原本次写过的字段', () => {
  it('收藏写失败 → isFavorite 还原，notes 不被顺手清掉', async () => {
    const { persistGroupFields, updateGroupFields } = await slice();
    const store = await makeStore([makeGroup('g', { isFavorite: false, notes: '原本的备注' })]);

    store.dispatch(updateGroupFields({ groupId: 'g', fields: { isFavorite: true } }));
    assert.equal(groupOf(store, 'g')?.isFavorite, true);

    store.dispatch(
      persistGroupFields.rejected(
        null,
        'F1',
        { groupId: 'g', fields: { isFavorite: true } },
        { groupId: 'g', snapshot: { isFavorite: false } }
      )
    );

    const g = groupOf(store, 'g');
    assert.equal(g?.isFavorite, false, '收藏必须回到 storage 真值');
    assert.equal(g?.notes, '原本的备注', '回滚只碰 isFavorite，不得覆盖未参与本次写入的字段');
  });

  it('备注写失败 → notes 还原，isFavorite 不被顺手改掉', async () => {
    const { persistGroupFields, updateGroupFields } = await slice();
    const store = await makeStore([makeGroup('g', { isFavorite: true, notes: '旧备注' })]);

    store.dispatch(updateGroupFields({ groupId: 'g', fields: { notes: '新备注' } }));
    store.dispatch(
      persistGroupFields.rejected(
        null,
        'F2',
        { groupId: 'g', fields: { notes: '新备注' } },
        { groupId: 'g', snapshot: { notes: '旧备注' } }
      )
    );

    const g = groupOf(store, 'g');
    assert.equal(g?.notes, '旧备注');
    assert.equal(g?.isFavorite, true);
  });

  it('四条写路径的 rejected 都必须写 state.error（供 UI/诊断读）', async () => {
    const { persistGroupFields, toggleGroupLockAndSync, updateGroupNameAndSync } = await slice();
    const store = await makeStore([makeGroup('g')]);

    store.dispatch(
      updateGroupNameAndSync.rejected(null, 'E1', { groupId: 'g', name: 'x' }, undefined as never)
    );
    assert.ok(store.getState().tabs.error, '重命名失败必须留错误信号');
    assert.equal(store.getState().tabs.errorSource, 'action', '写路径失败必须标 action 来源');
    store.dispatch(
      toggleGroupLockAndSync.rejected(null, 'E2', 'g', undefined as never)
    );
    assert.ok(store.getState().tabs.error, '锁定失败必须留错误信号');
    assert.equal(store.getState().tabs.errorSource, 'action');
    store.dispatch(
      persistGroupFields.rejected(null, 'E3', { groupId: 'g', fields: { notes: 'x' } }, undefined as never)
    );
    assert.ok(store.getState().tabs.error, '本地偏好失败必须留错误信号');
    assert.equal(store.getState().tabs.errorSource, 'action');
  });
});

// 1.22.12：errorSource 来源标注。修的是线上日志的误导前缀 —— 一次 removeTab
// 30s 超时被 TabList 打成「加载会话列表失败」，排障方向整个带偏（error 是
// loadGroups 与列表内写操作共享的字段，此前无人标注来源）。
describe('state.errorSource：错误来源标注（1.22.12）', () => {
  it('loadGroups.rejected → load；removeTab 类写失败 → action；新一轮加载清空', async () => {
    const { loadGroups, deleteTabAndSync } = await slice();
    const store = await makeStore([makeGroup('g')]);

    // 读路径失败
    store.dispatch(loadGroups.pending('R1', undefined));
    store.dispatch(loadGroups.rejected(new Error('读失败'), 'R1', undefined));
    assert.equal(store.getState().tabs.error, '读失败');
    assert.equal(store.getState().tabs.errorSource, 'load', '加载失败必须标 load');

    // 写路径失败（线上日志场景：removeTab 30s 超时）
    store.dispatch(
      deleteTabAndSync.rejected(
        new Error('操作超时（超过 30 秒无响应）：removeTab'),
        'R2',
        { groupId: 'g', tabId: 'g-t1' }
      )
    );
    assert.equal(
      store.getState().tabs.errorSource,
      'action',
      'removeTab 超时绝不能被当成加载失败消费（那正是误导日志的来源）'
    );

    // 新一轮加载 pending：error 与来源一起清空，不留下一环标注错位
    store.dispatch(loadGroups.pending('R3', undefined));
    assert.equal(store.getState().tabs.error, null);
    assert.equal(store.getState().tabs.errorSource, null);
  });
});

// ── 快照纯函数 ────────────────────────────────────────────────────────────
describe('P1-5 快照纯函数：写前抓取、按键回滚', () => {
  it('snapshotGroupMeta 抓写入前的值，组不存在返回 null', async () => {
    const { snapshotGroupMeta } = await helpers();
    const groups = [makeGroup('g', { name: 'A', isLocked: true, version: 7 })];
    assert.deepEqual(snapshotGroupMeta(groups as never, 'g'), {
      name: 'A',
      isLocked: true,
      version: 7,
      updatedAt: NOW,
    });
    assert.equal(snapshotGroupMeta(groups as never, 'nope'), null);
  });

  it('snapshotGroupLocalFields 只取本次写入的键', async () => {
    const { snapshotGroupLocalFields } = await helpers();
    const groups = [makeGroup('g', { isFavorite: true, notes: 'N' })];
    assert.deepEqual(snapshotGroupLocalFields(groups as never, 'g', { isFavorite: false }), {
      isFavorite: true,
    });
    assert.deepEqual(snapshotGroupLocalFields(groups as never, 'g', { notes: 'x' }), { notes: 'N' });
  });

  it('restoreGroupName 还原 name+version+updatedAt 但不动 isLocked', async () => {
    const { restoreGroupName } = await helpers();
    const group = makeGroup('g', { name: '新', version: 4, isLocked: true });
    restoreGroupName(group as never, { name: '旧', isLocked: false, version: 3, updatedAt: NOW });
    assert.equal(group.name, '旧');
    assert.equal(group.version, 3);
    assert.equal(group.updatedAt, NOW);
    assert.equal(group.isLocked, true, '锁定归锁定那条管，重命名回滚不许改');
  });

  it('restoreGroupLock 只还原 isLocked（version 归下一次 loadGroups 读真值）', async () => {
    const { restoreGroupLock } = await helpers();
    const group = makeGroup('g', { isLocked: true, version: 4, name: '已改名' });
    restoreGroupLock(group as never, { name: 'n', isLocked: false, version: 3, updatedAt: NOW });
    assert.equal(group.isLocked, false);
    assert.equal(group.name, '已改名', '锁定回滚不得改名字');
    assert.equal(group.version, 4, '锁定回滚不改 version：那是共享元信息，覆盖会盖掉并发写入方的 bump');
  });
});

// ── 组件接线（源码静态断言：别让 catch 变成空函数）──────────────────────────
describe('P1-5 TabGroup 接线：四条写路径都必须有失败出口', () => {
  const TAB_GROUP_SOURCE = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../src/components/tabs/TabGroup.tsx'),
    'utf8'
  );

  it('重命名/锁定/收藏/备注都匹配了各自的 rejected action', () => {
    for (const thunk of [
      'updateGroupNameAndSync',
      'toggleGroupLockAndSync',
      'persistGroupFields',
    ]) {
      assert.match(
        TAB_GROUP_SOURCE,
        new RegExp(`${thunk}\\.rejected\\.match\\(action\\)`),
        `${thunk} 失败时必须被识别为 rejected`
      );
    }
  });

  it('失败必须提示用户（静默回滚 = 用户以为改成功了）', () => {
    const toasts = TAB_GROUP_SOURCE.match(/showToast\('[^']*失败[^']*', 'error'\)/g) ?? [];
    assert.equal(toasts.length, 4, `期望 4 条失败提示，实际 ${toasts.length}：${toasts.join(',')}`);
  });

  it('保存失败后保持编辑态（用户能直接重试，而不是丢掉刚输入的内容）', () => {
    assert.match(TAB_GROUP_SOURCE, /重命名失败[\s\S]{0,200}setIsEditing\(true\)/);
    assert.match(TAB_GROUP_SOURCE, /备注保存失败[\s\S]{0,300}setIsEditingNotes\(true\)/);
  });

  it('草稿只在非编辑态才被外部值覆盖（回滚不得抹掉用户正在输入的内容）', () => {
    assert.match(TAB_GROUP_SOURCE, /if \(!isEditing\) setNewName\(group\.name\)/);
    assert.match(TAB_GROUP_SOURCE, /if \(!isEditingNotes\) setNotesDraft\(group\.notes/);
  });
});
