/**
 * e2e 脚本共享的**纯逻辑**层。
 *
 * 为什么单独一个文件而不是塞进 e2e-helpers.mjs：e2e-helpers 顶层 import playwright，
 * 单元测试引它会把整个浏览器栈拖起来。这里的每个导出要么纯函数、要么只依赖注入的
 * 参数与 node 内置 fs，可以在 node:test 里直测（tests/e2eScriptHelpers.test.ts）。
 *
 * 三件事集中在这里，避免 8 个脚本各抄一份、各错一次：
 *   1. 环境变量解析：仓库外的构建配置（权威）→ process.env → 仓库里的 .env
 *      （2026-11-23 起扩展的配置在仓库之外；这条路径与 vite.config.ts 的
 *        读取路径**逐层对齐** —— 扩展构建与 e2e 必须看到同一个值）
 *   2. 测试账号提取：统一从脚本 stdout 里抓，交给 run-e2e 收尾统一清理
 *   3. 判据 gate：把「打了 PASS/FAIL 日志但退出码永远是 0」的假防线变成真门禁
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnvText, resolveTapstackEnvPath } from './lib/tapstackEnv.mjs';

/**
 * 回退读取的环境文件（仓库内，只在仓库外的构建配置与 `process.env` 都没给该键时才生效）。
 *
 * 顺序语义不变：仍是「后者覆盖前者」（`.env.local` 覆盖 `.env`，与 vite 一致）。
 * 改的只是**层与层之间**的次序（见 `loadEnv`）：仓库外配置 > `process.env` > 仓库文件。
 */
export const ENV_FILES = ['.env', '.env.local'];

/** 跑 e2e 必需的凭据（匿名 key，公开可读；缺失时不该报出 Supabase 的天书错误码） */
export const REQUIRED_ENV = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'];

/** 清理测试账号用的管理凭据。有它就真删，没有就打印待清理清单（见 run-e2e.mjs） */
export const SERVICE_ROLE_ENV = 'SUPABASE_SERVICE_ROLE_KEY';

/** 读文件：不存在返回 null；存在但读不出来则抛出（读失败 ≠ 没配，不能静默降级） */
function readFileOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    throw err;
  }
}

/**
 * 取配置，优先级从高到低：
 *   1. **仓库外的构建配置**（`TAPSTACK_ENV_FILE` → `~/.config/tapstack/env`）—— **权威**
 *   2. `process.env`（CI 注入 / shell export）
 *   3. 仓库里的 `.env` → `.env.local`（历史遗留副本，层内后者覆盖前者）
 *
 * 为什么是这个优先级（2026-11-23 修正）：
 *   - **仓库外的构建配置是权威**：它是扩展构建（`vite.config.ts`）读的那一份 ⇒
 *     e2e 必须读到**同一个值**，否则「e2e 验过的」和「要发出去的」不是同一个东西。
 *   - 2026-11-23 起扩展的构建配置搬到**仓库之外**（`~/.config/tapstack/env`）——
 *     仓库根的 `.env.local` 是 `vercel link` 的地盘（1.32.0 事故：它被覆盖 ⇒
 *     构建照样成功 ⇒ 上架了没有云端配置的包）。⇒ 它排在仓库文件**上面**，
 *     仓库里那份旧副本只是历史遗留。
 *   - `process.env` 排在仓库文件**上面**、仓库外配置**下面**（此前它在最上面）：
 *     构建路径里 `injectViteEnv` 把仓库外配置**写进** process.env ⇒ 构建实际
 *     以仓库外配置为准；而 vite 的 `loadEnv` 是「文件先、process.env 后（覆盖）」
 *     ⇒ 环境变量又赢得过仓库文件。两边各赢一层，合起来就是这个次序。
 *     先前 e2e 把 process.env 放最上面 ⇒ 开发者 `export VITE_SUPABASE_URL=…`
 *     之后，扩展连文件里的项目、e2e 连 export 的项目 ⇒ **e2e 验的不是要发的东西**。
 *   - 文件不存在不算错误——CI 只注入环境变量是正常用法。
 *
 * ⚠️ 解析**复用** `parseEnvText`（构建侧同一个解析器），不再各写一套：
 *   先前 e2e 用自己的 `parseDotEnv`，它不认 `export ` 前缀、且**静默丢弃**坏行 ⇒
 *   同一个配置文件，构建认得出来、e2e 拿到 `undefined`，然后报「请把变量放到
 *   ~/.config/tapstack/env」——用户明明已经放了。
 *
 * @param {{ cwd?: string, processEnv?: Record<string, string | undefined>, files?: string[], readFile?: (path: string) => string | null, configFile?: string }} [options]
 */
export function loadEnv({
  cwd = process.cwd(),
  processEnv = process.env,
  files = ENV_FILES,
  readFile = readFileOrNull,
  configFile,
} = {}) {
  const out = {};
  // ── 第 1 层：仓库外的构建配置 —— **权威** ──────────────────────────────────
  // 它是扩展构建（vite.config.ts）读的那一份 ⇒ e2e 必须读到**同一个值**，
  // 否则「e2e 验过的」和「要发出去的」不是同一个东西。
  const configPath = configFile ?? resolveTapstackEnvPath({ env: processEnv }).path;
  const configText = readFile(configPath);
  if (configText != null) Object.assign(out, parseEnvText(configText).values);

  // ── 第 2 层：process.env ──────────────────────────────────────────────────
  // 排在仓库文件**上面**、仓库外配置**下面**：
  //   · vite 的 `loadEnv` 是「文件先写、process.env 后写（覆盖）」⇒ 仓库文件
  //     永远赢不了环境变量；
  //   · 但构建路径里 `injectViteEnv` 会把仓库外的配置**写进** process.env ⇒
  //     构建实际以仓库外配置为准。⇒ 这里照抄同一个次序。
  for (const [k, v] of Object.entries(processEnv)) {
    if (v !== undefined && !(k in out)) out[k] = v;
  }

  // ── 第 3 层：仓库里的 .env / .env.local（历史遗留副本）─────────────────────
  // 只在上面两层没给该键时才生效；层内仍是「后者覆盖前者」（.env.local 压 .env）。
  const repoTier = {};
  for (const f of files) {
    const text = readFile(join(cwd, f));
    if (text == null) continue; // 文件不存在：静默跳过，交给 requireEnv 统一报错
    Object.assign(repoTier, parseEnvText(text).values);
  }
  for (const [k, v] of Object.entries(repoTier)) {
    if (!(k in out)) out[k] = v;
  }
  return out;
}

/** 缺凭据时立刻报「缺哪个键、怎么给」，而不是让脚本跑到一半抛出 Supabase 错误码 */
export function requireEnv(env, names = REQUIRED_ENV) {
  const missing = names.filter(n => !env[n]);
  if (missing.length) {
    throw new Error(
      `缺少环境变量: ${missing.join(', ')}。` +
      `请在 ~/.config/tapstack/env（TAPSTACK_ENV_FILE 可指定别处）里放 ` +
      `（变量名不变：${names.join(' / ')}）—— 那是权威来源，` +
      `扩展构建与 e2e 读的是同一份。` +
      `（应急也可用 process.env 注入，但它只在配置文件没有该键时才生效。）`
    );
  }
  return env;
}

/** 测试账号专用域名：真实用户不可能命中这个域，所以从 stdout 抓它就是安全的 */
export const TEST_EMAIL_DOMAIN = 'test.tapstack.dev';
const TEST_EMAIL_RE = /e2e-[a-z0-9-]+@test\.tapstack\.dev/gi;

/** 机器可读的账号播报行：run-e2e 靠它知道本次运行造了哪些账号 */
export const ACCOUNT_MARKER = 'E2E_ACCOUNT';
export const accountMarker = email => `${ACCOUNT_MARKER} ${email}`;

/**
 * 从脚本 stdout 里提取本次产生的测试账号。
 * 认 ACCOUNT_MARKER 行（约定），也认任何落在测试专用域上的地址（兜底：日志里
 * 混进的地址、临时脚本没打标记的情况）。解析出的集合去重后返回；空输入返回空数组
 * —— 跑挂的脚本可能一个账号都没造出来，那不是错误。
 */
export function extractTestAccounts(text) {
  const found = new Set();
  for (const m of String(text).matchAll(TEST_EMAIL_RE)) found.add(m[0].toLowerCase());
  return [...found].sort();
}

/**
 * 比对「磁盘上存在的脚本」与「ORDER 登记表」。
 * 返回 missing（登记了但文件不在）/ extra（文件在但没登记 —— 永远不会跑）。
 * extra 是这里唯一有资格判失败的那一类：写了脚本忘了登记，等于没写。
 */
export function computeRegistryDiff(available, order) {
  const set = new Set(available);
  return {
    missing: order.filter(f => !set.has(f)),
    extra: available.filter(f => !order.includes(f)),
  };
}

/**
 * 判据 gate：把断言结果变成退出码。
 *
 * 为什么需要它：仓库里多个 e2e 脚本只 console.log('PASS'/'FAIL') 而从不设置
 * process.exitCode，run-e2e 永远判 PASS——那样的脚本是假装是防线。
 * 两条硬规则：
 *   - 一条判据都没打 → passed=false（没有断言 = 没有防线）
 *   - 有任何一条不通过 → 退出码 1
 */
export function createGate() {
  const checks = [];
  return {
    /** 记一条判据并打印，返回是否通过（便于在分支里继续跑） */
    check(name, passed, detail = '') {
      const ok = Boolean(passed);
      checks.push({ name, ok, detail });
      const tail = ok ? 'PASS' : `FAIL${detail ? ` — ${detail}` : ''}`;
      console.log(`  ${ok ? '✅' : '❌'} ${name}: ${tail}`);
      return ok;
    },
    get checks() { return checks.slice(); },
    get failures() { return checks.filter(c => !c.ok); },
    get passed() { return checks.length > 0 && checks.every(c => c.ok); },
    /** 打印汇总并写 process.exitCode；返回是否通过 */
    report(title = '判据') {
      const ok = this.passed;
      const n = checks.filter(c => c.ok).length;
      console.log(`\n${title}: ${n}/${checks.length} 通过`);
      for (const f of this.failures) console.log(`   ❌ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
      process.exitCode = ok ? 0 : 1;
      return ok;
    },
  };
}
