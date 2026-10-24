// 守候脚本的**行为**守卫：scripts/cws-wait-publish.sh。
//
// ── 这个脚本为什么需要守卫 ────────────────────────────────────────────────
// 上一版它只活在 /tmp，进程被杀、文件消失，而两份文档都写着「已挂守候进程」
// ⇒ 文档描述了一个不存在的进程。它进仓库后，就必须能被验证。
//
// ── 守什么 ────────────────────────────────────────────────────────────────
// ① **判据必须是退出码，不是 grep 输出文本**。
//    脚本 cws-publish.mjs 打印的是**未格式化的原始回包**
//    （`"uploadState":"SUCCESS"`，冒号后**没空格**），
//    上一版 /tmp 脚本 grep 的是 `'"uploadState": "SUCCESS"'`
//    ⇒ 永远匹配不上 ⇒ 即使上传成功了也会一直重试、永远报「没放行」。
//    用例 2 就是钉这一条：真上传成功了，守候脚本必须**报成功**。
// ② 商店没放行时**不许**发出 publish（否则等于反复空提交）。
// ③ 产物 sha256 对不上 ⇒ 一个字节都不许上传。
//
// ── 怎么跑 ────────────────────────────────────────────────────────────────
// 假 curl 放进 PATH（和 cwsPublishStatus.test.ts 同一套手法），按 URL 回放回包；
// 守候脚本跑的是**真的** scripts/cws-publish.mjs ⇒ 端到端验的是真实链路。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'scripts/cws-wait-publish.sh');
const ZIP_NAME = 'dist.zip';

interface Endpoint {
  body: string;
  status: number;
}

interface FakeResponses {
  item?: Endpoint;
  publish?: Endpoint;
  upload?: Endpoint;
}

interface RunResult {
  code: number;
  out: string;
  err: string;
  /** 假 curl 记下的实际请求 URL ——用来证明「publish 根本没被调用」 */
  called: string[];
}

/**
 * 跑一次守候脚本。
 *
 * @param fake        假 curl 按 URL 回放的回包
 * @param opts.expectSha    期望的 sha256；传 null 表示**不给** EXPECT_SHA（脚本应当拒绝上传）
 * @param opts.breakShaTool 放一个「吐不出东西」的假 shasum ⇒ ACTUAL_SHA 为空
 * @param opts.version      期望发的那一版
 */
function runWait(
  fake: FakeResponses,
  opts: {
    expectSha?: string | null;
    breakShaTool?: boolean;
    version?: string;
    attempts?: number;
  } = {},
): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'cws-wait-fake-'));
  const fakeCurl = join(dir, 'curl');
  const callLog = join(dir, 'calls.log');
  const zipPath = join(dir, ZIP_NAME);
  writeFileSync(zipPath, 'fake-zip-content');
  const realSha = createHash('sha256').update('fake-zip-content').digest('hex');

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

  // 假 shasum：存在但**吐不出 sha**（模拟工具缺失 / 读失败）
  // ⇒ ACTUAL_SHA 为空 ⇒ 脚本必须单独判它失败，不能让「空 vs 空」的比对蒙混过关。
  if (opts.breakShaTool) {
    const brokenSha = join(dir, 'shasum');
    writeFileSync(brokenSha, '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    chmodSync(brokenSha, 0o755);
  }

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${dir}:${process.env.PATH}`,
    CWS_CLIENT_ID: 'test-client',
    CWS_CLIENT_SECRET: 'test-secret',
    CWS_REFRESH_TOKEN: 'test-refresh',
    CWS_ITEM_ID: 'test-item-id',
    FAKE_LOG: callLog,
    ZIP: zipPath,
    EXPECT_SHA: opts.expectSha ?? realSha,
    EXPECT_VERSION: opts.version ?? '1.27.0',
    ATTEMPTS: String(opts.attempts ?? 1),
    SLEEP: '0',
    FAKE_ITEM_BODY: fake.item?.body ?? '{}',
    FAKE_ITEM_STATUS: String(fake.item?.status ?? 200),
    FAKE_PUBLISH_BODY: fake.publish?.body ?? '{}',
    FAKE_PUBLISH_STATUS: String(fake.publish?.status ?? 200),
    FAKE_UPLOAD_BODY: fake.upload?.body ?? '{}',
    FAKE_UPLOAD_STATUS: String(fake.upload?.status ?? 200),
  };
  // 只有显式传 null 才表示「不给 EXPECT_SHA」（默认给真实 sha）。
  if (opts.expectSha === null) delete env.EXPECT_SHA;

  try {
    const out = execFileSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env,
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

const publishCalls = (r: RunResult) => r.called.filter((u) => u.includes('/publish')).length;
const uploadCalls = (r: RunResult) => r.called.filter((u) => u.includes('upload/chromewebstore')).length;

describe('守候脚本：不得虚报、不得空提交', () => {
  it('商店没放行（uploadState=FAILURE）⇒ exit 3，且**不许发出 publish**', () => {
    const r = runWait({
      upload: {
        body: JSON.stringify({
          uploadState: 'FAILURE',
          itemError: [{ error_code: 'ITEM_NOT_UPDATABLE', error_detail: 'in pending review' }],
        }),
        status: 200,
      },
    });
    assert.equal(r.code, 3, `商店没放行时应当 exit 3，实际 ${r.code}；out=${r.out}`);
    assert.equal(uploadCalls(r), 1, '应当尝试过一次上传');
    assert.equal(publishCalls(r), 0, '商店没放行时**不许**发出 publish（那是反复空提交）');
    assert.doesNotMatch(r.out, /已提交审核/, '没放行时绝不能声称「已提交审核」');
  });

  it('上传真成功 ⇒ 必须报「已提交审核」并 exit 0（不许靠 grep 原始回包判成功）', () => {
    // 这一条钉的是「判据用退出码」：cws-publish.mjs 打印的是**未格式化**的原始回包
    // （"uploadState":"SUCCESS"，冒号后没空格）。上一版 /tmp 脚本 grep 的是
    // '"uploadState": "SUCCESS"' ⇒ 永远匹配不上 ⇒ 上传成功了也会一直重试。
    const r = runWait({
      upload: { body: JSON.stringify({ uploadState: 'SUCCESS', crxVersion: '1.27.0' }), status: 200 },
      item: { body: JSON.stringify({ uploadState: 'SUCCESS', crxVersion: '1.27.0' }), status: 200 },
      publish: { body: JSON.stringify({ status: ['OK'], statusDetail: ['OK.'] }), status: 200 },
    });
    assert.equal(r.code, 0, `应 exit 0，实际 ${r.code}；out=${r.out}；err=${r.err}`);
    assert.match(r.out, /已提交审核/, '上传+publish 都成功时必须报「已提交审核」');
    assert.equal(publishCalls(r), 1, '应当发出一次 publish 请求');
  });

  it('publish 回包 status 里没有 OK ⇒ exit 3，且绝不能声称「已提交审核」', () => {
    const r = runWait({
      upload: { body: JSON.stringify({ uploadState: 'SUCCESS', crxVersion: '1.27.0' }), status: 200 },
      item: { body: JSON.stringify({ uploadState: 'SUCCESS', crxVersion: '1.27.0' }), status: 200 },
      publish: { body: JSON.stringify({ status: ['FAILED'], statusDetail: ['nope.'] }), status: 200 },
    });
    assert.equal(r.code, 3, `publish 未生效时应当 exit 3，实际 ${r.code}；out=${r.out}`);
    assert.doesNotMatch(r.out, /已提交审核/, 'publish 没成功时绝不能声称「已提交审核」');
  });

  it('publish 成功但草稿版本对不上 ⇒ 不得声称「已提交审核」', () => {
    const r = runWait({
      upload: { body: JSON.stringify({ uploadState: 'SUCCESS', crxVersion: '1.27.0' }), status: 200 },
      item: { body: JSON.stringify({ uploadState: 'SUCCESS', crxVersion: '1.26.1' }), status: 200 },
      publish: { body: JSON.stringify({ status: ['OK'] }), status: 200 },
    });
    // 草稿版本不符 ⇒ 发布前自检就会挡住 publish ⇒ 不会声称成功。
    assert.notEqual(r.code, 0, '草稿版本对不上时不得 exit 0');
    assert.doesNotMatch(r.out, /已提交审核/, '草稿版本对不上时绝不能声称「已提交审核」');
    assert.equal(publishCalls(r), 0, '草稿版本对不上时不该发出 publish');
  });

  it('产物 sha256 对不上 ⇒ 一个字节都不许上传（exit 4）', () => {
    const r = runWait(
      {
        upload: { body: JSON.stringify({ uploadState: 'SUCCESS' }), status: 200 },
        item: { body: JSON.stringify({ uploadState: 'SUCCESS', crxVersion: '1.27.0' }), status: 200 },
        publish: { body: JSON.stringify({ status: ['OK'] }), status: 200 },
      },
      { expectSha: '0'.repeat(64) },
    );
    assert.equal(r.code, 4, `产物对不上时应当 exit 4，实际 ${r.code}；out=${r.out}`);
    assert.equal(uploadCalls(r), 0, '产物对不上时**不许**上传');
    assert.doesNotMatch(r.out, /已提交审核/, '绝不能声称「已提交审核」');
    // 两种失败要给**不同的诊断**（操作的下一步完全不同）：
    // 「你没告诉我该发哪个产物」 vs 「产物不是你以为的那个」。
    assert.match(r.out, /产物对不上/, '诊断要说清是「产物对不上」');
  });

  it('没给 EXPECT_SHA ⇒ 拒绝上传（产物新鲜度不能靠猜）', () => {
    const r = runWait(
      {
        upload: { body: JSON.stringify({ uploadState: 'SUCCESS' }), status: 200 },
        item: { body: JSON.stringify({ uploadState: 'SUCCESS', crxVersion: '1.27.0' }), status: 200 },
        publish: { body: JSON.stringify({ status: ['OK'] }), status: 200 },
      },
      { expectSha: null },
    );
    assert.equal(r.code, 4, `没给 EXPECT_SHA 时应当 exit 4，实际 ${r.code}；out=${r.out}`);
    assert.equal(uploadCalls(r), 0, '没给 EXPECT_SHA 时不许上传');
    // 「没给」和「给错了」要能分开：操作的下一步完全不同
    // （前者去补 EXPECT_SHA，后者去重新打包）。
    assert.match(r.out, /必须显式给出 EXPECT_SHA/, '诊断要说清是「没给 EXPECT_SHA」');
  });

  it('算不出产物的 sha256 ⇒ 拒绝上传（空值互相比对会蒙混过关）', () => {
    // shasum 存在但吐不出东西（工具缺失 / 读失败）⇒ ACTUAL_SHA 为空。
    // ⚠️ 这一条钉的是一个真实的 fail-open 洞：
    //   `if [ "$ACTUAL_SHA" != "$EXPECT_SHA" ]` 在两边都为空时是「相等」⇒ 放行
    //   ⇒ **完全没有新鲜度校验**就上传了。
    const r = runWait(
      {
        upload: { body: JSON.stringify({ uploadState: 'SUCCESS' }), status: 200 },
        item: { body: JSON.stringify({ uploadState: 'SUCCESS', crxVersion: '1.27.0' }), status: 200 },
        publish: { body: JSON.stringify({ status: ['OK'] }), status: 200 },
      },
      { expectSha: 'a'.repeat(64), breakShaTool: true },
    );
    assert.equal(r.code, 4, `算不出 sha256 时应当 exit 4，实际 ${r.code}；out=${r.out}`);
    assert.equal(uploadCalls(r), 0, '算不出 sha256 时不许上传');
    assert.match(r.out, /算不出产物的 sha256/, '诊断要说清是「算不出 sha256」');
  });
});
