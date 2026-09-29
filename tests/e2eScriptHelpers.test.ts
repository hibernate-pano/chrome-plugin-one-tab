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
  parseDotEnv,
  requireEnv,
} from '../scripts/e2e-support.mjs';

// e2e-support.mjs 是 .mjs，没有 JSDoc 类型标注（补它属于 scripts/ 的工作包，
// 不在本包范围内）。tsc 因此把 parseDotEnv 推成返回 `{}`、把 loadEnv 推成返回
// 「调用方传进去的那个对象字面量类型」——于是访问 env.VITE_SUPABASE_URL 报 TS2339。
// 那不是用例写错了，是模块缺声明。这里把两个函数的**真实契约**声明一次
// （实现见 scripts/e2e-support.mjs:31-43 与 62-75：一律收发「键 → 字符串」的环境变量袋）。
// 断言只在这一处，且断的是具体类型而不是 any——下游全部保持类型检查。
type EnvBag = Record<string, string | undefined>;
const parseEnv = parseDotEnv as (text: string) => Record<string, string>;
const readEnv = loadEnv as (opts?: { cwd?: string; processEnv?: EnvBag }) => EnvBag;

const mkProject = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-support-test-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
};

// ── 凭据来源：process.env 优先，缺失才回退 .env ──────────────────────

test('parseDotEnv 跳过注释与空行，值两侧成对引号被剥掉', () => {
  const env = parseEnv(
    [
      '# 注释行',
      '',
      'VITE_SUPABASE_URL=https://abc.supabase.co',
      '  VITE_SUPABASE_ANON_KEY = "eyJhbGciOi.payload.sig"  ',
      "SOME_FLAG='on'",
      'WITH_EQUALS=postgres://u:p@h:5432/db?a=1&b=2',
      '不是键值对',
    ].join('\n'),
  );
  assert.equal(env.VITE_SUPABASE_URL, 'https://abc.supabase.co');
  assert.equal(env.VITE_SUPABASE_ANON_KEY, 'eyJhbGciOi.payload.sig');
  assert.equal(env.SOME_FLAG, 'on');
  // 值里的 = 不能被当成第二个分隔符（老写法用 indexOf('=') 恰好也对，但值得钉住）
  assert.equal(env.WITH_EQUALS, 'postgres://u:p@h:5432/db?a=1&b=2');
  assert.ok(!('不是键值对' in env));
});

test('loadEnv：process.env 覆盖 .env，.env 独有的键仍能拿到', () => {
  const cwd = mkProject({
    '.env': 'VITE_SUPABASE_URL=https://from-file.supabase.co\nVITE_SUPABASE_ANON_KEY=anon-from-file\n',
  });
  const env = readEnv({
    cwd,
    processEnv: { VITE_SUPABASE_URL: 'https://from-ci.supabase.co' },
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
  const fromFiles = readEnv({ cwd, processEnv: {} });
  assert.equal(fromFiles.VITE_SUPABASE_URL, 'https://local.supabase.co');
  assert.equal(fromFiles.VITE_APP_VERSION, '1.0.0');

  const noFiles = readEnv({
    cwd: mkProject({}),
    processEnv: { VITE_SUPABASE_URL: 'https://ci.supabase.co', VITE_SUPABASE_ANON_KEY: 'anon' },
  });
  assert.equal(noFiles.VITE_SUPABASE_URL, 'https://ci.supabase.co');
});

test('requireEnv 在缺键时报出缺哪个、怎么给，而不是让脚本带着 undefined 跑', () => {
  assert.throws(
    () => requireEnv({ VITE_SUPABASE_URL: 'https://x.supabase.co' }, REQUIRED_ENV),
    (err: unknown) => {
      assert.ok(err instanceof Error, `requireEnv 必须抛 Error，实得：${String(err)}`);
      assert.match(err.message, /VITE_SUPABASE_ANON_KEY/);
      assert.match(err.message, /process\.env/);
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
