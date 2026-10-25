// 发布脚本的**行为**守卫：upload / publish / status 三条路径到底会不会假绿。
//
// ── 为什么不能只断言源码文本 ────────────────────────────────────────────────
// 上一版的守卫是「源码里出现某个正则 + 某个 process.exit(1)」
// ⇒ 变异验证时把判断改成 `if (false && …)`，它**照样绿**（零检测力）。
// 源码文本断言钉不住「exit(1) 是不是被那个条件守着」。
//
// 这里改成**真的把脚本跑起来**：把一个假 `curl` 放进 PATH，
// 让它按 URL 回放不同的回包，然后断言脚本的**退出码**。
//
// ── 覆盖哪几条路径（2026-10-24 审计 REL-01）───────────────────────────────
// ① upload：商店对「item 在审核队列」这一失败**正是回 HTTP 200**
//    （uploadState=FAILURE + itemError=[ITEM_NOT_UPDATABLE]）。
//    只看 HTTP 码 ⇒ 脚本 exit 0 ⇒ 我把「没发上去」报成「上传成功」。
// ② status：原来这个分支**完全没有退出码逻辑**，token 过期回 401 也 exit 0。
// ③ publish：HTTP 2xx 还要看商店自己的 status 字段；空草稿 publish 是静默 no-op。
//
// ── 2026-10-24（提审 1.28.3 时真机踩到）：守卫回放的形状必须是**真机形状** ──
//
// 旧用例把「草稿 uploadState=NOT_FOUND」当成「空草稿」，于是要求 publish 拒绝。
// 真机上：**上传成功之后**，草稿的 uploadState **也是 NOT_FOUND**（连续 5 次
// GET items/{id}?projection=DRAFT 全是它；publish 成功之后还是它）⇒
// 它区分不了「空草稿」与「草稿里正躺着刚上传好的包」。
// ⇒ 照着「我们以为的形状」写的闸门，**把真发布拦下来了**（今天就拦了一次：
//    草稿明明是 1.28.3，脚本却拒绝 publish）。
// ⇒ 现在：uploadState 不再当闸门（FAILURE / IN_PROGRESS 才拒绝），
//    闸门换成 crxVersion（必须等于期望版本），且**期望版本必填**。
//    本文件下面两条用例回放的**就是真机形状**（NOT_FOUND + 对的 crxVersion）。
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
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'scripts/cws-publish.mjs');

interface Endpoint {
  body: string;
  status: number;
}

interface FakeResponses {
  /** GET /items/{id}?projection=DRAFT —— 草稿 */
  item?: Endpoint;
  /** POST /items/{id}/publish —— 提交审核 */
  publish?: Endpoint;
  /** PUT upload/.../items/{id} —— 上传 */
  upload?: Endpoint;
}

interface RunResult {
  code: number;
  out: string;
  err: string;
  /** 假 curl 记下的「实际发出过的请求 URL」——用来证明「publish 根本没被调用」 */
  called: string[];
}

/**
 * 跑一次脚本子命令，用假 curl 按 URL 回放指定回包。
 *
 * 假 curl 的 URL 分派（顺序要紧：upload/publish 的 URL 都含 /items/）：
 *   1. oauth2.googleapis.com/token → access_token
 *   2. upload/chromewebstore      → 上传回包
 *   3. publish 结尾               → 提交审核回包
 *   4. items 中间                 → 草稿回包
 */
function runScript(cmd: string, args: string[], fake: FakeResponses): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'cws-fake-curl-'));
  const fakeCurl = join(dir, 'curl');
  const callLog = join(dir, 'calls.log');
  // 脚本的 http() 约定输出是「body + \n + http_code」。
  writeFileSync(
    fakeCurl,
    `#!/bin/bash
url=""
for a in "$@"; do
  case "$a" in http://*|https://*) url="$a";; esac
done
echo "$url" >> "$FAKE_LOG"
case "$url" in
  *oauth2.googleapis.com/token*) printf '{"access_token":"fake-token"}\\n200' ;;
  *upload/chromewebstore*) printf '%s\\n%s' "$FAKE_UPLOAD_BODY" "$FAKE_UPLOAD_STATUS" ;;
  */publish) printf '%s\\n%s' "$FAKE_PUBLISH_BODY" "$FAKE_PUBLISH_STATUS" ;;
  */items/*) printf '%s\\n%s' "$FAKE_ITEM_BODY" "$FAKE_ITEM_STATUS" ;;
  *) printf '{}\\n200' ;;
esac
`,
    { mode: 0o755 },
  );
  chmodSync(fakeCurl, 0o755);
  writeFileSync(callLog, '');
  try {
    const out = execFileSync('node', [SCRIPT, cmd, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        CWS_CLIENT_ID: 'test-client',
        CWS_CLIENT_SECRET: 'test-secret',
        CWS_REFRESH_TOKEN: 'test-refresh',
        CWS_ITEM_ID: 'test-item-id',
        FAKE_LOG: callLog,
        FAKE_ITEM_BODY: fake.item?.body ?? '{}',
        FAKE_ITEM_STATUS: String(fake.item?.status ?? 200),
        FAKE_PUBLISH_BODY: fake.publish?.body ?? '{}',
        FAKE_PUBLISH_STATUS: String(fake.publish?.status ?? 200),
        FAKE_UPLOAD_BODY: fake.upload?.body ?? '{}',
        FAKE_UPLOAD_STATUS: String(fake.upload?.status ?? 200),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out, err: '', called: readCalls(callLog) };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: e.stdout ?? '', err: e.stderr ?? '', called: readCalls(callLog) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readCalls(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
}

/** 造一个内容为空的假 zip —— 脚本只用 unzip 读版本号，读不到也不阻断。 */
function fakeZip(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cws-fake-zip-'));
  const p = join(dir, 'dist.zip');
  writeFileSync(p, 'not-a-real-zip');
  return p;
}

describe('发版结果自证：脚本不得假绿', () => {
  /**
   * 失败必须是「**明确报错 + exit 1**」，不能是「崩了、退出码恰好也是 1」。
   * 只断言退出码会被崩溃骗过（变异验证时踩过：把 `if (!statusMatch)` 改成
   * `if (false)` ⇒ 脚本在下一行解引用 null 崩掉 ⇒ 退出码 1 ⇒ 断言照样绿）。
   */
  function assertCleanFailure(r: RunResult, hint: RegExp, label: string) {
    assert.equal(r.code, 1, `${label}：必须 exit 1，实际 ${r.code}；err=${r.err}`);
    assert.doesNotMatch(
      r.err,
      /\n\s+at |SyntaxError|TypeError|ReferenceError/,
      `${label}：必须是「明确报错后退出 1」，不是崩溃 —— 崩溃的退出码也是 1，会骗过断言`,
    );
    assert.match(r.err, hint, `${label}：报错要说清原因；err=${r.err}`);
  }

  // ── upload ────────────────────────────────────────────────────────────────

  it('upload：uploadState=SUCCESS ⇒ exit 0', () => {
    const r = runScript('upload', [fakeZip()], {
      upload: { body: JSON.stringify({ uploadState: 'SUCCESS', crxVersion: '1.27.0' }), status: 200 },
    });
    assert.equal(r.code, 0, `应 exit 0，实际 ${r.code}；err=${r.err}`);
    assert.match(r.out, /上传成功/, '成功时应说「上传成功」');
  });

  it('upload：HTTP 200 但 uploadState=FAILURE ⇒ 必须 exit 1（这是真实事故形状）', () => {
    // 2026-10-23 的真回包：1.26.1 还在审核队列 ⇒ 商店回 200 + uploadState=FAILURE。
    const r = runScript('upload', [fakeZip()], {
      upload: {
        body: JSON.stringify({
          uploadState: 'FAILURE',
          itemError: [
            {
              error_code: 'ITEM_NOT_UPDATABLE',
              error_detail: 'The item cannot be updated now because it is in pending review.',
            },
          ],
        }),
        status: 200,
      },
    });
    assertCleanFailure(r, /ITEM_NOT_UPDATABLE/, 'uploadState=FAILURE');
    assert.doesNotMatch(r.out, /上传成功/, '失败时绝不能打印「上传成功」');
  });

  it('upload：uploadState=NOT_FOUND ⇒ 必须 exit 1', () => {
    const r = runScript('upload', [fakeZip()], {
      upload: { body: JSON.stringify({ uploadState: 'NOT_FOUND' }), status: 200 },
    });
    assertCleanFailure(r, /NOT_FOUND/, 'uploadState=NOT_FOUND');
  });

  it('upload：2xx 但回包里没有 uploadState ⇒ 必须 exit 1（无法自证 ≠ 成功）', () => {
    const r = runScript('upload', [fakeZip()], {
      upload: { body: JSON.stringify({ somethingElse: true }), status: 200 },
    });
    assertCleanFailure(r, /uploadState/, '缺少 uploadState 字段');
    assert.doesNotMatch(r.out, /上传成功/, '无法自证时绝不能打印「上传成功」');
  });

  it('upload：HTTP 5xx ⇒ 必须 exit 1', () => {
    const r = runScript('upload', [fakeZip()], {
      upload: { body: JSON.stringify({ error: 'boom' }), status: 500 },
    });
    assertCleanFailure(r, /HTTP 500/, 'HTTP 5xx');
  });

  // ── status ────────────────────────────────────────────────────────────────

  it('status：查询成功 ⇒ exit 0 且说清草稿状态', () => {
    const r = runScript('status', [], {
      item: { body: JSON.stringify({ crxVersion: '1.27.0', uploadState: 'SUCCESS' }), status: 200 },
    });
    assert.equal(r.code, 0, `应 exit 0，实际 ${r.code}；err=${r.err}`);
    assert.match(r.out, /crxVersion=1\.27\.0/, '成功时应报出草稿版本');
    assert.match(r.out, /uploadState=SUCCESS/, '成功时应报出上传状态');
  });

  it('status：HTTP 401 ⇒ 必须 exit 1（原来这个分支完全不看退出码）', () => {
    const r = runScript('status', [], {
      item: { body: JSON.stringify({ error: { code: 401, message: 'Invalid Credentials' } }), status: 401 },
    });
    assertCleanFailure(r, /HTTP 401/, 'HTTP 401');
  });

  it('status：HTTP 500 ⇒ 必须 exit 1', () => {
    const r = runScript('status', [], {
      item: { body: 'oops', status: 500 },
    });
    assertCleanFailure(r, /HTTP 500/, 'HTTP 500');
  });

  // ── publish ───────────────────────────────────────────────────────────────

  it('publish：真回包（status: ["OK"]）⇒ exit 0 且说「已提交审核」', () => {
    const r = runScript('publish', ['1.27.0'], {
      item: { body: JSON.stringify({ crxVersion: '1.27.0', uploadState: 'SUCCESS' }), status: 200 },
      publish: { body: JSON.stringify({ status: ['OK'], statusDetail: ['OK.'] }), status: 200 },
    });
    assert.equal(r.code, 0, `应 exit 0，实际 ${r.code}；err=${r.err}`);
    assert.match(r.out, /已提交审核/, '成功时应打印「已提交审核」');
  });

  it('publish：2xx 但 status 里没有 OK ⇒ 必须 exit 1（否则就是假绿）', () => {
    const r = runScript('publish', ['1.27.0'], {
      item: { body: JSON.stringify({ crxVersion: '1.27.0', uploadState: 'SUCCESS' }), status: 200 },
      publish: { body: JSON.stringify({ status: ['FAILED'], statusDetail: ['nope.'] }), status: 200 },
    });
    assertCleanFailure(r, /status/, 'status≠OK');
    assert.doesNotMatch(r.out, /已提交审核/, '失败时绝不能打印「已提交审核」');
  });

  it('publish：2xx 但回包里根本没有 status 字段 ⇒ 必须 exit 1（无法自证 ≠ 成功）', () => {
    const r = runScript('publish', ['1.27.0'], {
      item: { body: JSON.stringify({ crxVersion: '1.27.0', uploadState: 'SUCCESS' }), status: 200 },
      publish: { body: JSON.stringify({ somethingElse: true }), status: 200 },
    });
    assertCleanFailure(r, /status/, '缺少 status 字段');
    assert.doesNotMatch(r.out, /已提交审核/, '无法自证时绝不能打印「已提交审核」');
  });

  it('publish：HTTP 4xx ⇒ exit 1（既有行为，不能被这次改动挤掉）', () => {
    const r = runScript('publish', ['1.27.0'], {
      item: { body: JSON.stringify({ crxVersion: '1.27.0', uploadState: 'SUCCESS' }), status: 200 },
      publish: {
        body: JSON.stringify({ error: { code: 400, message: 'Publish condition not met' } }),
        status: 400,
      },
    });
    assertCleanFailure(r, /HTTP 400/, 'HTTP 4xx');
    assert.doesNotMatch(r.out, /已提交审核/, '失败时绝不能打印「已提交审核」');
  });

  it('publish：**不带期望版本** ⇒ 必须 exit 1，且**根本不该调 publish**', () => {
    // 2026-10-24 改的口径：判断「草稿里有没有可发的包」不再用 uploadState
    // （真机上它回 NOT_FOUND 时草稿里正躺着刚上传好的包），改用 crxVersion。
    // 而 crxVersion 要跟「期望版本」比 ⇒ **期望版本必填**：
    // 不知道要发哪一版，就不许发（草稿里可能是上一版，也可能是空草稿）。
    const r = runScript('publish', [], {
      item: { body: JSON.stringify({ crxVersion: '1.27.0', uploadState: 'NOT_FOUND' }), status: 200 },
      publish: { body: JSON.stringify({ status: ['OK'] }), status: 200 },
    });
    assertCleanFailure(r, /期望发布的版本/, '不带期望版本');
    assert.doesNotMatch(r.out, /已提交审核/, '没给版本时绝不能打印「已提交审核」');
    assert.equal(
      r.called.filter((u) => u.includes('/publish')).length,
      0,
      '没给期望版本时不该向商店发出 publish 请求',
    );
  });

  it('publish：**真机形状**（草稿 uploadState=NOT_FOUND + crxVersion 是要发的那一版）⇒ 照常提交', () => {
    // 2026-10-24 真机实测（提审 1.28.3）：
    //   upload → 回包 uploadState=SUCCESS
    //   GET item?projection=DRAFT → {crxVersion:"1.28.3", uploadState:"NOT_FOUND"}
    //   publish → 商店回 {"status":["OK"]}
    // ⇒ item 上的 uploadState 在「草稿里正躺着刚上传好的包」时**也是 NOT_FOUND**
    //   （空草稿时同样是 NOT_FOUND ⇒ 这个字段区分不了两者）。
    // ⇒ 旧守卫回放「NOT_FOUND = 空草稿」这个**我们以为的形状**，把真发布拦了下来。
    //   现在改成：uploadState 不再当闸门，闸门是 crxVersion。
    const r = runScript('publish', ['1.28.3'], {
      item: { body: JSON.stringify({ crxVersion: '1.28.3', uploadState: 'NOT_FOUND' }), status: 200 },
      publish: { body: JSON.stringify({ status: ['OK'], statusDetail: ['OK.'] }), status: 200 },
    });
    assert.equal(r.code, 0, `应 exit 0，实际 ${r.code}；err=${r.err}`);
    assert.equal(r.called.filter((u) => u.includes('/publish')).length, 1, '应当发出一次 publish 请求');
    assert.match(r.out, /已提交审核/, '商店说 OK 时应报出「已提交审核」');
  });

  it('publish：草稿上一次上传失败（uploadState=FAILURE）⇒ 必须 exit 1', () => {
    const r = runScript('publish', ['1.27.0'], {
      item: { body: JSON.stringify({ crxVersion: '1.26.1', uploadState: 'FAILURE' }), status: 200 },
      publish: { body: JSON.stringify({ status: ['OK'] }), status: 200 },
    });
    assertCleanFailure(r, /FAILURE/, '草稿上传失败');
    assert.equal(r.called.filter((u) => u.includes('/publish')).length, 0, '不该发出 publish 请求');
  });

  it('publish：商店还在处理上一次上传（uploadState=IN_PROGRESS）⇒ 必须 exit 1', () => {
    const r = runScript('publish', ['1.27.0'], {
      item: { body: JSON.stringify({ crxVersion: '1.27.0', uploadState: 'IN_PROGRESS' }), status: 200 },
      publish: { body: JSON.stringify({ status: ['OK'] }), status: 200 },
    });
    assertCleanFailure(r, /IN_PROGRESS/, '上传还在处理中');
    assert.equal(r.called.filter((u) => u.includes('/publish')).length, 0, '不该发出 publish 请求');
  });

  it('publish：给的期望版本与草稿版本不符 ⇒ 必须 exit 1，且不该发出 publish', () => {
    const r = runScript('publish', ['1.27.0'], {
      item: { body: JSON.stringify({ crxVersion: '1.26.1', uploadState: 'SUCCESS' }), status: 200 },
      publish: { body: JSON.stringify({ status: ['OK'] }), status: 200 },
    });
    assertCleanFailure(r, /1\.26\.1/, '版本不符');
    assert.equal(r.called.filter((u) => u.includes('/publish')).length, 0, '不该发出 publish 请求');
  });

  it('publish：期望版本与草稿版本一致 ⇒ 照常提交（别把版本核对做成永远拦）', () => {
    const r = runScript('publish', ['1.27.0'], {
      item: { body: JSON.stringify({ crxVersion: '1.27.0', uploadState: 'SUCCESS' }), status: 200 },
      publish: { body: JSON.stringify({ status: ['OK'] }), status: 200 },
    });
    assert.equal(r.code, 0, `应 exit 0，实际 ${r.code}；err=${r.err}`);
    assert.equal(r.called.filter((u) => u.includes('/publish')).length, 1, '应当发出一次 publish 请求');
  });

  it('publish：发布前自检拿不到草稿状态（HTTP 500）⇒ 必须 exit 1，且不该发出 publish', () => {
    const r = runScript('publish', ['1.27.0'], {
      item: { body: 'oops', status: 500 },
      publish: { body: JSON.stringify({ status: ['OK'] }), status: 200 },
    });
    assertCleanFailure(r, /HTTP 500/, '发布前自检失败');
    assert.equal(r.called.filter((u) => u.includes('/publish')).length, 0, '不该发出 publish 请求');
  });
});
