// .github/workflows/verify.yml 的结构回归测试。
//
// 为什么需要它：这个仓库的 CI 只在 GitHub 上跑，本地永远看不到它，所以配置本身需要被守。
//
// 2026-10-16 云端后端下线后，本文件守护的对象变了。过去它盯着「有没有真的装上 Postgres、
// 装了之后有没有验证装上了」——因为 tests/opStampGuard.pg.test.ts 在缺 initdb/pg_ctl/psql
// 时会整组静默 skip（该文件头部写明这块历史上出过两次事故）。那些 .pg.test.ts 连同
// supabase/migrations 已全部删除，于是同一条纪律反过来守：**CI 不装 Postgres，且
// 「没有 PG 测试」这件事本身必须是真的**——否则会重演「缺失 ⇒ 静默 skip ⇒ 全绿里一片空洞」。
//
// 同时把两条纪律钉死：e2e 不进 CI（要 headed Chrome + 真实凭据/云盘 + 写线上数据），
// 审计必须显式指定 npmjs registry（默认 npmmirror 没有 audit 端点，直接跑必失败）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = join(ROOT, '.github/workflows/verify.yml');
const TESTS_DIR = join(ROOT, 'tests');

const yaml = existsSync(WORKFLOW) ? readFileSync(WORKFLOW, 'utf8') : '';
// 结构断言必须只看真正生效的 YAML：注释里也会出现「initdb」「pnpm e2e」这些词，
// 拿注释当配置来断言，等于给自己写一份会骗人的测试。
const live = yaml
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');
/** 按 `- name:` / `- uses:` 切出来的步骤片段 */
const steps = live.split(/\n {6}- (?:name|uses):/);

/**
 * 递归列出 dir 下文件名以 suffix 结尾的文件（返回相对仓库根的路径）。
 *
 * 【为什么必须是递归的】下方「没有 PG 集成测试」的对照用例此前用
 * `readdirSync(TESTS_DIR).filter(...)` —— 只看顶层，对 tests/guards/*.pg.test.ts
 * 完全失明，而删掉的 tests/guards/migrationReplay.pg.test.ts 恰好就住在那里。
 * 实测：touch tests/guards/mut-probe.pg.test.ts 时旧实现照绿；
 * touch tests/mut-probe.pg.test.ts 时才红。对照用例守着的东西不能在子目录里隐身。
 */
function findTestsBySuffix(dir: string, suffix: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findTestsBySuffix(full, suffix));
    } else if (entry.name.endsWith(suffix)) {
      out.push(full.slice(ROOT.length + 1));
    }
  }
  return out.sort();
}

describe('CI: verify.yml 存在且能被触发', () => {
  it('工作流文件存在（想跑门禁时得有个入口）', () => {
    assert.ok(existsSync(WORKFLOW), '.github/workflows/verify.yml 不存在');
  });

  it('保留手动触发与 PR 两个入口', () => {
    // 2026-10-06 起触发器从 `push: branches:[main]` 降级为手动（pull_request +
    // workflow_dispatch）。理由：这个仓库远端只有 main 一个分支、近 20 个提交
    // 全部同一作者、历史 8 个 PR 都是自己开自己合 ⇒ 「PR 评审」这个 CI 原本
    // 最有用的场景从未发生过；剩下唯一作用是「每次 push 替我跑一遍」，
    // 而本机 pnpm test + pnpm validate 更快更直接。
    //
    // 但 workflow_dispatch 必须留着：它记录了「发布前该跑哪四道门」这份清单，
    // 删掉文件等于连清单一起丢。想跑时：gh workflow run verify.yml
    assert.match(live, /workflow_dispatch:/);
    assert.match(live, /pull_request:/);
  });

  it('不再有 push 自动触发（否则每次推送都要等一遍 CI）', () => {
    // 这条是「降级」这个决定本身的守卫：将来若有人把 push 触发器加回来，
    // 应当是深思熟虑后的选择，而不是顺手复制粘贴。
    assert.doesNotMatch(
      live,
      /^\s*push:\s*$/m,
      'push 触发器已按 2026-10-06 的决定移除；若要恢复请一并更新本用例的说明'
    );
  });
});

describe('CI: Postgres 已随云端后端退场（不得留下无人服务的安装段）', () => {
  it('不再安装 Postgres 16', () => {
    // 2026-10-16：opStampGuard.pg.test.ts / migrationReplay.pg.test.ts / migration*.test.ts
    // 这些真库集成测试随 supabase/migrations 一并删除，PG 安装段失去被服务对象。
    // 留着它等于每次 CI 白等 30s 装一个没人用的数据库。
    assert.ok(
      !/apt-get install/.test(live),
      'CI 里已经没有 PG 集成测试了，不该再装 Postgres；若确实要恢复，请连下面那条对照用例一起改'
    );
  });

  it('「CI 不装 PG」与「没有 PG 集成测试」必须同时成立（非空洞判据）', () => {
    // 这条是上一条的对照组。单看「YAML 里没有 apt-get」是**空洞**的：重演
    // 「PG 缺失 ⇒ 整组静默 skip ⇒ 一片全绿里一片空洞」只需要有人把 .pg.test.ts
    // 加回来，而 YAML 那边看不出来。所以这里直接扫测试目录——一旦 PG 测试复活，
    // 本用例立即变红，逼后来者把安装段与 initdb/pg_ctl/psql 探针一起加回去。
    // 2026-10-16：非递归 readdir 让这条判据对 tests/guards/*.pg.test.ts 失明
    // （而删掉的那批 PG 测试恰好都在子目录）——改成递归收集全树。
    const pgTests = findTestsBySuffix(TESTS_DIR, '.pg.test.ts');
    assert.deepEqual(
      pgTests,
      [],
      `发现 PG 集成测试：${pgTests.join('、')} —— 必须同时把 verify.yml 的 postgresql-16 ` +
        '安装段与 initdb/pg_ctl/psql 探针加回来，否则它们会静默 skip 而 CI 全绿'
    );
  });
});

describe('CI: 跑齐开发机的四道门', () => {
  it('装依赖用 --frozen-lockfile', () => {
    assert.match(live, /pnpm install --frozen-lockfile/);
  });

  it('跑单测', () => {
    assert.match(live, /run: pnpm test\s*$/m);
  });

  it('跑元数据/类型/lint/构建', () => {
    assert.match(live, /run: pnpm validate\s*$/m);
  });

  // 2026-10-04：审计收口到生产依赖。扩展发布的是 vite bundle，devDependencies
  // 一个字节都不进 dist；全量审计会被 dev 链路里「上游尚无修复版本」的漏洞
  // （当时是 braces <=3.0.3，经 @typescript-eslint 引入）长期染红，而 CI 常红
  // 会让人对门禁脱敏——比那个 dev 漏洞本身更危险。dev 链路要看得手动跑 pnpm audit。
  it('审计只覆盖生产依赖（--prod）', () => {
    assert.match(live, /pnpm audit --prod/);
  });

  it('审计显式指定 npmjs registry', () => {
    assert.match(live, /pnpm audit --prod --config\.registry=https:\/\/registry\.npmjs\.org\//);
  });
});

describe('CI: 不该出现的东西', () => {
  it('不跑 e2e', () => {
    assert.ok(!/pnpm e2e|run-e2e\.mjs/.test(live), 'e2e 需要 headed Chrome + 真实凭据 + 写线上库，不能进 CI');
  });

  it('不放宽任何阻塞步骤（未清债的检查只允许 continue-on-error 且带标记）', () => {
    const blockers = steps.filter((s) => /run: pnpm (test|validate|audit|install)/.test(s));
    assert.ok(blockers.length >= 4, `阻塞步骤数异常：${blockers.length}`);
    blockers.forEach((s) => {
      assert.ok(!s.includes('continue-on-error'), '阻塞步骤上挂了 continue-on-error');
    });
    const tolerated = steps.filter((s) => s.includes('continue-on-error'));
    tolerated.forEach((s) => {
      assert.match(s, /非阻塞/, '非阻塞步骤必须自己标明，否则会被误读成「已通过」');
    });
  });
});
