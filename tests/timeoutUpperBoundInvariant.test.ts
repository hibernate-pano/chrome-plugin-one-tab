// 跨模块超时不变量（2026-10-16 审查 M1 恢复的守卫）。
//
// ══════════════════════════════════════════════════════════════════════════
// 【不变量】DEFAULT_REQUEST_TIMEOUT_MS（WebDAV 请求级，45s）
//           > DEFAULT_TIMEOUT_MS（popup 消息协议级，30s）
//
// 为什么必须有这条：两层超时服务同一个用户操作的不同侧面 ——
//   · popup 侧 Promise.race 到 30s 就「不等了」，弹「操作耗时过长，
//     后台可能仍在继续」；
//   · SW 侧 WebDAV fetch 到 45s 才中止请求。
// 若请求上界 ≤ 协议上界，用户会先看到 popup 报失败、随后又看到操作其实
// 成功（请求在 30–45s 之间完成了）—— 比慢更让人困惑。方向反过来
// （协议上界 > 请求上界）则是 popup 先放弃、SW 还在跑，至少文案
// 「可能仍在继续」与事实一致。
//
// 历史：该不变量原由 tests/supabaseRequestTimeout.test.ts 钉住
// （supabase/client.ts 的 REQUEST_TIMEOUT_MS vs mutationProtocol 的
// DEFAULT_TIMEOUT_MS）。账号体系删除时那份测试连同 Supabase 一起没了，
// 而 WebDAV 侧新引入了 45s 上界却没人继承这条守卫 —— 改任一侧都
// 不会有测试红。本文件补上这个继承。
//
// 超时错误分类本身的用例（挂死 ⇒ WebDavRequestTimeoutError/isTimeout、
// PUT 同样超时、普通网络失败不误判）在 tests/newFeatures.test.ts。
// ══════════════════════════════════════════════════════════════════════════
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

globalThis.__TABSTACK_META_ENV__ = {
  DEV: false,
  MODE: 'test',
};

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

before(async () => {
  register(LOADER_PATH);
});

describe('超时不变量：WebDAV 请求上界必须大于 popup 协议上界', () => {
  it('DEFAULT_REQUEST_TIMEOUT_MS(45s) > DEFAULT_TIMEOUT_MS(30s)', async () => {
    const { DEFAULT_REQUEST_TIMEOUT_MS } = await import('@/sync-backend/webdav/client');
    const { DEFAULT_TIMEOUT_MS } = await import('@/core/mutationProtocol');

    assert.ok(
      DEFAULT_REQUEST_TIMEOUT_MS > DEFAULT_TIMEOUT_MS,
      `请求级上界（${DEFAULT_REQUEST_TIMEOUT_MS}ms）必须大于 popup 协议上界` +
        `（${DEFAULT_TIMEOUT_MS}ms），否则用户会先看到失败又看到成功`
    );
  });

  it('证伪护栏：只比大小不够 —— 协议上界不得被「修」成毫秒级（假通过）', async () => {
    // 把 DEFAULT_TIMEOUT_MS 改成 1ms 也能满足上一条的 >，但 popup 会在
    // 任何正常同步完成前就报「操作耗时过长」——那是用破坏 UX 的方式
    // 「满足」不变量。区间护栏堵住的正是这类假通过。
    const { DEFAULT_REQUEST_TIMEOUT_MS } = await import('@/sync-backend/webdav/client');
    const { DEFAULT_TIMEOUT_MS } = await import('@/core/mutationProtocol');

    assert.ok(
      DEFAULT_TIMEOUT_MS >= 5_000,
      `popup 协议上界不得低于 5s（现 ${DEFAULT_TIMEOUT_MS}ms）：整库同步秒级、` +
        '弱网大库更久，低于 5s 会把正常操作误报成超时'
    );
    assert.ok(
      DEFAULT_REQUEST_TIMEOUT_MS <= 60_000,
      `WebDAV 请求上界不得高于 60s（现 ${DEFAULT_REQUEST_TIMEOUT_MS}ms）：` +
        '它钉在单写者队列里，挂起越久用户点击排得越后'
    );
  });
});
