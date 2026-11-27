// 扩展构建配置的**唯一读取入口**（2026-11-23）。
//
// ── 为什么需要这个文件 ──────────────────────────────────────────────────────
//
// 2026-11-21 的 1.32.0 线上事故：打包前跑了一次 `vercel link`（部署法务站点用），
// 它把仓库根的 `.env.local` **整个覆盖**了（覆盖后只剩 `VERCEL_OIDC_TOKEN`，
// 扩展的 `VITE_SUPABASE_*` 全没了）。而 vite 对**缺失的 env 静默放行**、
// 打包脚本又**不看产物** ⇒「构建成功」出一个没有云端配置的扩展包 ⇒
// 上架后所有用户点登录都报「Supabase 配置缺失」。
//
// ⇒ 根因不是 vite 的 bug、也不是打包脚本的 bug，是
//   **同一个文件被两个用途共享**（扩展的构建配置 vs vercel 的部署配置）。
// ⇒ 修法不是「加个检查」（检查只是把症状从「悄悄出坏包」变成「构建红」），
//   而是**把两件事物理分开**：扩展的配置离开仓库目录，vercel 碰不到它。
//
// ── 配置在哪 ───────────────────────────────────────────────────────────────
//
//   1. `TAPSTACK_ENV_FILE` 环境变量指向的文件（CI、多台机器、各自指定）；
//   2. `~/.config/tapstack/env`（本机默认位置，**在仓库之外**）。
//
// 没有第三个来源 —— 特别是**不再读仓库根的 `.env.local`**：
// 那个文件是 vercel 的地盘（`vercel link` 会覆盖它），共享即是事故的根因。
//
// ── 为什么是「读不到就失败」而不是「读不到就退回默认」 ──────────────────────
//
// 缺配置时如果悄悄退回默认（空值 / 桩值），构建会**成功**出一个残废的包 ——
// 那正是 1.32.0 的形状。这里 fail-closed：读不到 ⇒ 构建直接红，
// 报错写清「文件在哪、该放什么、为什么放仓库外」。
//
// ── 纯度纪律 ────────────────────────────────────────────────────────────────
//
// `parseEnvText` / `resolveTapstackEnvPath` 是纯函数（无 IO、无时钟、无随机），
// 文件读取留在 `loadTapstackEnv` 里（读文件本身可通过 `readFile` 注入，便于单测）。

import { readFileSync, existsSync } from 'fs';
import { homedir as osHomedir } from 'os';
import { isAbsolute, join, resolve } from 'path';

/** 指定配置文件的环境变量名。 */
export const ENV_FILE_VAR = 'TAPSTACK_ENV_FILE';

/** 默认配置文件位置（相对 home）。 */
export const DEFAULT_ENV_DIR_SEGMENTS = ['.config', 'tapstack'];
export const DEFAULT_ENV_FILE_NAME = 'env';

/** 默认位置的人类可读写法（报错里用）。 */
export const DEFAULT_ENV_DISPLAY_PATH = '~/.config/tapstack/env';

/**
 * 仓库根 `.env.local` 里**真的**不再生效的键。
 *
 * 只有这两个：它们被 `injectViteEnv` 从仓库外的配置文件注入 `process.env`，
 * 而 `process.env` 在 vite 的 `loadEnv` 里**覆盖**文件 ⇒ 仓库里那份副本永远赢不了。
 * 别的 `VITE_` 键不在这个集合里 —— 它们照常被 vite 读进去、照常进产物。
 */
export const STALE_REPO_ENV_KEYS = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'];

/**
 * @typedef {Record<string, string>} EnvValues
 * @typedef {{ path: string, origin: 'explicit' | 'default', display: string }} EnvSource
 * @typedef {{ ok: boolean, values: EnvValues, source: EnvSource, problems: string[] }} LoadedEnv
 */

/**
 * 解析 `KEY=VALUE` 文本。**纯函数**。
 *
 * 支持的写法：
 *   · `KEY=value`
 *   · `KEY="value"` / `KEY='value'`（外层引号会被去掉）
 *   · `export KEY=value`（`export ` 前缀会被去掉）
 *   · `#` 开头的注释行、空行 → 忽略
 *   · 值里可以含 `=`（只在**第一个** `=` 处切分）
 *
 * 坏行（不是 KEY=VALUE / 键名不合法）⇒ 记成 problem（由调用方 fail-closed）。
 * 刻意**不**做 dotenv 的高级语法（多行值、变量插值）：这个文件是我们自己的格式，
 * 少一种语法就少一种「以为写对了其实没生效」的可能。
 *
 * @param {string} text
 * @returns {{ values: EnvValues, problems: string[] }}
 */
export function parseEnvText(text) {
  /** @type {EnvValues} */
  const values = {};
  /** @type {string[]} */
  const problems = [];
  const lines = String(text ?? '').split(/\r?\n/);

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) {
      problems.push(`第 ${index + 1} 行不是 KEY=VALUE：${line.slice(0, 40)}`);
      return;
    }

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      problems.push(`第 ${index + 1} 行的键名不合法：${key.slice(0, 40)}`);
      return;
    }

    let value = withoutExport.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    values[key] = value;
  });

  return { values, problems };
}

/**
 * 决定读哪个配置文件。**纯函数**。
 *
 * 顺序：`TAPSTACK_ENV_FILE` → `~/.config/tapstack/env`。
 * 返回 `origin` 说明是哪一条规则命中的（报错里要说清楚「我找了哪」）。
 *
 * @param {{ env?: Record<string, string | undefined>, homedir?: string, cwd?: string }} [options]
 * @returns {EnvSource}
 */
export function resolveTapstackEnvPath({ env = {}, homedir, cwd = process.cwd() } = {}) {
  const explicit = typeof env[ENV_FILE_VAR] === 'string' ? env[ENV_FILE_VAR].trim() : '';
  if (explicit) {
    return {
      path: isAbsolute(explicit) ? explicit : resolve(cwd, explicit),
      origin: 'explicit',
      display: `${ENV_FILE_VAR}=${explicit}`,
    };
  }
  const home = homedir ?? osHomedir();
  return {
    path: join(home, ...DEFAULT_ENV_DIR_SEGMENTS, DEFAULT_ENV_FILE_NAME),
    origin: 'default',
    display: DEFAULT_ENV_DISPLAY_PATH,
  };
}

/**
 * 读取扩展的构建配置。
 *
 * @param {{ env?: Record<string, string | undefined>, homedir?: string, cwd?: string, readFile?: (path: string) => string }} [options]
 * @returns {LoadedEnv}
 */
export function loadTapstackEnv({ env = process.env, homedir, cwd = process.cwd(), readFile } = {}) {
  const read = readFile ?? ((p) => readFileSync(p, 'utf8'));
  const source = resolveTapstackEnvPath({ env, homedir, cwd });

  let text;
  try {
    text = read(source.path);
  } catch (error) {
    const reason =
      error && error.code === 'ENOENT'
        ? '文件不存在'
        : `读取失败：${(error && error.message) || String(error)}`;
    return {
      ok: false,
      values: {},
      source,
      problems: [
        `读不到扩展的构建配置（${source.display} → ${source.path}）：${reason}`,
      ],
    };
  }

  const { values, problems } = parseEnvText(text);
  return { ok: problems.length === 0, values, source, problems };
}

/**
 * 把配置写进 `process.env`（只写 `VITE_` 前缀的键）。
 *
 * **为什么必须写进 process.env**：vite 6 的 `loadEnv` 是「**process.env 覆盖文件**」
 * （源码 `node_modules/vite/dist/node/chunks/dep-*.js` 里 `loadEnv` 先写文件、
 * 后写 process.env）⇒ 注入进去的值是**权威值**，仓库里任何 `.env.*` 都盖不住它。
 *
 * ⚠️ 前提：`vite.config.ts` 的配置函数在 vite 读 env **之前**求值
 * （`resolveConfig` → `loadConfigFromFile` → 求值配置函数 → 之后才 `loadEnv`），
 * 所以这里的注入来得及，dev 与 build 都吃得到。
 *
 * 非 `VITE_` 的键**不注入**（它们不该进产物）；返回 `ignored` 供调用方提示。
 *
 * @param {EnvValues} values
 * @param {Record<string, string | undefined>} [target]
 * @returns {{ injected: string[], ignored: string[] }}
 */
export function injectViteEnv(values, target = process.env) {
  const injected = [];
  const ignored = [];
  for (const [key, value] of Object.entries(values || {})) {
    if (key.startsWith('VITE_')) {
      target[key] = value;
      injected.push(key);
    } else {
      ignored.push(key);
    }
  }
  return { injected, ignored };
}

/**
 * 仓库根的 `.env.local` 里若还留着 `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`
 * ⇒ 那是一份**已经不再生效**的旧配置。
 *
 * 留着它不会坏包（构建不读它了），但会**误导人**：改了它却不生效 ⇒
 * 「改了配置却没生效」这类查不出来的事故。⇒ 明确提示。
 *
 * ⚠️ **只检查这两个键，不检查所有 `VITE_` 键**（2026-11-23 修正）：
 * 别的 `VITE_` 键**照样会进产物** —— vite 自己读 `.env` / `.env.local`，
 * 且 `injectViteEnv` 只覆盖被注入的那几个键，其余 `VITE_` 键按 vite 的规则照常生效。
 * 先前这个函数对**任意** `VITE_` 键都喊「已经不再生效」，于是：
 *   · 说法是假的（那些键其实还生效）；
 *   · 建议「删掉这几行」也误导（删了不会有任何变化）。
 * ⇒ 警告必须只覆盖**真的**不再生效的那两个键，否则它就从「提示」变成了「骗人」。
 *
 * @param {{ cwd?: string, fileExists?: (path: string) => boolean, readFile?: (path: string) => string }} [options]
 * @returns {string[]}
 */
export function warnAboutStaleRepoEnv({
  cwd = process.cwd(),
  fileExists = existsSync,
  readFile = (p) => readFileSync(p, 'utf8'),
} = {}) {
  const path = join(cwd, '.env.local');
  let text;
  try {
    if (!fileExists(path)) return [];
    text = readFile(path);
  } catch {
    return [];
  }
  const { values } = parseEnvText(text);
  const stale = STALE_REPO_ENV_KEYS.filter((k) => k in values);
  if (stale.length === 0) return [];
  const they = stale.length === 1 ? '它' : '它们';
  return [
    `${path} 里还有 ${stale.join('、')} —— ${they}**已经不再生效**` +
      `（扩展的构建配置现在只从 ${DEFAULT_ENV_DISPLAY_PATH} / ${ENV_FILE_VAR} 读）。` +
      `留着只会在「改了却没生效」时误导排查，建议删掉这几行。`,
  ];
}
