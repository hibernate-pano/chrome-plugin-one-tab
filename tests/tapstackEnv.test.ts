/**
 * 扩展构建配置的读取入口（2026-11-23）。
 *
 * ── 这个文件防的是哪次事故 ────────────────────────────────────────────────
 *
 * 1.32.0 上架后**所有用户登录都报**「Supabase 配置缺失」。根因链：
 *   `vercel link` 覆盖 `.env.local` → vite 对**缺失的 env 静默放行** →
 *   产物里没有 Supabase 配置 → 打包脚本也不看产物 → 坏包一路到商店公开页。
 *
 * ⇒ 根因不是 vite 的 bug，是**同一个文件被两个用途共享**
 *   （扩展的构建配置 vs vercel 的部署配置）。
 * ⇒ 修法不是「加个检查」（那只是把症状从「悄悄出坏包」变成「构建红」），
 *   而是**把两件事物理分开**：扩展的配置搬到仓库之外，vercel 碰不到它。
 *
 * ── 这里的用例分成两层 ────────────────────────────────────────────────────
 *
 * ① **判据层**：纯函数（解析、选路径、注入）的逐条断言。
 * ② **接线层**：真的用 vite 执行仓库里的 vite.config.ts ⇒ 断言「被 vercel
 *    覆盖的 .env.local 不再影响构建，且内联进产物的值来自新配置文件」。
 *
 * ⚠️ 接线层必须**显式**指定 TAPSTACK_ENV_FILE：不指定就会回落到
 *    `~/.config/tapstack/env` ⇒ 用例结果取决于**开发机**（别人机器恒红、
 *    本机恒绿）⇒ 那样的守卫等于没有。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseEnvText,
  resolveTapstackEnvPath,
  loadTapstackEnv,
  injectViteEnv,
  warnAboutStaleRepoEnv,
  ENV_FILE_VAR,
  DEFAULT_ENV_DISPLAY_PATH,
} from '../scripts/lib/tapstackEnv.mjs';
import { loadEnv as loadE2eEnv } from '../scripts/e2e-support.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PROJECT_URL = 'https://reccclnaxadbuccsrwmg.supabase.co';
/** 形态合法的桩 key（真 key 是 208 字符的 JWT）。 */
const GOOD_KEY = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxOTAwMDAwMDAwfQ.ciBuildOnlyDummySignatureNotARealKey_0000000000000000000000000';

describe('判据：解析 KEY=VALUE 文本', () => {
  it('普通赋值', () => {
    const { values, problems } = parseEnvText('VITE_SUPABASE_URL=https://x.supabase.co\n');
    assert.deepEqual(problems, []);
    assert.equal(values.VITE_SUPABASE_URL, 'https://x.supabase.co');
  });

  it('注释行与空行被忽略', () => {
    const { values, problems } = parseEnvText('# 一条注释\n\n   \nA=1\n');
    assert.deepEqual(problems, []);
    assert.equal(values.A, '1');
  });

  it('外层引号被去掉', () => {
    assert.equal(parseEnvText('A="x"\n').values.A, 'x');
    assert.equal(parseEnvText("B='y'\n").values.B, 'y');
  });

  it('export 前缀被去掉', () => {
    assert.equal(parseEnvText('export C=3\n').values.C, '3');
  });

  it('值里可以含 =（只在第一个 = 处切分）', () => {
    assert.equal(parseEnvText('D=a=b=c\n').values.D, 'a=b=c');
  });

  it('坏行（压根没有 =）⇒ 记成 problem（不能静默忽略：拼错的配置行看着像生效了）', () => {
    const { problems } = parseEnvText('这不是赋值行\n');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /KEY=VALUE/);
  });

  it('键名不合法 ⇒ 记成 problem', () => {
    const { problems } = parseEnvText('1BAD=x\n');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /键名/);
  });
});

describe('判据：配置文件路径', () => {
  it('默认是 ~/.config/tapstack/env', () => {
    const r = resolveTapstackEnvPath({ env: {}, homedir: '/home/tester' });
    assert.equal(r.path, '/home/tester/.config/tapstack/env');
    assert.equal(r.origin, 'default');
    assert.equal(r.display, DEFAULT_ENV_DISPLAY_PATH);
  });

  it(`${ENV_FILE_VAR} 优先（CI / 多台机器各指各的）`, () => {
    const r = resolveTapstackEnvPath({ env: { [ENV_FILE_VAR]: '/tmp/x.env' }, homedir: '/home/tester' });
    assert.equal(r.path, '/tmp/x.env');
    assert.equal(r.origin, 'explicit');
  });

  it('相对路径相对 cwd（不是相对 home）', () => {
    const r = resolveTapstackEnvPath({ env: { [ENV_FILE_VAR]: 'cfg.env' }, cwd: '/work' });
    assert.equal(r.path, '/work/cfg.env');
  });
});

describe('判据：读取配置文件', () => {
  it('文件不存在 ⇒ 失败，且报错写清路径（人要知道去哪儿放）', () => {
    const r = loadTapstackEnv({
      env: { [ENV_FILE_VAR]: '/definitely/not/here.env' },
      homedir: '/home/tester',
    });
    assert.equal(r.ok, false);
    assert.match(r.problems.join('；'), /文件不存在/);
    assert.match(r.problems.join('；'), /\/definitely\/not\/here\.env/);
  });

  it('文件里有坏行 ⇒ 失败（不静默丢弃那一行）', () => {
    const r = loadTapstackEnv({
      env: { [ENV_FILE_VAR]: '/tmp/whatever.env' },
      homedir: '/home/tester',
      readFile: () => 'VITE_SUPABASE_URL=x\n这一行坏了\n',
    });
    assert.equal(r.ok, false);
    assert.match(r.problems.join('；'), /KEY=VALUE/);
  });

  it('读得到 ⇒ 返回键值', () => {
    const r = loadTapstackEnv({
      env: { [ENV_FILE_VAR]: '/tmp/whatever.env' },
      homedir: '/home/tester',
      readFile: () => `VITE_SUPABASE_URL=${PROJECT_URL}\nVITE_SUPABASE_ANON_KEY=${GOOD_KEY}\n`,
    });
    assert.equal(r.ok, true);
    assert.equal(r.values.VITE_SUPABASE_URL, PROJECT_URL);
    assert.equal(r.values.VITE_SUPABASE_ANON_KEY, GOOD_KEY);
  });
});

describe('判据：注入 process.env', () => {
  it('只注入 VITE_ 前缀的键', () => {
    const target: Record<string, string> = {};
    const { injected, ignored } = injectViteEnv({ VITE_A: '1', WEBDAV_PASS: 'x' }, target);
    assert.deepEqual(injected, ['VITE_A']);
    assert.deepEqual(ignored, ['WEBDAV_PASS']);
    assert.equal(target.VITE_A, '1');
    assert.equal(target.WEBDAV_PASS, undefined, '非 VITE_ 的键不该进 process.env');
  });
});

describe('判据：仓库根 .env.local 里还留着 VITE_SUPABASE_* ⇒ 提示它是失效的旧配置', () => {
  const warningsFor = (content: string | null) =>
    warnAboutStaleRepoEnv({
      cwd: '/tmp',
      fileExists: () => content !== null,
      readFile: () => content ?? '',
    });

  it('里面有 VITE_SUPABASE_* 键 ⇒ 给出提示（改了它却不生效，只会误导排查）', () => {
    const warnings = warningsFor('VITE_SUPABASE_URL=https://x.supabase.co\n');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /不再生效/);
    assert.match(warnings[0], /VITE_SUPABASE_URL/);
  });

  it('里面只有**别的** VITE_ 键 ⇒ 不提示（那些键照样进产物，喊「不再生效」是骗人）', () => {
    // 2026-11-23 修正：先前的实现对**任意** VITE_ 键都喊「已经不再生效」，
    // 但 vite 自己读 .env / .env.local，其余 VITE_ 键照常进产物 ⇒ 说法是假的，
    // 「建议删掉这几行」也误导（删了不会有任何变化）。
    assert.deepEqual(warningsFor('VITE_SOMETHING_ELSE=1\n'), []);
    assert.deepEqual(warningsFor('VITE_APP_NAME=TapStack\n'), []);
  });

  it('里面没有 VITE_ 键 ⇒ 不提示', () => {
    assert.deepEqual(warningsFor('VERCEL_OIDC_TOKEN=xxx\n'), []);
  });

  it('文件不存在 ⇒ 不提示（那才是正常状态）', () => {
    assert.deepEqual(warningsFor(null), []);
  });
});

/**
 * 接线层：真的用 vite 执行仓库里的 vite.config.ts。
 *
 * 关键断言：**被 `vercel link` 覆盖掉的 .env.local 不再影响构建**，
 * 且 vite 会内联进产物的值来自新配置文件 —— 这正是这次修复要保住的性质。
 */
describe('接线：.env.local 被覆盖 ⇒ 构建不受影响，且内联的是新配置', () => {
  const runViteConfig = ({
    envFileContent,
    repoEnvLocalContent,
    useDefaultPath = false,
    homeDir,
  }: {
    envFileContent: string | null;
    repoEnvLocalContent: string | null;
    /** true = 不设 TAPSTACK_ENV_FILE，走默认路径（~/.config/tapstack/env，HOME 决定） */
    useDefaultPath?: boolean;
    homeDir?: string;
  }): { ok: boolean; message: string; inlinedUrl: string } => {
    const tmp = mkdtempSync(join(tmpdir(), 'tapstack-env-'));
    const envFile = join(tmp, 'tapstack.env');
    if (envFileContent !== null) writeFileSync(envFile, envFileContent, 'utf8');
    if (repoEnvLocalContent !== null) {
      writeFileSync(join(tmp, '.env.local'), repoEnvLocalContent, 'utf8');
    }

    // runner 放在仓库内（node_modules/.cache/，已被 gitignore），这样 import 'vite' 能解析。
    const runnerDir = join(ROOT, 'node_modules', '.cache', 'tapstack-tests');
    mkdirSync(runnerDir, { recursive: true });
    const runner = join(runnerDir, `vite-env-${process.pid}-${Date.now()}.mjs`);
    writeFileSync(
      runner,
      [
        "import { loadConfigFromFile, loadEnv } from 'vite';",
        `process.chdir(${JSON.stringify(tmp)});`,
        'try {',
        `  await loadConfigFromFile({ command: 'build', mode: 'production' }, ${JSON.stringify(
          join(ROOT, 'vite.config.ts'),
        )}, ${JSON.stringify(tmp)});`,
        // vite 会把哪个值内联进产物？＝ loadEnv 的结果（文件先、process.env 后）。
        "  const env = loadEnv('production', process.cwd());",
        "  console.log('CONFIG_OK:' + (env.VITE_SUPABASE_URL ?? ''));",
        '} catch (e) {',
        "  console.log('CONFIG_THREW:' + String(e && e.message));",
        '  process.exit(3);',
        '}',
      ].join('\n'),
      'utf8'
    );

    const childEnv: Record<string, string> = { ...process.env } as Record<string, string>;
    delete childEnv[ENV_FILE_VAR];
    if (useDefaultPath) {
      // 默认路径由 HOME 决定（node 的 os.homedir() 在 POSIX 上读 $HOME）
      // ⇒ 用临时 HOME ⇒ 结果与开发机上的 ~/.config/tapstack/env 无关。
      if (homeDir) childEnv.HOME = homeDir;
    } else {
      childEnv[ENV_FILE_VAR] = envFile;
    }
    childEnv.VITE_SUPABASE_URL = '';
    childEnv.VITE_SUPABASE_ANON_KEY = '';

    let res: ReturnType<typeof spawnSync>;
    try {
      res = spawnSync(process.execPath, [runner], {
        cwd: ROOT,
        encoding: 'utf8',
        env: childEnv,
      });
    } finally {
      rmSync(runner, { force: true });
      rmSync(tmp, { recursive: true, force: true });
    }

    const message = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    const inlined = message.match(/CONFIG_OK:(\S*)/);
    return { ok: res.status === 0, message, inlinedUrl: inlined ? inlined[1] : '' };
  };

  it('仓库根 .env.local 被 vercel 覆盖（只剩 VERCEL_*）⇒ 构建照常成功', () => {
    const r = runViteConfig({
      envFileContent: `VITE_SUPABASE_URL=${PROJECT_URL}\nVITE_SUPABASE_ANON_KEY=${GOOD_KEY}\n`,
      repoEnvLocalContent:
        '# 这个文件是 vercel link 的地盘\nVERCEL_OIDC_TOKEN=whatever\nVERCEL=1\n',
    });
    assert.equal(r.ok, true, `不该失败：${r.message}`);
    assert.match(r.message, /CONFIG_OK/);
  });

  it('仓库根 .env.local 里有一份**错的**旧配置 ⇒ 内联进产物的仍是新配置文件里的值', () => {
    // 这条是**判别力**所在：.env.local 里放「连的是别的项目」的地址 ——
    // 若构建读了它，闸门会直接红（连的不是本产品）；若构建读新配置文件，就该绿，
    // 且内联进产物的必须是新配置文件里的地址。
    const r = runViteConfig({
      envFileContent: `VITE_SUPABASE_URL=${PROJECT_URL}\nVITE_SUPABASE_ANON_KEY=${GOOD_KEY}\n`,
      repoEnvLocalContent:
        `VITE_SUPABASE_URL=https://someone-else-project.supabase.co\nVITE_SUPABASE_ANON_KEY=${GOOD_KEY}\n`,
    });
    assert.equal(r.ok, true, `不该失败：${r.message}`);
    assert.equal(r.inlinedUrl, PROJECT_URL, '内联进产物的必须是新配置文件里的地址');
  });

  it('配置文件不存在 ⇒ 构建失败，且报错写清去哪放', () => {
    const r = runViteConfig({ envFileContent: null, repoEnvLocalContent: null });
    assert.equal(r.ok, false, '读不到配置必须构建失败');
    assert.match(r.message, /CONFIG_THREW/);
    assert.match(r.message, /tapstack\.env/);
  });

  it('配置文件里没有 Supabase 配置 ⇒ 构建失败（不能「有半个就当配好了」）', () => {
    const r = runViteConfig({
      envFileContent: 'VITE_APP_NAME=TapStack\n',
      repoEnvLocalContent: null,
    });
    assert.equal(r.ok, false, '缺 Supabase 配置必须构建失败');
    assert.match(r.message, /Supabase 配置缺失/);
  });

  it('不设 TAPSTACK_ENV_FILE ⇒ 从默认路径（~/.config/tapstack/env）读', () => {
    // 默认路径这条也要**真的跑一遍**：否则「默认路径被改回 .env.local」这种变异
    // 只有单元测试能发现 —— 而单元测试证明不了「构建真的读了它」。
    // HOME 指向临时目录 ⇒ 与开发机上的真实配置无关（node 的 os.homedir() 读 $HOME）。
    const home = mkdtempSync(join(tmpdir(), 'tapstack-home-'));
    try {
      mkdirSync(join(home, '.config', 'tapstack'), { recursive: true });
      writeFileSync(
        join(home, '.config', 'tapstack', 'env'),
        `VITE_SUPABASE_URL=${PROJECT_URL}\nVITE_SUPABASE_ANON_KEY=${GOOD_KEY}\n`,
        'utf8'
      );
      const r = runViteConfig({
        envFileContent: null,
        repoEnvLocalContent: null,
        useDefaultPath: true,
        homeDir: home,
      });
      assert.equal(r.ok, true, `默认路径读不到时不该失败：${r.message}`);
      assert.equal(r.inlinedUrl, PROJECT_URL);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/**
 * 跨路径一致性：构建与 e2e 必须读到**同一个值**。
 *
 * ── 为什么要有这一层 ──────────────────────────────────────────────────────
 *
 * 2026-11-23 复查发现：构建路径（`vite.config.ts`）与 e2e 路径
 * （`scripts/e2e-support.mjs`）的优先级**是相反的** ⇒
 * 开发者在 shell 里 `export VITE_SUPABASE_URL=…` 之后，
 * 扩展连文件里的项目、e2e 连 export 的项目 ⇒
 * **e2e 验的不是要发的东西**（而 e2e 是发版前唯一的端到端验证）。
 *
 * ⇒ 这一层直接断言「同一个配置文件 + 同一个 process.env ⇒ 两条路径给同一个值」。
 * 它比两条路径各自的用例更强：任何一边改了优先级，这条立刻红。
 */
describe('跨路径：构建与 e2e 读到同一个值', () => {
  const readBoth = (
    configText: string,
    processEnv: Record<string, string>,
    repoFiles: Record<string, string> = {},
  ) => {
    const dir = mkdtempSync(join(tmpdir(), 'tapstack-cross-'));
    const repoDir = mkdtempSync(join(tmpdir(), 'tapstack-cross-repo-'));
    try {
      const configFile = join(dir, 'tapstack.env');
      writeFileSync(configFile, configText, 'utf8');
      for (const [name, body] of Object.entries(repoFiles)) {
        writeFileSync(join(repoDir, name), body, 'utf8');
      }

      // 构建侧：读文件 → 注入 process.env（注入即覆盖）。
      // ⚠️ 必须用 TAPSTACK_ENV_FILE 指过去：否则会回落到 homedir 下的默认路径，
      //    读不到文件 ⇒ 拿到的 values 是空的 ⇒ 这条用例会假红。
      const build = loadTapstackEnv({
        env: { ...processEnv, [ENV_FILE_VAR]: configFile },
      });
      assert.equal(build.ok, true, `构建侧应读得到配置：${build.problems.join('；')}`);
      const injected: Record<string, string> = { ...processEnv };
      injectViteEnv(build.values, injected);

      // e2e 侧：同份文件、同一份 process.env。
      const e2e = loadE2eEnv({
        cwd: repoDir,
        processEnv: { ...processEnv },
        configFile,
      }) as Record<string, string | undefined>;

      return { build: injected.VITE_SUPABASE_URL, e2e: e2e.VITE_SUPABASE_URL };
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  };

  it('shell 里有 VITE_SUPABASE_URL ⇒ 两条路径给同一个值', () => {
    // 这条在修复前会失败：构建给文件里的值、e2e 给 shell 的值。
    const { build, e2e } = readBoth(
      `VITE_SUPABASE_URL=${PROJECT_URL}\n`,
      { VITE_SUPABASE_URL: 'https://from-shell.supabase.co' },
    );
    assert.equal(build, PROJECT_URL, '构建应以仓库外配置为准');
    assert.equal(e2e, build, 'e2e 必须与构建看到同一个值');
  });

  it('仓库里有一份旧副本 ⇒ 两条路径都压过它', () => {
    const { build, e2e } = readBoth(
      `VITE_SUPABASE_URL=${PROJECT_URL}\n`,
      {},
      { '.env.local': 'VITE_SUPABASE_URL=https://stale-in-repo.supabase.co\n' },
    );
    assert.equal(build, PROJECT_URL);
    assert.equal(e2e, build, 'e2e 必须与构建看到同一个值');
  });

  it('export 前缀的文件 ⇒ 两条路径都能读出来', () => {
    // 修复前 e2e 的解析器不认 export 前缀 ⇒ 它拿到 undefined，
    // 然后报「请把变量放到 ~/.config/tapstack/env」——用户明明已经放了。
    const { build, e2e } = readBoth(
      `export VITE_SUPABASE_URL=${PROJECT_URL}\n`,
      {},
    );
    assert.equal(build, PROJECT_URL);
    assert.equal(e2e, PROJECT_URL, 'export 前缀在 e2e 侧也必须认得');
  });
});
