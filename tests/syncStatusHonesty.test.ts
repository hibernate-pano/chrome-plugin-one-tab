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

  // 2026-10-17 浏览器实测抓到的真缺陷（双模式特有，slim 上不存在）：
  // 状态卡原先只在 `isAuthenticated && user` 时渲染，而**自带存储用户没有
  // TapStack 账号**，isAuthenticated 恒为 false ⇒ 他们只看到「登录 / 注册」，
  // 永远看不到自己的同步状态（已配置 / 未解锁 / 去设置）—— 而登录对他们
  // 毫无意义。Playwright 实测确认过这个形态。
  it('自带存储用户即使未登录也必须看到同步状态卡（而不是「登录 / 注册」）', () => {
    // 卡片容器的渲染条件必须把 webdav 也算进去。
    assert.match(
      MENU,
      /settings\.syncBackend === 'webdav'\)\s*&&\s*\(/,
      '状态卡条件必须包含「选了自带存储」，否则没有账号的 WebDAV 用户看不到状态'
    );
    // 登录按钮必须反过来：未登录**且不是**自带存储时才提示。
    assert.match(
      MENU,
      /!isAuthenticated\s*&&\s*settings\.syncBackend !== 'webdav'/,
      '登录按钮不应出现在自带存储用户的菜单里 —— 他们不需要 TapStack 账号'
    );
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
