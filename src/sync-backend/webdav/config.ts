/**
 * WebDAV 连接配置的本地存储（2026-10-13，阶段 2）。
 *
 * ── 为什么单独一个模块，而不加进 UserSettings ────────────────────────────
 * `UserSettings` 会被**上传到云端**（settingsSyncService / uploadSettings）。
 * 把 WebDAV 的地址/账号/应用密码塞进去，等于把用户的云盘凭据上传到
 * 他自己的 WebDAV 目录里——虽是「自己的盘」，但那份文件一旦被同步客户端
 * 多端同步、或目录被别人共享，凭据就跟着走了。
 *
 * 更糟的情况：老用户的设置还在 Supabase 上。把 WebDAV 凭据放进
 * UserSettings ⇒ 切换后端的那一次同步会把凭据上传到**我的**数据库。
 *
 * 所以凭据走**独立的本地键**，永远不参与任何同步。
 *
 * ── 存什么、不存什么 ────────────────────────────────────────────────────
 * | 存 | 不存 |
 * |---|---|
 * | baseUrl、username、rootPath | 应用密码（每次会话从内存提示输入） |
 * | 加密口令（可选，见下） | 派生出的密钥（只在内存，用完即弃） |
 * | 「用户选择不加密」的显式意图 | |
 *
 * 关于加密口令：**每次同步都问用户输入**是最安全的，但体验灾难
 * （后台 alarm 触发时没人能输入）。折中方案（计划书 §5.2）：
 * 口令输入后派生出的密钥以「设备密钥」二次加密后存本地，
 * 而设备密钥本身需要用户口令才能解开——这在 WebDAV 后端上没有可信锚点，
 * 因此 **V1 选择：口令每次由浏览器会话内存持有，SW 重启后需重新解锁**。
 * 代价是「关掉浏览器再开，自动同步会提示需要口令」；收益是磁盘上
 * 永远没有能解开标签页内容的密钥。这个取舍必须在 UI 上说清。
 */
import { kvGet, kvSet, kvRemove } from '@/storage-kv/storageAdapter';
import type { AdapterKv } from './adapter';
import { logWarn } from '@/utils/log';

/** 配置键（独立于 STORAGE_KEYS：它不是「用户设置」，是连接凭据）。 */
const CONFIG_KEY = 'webdav_sync_config_v1';

/**
 * 会话凭据在浏览器会话存储里的键。
 *
 * `chrome.storage.session` 是内存态、绑定浏览器会话、重启浏览器即清空、
 * 且 popup / options / SW 三个执行上下文**共享同一份**。
 * 这正是会话口令需要的语义（磁盘上不留密钥，关浏览器后需重新解锁）。
 */
const SESSION_SECRETS_KEY = 'webdav_session_secrets_v1';

export interface WebDavConnectionConfig {
  /** 服务器根地址，例如 `https://dav.jianguoyun.com/dav/`。 */
  baseUrl: string;
  username: string;
  /** 库内的子目录（相对 baseUrl）。默认 `TapStack`。 */
  rootPath: string;
  /**
   * 「是否加密」的用户显式选择。
   *
   * - `'required'`（默认）：未提供口令 ⇒ 同步时报错要求输入
   * - `'plain'`：用户明确选择不加密（界面必须展示风险说明）
   *
   * 刻意**不存口令本身**，也不存「当前是否已解锁」——
   * 后者是内存态，持久化它会让人以为「重启后还能用」，实际密钥已经没了。
   */
  encryption: 'required' | 'plain';
}

/** 已保存的配置（不含凭据明文）。 */
export interface StoredWebDavConfig extends WebDavConnectionConfig {
  /** 最近一次「测试连接」的结果，用于设置页展示。不参与同步。 */
  lastCheck?: {
    at: string;
    ok: boolean;
    /** 服务端是否实现条件写（false = 并发保护较弱，需如实告知）。 */
    conditionalWrites: boolean;
    /** 已存在的云端会话数。 */
    groups: number;
    message?: string;
  };
}

const DEFAULT_ROOT = 'TapStack';

/** chrome.storage / IndexedDB 适配层 → AdapterKv（形状正好对得上）。 */
export const chromeKvAdapter: AdapterKv = {
  async get<T>(key: string) {
    return (await kvGet<unknown>(key)) as T | null;
  },
  async set<T>(key: string, value: T) {
    await kvSet(key, value);
  },
  async remove(key: string) {
    await kvRemove(key);
  },
};

/**
 * 读取已保存的配置。
 *
 * **返回 null 表示「还没配过」**，而不是返回一个默认配置：
 * 「没配过」与「配了但字段损坏」对用户是两个不同的下一步动作
 * （前者引导去配置，后者提示配置有问题）。
 */
export async function loadWebDavConfig(kv: AdapterKv = chromeKvAdapter): Promise<StoredWebDavConfig | null> {
  const raw = await kv.get<unknown>(CONFIG_KEY);
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.baseUrl !== 'string' || !o.baseUrl) return null;
  if (typeof o.username !== 'string') return null;
  return {
    baseUrl: o.baseUrl,
    username: o.username,
    rootPath: typeof o.rootPath === 'string' && o.rootPath ? o.rootPath : DEFAULT_ROOT,
    encryption: o.encryption === 'plain' ? 'plain' : 'required',
    ...(isLastCheck(o.lastCheck) ? { lastCheck: o.lastCheck } : {}),
  };
}

function isLastCheck(v: unknown): v is StoredWebDavConfig['lastCheck'] {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.at === 'string' && typeof o.ok === 'boolean' && typeof o.conditionalWrites === 'boolean';
}

/**
 * 保存配置。
 *
 * 应用密码与加密口令**不落盘**（见文件头），所以这个函数收不到它们。
 * 字段校验失败直接抛错（fail-closed）：存一份半残的配置比不存更糟——
 * 用户会以为配好了，下次同步才炸。
 */
export async function saveWebDavConfig(
  config: WebDavConnectionConfig,
  kv: AdapterKv = chromeKvAdapter
): Promise<void> {
  if (!config.baseUrl || typeof config.baseUrl !== 'string') {
    throw new Error('WebDAV 地址不能为空');
  }
  if (typeof config.username !== 'string') {
    throw new Error('用户名不能为空');
  }
  await kv.set(CONFIG_KEY, {
    baseUrl: config.baseUrl,
    username: config.username,
    rootPath: config.rootPath || DEFAULT_ROOT,
    encryption: config.encryption,
  } satisfies WebDavConnectionConfig);
}

/** 「保存并启用」与「测试连接」共用的表单输入（口令类字段只在内存里）。 */
export interface WebDavFormInput {
  baseUrl: string;
  username: string;
  password: string;
  encryption: 'required' | 'plain';
  passphrase: string;
}

export type WebDavFormValidation = { ok: true } | { ok: false; message: string };

/**
 * 「保存并启用」与「测试连接」共用的表单校验（2026-10-18 A 组）。
 *
 * 【为什么必须共用】这两条入口原先各有一套判断，而「测试连接」那套**不校验口令**：
 * 它把未校验的表单状态直接塞进 adapter，而 `checkConnection` 在远端还没有
 * manifest 时提前返回 `{groups: 0, encrypted: false}`（见 adapter.ts 的
 * `if (!loaded) return`），`unlock()` 根本没被调用 —— 缺失的口令无从检测。
 * 于是「只填应用密码 → 测试连接 → 绿灯『连接正常，云端已有 0 个会话』
 * → 保存并启用 → 成功」，真正的报错（adapter.ts 的「已选择启用加密，
 * 但本次没有提供口令」）要等到第一次上传才炸，而那时用户已经离开设置页。
 *
 * 【为什么口令是必填，而不是「有就校验」】口令只存在浏览器会话内存里
 * （见本文件 SessionSecrets 的论证），重开页面后必然为空。配置写着
 * `encryption: 'required'` 而本次没给口令时，同步**一定**跑不起来 ——
 * 唯一诚实的答案是当场说清，而不是先给绿灯再让用户去撞墙。
 *
 * @param cfg 已保存的配置（可为 null）。它只影响措辞，**不影响判定**：
 *   同一份表单在「配过」与「没配过」下的接受/拒绝结论必须一致，
 *   否则两条入口又会因 cfg 的读取时机不同而给出不同答案。
 */
export function validateWebDavForm(
  form: WebDavFormInput,
  cfg: StoredWebDavConfig | null = null
): WebDavFormValidation {
  if (!form.baseUrl || !form.username) {
    return { ok: false, message: '请填写地址与账号，未保存任何改动。' };
  }
  if (!form.password) {
    return { ok: false, message: '请填写应用密码，未保存任何改动。' };
  }
  if (form.encryption === 'required' && !form.passphrase.trim()) {
    return {
      ok: false,
      message:
        cfg?.encryption === 'required'
          ? '这个云端库按「加密」配置，但本次没有提供加密口令 —— 口令只保存在浏览器会话内存里，' +
            '重开页面后需要重新输入。未保存任何改动。'
          : '选择了加密但没有填写加密口令，未保存任何改动。',
    };
  }
  return { ok: true };
}

/**
 * 「已保存配置」与「表单里正在编辑的内容」是否指向**同一个**云端库
 * （2026-10-18 round 39 P0）。
 *
 * 【这个 bug 的形状】首次推送的探测与执行走的是**两套数据源**：
 *   · 探测（`probeRemote`）用表单里的 baseUrl/username/password 现造一个
 *     `WebDavBackendAdapter`，于是确认框里报的数字是 **B 库**的；
 *   · 执行（`sendSyncCommand('upload'/'download')）在 service worker 里走
 *     `getActiveSyncBackend()`，读的是**已保存配置**，也就是 **A 库**。
 * 于是「把表单改成 B 库 → 点检查并推送」会拿 B 库的数字换取用户点确认，
 * 再把数据写进 A 库。用户全程看到的是 B 库的界面，磁盘上动的是 A 库。
 *
 * 这不是文案瑕疵，是让用户在一个他并未同意的写入上点了「确定」——
 * 与 round 38 修的「谎报已关闭」同级，都属于「界面说的 ≠ 实际发生的」。
 *
 * 【为什么只在 push/pull 入口拦，而不是让执行侧改用表单】应用密码只活在会话
 * 内存，service worker 侧拿不到用户刚输入的密码；让 SW 改用表单等于把口令送进
 * 后台进程，代价远大于收益。正确方向是**要求用户先把表单落盘**：
 * 落盘后 SW 读到的就是同一个库，两套数据源自然对齐。
 *
 * 【比什么】只比**库的身份**，不比应用密码：口令每次会话都可能不同，
 * 它不同不代表指向不同的库。加密态（encryption）**要**比 —— 同一地址同一账号，
 * 明文与加密是两套布局，按明文探测加密库会拿到一个不实的计数。
 */
export function webdavFormMatchesSavedConfig(
  form: Pick<WebDavFormInput, 'baseUrl' | 'username' | 'encryption'>,
  saved: StoredWebDavConfig | null
): boolean {
  if (!saved) return false;
  return (
    form.baseUrl === saved.baseUrl &&
    form.username === saved.username &&
    form.encryption === saved.encryption
  );
}

/** 上次「测试连接」结果的可展示快照（与存储形状解耦，UI 直接渲染）。 */
export interface CheckResultSnapshot {
  ok: boolean;
  groups: number;
  conditionalWrites: boolean;
  message?: string;
  /** 那次测试发生的时间（ISO），供 UI 如实标注「上次测试」。 */
  at: string;
}

/**
 * 「上次测试连接」的有效期（2026-10-18 A6）。
 *
 * 【为什么要有期限】没有期限的话，半年前的一次绿灯会被当成「现在的连接状态」
 * 显示出来 —— 那是另一种假绿灯。一周内的结果还算是近期证据；更旧的只说明
 * 「上次测的时候是通的」，而面板没有路径表达这种弱语气，只能不显示。
 */
export const LAST_CHECK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 存储里的 lastCheck → 可展示的快照（2026-10-18 A6）。
 *
 * 【为什么需要它】`saveLastCheck` 与本函数成对存在：原先只写不读，`lastCheck`
 * 是死代码，于是一次成功的「测试连接」绿灯活不过重开页面 —— 与该面板自己
 * 的诚实度纪律矛盾（它承诺的每一句话都要等于真实行为，而「刚才测过是通的」
 * 是真实事实，却被丢掉了）。
 *
 * 返回 null 的情形（全部是 fail-honest：宁可不显示，也不说一句无根据的话）：
 *   · 没有记录；· 时间解析不出来；· 结果太旧（超过 TTL）；· 时钟异常（未来时间）；
 *   · groups 不是合法的非负数（`isLastCheck` 只校验了三个字段，没管 groups）。
 */
export function checkResultFromLastCheck(
  lastCheck: StoredWebDavConfig['lastCheck'] | null | undefined,
  now: number = Date.now()
): CheckResultSnapshot | null {
  if (!lastCheck) return null;
  const atMs = Date.parse(lastCheck.at);
  if (!Number.isFinite(atMs)) return null;
  // 用绝对值：时钟被拨到过去/未来都会让「多久以前」失真，两种都不可信。
  if (Math.abs(now - atMs) > LAST_CHECK_TTL_MS) return null;
  if (!Number.isFinite(lastCheck.groups) || lastCheck.groups < 0) return null;
  return {
    ok: lastCheck.ok,
    groups: Math.floor(lastCheck.groups),
    conditionalWrites: lastCheck.conditionalWrites,
    ...(typeof lastCheck.message === 'string' ? { message: lastCheck.message } : {}),
    at: lastCheck.at,
  };
}

/** 记录「测试连接」结果（供设置页展示；不含凭据）。 */
export async function saveLastCheck(
  lastCheck: NonNullable<StoredWebDavConfig['lastCheck']>,
  kv: AdapterKv = chromeKvAdapter
): Promise<void> {
  const current = await loadWebDavConfig(kv);
  if (!current) return; // 还没配置就没有「上次测试」可言
  await kv.set(CONFIG_KEY, { ...current, lastCheck } satisfies StoredWebDavConfig);
}

/** 清除配置（用户要切回 Supabase 后端时用）。 */
export async function clearWebDavConfig(kv: AdapterKv = chromeKvAdapter): Promise<void> {
  await kv.remove(CONFIG_KEY);
}

/**
 * 内存态的会话凭据。
 *
 * 存在模块级变量里，**不落盘**。模块内存是本执行上下文的快取：
 * popup 里解锁只 living 在 popup 的 JS 世界里，SW 根本看不到它。
 *
 * ── 为什么还要镜像一份到 `chrome.storage.session`（2026-10-14 修 P0 时加）──
 * MV3 里 popup / options / SW 是三个独立的 JS 上下文，各自的模块内存互不相通。
 * 只放模块内存 ⇒ 用户在设置页输完密码，后台 SW 的定时同步永远是「未解锁」。
 * `chrome.storage.session` 是内存态（不写磁盘，重启浏览器即清空），
 * 且三个上下文共享 —— 它才是「浏览器会话内存」的正确载体。
 * 模块变量保留为快取（同步读），session 存储是跨上下文的真相源（异步读）。
 *
 * 用对象而非两个独立变量：应用密码与加密口令必须**成对**才有意义，
 * 分开存会出现「拿了旧口令配新密码」这种静默错配，而错配的表现是
 * 「解密失败」，用户完全看不出是哪一步错了。
 */
interface SessionSecrets {
  password: string;
  passphrase: string | null;
}

let sessionSecrets: SessionSecrets | null = null;

let sessionUser = '';

interface SessionStore {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove: (key: string) => Promise<void>;
}

/** 浏览器会话存储（扩展环境才有；Node 测试环境返回 null 走纯内存）。 */
function sessionStore(): SessionStore | null {
  try {
    const c = (globalThis as { chrome?: { storage?: { session?: SessionStore } } }).chrome;
    return c?.storage?.session ?? null;
  } catch {
    return null;
  }
}

function isSessionSecretsRaw(v: unknown): v is { username: string; password: string; passphrase: string | null } {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.username === 'string' &&
    typeof o.password === 'string' &&
    (o.passphrase === null || typeof o.passphrase === 'string')
  );
}

/**
 * 设置会话凭据。
 *
 * 与已保存配置**不一致**时直接抛错：把 A 目录的密码配到 B 目录上，
 * 表现是 401 或解密失败，而用户完全看不出是自己配串了。
 *
 * 同时写模块内存与 `chrome.storage.session`：前者是本上下文的快取，
 * 后者让 SW / popup / options 三端共享。session 写失败只告警不抛错 ——
 * 本上下文的内存已生效，同步仍可工作；下次跨上下文读取时再报未解锁。
 */
export async function setSessionSecrets(
  username: string,
  password: string,
  passphrase: string | null
): Promise<void> {
  if (!password) throw new Error('应用密码不能为空');
  sessionSecrets = { password, passphrase };
  sessionUser = username;
  const store = sessionStore();
  if (!store) return;
  try {
    await store.set({ [SESSION_SECRETS_KEY]: { username, password, passphrase } });
  } catch (err) {
    logWarn('[webdav-config] 会话凭据未能共享到浏览器会话存储（本页仍可用，后台同步可能需重新解锁）:', err);
  }
}

/**
 * 读会话凭据。null = 本次浏览器会话内还没有解锁。
 *
 * 先读模块快取， miss 再读 `chrome.storage.session`（跨上下文）。
 * 命中后回填模块快取，因此同一上下文内第二次是同步命中。
 */
export async function getSessionSecrets(username: string): Promise<SessionSecrets | null> {
  // 用户名变了但凭据没重新输入 ⇒ 视为未解锁。
  // 静默复用旧密码只会得到一个莫名 401。
  if (sessionSecrets && sessionUser === username) return sessionSecrets;
  if (sessionSecrets && sessionUser !== username) return null;
  const store = sessionStore();
  if (!store) return null;
  try {
    const got = await store.get(SESSION_SECRETS_KEY);
    const raw = got?.[SESSION_SECRETS_KEY];
    if (!isSessionSecretsRaw(raw) || raw.username !== username || !raw.password) return null;
    sessionSecrets = { password: raw.password, passphrase: raw.passphrase };
    sessionUser = raw.username;
    return sessionSecrets;
  } catch {
    return null;
  }
}

/**
 * 清除会话凭据（切换后端 / 用户主动锁定时用）。
 *
 * 注意：它只清凭据本身，不清 `activeBackend` 缓存 —— 调用方必须随后调
 * `invalidateActiveSyncBackend()`（见 `@/sync-backend`），否则旧适配器实例
 * 里缓存的 Vault（已派生的密钥）还会继续生效，「锁定」等于没锁。
 */
export async function clearSessionSecrets(): Promise<void> {
  sessionSecrets = null;
  sessionUser = '';
  const store = sessionStore();
  if (!store) return;
  try {
    await store.remove(SESSION_SECRETS_KEY);
  } catch (err) {
    logWarn('[webdav-config] 清除会话凭据时未能同步清除浏览器会话存储:', err);
  }
}

/** 供测试用：把模块级状态复位，避免测试之间串味。 */
export async function __resetSessionSecretsForTests(): Promise<void> {
  await clearSessionSecrets();
}

/**
 * 「WebDAV 配置 / 解锁状态变了」事件名（2026-10-18 P2#4）。
 *
 * 背景：设置页的自动同步提示（`autoSyncHint`）与推送区块的可用性都读
 * `getLastBackendResolution()`，而那个结果是**进程内缓存**。子组件
 * （WebDavSettings）保存 / 锁定 / 清除配置后，父页面的提示不会自动更新 ——
 * 用户点完「锁定」仍看到「已配置并解锁」。
 *
 * 为什么是 window 事件而不是回调 props：两个组件都要因它刷新
 * （父组件刷 hint，子组件刷自己的 resolvedBackend），而它们是父子关系；
 * 用事件让双方各自订阅，避免把刷新逻辑在父子间来回传。
 */
export const WEBDAV_CONFIG_CHANGED_EVENT = 'tapstack:webdav-config-changed';

/**
 * 广播「配置或解锁状态已变」。
 *
 * 为什么包一层而不是让调用方直接 dispatchEvent：调用点散布在三个 handler 里，
 * 各自 `new CustomEvent(...)` 会在改事件名时漏改一处 —— 而漏改的表现是
 * 「某一处操作后 UI 不刷新」，极难自查。
 */
export function notifyWebDavConfigChanged(): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new Event(WEBDAV_CONFIG_CHANGED_EVENT));
}

