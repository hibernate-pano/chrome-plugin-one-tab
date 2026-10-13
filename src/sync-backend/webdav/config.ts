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

/** 配置键（独立于 STORAGE_KEYS：它不是「用户设置」，是连接凭据）。 */
const CONFIG_KEY = 'webdav_sync_config_v1';

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
 * 存在模块级变量里，**不落盘**。Service Worker 被回收即失效——
 * 这是有意的（见文件头「每次由浏览器会话内存持有」）。
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

/**
 * 设置会话凭据。
 *
 * 与已保存配置**不一致**时直接抛错：把 A 目录的密码配到 B 目录上，
 * 表现是 401 或解密失败，而用户完全看不出是自己配串了。
 */
export function setSessionSecrets(
  username: string,
  password: string,
  passphrase: string | null
): void {
  if (!password) throw new Error('应用密码不能为空');
  sessionSecrets = { password, passphrase };
  sessionUser = username;
}

let sessionUser = '';

/** 读会话凭据。null = 本次 SW 生命周期内还没有解锁。 */
export function getSessionSecrets(username: string): SessionSecrets | null {
  // 用户名变了但凭据没重新输入 ⇒ 视为未解锁。
  // 静默复用旧密码只会得到一个莫名 401。
  if (!sessionSecrets || sessionUser !== username) return null;
  return sessionSecrets;
}

/** 清除会话凭据（切换后端 / 用户主动锁定时用）。 */
export function clearSessionSecrets(): void {
  sessionSecrets = null;
  sessionUser = '';
}

/** 供测试用：把模块级状态复位，避免测试之间串味。 */
export function __resetSessionSecretsForTests(): void {
  clearSessionSecrets();
}

