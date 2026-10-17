// Wave 2B 诚实度探针（2026-10-16）。
//
// 本次修复的六个缺陷里有三个的共同形状是「UI 断言了一个从未被检查的状态」：
//   · 菜单同步状态行：写死的绿点 + 「自带存储」，未配置/未解锁也显示「已连接」；
//   · 「上次同步」行：读 Redux tabs.lastSyncTime，而那个字段没有任何写方 ⇒
//     永远不渲染（不是「显示旧值」，是整行消失，连带用户唯一的同步反馈也没了）；
//   · 自动同步开关：未配置云盘也能打开，并弹出「每 N 分钟同步一次」。
//
// 本文件的判据分两层，缺一不可：
//   (a) **运行时**：用真实的 `primeSyncBackend()` 跑出三种真实解析结果
//      （未配置 / 已配置未解锁 / 已配置已解锁），断言分类函数给出三种**不同**
//       的 UI 状态。这直接证伪「无论后端怎样都返回同一个状态」的常量实现 ——
//       只做源码结构断言的话，一个恒返回 `'ready'` 的映射函数照样能全绿。
//   (b) **结构**：断言菜单/设置页真的把这条链接进了渲染（调
//       getLastBackendResolution 而不是自造状态；颜色来自状态档位而不是
//       字面量 bg-green-500；开启自动同步前检查 fresh.kind）。
//
// 本仓库没有 DOM 测试环境（tests/webdavSettingsUi.test.ts 头部有记录），
// 所以 (b) 用「读源码 + 结构断言」，与 a11yLists / noSilentFalseSuccess 同惯例。
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.VERBOSE) {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

import {
  primeSyncBackend,
  getLastBackendResolution,
  resetActiveSyncBackend,
  setBackendFactory,
} from '@/sync-backend';
import {
  clearSessionSecrets,
  saveWebDavConfig,
  setSessionSecrets,
} from '@/sync-backend/webdav/config';
import {
  canEnableAutoSync,
  classifyBackendResolution,
  formatLastSyncTime,
  type BackendResolution,
} from '@/components/layout/backendStatus';
import type { SyncBackendPort } from '@/sync-backend/ports';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');
/** 剥掉注释再断言：注释里出现旧文案不算「界面还这么写」。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// ── 内存 KV：让 storage-kv 这一层可控（与 webdavWiring.test.ts 同底座）────
// 为什么必须铺 localStorage：`resolveBackendOutcome()` 读的是真实 storage-kv
// 适配层（无 IndexedDB 的 node 环境回退 localStorage），往测试自己的 Map 里
// 塞值它与解析读到的是两个数据源 —— 那会把「测试没接上」伪装成「实现坏了」。
const store = new Map<string, unknown>();

{
  const ls = {
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => (store.has(k) ? String(store.get(k)) : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
  (globalThis as Record<string, unknown>).window = { localStorage: ls };
}

let storageReady: Promise<void> | null = null;
function ensureStorageReady(): Promise<void> {
  if (!storageReady) {
    storageReady = (async () => {
      const { initStorage } = await import('@/storage-kv/storageAdapter');
      await initStorage();
    })();
  }
  return storageReady;
}

const realKv = {
  async get<T>(k: string) {
    await ensureStorageReady();
    const { kvGet } = await import('@/storage-kv/storageAdapter');
    return kvGet<T>(k);
  },
  async set<T>(k: string, v: T) {
    await ensureStorageReady();
    const { kvSet } = await import('@/storage-kv/storageAdapter');
    return kvSet(k, v);
  },
  async remove(k: string) {
    await ensureStorageReady();
    const { kvRemove } = await import('@/storage-kv/storageAdapter');
    return kvRemove(k);
  },
};

async function resetStorage() {
  await ensureStorageReady();
  const { kvRemove } = await import('@/storage-kv/storageAdapter');
  for (const k of [...store.keys()]) {
    if (k.startsWith('webdav_') || k === 'user_settings') await kvRemove(k);
  }
}

const CONFIG = {
  baseUrl: 'https://dav.example.com/dav/',
  username: 'u',
  rootPath: 'TapStack',
  encryption: 'plain' as const,
};

const fakeBackend = (): SyncBackendPort =>
  ({
    id: 'webdav',
    label: 'fake',
    async fetchFingerprints() {
      return [];
    },
    async downloadGroups() {
      return [];
    },
    async uploadGroups() {
      return { writtenIds: [] };
    },
    async broadcastDeletes() {},
    async purgeExpiredDeletes() {
      return 0;
    },
    async uploadSettings() {},
    async downloadSettings() {
      return null;
    },
  }) satisfies SyncBackendPort;

describe('缺陷 1：同步状态由真实解析决定，三种状态互相可区分', () => {
  beforeEach(async () => {
    await clearSessionSecrets();
    resetActiveSyncBackend();
    setBackendFactory(null);
    await resetStorage();
    // ⚠️ 必须显式种下 syncBackend:'webdav'（2026-10-17 双模式适配）。
    // main 上账户体系仍在，readConfiguredBackendId 读不到设置会回落
    // 'supabase'，于是本用例在到「未配置」之前就解析成 supabase ——
    // resolvedId=supabase ⇒ 无 lockedReason ⇒ classify 出 ready，
    // 三条「未配置/未解锁」用例全变成假绿。这是 main 与 slim 的真实差异：
    // slim 上没有 supabase 回落路径，不需要种。
    const { DEFAULT_SETTINGS } = await import('@/utils/storage');
    const { kvSet } = await import('@/storage-kv/storageAdapter');
    await kvSet('user_settings', { ...DEFAULT_SETTINGS, syncBackend: 'webdav' });
  });

  it('未配置 → 真实解析返回锁定原因，分类为「未配置」且可去设置', async () => {
    await primeSyncBackend();
    const status = classifyBackendResolution(getLastBackendResolution());
    assert.equal(status.kind, 'unconfigured', '没配云盘必须显示未配置，而不是绿色');
    assert.equal(status.tone, 'muted');
    assert.equal(status.actionable, true, '未配置必须给出「去设置」入口');
    assert.equal(canEnableAutoSync(status), false, '未配置时自动同步不得放行');
  });

  it('已配置但本次会话未解锁 → 分类为「未解锁」（与未配置不同）', async () => {
    await saveWebDavConfig(CONFIG, realKv);
    await primeSyncBackend();
    const status = classifyBackendResolution(getLastBackendResolution());
    assert.equal(status.kind, 'locked', '配置在但没解锁必须显示未解锁');
    assert.notEqual(status.kind, 'unconfigured', '「已配置未解锁」与「没配置」必须是两种状态');
    assert.equal(status.tone, 'warn');
    assert.equal(status.actionable, true, '未解锁必须给出「去设置」入口');
    assert.equal(canEnableAutoSync(status), false, '未解锁时自动同步不得放行');
  });

  it('已配置且本次会话已解锁 → 分类为 ready（绿点），且无锁定原因', async () => {
    await saveWebDavConfig(CONFIG, realKv);
    await setSessionSecrets('u', 'app-password', null);
    setBackendFactory(() => fakeBackend());
    const out = await primeSyncBackend();
    assert.equal(out.lockedReason, undefined, '就绪态不得残留锁定原因');
    const status = classifyBackendResolution(getLastBackendResolution());
    assert.equal(status.kind, 'ready');
    assert.equal(status.tone, 'ok');
    assert.equal(status.actionable, false, '就绪态不应再出现「去设置」');
    assert.equal(canEnableAutoSync(status), true, '只有就绪态才允许开启自动同步');
  });

  it('读失败 / 没见过的原因 → error / unknown，绝不猜成「已解锁」', () => {
    const failed = classifyBackendResolution({
      backend: fakeBackend(),
      resolvedId: 'webdav',
      requestedId: 'webdav',
      lockedReason: '自带存储的配置读取失败，已中止本次同步以免数据传到未知的地址。请稍后重试。',
      at: new Date().toISOString(),
    } satisfies NonNullable<BackendResolution>);
    assert.equal(failed.kind, 'error');
    assert.equal(failed.tone, 'error', '存储故障是红色，不是「未解锁」的琥珀或就绪的绿');

    const opaque = classifyBackendResolution({
      backend: fakeBackend(),
      resolvedId: 'webdav',
      requestedId: 'webdav',
      lockedReason: '一种没人见过的新原因',
      at: new Date().toISOString(),
    } satisfies NonNullable<BackendResolution>);
    assert.equal(opaque.kind, 'error', '没见过的原因按「不可读」展示，不往外猜状态');

    assert.equal(classifyBackendResolution(null).kind, 'unknown');
  });

  // ── 2026-10-16 审查 L4：lockedKind 机器字段 ──────────────────────────
  it('真实解析携带 lockedKind：未配置/未解锁在产生点标注，分类不靠文案', async () => {
    await primeSyncBackend();
    const unconfigured = getLastBackendResolution();
    assert.equal(unconfigured?.lockedKind, 'unconfigured', '没配云盘必须在解析结果里标注机器分类');
    assert.equal(classifyBackendResolution(unconfigured).kind, 'unconfigured');

    await saveWebDavConfig(CONFIG, realKv);
    await primeSyncBackend();
    const locked = getLastBackendResolution();
    assert.equal(locked?.lockedKind, 'locked', '配了没解锁必须标注 locked，与未配置区分');
    assert.equal(classifyBackendResolution(locked).kind, 'locked');
  });

  it('lockedKind 优先于文案：机器字段说 error，文案含「解锁」也必须是 error', () => {
    // 证伪正则兜底的优先级：若分类还按文案走，这条含「解锁」的读失败原因
    // 会被误判成「未解锁」（琥珀 + 让用户去输口令），而真相是存储故障。
    const status = classifyBackendResolution({
      backend: fakeBackend(),
      resolvedId: 'webdav',
      requestedId: 'webdav',
      lockedReason: '解锁状态读取失败（存储不可读）',
      lockedKind: 'error',
      at: new Date().toISOString(),
    } satisfies NonNullable<BackendResolution>);
    assert.equal(status.kind, 'error', '机器字段必须压过文案正则');
    assert.equal(status.tone, 'error');
  });

  it('⚠️ 工厂抛错（预期外异常）⇒ 解析结果带锁定标记，不得变假绿灯', async () => {
    // 2026-10-16 L4 连带修复：修复前 primeSyncBackend 的 catch 返回的
    // outcome 没有 lockedReason/lockedKind，读者看到「无锁定原因」会判成
    // ready 绿点 —— 存储故障时 UI 宣称「已配置并解锁」。
    await saveWebDavConfig(CONFIG, realKv);
    await setSessionSecrets('u', 'app-password', null);
    setBackendFactory(() => {
      throw new Error('simulated factory crash');
    });
    try {
      const out = await primeSyncBackend();
      assert.ok(out.lockedReason, '工厂抛错必须留下锁定原因（否则读者判成就绪绿点）');
      assert.equal(out.lockedKind, 'error');
      const status = classifyBackendResolution(getLastBackendResolution());
      assert.equal(status.kind, 'error', '预期外异常必须显示「状态不可读」，不是绿色');
      assert.equal(canEnableAutoSync(status), false);
    } finally {
      setBackendFactory(null);
    }
  });

  const MENU = stripComments(read('src/components/layout/HeaderDropdown.tsx'));

  it('菜单接的是真实状态源：primeSyncBackend + getLastBackendResolution', () => {
    assert.match(MENU, /primeSyncBackend\(\)/, '必须真的解析后端，才能知道配没配、解没解锁');
    assert.match(MENU, /getLastBackendResolution\(\)/, '必须读解析结果，而不是自己编一个状态');
    assert.match(MENU, /classifyBackendResolution\(/);
  });

  it('写死的绿点已删除：颜色来自状态档位映射', () => {
    assert.ok(!MENU.includes('bg-green-500'), '菜单里不得再出现写死的绿点');
    assert.match(MENU, /BACKEND_STATUS_DOT_CLASS\[backendStatus\.tone\]/, '颜色必须跟状态走');
  });

  it('未就绪状态渲染「去设置」入口（复用 openOptionsPage 路径）', () => {
    assert.match(MENU, /backendStatus\.actionable/, '可行动状态必须驱动入口渲染');
    assert.match(MENU, /去设置/);
    assert.match(MENU, /handleOpenOptions/, '入口应复用已有 openOptionsPage handler');
  });
});

describe('缺陷 2：上次同步时间读真值，坏数据不渲染', () => {
  const MENU = stripComments(read('src/components/layout/HeaderDropdown.tsx'));

  it('菜单读 storage.getLastSyncTime()（真写方在 syncEngine 的成功路径）', () => {
    assert.match(MENU, /storage\.getLastSyncTime\(\)/, '必须从持久键读，而不是 Redux 里没人写的字段');
  });

  it('不再从 Redux tabs.lastSyncTime 取值（该字段零写方，行永远不渲染）', () => {
    assert.doesNotMatch(
      MENU,
      /state\.tabs\)\.lastSyncTime|state\.tabs\.lastSyncTime/,
      'Redux 的 lastSyncTime 没有任何 reducer/thunk 写入，读它等于这一行永远消失'
    );
  });

  it('措辞是「上次成功同步」——该键也由后台下载/上传写，不能标成「手动」', () => {
    assert.ok(!MENU.includes('最后手动同步'), '后台同步也会刷新该键，标「手动」是假话');
    assert.ok(MENU.includes('上次成功同步'), '使用与真实写入语义一致的措辞');
  });

  it('formatLastSyncTime：相对时间正确；坏时间戳返回 null（调用方不渲染整行）', () => {
    const now = new Date('2026-10-16T12:00:00.000Z');
    assert.equal(formatLastSyncTime('2026-10-16T11:59:30.000Z', now), '刚刚');
    assert.equal(formatLastSyncTime('2026-10-16T11:30:00.000Z', now), '30 分钟前');
    assert.equal(formatLastSyncTime('2026-10-16T09:00:00.000Z', now), '3 小时前');
    assert.equal(formatLastSyncTime('2026-10-14T12:00:00.000Z', now), '2 天前');
    assert.equal(formatLastSyncTime('不是时间', now), null, '坏数据必须返回 null，不能显示 Invalid Date');
    assert.equal(formatLastSyncTime('2026-10-16T12:05:00.000Z', now), '刚刚', '时钟回拨不显示负数');
  });

  it('真值源确实有写方：syncEngine 上传与下载成功路径都写 setLastSyncTime', () => {
    const engine = read('src/services/syncEngine.ts');
    const writes = engine.match(/storage\.setLastSyncTime\(/g) ?? [];
    assert.ok(
      writes.length >= 2,
      `上传与下载成功路径都要写，否则这一行没有真值来源（当前 ${writes.length} 处）`
    );
  });
});

describe('缺陷 3：自动同步在配置 + 解锁前不得被打开', () => {
  const OPTIONS = read('src/options/OptionsPage.tsx');
  const CODE = stripComments(OPTIONS);

  it('开启前先做真实解析；未就绪时直接拒绝，而不是先亮开关再报错', () => {
    assert.match(CODE, /refreshBackendStatus/, '必须复用真实解析函数');
    assert.match(CODE, /canEnableAutoSync\(fresh\)/, '放行判据必须来自后端状态，而不是 settings 副本');
    const start = CODE.indexOf('const handleToggleAutoSync');
    assert.ok(start > 0, '应能找到 handleToggleAutoSync');
    const end = CODE.indexOf('const handleSetSyncInterval', start);
    const body = CODE.slice(start, end === -1 ? CODE.length : end);
    const gate = body.indexOf('canEnableAutoSync(fresh)');
    const dispatch = body.indexOf('dispatch(setSyncEnabled(nextEnabled))');
    assert.ok(gate > 0, '未就绪必须有拒绝分支');
    assert.ok(dispatch > 0, '就绪后才有开启分支');
    assert.ok(gate < dispatch, '拒绝必须发生在 setSyncEnabled 之前 —— 先开后拒 = 开关闪一下又弹错');
  });

  it('未配置 / 未解锁的提示说明「开了也不会运行」，而不是承诺节奏', () => {
    assert.ok(
      CODE.includes('云盘尚未配置：自动同步即使打开也不会运行'),
      '未配置时必须说清开了也不会跑'
    );
    assert.ok(
      CODE.includes('重新输入应用密码与加密口令之前，自动同步不会运行'),
      '未解锁时必须说清恢复条件'
    );
  });

  it('开启成功的 toast 与就绪提示都写明「重启浏览器后要重新输密码」', () => {
    assert.match(
      CODE,
      /关闭浏览器后需重新输入应用密码才会继续/,
      '开启成功的 toast 必须带上重启后的后果（config.ts 明确要求 UI 说出来）'
    );
    assert.match(
      CODE,
      /关闭浏览器后需要重新输入应用密码/,
      '就绪态提示也必须说明重启后自动同步会停'
    );
  });

  it('设置页状态同样来自 getLastBackendResolution 的真实解析', () => {
    assert.match(CODE, /getLastBackendResolution\(\)/);
    assert.match(CODE, /classifyBackendResolution\(/);
  });
});

describe('缺陷 4：文案与注释不得指向已删除的后端切换控件', () => {
  it('不再说「切换同步方式不会替你验证」——切换控件已删除', () => {
    const code = stripComments(read('src/options/OptionsPage.tsx'));
    assert.ok(
      !code.includes('切换同步方式不会替你验证'),
      '后端切换控件已删除，这句话在讲一个不存在的东西'
    );
    assert.ok(
      code.includes('保存并启用不会替你验证地址可用性'),
      '应改为指向页面上真实存在的动作「保存并启用」'
    );
  });

  it('档位行注释与「始终渲染」的代码对齐', () => {
    const raw = read('src/options/OptionsPage.tsx');
    // 剥注释再查旧说法：新注释里引用旧说法作为反面例子，不剥会自己判自己违规。
    const code = stripComments(raw);
    assert.ok(
      !code.includes('只在自动同步开着时显示'),
      '注释不得再声称条件渲染：「同步间隔」radiogroup 是无条件渲染的'
    );
    assert.match(raw, /档位行：\*\*始终渲染\*\*/, '注释要写明真实行为与保留常显的理由');
  });
});

describe('缺陷 6：隐私 / 商店披露不得再描述已删除的产品事件', () => {
  it('privacy.html 明确写出「不记录产品事件或使用统计」', () => {
    const privacy = read('src/legal/privacy.html');
    assert.ok(!privacy.includes('产品事件仅保存在'), '旧的「仅保存在设备本地」仍在暗示采集');
    assert.match(privacy, /不记录任何产品事件或使用统计/, '应正面声明不记录');
  });

  it('CHROMEWEBSTORE.md 的 User activity 行不再声称记录', () => {
    const storeText = read('CHROMEWEBSTORE.md');
    assert.ok(!storeText.includes('产品事件仅存本地'), '被删除的采集不得还挂在审核披露表里');
    const row = storeText.split('\n').find(l => l.startsWith('| User activity |'));
    assert.ok(row, '披露表必须有 User activity 行');
    assert.ok(row?.includes('不记录'), '应正面声明「不记录」');
  });
});
