/**
 * e2e 脚本共享的**纯逻辑**层。
 *
 * 为什么单独一个文件而不是塞进 e2e-helpers.mjs：e2e-helpers 顶层 import playwright，
 * 单元测试引它会把整个浏览器栈拖起来。这里的每个导出要么纯函数、要么只依赖注入的
 * 参数与 node 内置 fs，可以在 node:test 里直测（tests/e2eScriptHelpers.test.ts）。
 *
 * 三件事集中在这里，避免 8 个脚本各抄一份、各错一次：
 *   1. 环境变量解析：process.env 优先，缺失才回退 .env（CI 注入的根因修复）
 *   2. 测试账号提取：统一从脚本 stdout 里抓，交给 run-e2e 收尾统一清理
 *   3. 判据 gate：把「打了 PASS/FAIL 日志但退出码永远是 0」的假防线变成真门禁
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 回退读取的环境文件，按顺序后者覆盖前者（.env.local 覆盖 .env，与 Vite 一致） */
export const ENV_FILES = ['.env', '.env.local'];

/**
 * 必需的环境变量清单。
 *
 * 2026-10-16 Supabase 下线后**清空**：云端后端唯一需要凭据的 4 支 e2e 脚本
 * （e2e-sync-test / e2e-batched-sync-roundtrip / e2e-auto-upload-test /
 * e2e-fresh-device-edit-wins）随 `@supabase/supabase-js` 与 `src/utils/supabase/*`
 * 一起删除。当时仍登记在 ORDER 里、驱动已删登录 UI 的 4 支本地数据安全脚本
 * （tab-delete / background-sync / local-delete / stress）已改为**本机 dufs + WebDAV**
 * （配置/凭据在脚本内播种，不来自环境变量）。因此现在「登记表里不需要环境凭据」
 * 是一句真话；且这不是靠自觉：`login()` helper 随账号 UI 一起失效，任何重新登记
 * 它的脚本会被 run-e2e 的登记表门禁 `findDeadLoginImports` 挡下
 * （tests/e2eScriptHelpers.test.ts 钉住该门禁能变红）。
 * 保留导出而不是删掉它：将来接入需要凭据的后端时，这里加回键名即可，
 * `requireEnv(env, REQUIRED_ENV)` 的调用形态不变；而清单为空时
 * 默认不拦任何环境 —— 这是「当前没有必需凭据」的如实表达，不是假绿
 * （tests/e2eScriptHelpers.test.ts 用显式清单断言缺键文案）。
 */
export const REQUIRED_ENV = [];

/**
 * 解析 dotenv 文本。
 * 与原先散在 4 个脚本里的手写循环相比只做两处收紧：
 *   - 值两侧的成对引号剥掉（Vite 侧就是这么解析的，留着会让 URL 变成 "https://..."）
 *   - 键名校验放宽到 [A-Za-z_][A-Za-z0-9_]*，不再只认大写
 */
export function parseDotEnv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const value = m[2].trim();
    const quoted = value.match(/^(['"])(.*)\1$/);
    out[m[1]] = quoted ? quoted[2] : value;
  }
  return out;
}

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
 * 取配置：**process.env 优先**，缺失的键才回退读 .env / .env.local。
 *
 * 为什么是这个优先级：密钥来源写死在代码里时，CI 与其他环境无法注入，只能靠
 * 「仓库里恰好有一份 .env」。反过来（.env 覆盖环境变量）会让 CI 静默连错项目。
 * 文件不存在不算错误——CI 只注入环境变量是正常用法。
 */
export function loadEnv({
  cwd = process.cwd(),
  processEnv = process.env,
  files = ENV_FILES,
  readFile = readFileOrNull,
} = {}) {
  const out = {};
  for (const f of files) {
    const text = readFile(join(cwd, f));
    if (text == null) continue; // 文件不存在：静默跳过，交给 requireEnv 统一报错
    Object.assign(out, parseDotEnv(text));
  }
  return { ...out, ...processEnv };
}

/** 缺凭据时立刻报「缺哪个键、怎么给」，而不是让脚本跑到一半报出无法定位的错误 */
export function requireEnv(env, names = REQUIRED_ENV) {
  const missing = names.filter(n => !env[n]);
  if (missing.length) {
    throw new Error(
      `缺少环境变量: ${missing.join(', ')}。` +
      `请用 process.env 注入，或在仓库根目录放 .env（变量名不变：${names.join(' / ')}）。`
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
 * 登记表门禁：找出「登记在 ORDER 里、却还 import 已死的 login() helper」的脚本。
 *
 * 为什么必须有：2026-10-16 账号体系删除后，曾有 4 支仍登记在 ORDER 的脚本继续
 * import `login()`（它点击 `登录 / 注册`，全仓已无处渲染），于是 `pnpm e2e` 仍把
 * 它们算作「可跑」，实际每支都会在 20s 超时里失败。登记表说它们能跑 = 登记表在
 * 说谎，比没有登记表更坏（.memory 的「登记表即门禁」纪律）。
 *
 * 识别口径（只认真正会让脚本失效的形态）：
 *   · 具名 import：`import { ..., login, ... } from './e2e-helpers.mjs'`（含 `as` 别名）
 *   · 命名空间 import 后再 `helpers.login(...)`
 * 只扫**登记在 ORDER 里**的脚本：未登记的脚本本来就过不了 computeRegistryDiff 那关。
 *
 * @param registered ORDER 里的脚本文件名数组
 * @param readScript (file) => string | null；null = 文件不存在（registry diff 另有门禁）
 * @returns 违规脚本文件名数组（顺序同 registered）
 */
export function findDeadLoginImports(registered, readScript) {
  const offenders = [];
  for (const file of registered) {
    const src = readScript(file);
    if (typeof src !== 'string') continue;
    const withoutLineComments = src.replace(/\/\/[^\n]*/g, '');
    const namedLogin = [...withoutLineComments.matchAll(
      /import\s*\{([^}]*)\}\s*from\s*['"]\.\/e2e-helpers\.mjs['"]/g
    )].some(m =>
      m[1]
        .split(',')
        .some(spec => spec.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim() === 'login')
    );
    if (namedLogin) {
      offenders.push(file);
      continue;
    }
    const namespaces = [...withoutLineComments.matchAll(
      /import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]\.\/e2e-helpers\.mjs['"]/g
    )].map(m => m[1]);
    if (namespaces.some(ns => new RegExp(`\\b${ns}\\.login\\s*\\(`).test(withoutLineComments))) {
      offenders.push(file);
    }
  }
  return offenders;
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
