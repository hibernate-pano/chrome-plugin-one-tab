// scripts/e2e-support.mjs 的回归用例。
//
// 为什么这些函数值得单测：它们是 e2e 体系里**唯一能在 CI 里跑**的部分。
// e2e 脚本本身要 headed Chrome + 真实 Supabase，本地都跑不了，于是"登记表完整、
// 凭据来源受控、账号能被收尾清理、判据真的会置退出码"这四件事只能靠这里的
// 纯函数测试来钉住——它们一旦回归，仓库里会重新长出一批"写了永远不跑 /
// 只打日志不报错 / 密钥只能从 .env 读"的假防线。
//
// 修之前的行为（对照）：run-e2e 对"存在但未登记"只 console.warn、退出码仍为 0；
// 脚本对 .env 硬 readFileSync、process.env 完全无效；判据只 console.log、退出码恒 0。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ACCOUNT_MARKER,
  REQUIRED_ENV,
  accountMarker,
  computeRegistryDiff,
  createGate,
  extractTestAccounts,
  loadEnv,
  requireEnv,
} from '../scripts/e2e-support.mjs';
import { parseEnvText } from '../scripts/lib/tapstackEnv.mjs';

// e2e-support.mjs 是 .mjs，没有 JSDoc 类型标注（补它属于 scripts/ 的工作包，
// 不在本包范围内）。tsc 因此把 loadEnv 推成返回「调用方传进去的那个对象字面量
// 类型」——于是访问 env.VITE_SUPABASE_URL 报 TS2339。
// 那不是用例写错了，是模块缺声明。这里把函数的**真实契约**声明一次
// （实现见 scripts/e2e-support.mjs：一律收发「键 → 字符串」的环境变量袋）。
// 断言只在这一处，且断的是具体类型而不是 any——下游全部保持类型检查。
type EnvBag = Record<string, string | undefined>;
const parseEnv = parseEnvText as (text: string) => {
  values: Record<string, string>;
  problems: string[];
};
const readEnv = loadEnv as (opts?: {
  cwd?: string;
  processEnv?: EnvBag;
  configFile?: string;
}) => EnvBag;

/**
 * 「仓库外的构建配置」这一层的**占位路径**（2026-11-23 起扩展的配置在
 * `~/.config/tapstack/env`，见 scripts/lib/tapstackEnv.mjs）。
 *
 * 下面那些用例要的是「这一层不存在」⇒ 必须钉死，否则结果取决于**开发机**上
 * 有没有那份文件（别人机器恒绿、本机恒红 —— 那样的用例等于没有）。
 */
const NO_CONFIG_FILE = join(tmpdir(), 'e2e-support-test-no-config.env');

const mkProject = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-support-test-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
};

// ── 凭据来源：仓库外的构建配置（权威）→ process.env → 仓库里的 .env ────

test('解析器跳过注释与空行，值两侧成对引号被剥掉', () => {
  // 2026-11-23：e2e 不再自带一套解析器，改用构建侧同一个 parseEnvText
  // （scripts/lib/tapstackEnv.mjs）⇒ 同一个配置文件，两条路径必须得到同一个结果。
  const { values: env, problems } = parseEnv(
    [
      '# 注释行',
      '',
      'VITE_SUPABASE_URL=https://abc.supabase.co',
      '  VITE_SUPABASE_ANON_KEY = "eyJhbGciOi.payload.sig"  ',
      "SOME_FLAG='on'",
      'WITH_EQUALS=postgres://u:p@h:5432/db?a=1&b=2',
    ].join('\n'),
  );
  assert.deepEqual(problems, []);
  assert.equal(env.VITE_SUPABASE_URL, 'https://abc.supabase.co');
  assert.equal(env.VITE_SUPABASE_ANON_KEY, 'eyJhbGciOi.payload.sig');
  assert.equal(env.SOME_FLAG, 'on');
  // 值里的 = 不能被当成第二个分隔符（老写法用 indexOf('=') 恰好也对，但值得钉住）
  assert.equal(env.WITH_EQUALS, 'postgres://u:p@h:5432/db?a=1&b=2');
});

test('解析器认 export 前缀、且坏行被记成问题（不再静默丢弃）', () => {
  // 这两条正是先前 e2e 与构建**给出不同答案**的根因：
  // 构建认 export、且坏行 fail-closed；e2e 两样都不认 ⇒ 同一份文件，
  // 构建成功、e2e 拿到 undefined，然后报「请把变量放到 ~/.config/tapstack/env」。
  const withExport = parseEnv('export VITE_SUPABASE_URL=https://abc.supabase.co\n');
  assert.equal(withExport.values.VITE_SUPABASE_URL, 'https://abc.supabase.co');
  assert.deepEqual(withExport.problems, []);

  const withBadLine = parseEnv('VITE_SUPABASE_URL=https://abc.supabase.co\n这一行坏了\n');
  assert.equal(withBadLine.problems.length, 1, '坏行必须被报出来，不能静默丢弃');
  assert.match(withBadLine.problems[0], /KEY=VALUE/);
});

test('loadEnv：process.env 覆盖 .env，.env 独有的键仍能拿到', () => {
  const cwd = mkProject({
    '.env': 'VITE_SUPABASE_URL=https://from-file.supabase.co\nVITE_SUPABASE_ANON_KEY=anon-from-file\n',
  });
  const env = readEnv({
    cwd,
    processEnv: { VITE_SUPABASE_URL: 'https://from-ci.supabase.co' },
    configFile: NO_CONFIG_FILE,
  });
  // 修之前：只读 .env，CI 注入的 URL 完全无效
  assert.equal(env.VITE_SUPABASE_URL, 'https://from-ci.supabase.co');
  assert.equal(env.VITE_SUPABASE_ANON_KEY, 'anon-from-file');
});

test('loadEnv：.env.local 覆盖 .env，且两者都缺时只靠 process.env 也能跑', () => {
  const cwd = mkProject({
    '.env': 'VITE_SUPABASE_URL=https://base.supabase.co\nVITE_APP_VERSION=1.0.0\n',
    '.env.local': 'VITE_SUPABASE_URL=https://local.supabase.co\n',
  });
  const fromFiles = readEnv({ cwd, processEnv: {}, configFile: NO_CONFIG_FILE });
  assert.equal(fromFiles.VITE_SUPABASE_URL, 'https://local.supabase.co');
  assert.equal(fromFiles.VITE_APP_VERSION, '1.0.0');

  const noFiles = readEnv({
    cwd: mkProject({}),
    processEnv: { VITE_SUPABASE_URL: 'https://ci.supabase.co', VITE_SUPABASE_ANON_KEY: 'anon' },
    configFile: NO_CONFIG_FILE,
  });
  assert.equal(noFiles.VITE_SUPABASE_URL, 'https://ci.supabase.co');
});

test('loadEnv：仓库外的构建配置（2026-11-23 起扩展配置在那儿）压过仓库里的旧副本', () => {
  // 仓库根的 .env.local 现在是 vercel link 的地盘 ⇒ 扩展的配置搬到仓库之外。
  // ⇒ 那一层的优先级必须**高于**仓库里的 .env / .env.local，
  //    否则 e2e 脚本会读到一份「早就失效的旧配置」却毫无察觉。
  const cwd = mkProject({
    '.env.local': 'VITE_SUPABASE_URL=https://stale-in-repo.supabase.co\n',
  });
  const configFile = join(mkProject({}), 'tapstack.env');
  writeFileSync(configFile, 'VITE_SUPABASE_URL=https://authoritative.supabase.co\n');

  const env = readEnv({ cwd, processEnv: {}, configFile });
  assert.equal(env.VITE_SUPABASE_URL, 'https://authoritative.supabase.co');
});

test('loadEnv：仓库外的构建配置压过 process.env（与构建路径逐层对齐）', () => {
  // 【这条是 2026-11-23 修的那个分叉】构建路径里 `injectViteEnv` 会把
  // 仓库外的配置**写进** process.env ⇒ 构建实际以**文件**为准。
  // e2e 若把 process.env 放最上面 ⇒ 开发者 `export VITE_SUPABASE_URL=…` 之后，
  // 扩展连文件里的项目、e2e 连 export 的项目 ⇒ **e2e 验的不是要发的东西**。
  // ⇒ 两边必须逐层对齐：仓库外配置 > process.env > 仓库文件。
  const cwd = mkProject({
    '.env': 'VITE_SUPABASE_URL=https://from-repo-file.supabase.co\n',
  });
  const configFile = join(mkProject({}), 'tapstack.env');
  writeFileSync(configFile, 'VITE_SUPABASE_URL=https://authoritative.supabase.co\n');

  const env = readEnv({
    cwd,
    processEnv: { VITE_SUPABASE_URL: 'https://from-shell.supabase.co' },
    configFile,
  });
  assert.equal(
    env.VITE_SUPABASE_URL,
    'https://authoritative.supabase.co',
    '文件是权威来源 ⇒ 必须压过 shell 注入的值（与构建一致）',
  );
});

test('loadEnv：process.env 仍然压过仓库里的 .env（CI 注入不能被回归掉）', () => {
  // 上一条把文件提到 process.env 之上时，**很容易顺手把这条也弄反**。
  // vite 的 loadEnv 是「文件先写、process.env 后写（覆盖）」⇒ 环境变量
  // 赢得过仓库文件。仓库外配置与仓库文件是**两层**，别混成一层。
  const cwd = mkProject({
    '.env': 'VITE_SUPABASE_URL=https://from-repo-file.supabase.co\n',
  });
  const env = readEnv({
    cwd,
    processEnv: { VITE_SUPABASE_URL: 'https://from-ci.supabase.co' },
    configFile: NO_CONFIG_FILE,
  });
  assert.equal(env.VITE_SUPABASE_URL, 'https://from-ci.supabase.co');
});

test('requireEnv 在缺键时报出缺哪个、怎么给，而不是让脚本带着 undefined 跑', () => {
  assert.throws(
    () => requireEnv({ VITE_SUPABASE_URL: 'https://x.supabase.co' }, REQUIRED_ENV),
    (err: unknown) => {
      assert.ok(err instanceof Error, `requireEnv 必须抛 Error，实得：${String(err)}`);
      assert.match(err.message, /VITE_SUPABASE_ANON_KEY/);
      // 报错要指向**权威来源**（仓库外的构建配置），而不是只提 process.env
      // —— 权威来源只有一个，指错了等于让人去改一个不生效的地方。
      assert.match(err.message, /~\/\.config\/tapstack\/env/);
      return true;
    },
  );
  const okEnv = { VITE_SUPABASE_URL: 'https://x.supabase.co', VITE_SUPABASE_ANON_KEY: 'anon' };
  assert.equal(requireEnv(okEnv), okEnv);
});

// ── 测试账号提取：跑完能统一清理，不留残号 ─────────────────────────

test('extractTestAccounts 抓 E2E_ACCOUNT 标记行并去重排序', () => {
  const out = [
    `${ACCOUNT_MARKER} e2e-st-abc123@test.tapstack.dev`,
    '✅ 正控② 通过',
    `${ACCOUNT_MARKER} e2e-tb-aaa111@test.tapstack.dev`,
    `${ACCOUNT_MARKER} e2e-st-abc123@test.tapstack.dev`, // 同一脚本重跑/日志重复
  ].join('\n');
  assert.deepEqual(extractTestAccounts(out), [
    'e2e-st-abc123@test.tapstack.dev',
    'e2e-tb-aaa111@test.tapstack.dev',
  ]);
});

test('extractTestAccounts 兜底认测试专用域，且不会误伤真实用户邮箱', () => {
  const out = [
    '测试账号: e2e-nr-9f9f9f@test.tapstack.dev',
    '真实用户 jasper@example.com 不该被当成测试账号',
  ].join('\n');
  assert.deepEqual(extractTestAccounts(out), ['e2e-nr-9f9f9f@test.tapstack.dev']);
  assert.deepEqual(extractTestAccounts(''), []);
  assert.deepEqual(extractTestAccounts('脚本还没跑到注册那步'), []);
});

test('accountMarker 产出的行能被自己的提取函数原样解析回来', () => {
  const email = `e2e-web-${'a'.repeat(6)}@test.tapstack.dev`;
  assert.equal(accountMarker(email), `E2E_ACCOUNT ${email}`);
  assert.deepEqual(extractTestAccounts(accountMarker(email)), [email]);
});

// ── 登记表完整性：写了没登记 = 假防线，必须判失败 ───────────────────

test('computeRegistryDiff 报出"存在但未登记"，正是 run-e2e 现在判失败的那一类', () => {
  const order = ['e2e-a.mjs', 'e2e-b.mjs'];
  const available = ['e2e-a.mjs', 'e2e-b.mjs', 'e2e-hard-delete-empty-group.mjs'];
  const { missing, extra } = computeRegistryDiff(available, order);
  assert.deepEqual(extra, ['e2e-hard-delete-empty-group.mjs']);
  assert.deepEqual(missing, []);
  // 修之前 extra 只是 warning，这里必须是可判失败的量
  assert.equal(Boolean(extra.length || missing.length), true);
});

test('computeRegistryDiff 同时报出陈旧登记（ORDER 里有、磁盘上没有）', () => {
  const { missing, extra } = computeRegistryDiff(['e2e-a.mjs'], ['e2e-a.mjs', 'e2e-gone.mjs']);
  assert.deepEqual(missing, ['e2e-gone.mjs']);
  assert.deepEqual(extra, []);
});

// ── 判据 gate：只有 PASS/FAIL 日志、退出码恒 0 的脚本是假防线 ─────────

test('createGate 全部通过 → 退出码 0', () => {
  const gate = createGate();
  assert.equal(gate.check('判据一', true), true);
  assert.equal(gate.check('判据二', true, '不该出现的 detail'), true);
  assert.equal(gate.passed, true);
  assert.equal(gate.report('汇总'), true);
  assert.equal(process.exitCode ?? 0, 0);
});

test('createGate 有一条不过 → 退出码非 0，并保留失败明细', () => {
  const gate = createGate();
  gate.check('删除后本地物理消失', false, '仍在存储 isDeleted=true');
  gate.check('多页会话保留', true);
  assert.equal(gate.passed, false);
  assert.deepEqual(gate.failures.map(f => f.name), ['删除后本地物理消失']);
  assert.equal(gate.report('汇总'), false);
  assert.equal(process.exitCode, 1);
  process.exitCode = 0; // 复位，别把失败码带给后续用例
});

test('createGate 一条判据都没打 → 不通过（没有断言 = 没有防线）', () => {
  const gate = createGate();
  assert.equal(gate.passed, false);
  assert.equal(gate.report('汇总'), false);
  assert.equal(process.exitCode, 1);
  process.exitCode = 0;
});
