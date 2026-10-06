/**
 * S3 拆分 · client：Supabase 客户端初始化与会话持久化单源。
 * （原 src/utils/supabase.ts 顶部逐字搬运，仅 import 路径随目录调整；行为零变化。）
 */
import { createClient } from '@supabase/supabase-js';
import { hasExtensionStorage } from '@/storage-kv/env';
import { sharedStringStorage } from '@/storage-kv/stringStore';

// 安全的配置管理
function getSecureConfig() {
  // 从环境变量中获取 Supabase 配置
  const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
  const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

  // 验证环境变量格式
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return null;
  }

  // 验证URL格式
  try {
    const url = new URL(SUPABASE_URL);
    if (!url.hostname.includes('supabase.co')) {
      return null;
    }
  } catch (error) {
    return null;
  }

  // 验证匿名密钥格式（JWT格式）
  if (!SUPABASE_ANON_KEY.startsWith('eyJ')) {
    return null;
  }

  // 在生产环境中，不要在控制台输出完整的配置信息
  if (import.meta.env.DEV) {
    logInfo('Supabase 配置已加载:', {
      url: SUPABASE_URL,
      keyPrefix: SUPABASE_ANON_KEY.substring(0, 10) + '...'
    });
  }

  return {
    url: SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY
  };
}

// 延迟初始化 Supabase 客户端
let supabaseClient: ReturnType<typeof createClient> | null = null;

// S2 收敛：跨上下文 session 存储与环境探测已下沉为共享单源
// （@/storage-kv/env + @/storage-kv/stringStore，与 KV 迁移层同源），
// 实现逐字搬运，行为零变化。调用方 import 路径保持不变。
const supabaseSharedStorage = sharedStringStorage;

/**
 * 迁移旧版 localStorage 中 supabase-js 的 session token 到 chrome.storage.local。
 * 早期版本 supabase-js 默认使用 localStorage 存 session（popup 上下文可用，
 * service-worker 不可用）。升级后统一走 chrome.storage，未登录用户无感；
 * 已登录用户 token 会被搬过去，避免升级后要求重新登录。
 */
async function migrateLegacySupabaseSession(): Promise<void> {
  try {
    // 只在扩展环境做迁移：网页版的 session 本来就该待在 localStorage，
    // 没有 chrome.storage 可搬（否则会先删 localStorage 却无处写入）。
    if (!hasExtensionStorage()) return;
    if (typeof localStorage === 'undefined') return;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) {
        const value = localStorage.getItem(key);
        if (value) {
          await chrome.storage.local.set({ [key]: value });
          logInfo('[Supabase] 已迁移旧 session 到 chrome.storage.local');
        }
        localStorage.removeItem(key);
      }
    }
  } catch (err) {
    logWarn('[Supabase] 迁移旧 session 失败（可忽略）:', err);
  }
}

function initSupabaseClient() {
  if (supabaseClient) {
    return supabaseClient;
  }

  const config = getSecureConfig();
  if (!config) {
    // 配置缺失时，创建一个占位符客户端
    // 使用占位符 URL 和 key，避免后续调用时出错
    logWarn('Supabase 配置缺失。同步功能将不可用。如需使用同步功能，请在 .env 文件中设置 VITE_SUPABASE_URL 和 VITE_SUPABASE_ANON_KEY。');
    supabaseClient = createClient('https://placeholder.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsYWNlaG9sZGVyIiwicm9sZSI6ImFub24iLCJpYXQiOjE2NDUxOTIwMDAsImV4cCI6MTk2MDc2ODAwMH0.placeholder');
    return supabaseClient;
  }

  supabaseClient = createClient(config.url, config.anonKey, {
    auth: {
      // service-worker 无 localStorage，统一用 chrome.storage.local 持久化 session
      storage: supabaseSharedStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
    // 注意是 global.fetch 而不是顶层 fetch：supabase-js 的
    // SupabaseClientOptions 把自定义 fetch 放在 global 下（顶层那个
    // `fetch?: Fetch` 是 auth-js 的选项，PostgREST 读不到）。
    global: { fetch: fetchWithTimeout },
  });

  // 旧 session 迁移（幂等：只搬一次，搬完即删 localStorage 源）
  void migrateLegacySupabaseSession();

  return supabaseClient;
}

/**
 * 带请求级超时的 fetch（2026-10-06）。
 *
 * 【为什么必须有】此前 supabase client 的每一次 PostgREST 请求都是裸
 * `await fetch(...)`：没有 AbortSignal、没有上界。后果链条：
 *   弱网 / Supabase 抖动 → 一个请求挂住几分钟
 *   → syncEngine.upload / downloadAndMerge 整条管线挂住（它们都是串行 await）
 *   → mutationQueue 的 running 标志一直为 true，单写者队列被占死
 *   → 用户点任何操作都排在它后面，也就是「点了没反应」
 *   → 30 秒后 popup 报「操作超时」，但 SW 侧仍在等那个请求
 *
 * 也就是说：IndexedDB 看门狗治的是「本地存储挂起」，本函数治的是
 * 「网络请求挂起」——两条独立的死锁路径，此前只堵了前者。
 *
 * 【为什么超时值必须大于 popup 的 30s 协议上界】
 * popup 在 30s 就放弃等待并给用户「可能仍在继续」的提示。若请求上界更小，
 * 用户会先看到失败、随后又看到操作其实成功（或反过来）——比慢更让人困惑。
 * 取 45s：晚于 30s 协议上界（不误杀合法慢同步），远大于健康请求耗时
 * （实测数百会话整库上传在秒级）。
 *
 * 【超时后必须 abort，不能只是 reject Promise】
 * 只 reject 不 abort 的话，底层连接仍挂着，SW 仍被这次请求占住 ——
 * 那就等于没超时。abort 会真正断开发送/接收，让连接与 SW 上下文一起释放。
 *
 * 【不吞原始错误】AbortError 与普通网络错误一样向上抛，由各调用方原有的
 * fail-closed 分支处理（上传失败保留 pending_upload、下轮重试）。
 */
const REQUEST_TIMEOUT_MS = 45_000;

const fetchWithTimeout: typeof fetch = (input, init) => {
  // 调用方自带 signal 时不覆盖：两个 signal 无法合并，而我们的超时是兜底
  // 需求，不该压过业务侧的取消意图（例如 auth 的 token 刷新）。
  if (init?.signal) return fetch(input, init);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetch(input, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
  });
};

// 检查 Supabase 是否已配置
export function isSupabaseConfigured(): boolean {
  const config = getSecureConfig();
  return config !== null;
}

// 检查 Supabase 配置的辅助函数
export function checkSupabaseConfig() {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase 配置缺失。请确保在 .env 文件中设置了 VITE_SUPABASE_URL 和 VITE_SUPABASE_ANON_KEY。');
  }
}

// 导出 supabase 客户端，延迟初始化
export const supabase = initSupabaseClient();

export { getDeviceId } from '../deviceUtils';
import { logInfo, logWarn } from '../log';

// 设备 ID 统一来源：与操作印记 last_op_device 同源（deviceUtils），
// 避免同一台设备在云端留下两种身份（历史上这里曾另有一套 UUID 实现，
// 导致 tab_groups.device_id 与 last_op_device 长期不一致）。
// 已确认全仓没有任何逻辑比较 device_id 的值，改来源只影响元数据一致性。
