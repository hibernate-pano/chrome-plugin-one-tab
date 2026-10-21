// 钉死 OpStamp 全序比较（规格 §4.2）：
// - s 不同走数值；s 相同走 d 字典序；完全相等返回 0
// - 无 updatedAt/id 兜底：seq 单调递增保证唯一赢家
// - EMPTY_STAMP 全序最小值（迁移前数据 + 云端空列）
//
// 文件样板与 tests/mutationOps.test.ts 一致：@/ 别名需在 register(loader) 之后
// 动态 import；本模块不依赖 chrome/supabase，但保持样板统一。
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};
const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

before(async () => {
  register(LOADER_PATH);
});

describe('opStamp: 全序比较（§4.2）', () => {
  it('s 不同按数值', async () => {
    const { compareStamps } = await import('@/core/opStamp');
    assert.equal(compareStamps({ d: 'a', s: 2 }, { d: 'a', s: 1 }), 1);
    assert.equal(compareStamps({ d: 'a', s: 1 }, { d: 'a', s: 2 }), -1);
  });
  it('s 相同按 d 字典序', async () => {
    const { compareStamps } = await import('@/core/opStamp');
    assert.equal(compareStamps({ d: 'b', s: 5 }, { d: 'a', s: 5 }), 1);
    assert.equal(compareStamps({ d: 'a', s: 5 }, { d: 'b', s: 5 }), -1);
  });
  it('完全相等 → 0', async () => {
    const { compareStamps } = await import('@/core/opStamp');
    assert.equal(compareStamps({ d: 'a', s: 5 }, { d: 'a', s: 5 }), 0);
  });
  it('字典序把 "device10" 视为小于 "device2"（与数值序相反，钉死避免被改成数值比较）', async () => {
    // 规格 §4.2 明确「字符串字典序」。"device10" 与 "device2" 在数值序下前者更大，
    // 在字典序下逐字符比到第 7 位是 '1' vs '2'，前者更小——必须保证实现不退化为数值。
    const { compareStamps } = await import('@/core/opStamp');
    assert.equal(compareStamps({ d: 'device10', s: 1 }, { d: 'device2', s: 1 }), -1);
  });
  it('EMPTY_STAMP 是全序最小值', async () => {
    const { compareStamps, EMPTY_STAMP } = await import('@/core/opStamp');
    assert.equal(compareStamps(EMPTY_STAMP, { d: 'a', s: 1 }), -1);
    assert.equal(compareStamps({ d: 'a', s: 1 }, EMPTY_STAMP), 1);
    assert.equal(compareStamps(EMPTY_STAMP, EMPTY_STAMP), 0);
  });
  it('isLater 是 compareStamps > 0 的薄包装', async () => {
    const { isLater } = await import('@/core/opStamp');
    assert.equal(isLater({ d: 'b', s: 1 }, { d: 'a', s: 1 }), true);
    assert.equal(isLater({ d: 'a', s: 1 }, { d: 'a', s: 1 }), false);
  });
  it('makeStamp 工厂', async () => {
    const { makeStamp } = await import('@/core/opStamp');
    assert.deepEqual(makeStamp('dev', 7), { d: 'dev', s: 7 });
  });
});

// ── compareStampsLoose：WebDAV 写路径唯一的印记比较器 ─────────────────────
//
// 它是 src/sync-backend/webdav/adapter.ts:850（写路径）与
// src/sync-backend/webdav/firstSyncDecision.ts:399,433（复活检查）唯一用到的
// 印记比较器，方向性必须被钉死。
//
// 为什么它的口径必须与 compareStamps **不同**（源码注释里已说明，这里钉死）：
//   本文件的 EMPTY_STAMP 是 {d:'', s:0}，而 compareStampsLoose 对「无印记」用
//   {d:'', s:-Infinity}。-Infinity 让「无印记」严格小于**任何**真实印记
//   （含 seq=0 的第一份，也含 device 为空串的 seq=0 印记）。
//   若把 -Infinity 改成 0（= EMPTY_STAMP 的 seq），无印记与一枚 {d:'', s:0} 的
//   真实印记会**打平**（0），走进「本地赢」的分支用「状态未知的本地副本」覆盖远端
//   —— 正是注释警告的危险方向，而所有现有测试依然全绿。
// 所以「无印记 < 任何真实印记」这条必须被直接断言，而不是靠注释维持。
describe('opStamp: compareStampsLoose（无印记口径，刻意不同于 compareStamps）', () => {
  it('两侧都无印记 → 0', async () => {
    const { compareStampsLoose } = await import('@/core/opStamp');
    assert.equal(compareStampsLoose(undefined, undefined), 0);
  });

  it('无印记严格小于 seq=0 的真实印记（最关键的一条）', async () => {
    const { compareStampsLoose } = await import('@/core/opStamp');
    assert.equal(
      compareStampsLoose(undefined, { d: 'a', s: 0 }),
      -1,
      '无印记必须严格小于 seq=0 的真实印记：方向反了会用「不知道」的本地副本覆盖远端'
    );
    assert.equal(compareStampsLoose({ d: 'a', s: 0 }, undefined), 1);
  });

  it('无印记严格小于 EMPTY_STAMP', async () => {
    const { compareStampsLoose, EMPTY_STAMP } = await import('@/core/opStamp');
    assert.equal(compareStampsLoose(undefined, EMPTY_STAMP), -1);
    assert.equal(compareStampsLoose(EMPTY_STAMP, undefined), 1);
  });

  it('无印记严格小于任何真实印记（哪怕那枚印记的 device 是空串、seq=0）', async () => {
    // 这一条是「把 -Infinity 改成 0」的唯一守门人：
    // 改成 0 时，{d:'', s:0} 这枚真实印记会与「无印记」打平（0）而不是更小。
    const { compareStampsLoose } = await import('@/core/opStamp');
    const realStamps = [
      { d: '', s: 0 },
      { d: 'a', s: 0 },
      { d: 'a', s: 1 },
      { d: 'zzz', s: 99 },
    ];
    for (const real of realStamps) {
      assert.equal(
        compareStampsLoose(undefined, real),
        -1,
        `无印记必须严格小于真实印记 ${JSON.stringify(real)}`
      );
      assert.equal(
        compareStampsLoose(real, undefined),
        1,
        `真实印记 ${JSON.stringify(real)} 必须严格大于无印记`
      );
    }
  });

  it('与 compareStamps 口径确实不同，且 loose 是更保守的那一个', async () => {
    const { compareStamps, compareStampsLoose, EMPTY_STAMP } = await import('@/core/opStamp');
    // compareStamps 的入参类型是必填 OpStamp：喂 undefined 直接抛错，
    // 「不存在的印记」在它那儿根本不是一个合法状态。
    assert.throws(() => compareStamps(undefined as any, { d: 'a', s: 0 }));
    // compareStamps 用 EMPTY_STAMP({d:'',s:0}) 代表「无印记」时，与一枚
    // device 为空串、seq=0 的真实印记**打平**（0）—— 这正是 loose 要避免的方向：
    // loose 对同一组输入给 -1（更保守 = 更倾向认输，不拿「不知道」的状态覆盖远端）。
    assert.equal(compareStamps({ d: '', s: 0 }, { d: '', s: 0 }), 0);
    assert.equal(compareStampsLoose(undefined, { d: '', s: 0 }), -1);
    assert.equal(compareStamps(EMPTY_STAMP, EMPTY_STAMP), 0);
    assert.equal(compareStampsLoose(undefined, EMPTY_STAMP), -1);
  });
});