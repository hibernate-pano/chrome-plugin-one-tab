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

/** 跑 e2e 必需的凭据（匿名 key，公开可读；缺失时不该报出 Supabase 的天书错误码） */
export const REQUIRED_ENV = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'];

/** 清理测试账号用的管理凭据。有它就真删，没有就打印待清理清单（见 run-e2e.mjs） */
export const SERVICE_ROLE_ENV = 'SUPABASE_SERVICE_ROLE_KEY';

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

/** 缺凭据时立刻报「缺哪个键、怎么给」，而不是让脚本跑到一半抛出 Supabase 错误码 */
export function requireEnv(env, names = REQUIRED_ENV) {
  const missing = names.filter(n => !env[n]);
  if (missing.length) {
    throw new Error(
      `缺少环境变量: ${missing.join(', ')}。` +
      `请用 process.env 注入（如 VITE_SUPABASE_URL=https://xxx.supabase.co），` +
      `或在仓库根目录放 .env（变量名不变：${names.join(' / ')}）。`
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
