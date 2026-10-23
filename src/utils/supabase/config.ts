/**
 * Supabase 运行时配置（URL + anon key）—— **不 import 任何 SDK**。
 *
 * ── 为什么单独成文件 ──────────────────────────────────────────────────────
 * 「云端现在在不在服务」这件事，必须能在**不加载 SDK** 的前提下问出口
 * （见 `cloudAvailability.ts`）。能问的前提就是不加载 SDK，而配置是问它
 * 唯一的输入。
 *
 * 若把配置读取留在 `client.ts` 里，问「云端在吗」就得先把整条 SDK 拖进来
 * ⇒ 弹窗每开一次付 ≈75KB ⇒ 荒谬。
 *
 * ⇒ 配置读取单独成文件：**弹窗侧与 SW 侧都能用**，且不牵动 SDK。
 */
import { logInfo } from '../log';

/** 运行时配置（只有问「云端在吗」与「拿 anon key 发请求」需要这两样）。 */
export interface SupabaseRuntimeConfig {
  url: string;
  anonKey: string;
}

/**
 * 缓存的配置（`null` = 「还没配」也算一个**结论**，也缓存）。
 *
 * ⚠️ 为什么缓存是安全的：配置是**构建期常量** —— Vite 在打包时把
 * `import.meta.env.VITE_*` **内联进产物** ⇒ 运行时它**不会变**。
 * ⇒ 「每次探活都重跑一遍解析」是**纯浪费**（一轮同步要问 6-8 次）。
 *
 * ⚠️ 为什么「还没配」也缓存：它同样是**构建期**的结论（env 没给就是没给），
 * 缓存它才不会每问一次就重跑一遍。
 */
let cachedConfig: SupabaseRuntimeConfig | null = null;

/** 缓存是否已经算过一次（`null` 是合法结论 ⇒ 用单独一个标记区分「没算过」）。 */
let configResolved = false;

/**
 * 读运行时配置；**读不到就返回 null**（不是「配错了」，是「还没配」）。
 *
 * ⚠️ 判据用**机器可判**的条件（URL 是不是 supabase.co、key 是不是 JWT 形状），
 * 不用文案匹配 —— 与本仓「界面文案不许成为判据」同源。
 *
 * ⚠️ **整段都在 try 里**（2026-10-23，第 51 轮）：`import.meta.env` 的读取
 * **本身**可能抛（env 被换掉、env 对象的 getter 炸了、非 Vite 环境里
 * `import.meta.env` 是 undefined ⇒ 读它的属性就是 TypeError）。
 * ⇒ 而这一层是「**问云端在吗**」的**输入**：它抛 ⇒ 探活抛 ⇒
 * 「云端不可用」这件事还没问出口就先崩了 ⇒ 「**不知道**」被读成「**崩了**」。
 * ⇒ 读不到就返回 null（= 还没配 / 不知道），由探活按「不知道」处理。
 */
const readSupabaseConfig = (): SupabaseRuntimeConfig | null => {
  try {
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
    //
    // ⚠️ 这行日志**只会打一次**（2026-10-23，第 51 轮）：它在**成功读到配置**
    // 之后，而成功的那次结果被**缓存**了 ⇒ 之后每次探活都直接拿缓存，
    // 不会再走到这里 ⇒ DEV 下也不会刷屏（原来一轮同步 6-8 次探活 = 6-8 行）。
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
  } catch {
    // 读 env / 解析抛了 ⇒ 「读不到」⇒ 不是「配错了」，是「还没配」。
    return null;
  }
};

/**
 * 读运行时配置（**带缓存**）。
 *
 * ⚠️ 缓存的是**结论**（配好了 / 还没配），不是「每次都重算一遍」——
 * 见上面 `cachedConfig` 的注释（配置是构建期常量 ⇒ 运行时不变）。
 */
export const getSupabaseConfig = (): SupabaseRuntimeConfig | null => {
  if (configResolved) return cachedConfig;
  cachedConfig = readSupabaseConfig();
  configResolved = true;
  return cachedConfig;
};

/**
 * 仅测试用：忘掉缓存的配置（让下一次调用**重新读** env）。
 *
 * ⚠️ 为什么需要它：模块级状态会**跨用例残留** —— 一个用例把 env 换成
 * 「会抛错的样子」，下一个用例就拿不到正常配置 ⇒ 那条「读不到就返回 null」
 * 的断言会变成**假绿**。
 *
 * ⚠️ 生产代码不许调它（与仓库既有约定同款：`__resetOutageTrackerForTests` /
 * `__resetKeyCacheForTesting` / `__resetCloudColumnProbeCacheForTests`）。
 */
export function __resetSupabaseConfigCacheForTests(): void {
  cachedConfig = null;
  configResolved = false;
}
