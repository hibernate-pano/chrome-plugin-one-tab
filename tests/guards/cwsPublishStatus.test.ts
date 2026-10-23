// 发布脚本的**行为**守卫：publish 分支到底会不会误报「已发布」。
//
// ── 为什么不能只断言源码文本 ────────────────────────────────────────────────
// 上一版的守卫是「源码里出现某个正则 + 某个 process.exit(1)」
// ⇒ 变异验证时把判断改成 `if (false && …)`，它**照样绿**（零检测力）。
// 源码文本断言钉不住「exit(1) 是不是被那个条件守着」。
//
// 这里改成**真的把脚本跑起来**：把一个假 `curl` 放进 PATH，
// 让它按用例回放不同的回包，然后断言脚本的**退出码**。
//
// ── 为什么值得单独一个文件 ────────────────────────────────────────────────
// 「提交审核」是发版流程里最关键的一步（upload 只改草稿，publish 才真提交）。
// 它一旦假绿，我会把「没提交」报成「已发布」—— 而这正是本仓库反复吃过的
// 亏（见 docs/RELEASE-NOTES.md 里每次提审都要靠公开页复核）。
//
// ── 为什么住在 tests/guards/ ──────────────────────────────────────────────
// 单测 glob 只覆盖顶层的话（历史上踩过），本文件会被静默跳过 ——
// 它住在子目录里，glob 退化了它第一个消失。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'scripts/cws-publish.mjs');

/**
 * 跑一次 `publish` 子命令，用假 curl 回放指定回包。
 * 返回 { code, out, err }。
 */
function runPublish(responseBody: string, responseStatus = 200) {
  const dir = mkdtempSync(join(tmpdir(), 'cws-fake-curl-'));
  const fakeCurl = join(dir, 'curl');
  // 假 curl：认 URL，token 端点回 access_token，publish 端点回放用例指定的内容。
  // 脚本的 http() 约定输出是「body + \n + http_code」。
  writeFileSync(
    fakeCurl,
    `#!/bin/bash
url=""
for a in "$@"; do
  case "$a" in http://*|https://*) url="$a";; esac
done
case "$url" in
  *oauth2.googleapis.com/token*) printf '{"access_token":"fake-token"}\\n200' ;;
  */publish) printf '%s\\n%s' "$FAKE_BODY" "$FAKE_STATUS" ;;
  *) printf '{}\\n200' ;;
esac
`,
    { mode: 0o755 },
  );
  chmodSync(fakeCurl, 0o755);
  try {
    const out = execFileSync('node', [SCRIPT, 'publish'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        CWS_CLIENT_ID: 'test-client',
        CWS_CLIENT_SECRET: 'test-secret',
        CWS_REFRESH_TOKEN: 'test-refresh',
        CWS_ITEM_ID: 'test-item-id',
        FAKE_BODY: responseBody,
        FAKE_STATUS: String(responseStatus),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out, err: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: e.stdout ?? '', err: e.stderr ?? '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('发版结果自证：publish 不得假绿', () => {
  /**
   * 失败必须是「**明确报错 + exit 1**」，不能是「崩了、退出码恰好也是 1」。
   * 只断言退出码会被崩溃骗过（变异验证时踩过：把 `if (!statusMatch)` 改成
   * `if (false)` ⇒ 脚本在下一行解引用 null 崩掉 ⇒ 退出码 1 ⇒ 断言照样绿）。
   */
  function assertCleanFailure(r: { code: number; err: string }, hint: RegExp, label: string) {
    assert.equal(r.code, 1, `${label}：必须 exit 1，实际 ${r.code}`);
    assert.doesNotMatch(
      r.err,
      /\n\s+at |SyntaxError|TypeError|ReferenceError/,
      `${label}：必须是「明确报错后退出 1」，不是崩溃 —— 崩溃的退出码也是 1，会骗过断言`,
    );
    assert.match(r.err, hint, `${label}：报错要说清原因`);
  }

  it('真回包（status: ["OK"]）⇒ exit 0 且说「已提交审核」', () => {
    const r = runPublish(JSON.stringify({ status: ['OK'], statusDetail: ['OK.'] }));
    assert.equal(r.code, 0, `应 exit 0，实际 ${r.code}；err=${r.err}`);
    assert.match(r.out, /已提交审核/, '成功时应打印「已提交审核」');
  });

  it('2xx 但 status 里没有 OK ⇒ 必须 exit 1（否则就是假绿）', () => {
    const r = runPublish(JSON.stringify({ status: ['FAILED'], statusDetail: ['nope.'] }));
    assertCleanFailure(r, /status/, 'status≠OK');
    assert.doesNotMatch(r.out, /已提交审核/, '失败时绝不能打印「已提交审核」');
  });

  it('2xx 但回包里根本没有 status 字段 ⇒ 必须 exit 1（无法自证 ≠ 成功）', () => {
    const r = runPublish(JSON.stringify({ somethingElse: true }));
    assertCleanFailure(r, /status/, '缺少 status 字段');
    assert.doesNotMatch(r.out, /已提交审核/, '无法自证时绝不能打印「已提交审核」');
  });

  it('HTTP 4xx ⇒ exit 1（既有行为，不能被这次改动挤掉）', () => {
    const r = runPublish(
      JSON.stringify({ error: { code: 400, message: 'Publish condition not met' } }),
      400,
    );
    assertCleanFailure(r, /HTTP 400/, 'HTTP 4xx');
    assert.doesNotMatch(r.out, /已提交审核/, '失败时绝不能打印「已提交审核」');
  });

  it('2xx + uploadState=NOT_FOUND（空草稿的静默 no-op）⇒ exit 1', () => {
    const r = runPublish(JSON.stringify({ uploadState: 'NOT_FOUND' }));
    assertCleanFailure(r, /NOT_FOUND/, '空草稿 no-op');
    assert.doesNotMatch(r.out, /已提交审核/, 'no-op 时绝不能打印「已提交审核」');
  });
});
