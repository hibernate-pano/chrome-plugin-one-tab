// .github/workflows/verify.yml 的结构回归测试。
//
// 为什么需要它：这个仓库的 CI 只在 GitHub 上跑，本地永远看不到它。而它身上藏着一个
// 「看起来全绿、其实什么都没验」的坑——tests/opStampGuard.pg.test.ts 在缺 initdb/pg_ctl/psql
// 时整组静默 skip（该文件头部写明这块历史上出过两次事故），而 CI 的 YAML 恰恰就是
// 「有没有真的装上 Postgres、装了之后有没有验证装上了」的唯一证据。证据本身需要被守。
//
// 同时把两条纪律钉死：e2e 不进 CI（要 headed Chrome + 真实 Supabase 凭据 + 写线上库），
// 审计必须显式指定 npmjs registry（默认 npmmirror 没有 audit 端点，直接跑必失败）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = join(ROOT, '.github/workflows/verify.yml');

const yaml = existsSync(WORKFLOW) ? readFileSync(WORKFLOW, 'utf8') : '';
// 结构断言必须只看真正生效的 YAML：注释里也会出现「initdb」「pnpm e2e」这些词，
// 拿注释当配置来断言，等于给自己写一份会骗人的测试。
const live = yaml
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');
/** 按 `- name:` / `- uses:` 切出来的步骤片段 */
const steps = live.split(/\n {6}- (?:name|uses):/);

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

describe('CI: Postgres 必须真的装上（防静默 skip）', () => {
  it('装了 Postgres 16（显式 apt 安装，不依赖已下架的第三方 action）', () => {
    // supercharge/setup-postgres 仓库 2026-10 已不存在，继续钉它等于钉一个必红的 CI。
    assert.match(live, /apt-get install -y postgresql-16/);
  });

  it('探测三个二进制的同一步里必须 exit 1', () => {
    const guard = steps.find((s) => s.includes('command -v'));
    assert.ok(guard, '找不到探测 initdb/pg_ctl/psql 的步骤——PG 缺失时会整组 skip 而 CI 全绿');
    ['initdb', 'pg_ctl', 'psql'].forEach((bin) =>
      assert.ok(guard.includes(bin), `探测步骤没检查 ${bin}`)
    );
    assert.match(guard, /exit 1/, '探测步骤没有 exit 1：缺 PG 只会打印告警，门禁照样放行');
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
