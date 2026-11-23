/**
 * 构建期 / 打包期的 Supabase 配置闸门（2026-11-23）。
 *
 * ── 这个文件防的是哪次事故 ────────────────────────────────────────────────
 *
 * 1.32.0 上架后**所有用户登录都报**「Supabase 配置缺失」。根因链：
 *   `vercel link` 覆盖 `.env.local` → vite 对缺失的 env **静默放行** →
 *   产物里没有 Supabase 配置 → 打包脚本也不看产物 → 坏包一路到商店公开页。
 *
 * ⇒ 判据必须钉住两件事：
 *   ① **配置形态**不对 ⇒ 构建**失败**（不是「构建出一个残废的包」）；
 *   ② **产物里**没有内联的 Supabase 配置 ⇒ **拒绝出包**。
 *
 * ── 为什么接线用「真的跑那条路径」而不是断言源码长相 ──────────────────────
 *
 * 「源码里出现了 checkSupabaseEnv(」这种断言**零检测力**：把调用换成
 * `checkSupabaseEnv('')` 它照样绿。而这里：
 *   · 构建期那条：真的用 vite 的 `loadConfigFromFile` **执行**仓库里的
 *     vite.config.ts（配置函数里就会抛）⇒ 闸门被摘掉 ⇒ 这条立刻红；
 *   · 打包期那条：真的在临时目录里**跑** package-extension.js（产物坏 ⇒ 退出码 1）
 *     ⇒ 闸门被摘掉 ⇒ 这条立刻红。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkSupabaseEnv,
  checkSupabaseConfigInArtifacts,
} from '../scripts/lib/supabaseBuildGate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 一个形态合法的桩 key（真 key 是 208 字符的 JWT）。 */
const GOOD_KEY =
  'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxOTAwMDAwMDAwfQ.ciBuildOnlyDummySignatureNotARealKey_0000000000000000000000000';

describe('闸门判据：配置形态', () => {
  it('缺 URL ⇒ 判红', () => {
    const r = checkSupabaseEnv(undefined, GOOD_KEY);
    assert.equal(r.ok, false);
    assert.match(r.problems.join('；'), /VITE_SUPABASE_URL/);
  });

  it('缺 key ⇒ 判红', () => {
    const r = checkSupabaseEnv('https://reccclnaxadbuccsrwmg.supabase.co', '');
    assert.equal(r.ok, false);
    assert.match(r.problems.join('；'), /VITE_SUPABASE_ANON_KEY/);
  });

  it('URL 不是 Supabase 项目地址 ⇒ 判红', () => {
    // 地址要够长（≥20 字符），否则先被「太短」那条判据拦下，测的就不是主机名判据了。
    const r = checkSupabaseEnv('https://example.com/not-a-supabase-project', GOOD_KEY);
    assert.equal(r.ok, false);
    assert.match(r.problems.join('；'), /supabase\.co/);
  });

  it('连的是**别的** Supabase 项目 ⇒ 判红（连错项目比直接报错更难查）', () => {
    const r = checkSupabaseEnv('https://someone-else-project.supabase.co', GOOD_KEY);
    assert.equal(r.ok, false);
    assert.match(r.problems.join('；'), /本产品/);
  });

  it('项目地址末尾多一个斜杠 ⇒ 仍算同一个项目（别让人为的斜杠卡住发版）', () => {
    const r = checkSupabaseEnv('https://reccclnaxadbuccsrwmg.supabase.co/', GOOD_KEY);
    assert.equal(r.ok, true, r.problems.join('；'));
  });

  it('key 是占位符/掩码（长度不够）⇒ 判红（这正是本次事故的形态）', () => {
    // 真 key 208 字符；被脱敏的值只有 13–55 字符 ⇒ 形态像 JWT 但不可用。
    const r = checkSupabaseEnv('https://reccclnaxadbuccsrwmg.supabase.co', 'eyJxxxxxxxxxxxx');
    assert.equal(r.ok, false);
    assert.match(r.problems.join('；'), /字符/);
  });

  it('key 既不是 JWT 也不是 sb_ 形态 ⇒ 判红', () => {
    const r = checkSupabaseEnv('https://reccclnaxadbuccsrwmg.supabase.co', 'your-anon-key-here');
    assert.equal(r.ok, false);
    assert.match(r.problems.join('；'), /JWT/);
  });

  it('配置齐且形态对 ⇒ 放行', () => {
    const r = checkSupabaseEnv('https://reccclnaxadbuccsrwmg.supabase.co', GOOD_KEY);
    assert.equal(r.ok, true, r.problems.join('；'));
  });

  it('新式 sb_publishable_ 密钥也放行（别把未来的形态锁死）', () => {
    const r = checkSupabaseEnv(
      'https://reccclnaxadbuccsrwmg.supabase.co',
      'sb_publishable_' + 'a'.repeat(43)
    );
    assert.equal(r.ok, true, r.problems.join('；'));
  });
});

describe('闸门判据：产物内联', () => {
  it('产物里没有项目地址 ⇒ 判红（1.32.0 坏包的形态）', () => {
    const r = checkSupabaseConfigInArtifacts(['console.log(1);', 'const u = undefined;']);
    assert.equal(r.ok, false);
    assert.match(r.problems.join('；'), /supabase\.co/);
  });

  it('产物里只有地址没有 key ⇒ 判红', () => {
    const r = checkSupabaseConfigInArtifacts(['const u="https://reccclnaxadbuccsrwmg.supabase.co";']);
    assert.equal(r.ok, false);
    assert.match(r.problems.join('；'), /key/);
  });

  it('产物里是**别的**项目的地址 ⇒ 判红', () => {
    const r = checkSupabaseConfigInArtifacts([
      `const u="https://someone-else-project.supabase.co";const k="${GOOD_KEY}";`,
    ]);
    assert.equal(r.ok, false);
    assert.match(r.problems.join('；'), /本项目/);
  });

  it('产物里地址与 key 都在 ⇒ 放行', () => {
    const r = checkSupabaseConfigInArtifacts([
      `const u="https://reccclnaxadbuccsrwmg.supabase.co";const k="${GOOD_KEY}";`,
    ]);
    assert.equal(r.ok, true, r.problems.join('；'));
  });
});

/**
 * 接线（构建期）：真的用 vite 执行仓库里的 vite.config.ts。
 *
 * ⚠️ 两个坑：
 *  1. 子进程 cwd 必须是**临时目录**：vite.config.ts 里的 `loadEnv(mode, process.cwd())`
 *     会去 cwd 找 .env / .env.local ⇒ 在临时目录里跑 ⇒ 只会看到我们显式给的环境变量
 *     ⇒ 「缺配置」这个前提才是真的（而不是被仓库里那份能用的 .env.local 顶掉）。
 *     而 runner 脚本本身必须放在**仓库内**（node_modules/.cache/ 下）——
 *     放在 /tmp 里的话 `import 'vite'` 解析不到仓库的 node_modules。
 *     ⇒ 先在仓库内落 runner，运行时再 chdir 到临时目录。
 *  2. 环境变量必须**显式给空字符串**，不能靠「不设置」：
 *     vite 6 里 process.env 优先于 .env 文件，留空才等价于「没配」。
 */
describe('接线（构建期）：配置缺失 ⇒ vite.config.ts 真的抛', () => {
  const runConfig = (env: Record<string, string>): { ok: boolean; message: string } => {
    const tmp = mkdtempSync(join(tmpdir(), 'tapstack-vite-cfg-'));
    // runner 放在仓库内（node_modules/.cache/，已被 gitignore），这样 import 'vite' 能解析。
    const runnerDir = join(ROOT, 'node_modules', '.cache', 'tapstack-tests');
    mkdirSync(runnerDir, { recursive: true });
    const runner = join(runnerDir, `vite-cfg-${process.pid}-${Date.now()}.mjs`);
    writeFileSync(
      runner,
      [
        "import { loadConfigFromFile } from 'vite';",
        `process.chdir(${JSON.stringify(tmp)});`,
        'try {',
        `  await loadConfigFromFile({ command: 'build', mode: 'production' }, ${JSON.stringify(
          join(ROOT, 'vite.config.ts'),
        )}, ${JSON.stringify(tmp)});`,
        "  console.log('CONFIG_OK');",
        '} catch (e) {',
        "  console.log('CONFIG_THREW:' + String(e && e.message));",
        '  process.exit(3);',
        '}',
      ].join('\n'),
      'utf8'
    );
    let res: ReturnType<typeof spawnSync>;
    try {
      res = spawnSync(process.execPath, [runner], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          // 清掉可能从父进程继承的 VITE_ 变量，保证「缺配置」是真的缺。
          VITE_SUPABASE_URL: env.VITE_SUPABASE_URL ?? '',
          VITE_SUPABASE_ANON_KEY: env.VITE_SUPABASE_ANON_KEY ?? '',
        },
      });
    } finally {
      rmSync(runner, { force: true });
    }
    return { ok: res.status === 0, message: `${res.stdout ?? ''}${res.stderr ?? ''}` };
  };

  it('缺 Supabase 配置 ⇒ 配置加载就失败（不是「构建出一个残废的包」）', () => {
    const r = runConfig({});
    assert.equal(r.ok, false, '缺配置时 vite.config.ts 必须抛错');
    assert.match(r.message, /CONFIG_THREW/);
    assert.match(r.message, /Supabase 配置缺失/);
  });

  it('配置齐 ⇒ 配置加载成功（闸门不能把正常构建也拦了）', () => {
    const r = runConfig({
      VITE_SUPABASE_URL: 'https://reccclnaxadbuccsrwmg.supabase.co',
      VITE_SUPABASE_ANON_KEY: GOOD_KEY,
    });
    assert.equal(r.ok, true, `配置齐时不该失败：${r.message}`);
    assert.match(r.message, /CONFIG_OK/);
  });
});

/**
 * 接线（打包期）：真的在临时目录里跑 package-extension.js。
 *
 * ⚠️ 临时目录里放的是**本仓库的脚本副本**（不是重写的假脚本）——
 *   否则测的就是假脚本，闸门摘没摘都测不出来。
 */
describe('接线（打包期）：产物里没有 Supabase 配置 ⇒ 拒绝出包', () => {
  const runPackaging = (artifactJs: string): { status: number | null; output: string; zipExists: boolean } => {
    const tmp = mkdtempSync(join(tmpdir(), 'tapstack-pkg-'));
    copyFileSync(join(ROOT, 'package-extension.js'), join(tmp, 'package-extension.js'));
    mkdirSync(join(tmp, 'scripts', 'lib'), { recursive: true });
    copyFileSync(
      join(ROOT, 'scripts', 'lib', 'supabaseBuildGate.mjs'),
      join(tmp, 'scripts', 'lib', 'supabaseBuildGate.mjs')
    );
    mkdirSync(join(tmp, 'dist'), { recursive: true });
    writeFileSync(join(tmp, 'dist', 'manifest.json'), '{"name":"x","version":"1.0.0"}', 'utf8');
    writeFileSync(join(tmp, 'dist', 'index.js'), artifactJs, 'utf8');
    const res = spawnSync(process.execPath, ['package-extension.js'], { cwd: tmp, encoding: 'utf8' });
    return {
      status: res.status,
      output: `${res.stdout ?? ''}${res.stderr ?? ''}`,
      zipExists: existsSync(join(tmp, 'chrome-extension.zip')),
    };
  };

  it('产物里没有 Supabase 配置 ⇒ 退出码非 0 且不产出 zip', () => {
    const r = runPackaging('const u = undefined; const k = undefined;');
    assert.notEqual(r.status, 0, '坏产物必须让打包失败');
    assert.match(r.output, /拒绝出包/);
    assert.equal(r.zipExists, false, '失败时不该留下一个能上传的 zip');
  });

  it('产物里有 Supabase 配置 ⇒ 正常出包', () => {
    const r = runPackaging(
      `const u="https://reccclnaxadbuccsrwmg.supabase.co";const k="${GOOD_KEY}";`
    );
    assert.equal(r.status, 0, `好产物不该打包失败：${r.output}`);
    assert.match(r.output, /已内联 Supabase 配置/);
    assert.equal(r.zipExists, true);
  });
});
