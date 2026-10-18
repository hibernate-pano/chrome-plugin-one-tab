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
  autoSyncBlockedCopy,
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
    assert.equal(canEnableAutoSync(status, true), false, '未配置时自动同步不得放行（登录与否都无关）');
  });

  it('已配置但本次会话未解锁 → 分类为「未解锁」（与未配置不同）', async () => {
    await saveWebDavConfig(CONFIG, realKv);
    await primeSyncBackend();
    const status = classifyBackendResolution(getLastBackendResolution());
    assert.equal(status.kind, 'locked', '配置在但没解锁必须显示未解锁');
    assert.notEqual(status.kind, 'unconfigured', '「已配置未解锁」与「没配置」必须是两种状态');
    assert.equal(status.tone, 'warn');
    assert.equal(status.actionable, true, '未解锁必须给出「去设置」入口');
    assert.equal(canEnableAutoSync(status, true), false, '未解锁时自动同步不得放行（登录与否都无关）');
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
    assert.equal(canEnableAutoSync(status, true), true, 'WebDAV 就绪态不要求登录（账号由用户自带）');
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
      assert.equal(canEnableAutoSync(status, true), false);
    } finally {
      setBackendFactory(null);
    }
  });

  const MENU = stripComments(read('src/components/layout/HeaderDropdown.tsx'));

  it('菜单接的是真实状态源：refreshBackendResolutionOnly + getLastBackendResolution', () => {
    // 2026-10-18 P2-6：从 `primeSyncBackend()` 改为 `refreshBackendResolutionOnly()`。
    // 两者都会重算解析结果，区别是后者**不重建适配器** —— 打开菜单只是「看状态」，
    // 不该因此丢弃已派生的 Vault 并让下一次同步重跑 250k 轮 PBKDF2。
    //
    // 断言必须同时接受「读真实解析」这件事不变：换成读缓存/自造状态视为违规。
    assert.match(
      MENU,
      /refreshBackendResolutionOnly\(\)/,
      '必须真的解析后端，才能知道配没配、解没解锁（且不得为此重建适配器）'
    );
    assert.match(MENU, /getLastBackendResolution\(\)/, '必须读解析结果，而不是自己编一个状态');
    assert.match(MENU, /classifyBackendResolution\(/);
    // 反向：菜单这条路径上不得再出现无效化 + 全量重建（那会丢掉 Vault）。
    assert.ok(
      !/invalidateActiveSyncBackend\(\)/.test(MENU),
      '读状态不得 invalidate 重建：那会让下一次同步重跑密钥派生'
    );
  });

  it('写死的绿点已删除：颜色来自状态档位映射', () => {
    assert.ok(!MENU.includes('bg-green-500'), '菜单里不得再出现写死的绿点');
    // 2026-10-18 C 组：色档仍然来自状态，但取值改由 resolveMenuSyncStatus
    // 统一决定（云端未登录恒为 warn，不得转述后端的 ready）。
    assert.match(
      MENU,
      /BACKEND_STATUS_DOT_CLASS\[syncStatusView\.tone\]/,
      '颜色必须跟状态走'
    );
  });

  it('未就绪状态渲染「去设置」入口（复用 openOptionsPage 路径）', () => {
    assert.match(MENU, /syncStatusView\.actionable/, '可行动状态必须驱动入口渲染');
    assert.match(MENU, /去设置/);
    assert.match(MENU, /handleOpenOptions/, '入口应复用已有 openOptionsPage handler');
  });

  // 2026-10-17 浏览器实测抓到的真缺陷（双模式特有，slim 上不存在）：
  // 状态卡原先只在 `isAuthenticated && user` 时渲染，而**自带存储用户没有
  // TapStack 账号**，isAuthenticated 恒为 false ⇒ 他们只看到「登录 / 注册」，
  // 永远看不到自己的同步状态（已配置 / 未解锁 / 去设置）—— 而登录对他们
  // 毫无意义。Playwright 实测确认过这个形态。
  it('自带存储用户即使未登录也必须看到同步状态卡（而不是「登录 / 注册」）', () => {
    // 2026-10-18 C 组：条件不再写在 JSX 里，而是**无条件渲染** + 由
    // resolveMenuSyncStatus 按后端（和登录态）算出整行状态。断言分两层：
    // （a）行为：webdav / supabase 两种后端、登录与否的四种组合都有头衔与前缀，
    //      manifest 永不说「未登录」以外的话；
    // （b）结构：卡片无条件渲染（旧条件已删）。
    assert.ok(
      !/isAuthenticated && user\) \|\| settings\.syncBackend === 'webdav'/.test(MENU),
      '不得再按「已登录 或 自带存储」隐藏状态卡（云端未登录同样需要看到同步）'
    );
    assert.match(MENU, /resolveMenuSyncStatus\(/, '状态行必须走统一函数，不在 JSX 里各写一份');
    // 登录按钮必须保留：未登录**且不是**自带存储时才提示。
    assert.match(
      MENU,
      /!isAuthenticated\s*&&\s*settings\.syncBackend !== 'webdav'/,
      '登录按钮不应出现在自带存储用户的菜单里 —— 他们不需要 TapStack 账号'
    );
  });

  // 行为断言：四种组合的头衔/前缀/可行动入口。只做源码结构断言的话，
  // 一个恒返回同一个视图的 resolveMenuSyncStatus 也能全绿。
  it('菜单状态卡：四种后端×登录态组合各自成立，云端未登录不说任何「就绪」', async () => {
    const { resolveMenuSyncStatus } = await import('@/components/sync/syncPreviewView');
    const ready = { label: '已配置并解锁', tone: 'ok' as const, actionable: false };
    const locked = { label: '未解锁', tone: 'warn' as const, actionable: true };

    const webdavAnon = resolveMenuSyncStatus({
      syncBackend: 'webdav',
      isAuthenticated: false,
      userEmail: null,
      backend: locked,
    });
    assert.equal(webdavAnon.headline, '自带存储');
    assert.equal(webdavAnon.needsLogin, false, '自带存储用户不需要 TapStack 账号');
    assert.ok(!webdavAnon.label.includes('登录'), '不带账号的后端不该提示登录');

    const cloudAuthed = resolveMenuSyncStatus({
      syncBackend: 'supabase',
      isAuthenticated: true,
      userEmail: 'a@b.c',
      backend: ready,
    });
    assert.equal(cloudAuthed.headline, 'a@b.c');
    assert.equal(cloudAuthed.label, '已配置并解锁');
    assert.equal(cloudAuthed.prefix, 'TapStack 云端');
    assert.equal(cloudAuthed.needsLogin, false);

    const cloudAnon = resolveMenuSyncStatus({
      syncBackend: 'supabase',
      isAuthenticated: false,
      userEmail: null,
      backend: ready,
    });
    assert.equal(cloudAnon.headline, '未登录');
    assert.equal(cloudAnon.label, '未登录', 'Supabase 分支永远没 lockedReason，ready 不代表能同步');
    assert.equal(cloudAnon.needsLogin, true, '未登录时唯一可行动的事就是去登录');
    assert.ok(!cloudAnon.label.includes('已配置'), '不得把 ready 转述给未登录用户');
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
    assert.match(CODE, /canEnableAutoSync\(fresh, isAuthenticated\)/, '放行判据必须来自后端状态 + 登录态，而不是 settings 副本');
    const start = CODE.indexOf('const handleToggleAutoSync');
    assert.ok(start > 0, '应能找到 handleToggleAutoSync');
    const end = CODE.indexOf('const handleSetSyncInterval', start);
    const body = CODE.slice(start, end === -1 ? CODE.length : end);
    const gate = body.indexOf('canEnableAutoSync(fresh, isAuthenticated)');
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
    // ── 2026-10-18 P2-8 收口：WebDAV 专属文案不得与云端共用同一条 return ──
    // 原先 hint 是一条共享的 return 链，云端用户也会走过讲「应用密码」那段：
    // 改一句云端文案就会误报红，反之改坏了 WebDAV 文案也可能被云端的某句话
    // 顶着看不出来。
    //
    // 现在判据是：云端分支必须**先 early return**，WebDAV 的那两句必须排在它
    // **之后**。顺序即语义 —— 只要云端先返回，两者就不会互相污染。
    //
    // ⚠️ 锚点要选**后端专属**文案（「关闭浏览器后需要重新输入应用密码」），
    // 不能选 locked 分支那句：那是 WebDAV 未解锁态，排在云端判断之前是对的
    //（云端没有 locked 态，走不到那里）。
    const cloudGuard = CODE.indexOf("backendStatus.backendId === 'supabase'");
    const webdavOnlyCopy = CODE.indexOf('关闭浏览器后需要重新输入应用密码');
    assert.ok(cloudGuard > 0, 'hint 必须有云端分支');
    assert.ok(webdavOnlyCopy > 0, 'hint 必须保留 WebDAV 的重启说明');
    assert.ok(
      cloudGuard < webdavOnlyCopy,
      '云端分支必须排在前并 early return：否则 WebDAV 专属文案会被云端用户看到'
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

  // 2026-10-17 浏览器实测抓到的真缺陷（单测原本覆盖不到）：
  // 切换同步方式后 hint 不刷新，仍在承诺「会自动同步」。
  //
  // 症状（Playwright 实测）：默认 TapStack 云端时 hint 是「打开后…会按间隔
  // 同步」；点「自带存储（WebDAV）」切到未配置状态后 hint **不变**，仍在承诺
  // 会自动同步 —— 而点开关其实会被拒绝（闸门本身是好的）。承诺与行为不一致，
  // 正是本组要消灭的那类「假绿灯」。
  //
  // 根因：handleSelectBackend 只做了 invalidateActiveSyncBackend +
  // primeSyncBackend（那是为缓存与 SW 一致性），没有 setBackendStatus，
  // 于是本页显示的状态仍是改动前的值。
  it('切后端后必须刷新本页状态（否则 hint 会继续承诺自动同步）', () => {
    const start = CODE.indexOf('const handleSelectBackend');
    assert.ok(start > 0, '应能找到 handleSelectBackend');
    const end = CODE.indexOf('return (', start);
    const body = CODE.slice(start, end === -1 ? CODE.length : end);
    assert.match(
      body,
      /refreshBackendStatus\(\)/,
      '切换后端后必须调 refreshBackendStatus —— 只 invalidate + prime 不会更新本页显示的状态'
    );
    // 反证：primeSyncBackend 单独存在不够（那正是修复前的形态）。
    assert.match(body, /primeSyncBackend\(\)/, '前提：此处确实在重解析后端（修复前只有这一步）');
  });

});

describe('缺陷 4：文案与注释不得指向已删除的后端切换控件', () => {
  // ⚠️ 2026-10-17 双模式适配说明（与 slim 的分歧，刻意保留）：
  //
  // slim 分支删除了后端切换器（云端下线），所以它断言两件事：
  //   · 「切换同步方式不会替你验证」必须消失（那句话在讲一个不存在的控件）；
  //   · 改为「保存并启用不会替你验证地址可用性」。
  //
  // 本项目**保留** TapStack 云端后端，切换器仍然存在（handleSelectBackend
  // + 双 radiogroup），所以旧句子描述的是真实存在的动作、且是有用的警告 ——
  // 按 slim 的断言删掉它，会让切换控件失去那句提醒。
  //
  // 因此本组改为断言双模式的真相：**两句都应在**（两个动作都存在，各自
  // 都该有警告）。这不是给测试放水 —— 它比 slim 的版本多钉一条。
  it('两个真实存在的动作都要有「不会替你验证」的警告（双模式：切换器仍在）', () => {
    const code = stripComments(read('src/options/OptionsPage.tsx'));
    assert.ok(
      code.includes('切换同步方式不会替你验证'),
      '双模式下切换器仍存在（handleSelectBackend + 双 radiogroup），' +
        '这句话讲的是真实动作，删掉会让切换控件失去警告'
    );
    // 双模式下用户的实际动作是「保存并启用」（而不是先切后端再配）——
    // 警告必须点名这个动作，否则用户不知道该做什么。
    // 不要求 slim 的那个精确措辞：文案有多个等价写法，钉死字面量会把
    // 「改一句更好读的话」变成测试红灯。
    assert.ok(
      code.includes('保存并启用'),
      '警告必须点名用户的实际动作「保存并启用」，不能只说「不会替你验证」'
    );
    assert.ok(
      code.includes('测试连接'),
      '警告应指出「先测试连接」这条可执行的路径'
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

describe('缺陷 6：隐私 / 商店披露必须与真实的埋点行为一致', () => {
  // ⚠️ 2026-10-17 双模式适配说明（与 slim 的分歧，刻意保留）：
  //
  // slim 分支把 productEvents / 诊断 / 反馈能力整体删除了，所以它的断言是
  // 「必须声明**不记录**任何产品事件或使用统计」。
  //
  // 本项目保留了这些能力（src/utils/productEvents.ts 仍在，
  // TabManager.ts:167/305 仍在 trackProductEvent('session_saved')），
  // 所以正确的不变式**不是**「声明不记录」，而是
  // **「披露与行为一致」**：
  //   · 真的在采集 ⇒ 就必须如实说采集了什么、存在哪里、上不上传；
  //   · 谎称「不记录」才是真正的合规问题。
  //
  // 本组改为钉住「如实披露」：既不羞辱埋点（那是产品决策），也不允许
  // 披露与代码脱节。这比 slim 版本更贴合本项目的实际。
  it('privacy.html 如实披露产品事件的范围：仅本地、不上传', () => {
    const privacy = read('src/legal/privacy.html');
    assert.match(
      privacy,
      /产品事件仅保存在您的设备本地，不会上传/,
      '本项目仍采集产品事件（productEvents），必须如实说明「仅本地、不上传」'
    );
    assert.ok(
      !privacy.includes('不记录任何产品事件或使用统计'),
      '代码仍在采集却声明「不记录」= 披露与行为脱节，那才是真的合规问题'
    );
  });

  it('CHROMEWEBSTORE.md 的 User activity 行与埋点行为一致（本地记录、不上传）', () => {
    const storeText = read('CHROMEWEBSTORE.md');
    const row = storeText.split('\n').find(l => l.startsWith('| User activity |'));
    assert.ok(row, '披露表必须有 User activity 行');
    assert.ok(
      row?.includes('仅本地') && row?.includes('不上传'),
      'User activity 行必须说清「仅本地记录、不上传」，与实际埋点行为一致'
    );
    assert.ok(
      !row?.includes('不记录'),
      '本项目确实在本地记录产品事件，声称「不记录」与行为脱节'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 缺陷 7（2026-10-18 P1#1）：云端未登录不得开自动同步
//
// 【为什么单独一组】B8 把「自动同步开关不得在未就绪时开启」做完了，但判据
// 只有 `status.kind === 'ready'`。而 **Supabase 分支永远没有 lockedReason**
// （它不检查登录态），所以云端用户哪怕从未登录，解析结果也是 ready ⇒ 放行
// ⇒ toast 承诺「每 N 分钟同步一次」，而后台每轮都在 not_logged_in 处返回。
//
// 这是 B8 自己新造的假绿灯：诚实化了 WebDAV，却给云端开了个口子。
//
// 【本组的判别力】只断言 kind 会漏掉这个缺陷（云端 ready 就是 ready）。
// 必须断言 **canEnableAutoSync 的返回值随登录态变化** —— 删掉登录态判据
// 时下面两条会红；把登录态判据写成恒真也一样会红。
// ─────────────────────────────────────────────────────────────────────────
describe('缺陷 7：云端未登录是「未就绪」，不是绿灯', () => {
  /** 构造一个云端解析结果：Supabase 分支的真实形状（无 lockedReason）。 */
  const cloudResolved = (): NonNullable<BackendResolution> => ({
    backend: fakeBackend(),
    resolvedId: 'supabase',
    requestedId: 'supabase',
    at: new Date().toISOString(),
  });

  it('云端 + 未登录 ⇒ 不得放行（哪怕 kind 是 ready）', () => {
    const status = classifyBackendResolution(cloudResolved());
    // 前置：确认这确实是「ready」—— 否则本用例会因为别的原因通过（假绿）。
    assert.equal(status.kind, 'ready', '前提：云端解析没有锁定原因，kind 就是 ready');
    assert.equal(status.backendId, 'supabase', '分类必须带上后端 id，否则门禁无从分流');
    assert.equal(
      canEnableAutoSync(status, false),
      false,
      '云端未登录时自动同步不得放行：后台每轮都会 not_logged_in，承诺必然落空'
    );
  });

  it('云端 + 已登录 ⇒ 放行', () => {
    const status = classifyBackendResolution(cloudResolved());
    assert.equal(
      canEnableAutoSync(status, true),
      true,
      '已登录的云端用户必须能开自动同步（不能把门禁做成「云端一律不开」）'
    );
  });

  it('两种后端的就绪条件必须不同（这是本次缺陷的形状）', () => {
    const cloud = classifyBackendResolution(cloudResolved());
    const webdav = classifyBackendResolution({
      backend: fakeBackend(),
      resolvedId: 'webdav',
      requestedId: 'webdav',
      at: new Date().toISOString(),
    });
    assert.equal(webdav.kind, 'ready', '前提：WebDAV 已配置已解锁也是 ready');
    assert.equal(
      canEnableAutoSync(cloud, false),
      false,
      '云端未登录：拒绝'
    );
    assert.equal(
      canEnableAutoSync(webdav, false),
      true,
      'WebDAV 未登录（本来就没有账号）：放行 —— 这正是「按后端分流」的意义'
    );
  });

  it('拒绝文案必须按后端分说：云端缺的是「登录」，不是「应用密码」', () => {
    const cloud = classifyBackendResolution(cloudResolved());
    const cloudMsg = autoSyncBlockedCopy(cloud, false);
    assert.match(cloudMsg, /登录/, '云端未登录的文案必须说「登录」');
    assert.doesNotMatch(
      cloudMsg,
      /应用密码|加密口令/,
      '云端没有「应用密码」这个概念 —— 让用户去输 WebDAV 口令是把他引向错误的动作'
    );

    const webdavLocked = classifyBackendResolution({
      backend: fakeBackend(),
      resolvedId: 'webdav',
      requestedId: 'webdav',
      lockedReason: '你选择了「自带存储」，但本次还没有解锁云服务。',
      lockedKind: 'locked',
      at: new Date().toISOString(),
    });
    const webdavMsg = autoSyncBlockedCopy(webdavLocked, false);
    assert.match(webdavMsg, /解锁|应用密码|口令/, 'WebDAV 未解锁要说「解锁」');
    assert.doesNotMatch(webdavMsg, /登录/, 'WebDAV 用户不需要登录');
  });

  it('hint 不得对未登录的云端用户承诺同步节奏（结构）', () => {
    const code = stripComments(read('src/options/OptionsPage.tsx'));
    assert.match(
      code,
      /backendStatus\.backendId === 'supabase'/,
      'hint 必须先按后端分流，否则云端分支会落到讲「应用密码」的那段'
    );
    assert.match(code, /尚未登录 TapStack 云端/, '未登录时 hint 必须说明自动同步不会运行');
  });
});
