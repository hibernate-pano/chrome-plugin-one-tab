// 构建期 / 打包期的 Supabase 配置闸门（2026-11-23）。
//
// ── 为什么需要这道闸 ──────────────────────────────────────────────────────
//
// 2026-11-21 出了一次**线上事故**：1.32.0 提审上架后，**所有用户登录都报**
// 「Supabase 配置缺失。请确保在 .env 文件中设置了 VITE_SUPABASE_URL 和
// VITE_SUPABASE_ANON_KEY。」
//
// 根因链（每一环单独看都不算 bug，串起来就是事故）：
//   1. `vercel link` 在打包前**覆盖**了 `.env.local`（只留下 VERCEL_OIDC_TOKEN）；
//   2. vite 对**缺失的 env 静默放行** —— `import.meta.env.VITE_SUPABASE_URL`
//      变成 undefined，产物照样「构建成功」；
//   3. 打包脚本只检查 zip 能不能生成、manifest 版本对不对 —— **不看产物里有没有
//      真正内联了 Supabase 配置**；
//   4. 于是「一个没有云端配置的扩展包」一路走到商店公开页，
//      直到真实用户点登录才发现。
//
// ⇒ 这道闸的形状就是事故的形状：**配置形态不对 ⇒ 构建/打包直接失败**，
//   而不是「构建出一个残废的包，让用户去发现」。
//
// ── 为什么放在 scripts/lib 而不是 src/core ────────────────────────────────
//
// 它要被**三个**地方用：vite.config.ts（TS）、package-extension.js（纯 JS）、
// 测试（TS）。`package-extension.js` 是 node 直接跑的脚本，**import 不了 .ts**
// ⇒ 闸门必须写成 node 原生能吃的 .mjs。（纯度不变量不受影响：三个函数都是纯的，
// 读文件留在调用方。）
//
// ── 判据口径 ──────────────────────────────────────────────────────────────
//
// 与 `src/utils/supabase/client.ts` 里既有的运行时校验**同口径**：
// URL 主机名必须含 `supabase.co`，key 必须是 JWT（`eyJ` 开头）。
// ⚠️ 额外加一条**长度下限**：真 key 是 208 字符的 JWT，而被脱敏/被截断的
// 值（占位符、掩码）长度只有 13–55 ⇒ 形态对但长度不对，一样是**没配好**。
// 这一条正是本次事故能溜过去的原因：光看「非空」不够。

/** URL 至少要像这么长才算「像样的 URL」。 */
const MIN_URL_LENGTH = 20;

/** 完整 JWT 的长度下限（真 key 208 字符；占位符/掩码只有 13–55）。 */
const MIN_JWT_LENGTH = 100;

/** 新式 publishable/secret key 的长度下限（`sb_publishable_…` 形态）。 */
const MIN_SB_KEY_LENGTH = 40;

/**
 * 本产品**唯一该连**的 Supabase 项目地址。
 *
 * ── 为什么把它钉死（而不是「主机名含 supabase.co 就算」） ──────────────────
 *
 * 「形态对」与「是本项目」是两件事：
 *   · 形态对 ⇒ 它是一个像样的 Supabase 配置（`src/utils/supabase/client.ts`
 *     的运行时校验管这一层，测试里用 `stub.supabase.co` 当桩）；
 *   · 是本项目 ⇒ 它连的是**我们的**库。钉错了 ⇒ 用户登录进的是**别人的项目**，
 *     或者连上一个空库 —— 症状是「登录成功但什么都是空的」，比直接报错更难查。
 *
 * 钉它**不新增任何暴露面**：这个地址本来就内嵌在**已上架**的扩展产物里，
 * 也早就写在 `scripts/lead-verify-*.mjs` / `docs/RELEASE-NOTES.md` 里
 * （Supabase 的项目 ref 与 anon key 按设计就是公开的）。
 */
export const EXPECTED_PROJECT_URL = 'https://reccclnaxadbuccsrwmg.supabase.co';

/** 去掉末尾斜杠再比，避免 `https://x.supabase.co/` 与 `https://x.supabase.co` 被判成两个项目。 */
function normalizeUrl(url) {
  return typeof url === 'string' ? url.trim().replace(/\/+$/, '') : '';
}

/**
 * 检查配置形态。
 *
 * 纯函数：同样的两个字符串 ⇒ 同样的结论（无 IO、无时钟、无随机）。
 */
export function checkSupabaseEnv(url, key) {
  const problems = [];

  const u = normalizeUrl(url);
  const k = typeof key === 'string' ? key.trim() : '';

  if (!u) {
    problems.push('VITE_SUPABASE_URL 为空');
  } else if (u.length < MIN_URL_LENGTH) {
    problems.push(`VITE_SUPABASE_URL 太短（${u.length} 字符）：像是被截断的值`);
  } else if (!/https?:\/\/[^/]*supabase\.co/i.test(u)) {
    problems.push(
      `VITE_SUPABASE_URL 的主机名不含 supabase.co（收到 ${u.slice(0, 40)}…）：这不是一个 Supabase 项目地址`
    );
  } else if (u.toLowerCase() !== EXPECTED_PROJECT_URL.toLowerCase()) {
    problems.push(
      `VITE_SUPABASE_URL 连的不是本产品的项目（收到 ${u}，应为 ${EXPECTED_PROJECT_URL}）：` +
        '连错项目 ⇒ 用户会「登录成功但库里什么都没有」，比直接报错更难查'
    );
  }

  if (!k) {
    problems.push('VITE_SUPABASE_ANON_KEY 为空');
  } else if (k.startsWith('eyJ')) {
    if (k.length < MIN_JWT_LENGTH) {
      problems.push(
        `VITE_SUPABASE_ANON_KEY 只有 ${k.length} 字符（JWT 应 ≥ ${MIN_JWT_LENGTH}）：` +
          '像是被脱敏/被截断的值，不是可用的密钥'
      );
    } else if (k.split('.').length !== 3) {
      problems.push('VITE_SUPABASE_ANON_KEY 长得像 JWT 但不是三段（eyJ.x.y）');
    }
  } else if (k.startsWith('sb_')) {
    if (k.length < MIN_SB_KEY_LENGTH) {
      problems.push(
        `VITE_SUPABASE_ANON_KEY 只有 ${k.length} 字符（sb_ 开头的密钥应 ≥ ${MIN_SB_KEY_LENGTH}）`
      );
    }
  } else {
    problems.push(
      'VITE_SUPABASE_ANON_KEY 既不是 JWT（eyJ 开头）也不是新式密钥（sb_ 开头）：' +
        '多半是没配（占位符原样写进来了）'
    );
  }

  return { ok: problems.length === 0, problems };
}

/**
 * 从产物文本里找内联的 Supabase 配置。
 *
 * 纯函数：给定一批产物文本 ⇒ 结论。
 *
 * 判据：产物里必须**同时**出现
 *   · **本产品的**项目地址（`EXPECTED_PROJECT_URL`，精确匹配，不接受别的 *.supabase.co）；
 *   · 一个完整形态的 key（`eyJ…` 三段且够长，或 `sb_…`）。
 * 两者缺一 ⇒ 产物缺配置 ⇒ 不能出包。
 */
export function checkSupabaseConfigInArtifacts(texts) {
  const problems = [];
  const all = texts.filter(t => typeof t === 'string').join('\n');

  const hasUrl = /https?:\/\/[a-z0-9-]+\.supabase\.co/i.test(all);
  if (!hasUrl) {
    problems.push(
      '产物里找不到内联的 Supabase 项目地址（*.supabase.co）：' +
        '说明构建时 VITE_SUPABASE_URL 是空的 —— 这个包装上去会「登录失败」'
    );
  } else if (!all.toLowerCase().includes(EXPECTED_PROJECT_URL.toLowerCase())) {
    problems.push(
      `产物里的 Supabase 地址不是本项目的（应为 ${EXPECTED_PROJECT_URL}）：` +
        '连错项目 ⇒ 用户会「登录成功但库里什么都没有」'
    );
  }

  const jwt = all.match(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/);
  const sbKey = all.match(/sb_(?:publishable|secret)_[A-Za-z0-9_-]{20,}/);
  if (!jwt && !sbKey) {
    problems.push(
      '产物里找不到完整形态的 Supabase key：' +
        '说明构建时 VITE_SUPABASE_ANON_KEY 是空的（或只剩占位符）—— 这个包装上去会「登录失败」'
    );
  } else if (jwt && jwt[0].length < MIN_JWT_LENGTH) {
    problems.push(`产物里的 key 只有 ${jwt[0].length} 字符：像是被脱敏/被截断的值`);
  }

  return { ok: problems.length === 0, problems };
}
