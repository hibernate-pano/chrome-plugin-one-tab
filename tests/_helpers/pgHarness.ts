// 真 Postgres 门禁的共用起停器（非 *.test.ts，不被 pnpm test 收集）。
//
// 两份真库门禁（tests/opStampGuard.pg.test.ts、tests/guards/migrationReplay.pg.test.ts）
// 之前各自内联了一份 initdb/pg_ctl/psql 调用。三件事必须收口到一处：
//
// 1. **locale 环境**：Homebrew PostgreSQL 16.15 在 LC_ALL 为空/未设时**起不来**，
//    而报错只写在 pg.log 里、pg_ctl 自己只说「无法启动服务器进程」：
//        FATAL: postmaster became multithreaded during startup
//        HINT:  Set the LC_ALL environment variable to a valid locale.
//    测试子进程继承宿主环境，Cindy/CI 这类 LC_ALL 为空的环境里必挂。
//    实测（2026-10-08，PG 16.15 / aarch64-apple-darwin25）：
//      LC_ALL/LANG 全无 → 起不来；LC_ALL= LANG= → 起不来；LC_ALL=C → 正常（LANG=C 单独也行）。
//    所以**所有**起 PG 的子进程都必须显式带上 LC_ALL+LANG，不能靠宿主环境。
//    反向验证时要**两个键一起**去掉：LC_ALL=C 单独够用、LANG=C 单独也够用，
//    只去掉一个会变绿，那不是修复失效，而是另一个键补位。
//
// 2. **假绿**：起不来时如果从 node:test 的 before hook 抛出，整组用例会被标成
//    `cancelled` 而不是 `fail` —— 报告里 "fail 0" 看起来一切正常，门禁等于没有。
//    本起停器**只抛错、不吞错**，由调用方在每个用例里 assert.fail（见 gate() 惯例），
//    保证「库起不来」一定是红的。SKIP_REASON 只留给「二进制根本不存在」。
//
// 3. **端口/套接字占用**：启动前探测端口，被占用就换一个（最多连续 20 个），
//    全占满则显式失败并列出原因 —— 不允许静默 skip，也不允许留一个看不出原因的
//    pg_ctl 报错。
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 起 PG 的子进程必须带的环境。
 * 注意这是**替换**整个 env（不是合并覆盖单键），所以 spread process.env 在前。
 */
export const PG_ENV: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C', LANG: 'C' };

export function findBinary(name: string): string | null {
  try {
    return execFileSync('which', [name], { encoding: 'utf8', env: PG_ENV }).trim() || null;
  } catch {
    return null;
  }
}

export const PG_BINS = {
  initdb: findBinary('initdb'),
  pg_ctl: findBinary('pg_ctl'),
  psql: findBinary('psql'),
};

/**
 * SKIP_REASON 唯一允许出现的情形：二进制根本不存在。
 * 「装了二进制但库起不来」必须走显式失败，不能伪装成 skip/cancelled。
 */
export const PG_BINARIES_PRESENT = Boolean(PG_BINS.initdb && PG_BINS.pg_ctl && PG_BINS.psql);

export const PG_MISSING_BINARIES_REASON =
  '未找到 initdb/pg_ctl/psql（二进制不存在），跳过真实 Postgres 用例，SQL 文本护栏仍会执行';

/** 首选端口被占时向后探测的窗口大小。 */
const PORT_SCAN_SPAN = 20;

function errText(e: unknown): string {
  const err = e as { stderr?: unknown; message?: string };
  const parts: string[] = [];
  const stderr = err.stderr ? String(err.stderr).trim() : '';
  if (stderr) parts.push(stderr);
  if (err.message) parts.push(err.message);
  return parts.join('\n') || String(e);
}

/** pg.log 尾部：pg_ctl 的 stdout 只有一句「无法启动服务器进程」，真正的原因在这里。 */
export function pgLogTail(logPath: string, lines = 40): string {
  if (!existsSync(logPath)) return '(pg.log 不存在 —— pg_ctl 在写日志之前就失败了)';
  const text = readFileSync(logPath, 'utf8').trimEnd();
  if (!text) return '(pg.log 为空)';
  return text.split('\n').slice(-lines).join('\n');
}

/** 端口能否 bind（127.0.0.1）。占用 ⇒ false。 */
function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer();
    probe.once('error', () => done(false));
    probe.once('listening', () => probe.close(() => done(true)));
    probe.listen(port, '127.0.0.1');
  });
}

/**
 * 从 preferredPort 起找一个空闲端口；连续 PORT_SCAN_SPAN 个都占用 ⇒ 显式失败并列出。
 * 之所以还要探测：门禁用 `-c listen_addresses=`（不监听 TCP）+ 每进程独立的 mkdtemp
 * 套接字目录，端口本不会撞车；但只要有人改成共享套接字目录或打开 TCP 监听，
 * 撞车必须显式换端口/报错，而不是留一个看不出原因的 pg_ctl 失败。
 */
async function pickFreePort(preferred: number): Promise<number> {
  const busy: number[] = [];
  for (let port = preferred; port < preferred + PORT_SCAN_SPAN; port += 1) {
    if (await portFree(port)) return port;
    busy.push(port);
  }
  throw new Error(
    `端口 ${preferred} 起连续 ${PORT_SCAN_SPAN} 个全部被占用（${busy.join(', ')}）：` +
      '没有可用端口可给真库门禁，请先释放占用者或改用别的首选端口'
  );
}

export interface RunningPg {
  readonly workDir: string;
  readonly dataDir: string;
  readonly socketDir: string;
  readonly logPath: string;
  readonly port: number;
  /** -tA 单行查询（返回值已 trim）。 */
  psql(sql: string): string;
  /** 用 psql -f 跑一个迁移文件；默认 ON_ERROR_STOP=1（失败即抛，绝不静默吞）。 */
  psqlFile(file: string, extraArgs?: string[]): void;
  /** 同 psqlFile，但显式指定目标库（golden 比对要重放到第二个全新空库上）。 */
  psqlFileOn(database: string, file: string, extraArgs?: string[]): void;
  /** 同 psql，但显式指定目标库。 */
  psqlOn(database: string, sql: string): string;
  /** 停库 + 删临时目录；幂等，可重复调用。 */
  stop(): void;
}

export interface StartPostgresOptions {
  /** 出错信息里的门禁名（方便一眼看出是哪份门禁挂了）。 */
  label: string;
  /** 首选端口；两份门禁取不同值，互不冲突。 */
  preferredPort: number;
  /** mkdtemp 前缀。 */
  filePrefix?: string;
}

/**
 * 起一个一次性真 Postgres。任何一步失败都抛带 pg.log 尾部的 Error —— **不返回 null、
 * 不 skip**。调用方要么拿到可用实例，要么把失败变成用例失败。
 */
export async function startPostgres(opts: StartPostgresOptions): Promise<RunningPg> {
  if (!PG_BINS.initdb || !PG_BINS.pg_ctl || !PG_BINS.psql) {
    throw new Error(`Postgres 二进制缺失：${PG_MISSING_BINARIES_REASON}`);
  }

  const workDir = mkdtempSync(join(tmpdir(), opts.filePrefix ?? 'tapstack-pg-'));
  const dataDir = join(workDir, 'data');
  const socketDir = join(workDir, 'sock');
  const logPath = join(workDir, 'pg.log');
  mkdirSync(socketDir);
  let port = opts.preferredPort;

  try {
    port = await pickFreePort(opts.preferredPort);

    execFileSync(
      PG_BINS.initdb,
      ['-D', dataDir, '-U', 'postgres', '--auth=trust', '--encoding=UTF8', '--locale=C'],
      { env: PG_ENV, stdio: 'pipe', encoding: 'utf8' }
    );

    execFileSync(
      PG_BINS.pg_ctl,
      [
        '-D', dataDir,
        '-w',
        '-o', `-k ${socketDir} -c listen_addresses= -p ${port}`,
        '-l', logPath,
        'start',
      ],
      { env: PG_ENV, stdio: 'pipe', encoding: 'utf8' }
    );

    // pg_ctl -w 只等「进程活着」；再用 psql 真连一次，才算「库起来了」。
    execFileSync(
      PG_BINS.psql,
      ['-h', socketDir, '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-tA', '-c', 'select 1'],
      { env: PG_ENV, stdio: 'pipe', encoding: 'utf8' }
    );
  } catch (e) {
    const tail = pgLogTail(logPath);
    try {
      if (PG_BINS.pg_ctl && existsSync(dataDir)) {
        execFileSync(PG_BINS.pg_ctl, ['-D', dataDir, '-m', 'immediate', 'stop'], {
          env: PG_ENV,
          stdio: 'pipe',
        });
      }
    } catch {
      /* 停不掉也照报原始失败，不互相掩盖 */
    }
    rmSync(workDir, { recursive: true, force: true });
    throw new Error(
      `${opts.label} 的 Postgres 启动失败（端口 ${port}，套接字 ${socketDir}）：\n` +
        `${errText(e)}\n--- pg.log 尾部 ---\n${tail}`
    );
  }

  let stopped = false;
  const run = (args: string[]): string =>
    execFileSync(PG_BINS.psql as string, args, { env: PG_ENV, stdio: 'pipe', encoding: 'utf8' });

  // psql 的公共参数段（目标库在方法之间共享，抽成局部函数而不是对象方法互调：
  // 对象字面量里的 `psqlFileOn(...)` 裸标识符调用不在作用域内，会 ReferenceError）。
  const connArgs = (database: string): string[] => [
    '-h', socketDir,
    '-p', String(port),
    '-U', 'postgres',
    '-d', database,
  ];
  const psqlFileOn = (database: string, file: string, extraArgs: string[] = []): void => {
    run([
      ...connArgs(database),
      '-q',
      '-v', 'ON_ERROR_STOP=1',
      ...extraArgs,
      '-f', file,
    ]);
  };

  return {
    workDir,
    dataDir,
    socketDir,
    logPath,
    port,
    psql(sql: string): string {
      return run([...connArgs('postgres'), '-tA', '-c', sql]).trim();
    },
    psqlFile(file: string, extraArgs: string[] = []): void {
      psqlFileOn('postgres', file, extraArgs);
    },
    psqlFileOn,
    psqlOn(database: string, sql: string): string {
      return run([...connArgs(database), '-tA', '-c', sql]).trim();
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      try {
        execFileSync(PG_BINS.pg_ctl as string, ['-D', dataDir, '-m', 'immediate', 'stop'], {
          env: PG_ENV,
          stdio: 'pipe',
        });
      } catch {
        /* 关不掉不该盖住测试结论；临时目录照删 */
      }
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}
