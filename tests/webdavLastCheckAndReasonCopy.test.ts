// A 组 A6 + A8：上次测试结果的持久化与 reason 文案登记（2026-10-18）。
//
// ── A6 缺陷形状 ───────────────────────────────────────────────────────────
// `config.ts` 的 `saveLastCheck` 是**死代码**：`src/` 内零调用点。而
// `WebDavSettings` 的 mount effect 只读 baseUrl / username / rootPath / encryption，
// 从不用 `cfg.lastCheck` 播种 check 状态。后果：一次成功的「测试连接」绿灯
// 在每次重开页面时丢失 —— 与该面板自己的「诚实度纪律」（每句话都必须等于
// 真实行为）矛盾：那次测试是真实发生过的，面板却假装没有。
//
// 修法：mount 时从 `cfg.lastCheck` 播种；测试（成功/失败）后 fire-and-forget 写回。
// 关键是**播种必须有有效期**：没有 TTL 的话，几天前（甚至另一个地址的）绿灯
// 会被当成「现在的连接状态」显示出来 —— 那就把「死代码」修成了「新假绿灯」。
//
// ── A8 缺陷形状 ───────────────────────────────────────────────────────────
// `downloadReasonCopy` 自带一张 5 条的 reason→文案表，而 B 组在
// `syncPreviewView.SYNC_REASON_COPY` 里新增了 `backend_unknown`。两张表 →
// 面板这边退化成**裸枚举**（用户看到 `backend_unknown` 这几个字母）。
//
// ── 测试形态约束 ──────────────────────────────────────────────────────────
// 本仓库没有 jsdom / happy-dom / @testing-library，也不为此装依赖
// （见 tests/a11yDialogs.test.ts 顶部注释）。所以行为断言针对**纯函数**
// （`checkResultFromLastCheck` / `resolveSyncFailureCopy`），源码字符串断言
// 只用来钉「组件真的调用了它们」。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LAST_CHECK_TTL_MS,
  checkResultFromLastCheck,
  type StoredWebDavConfig,
} from '@/sync-backend/webdav/config';
import { SYNC_REASON_COPY, resolveSyncFailureCopy } from '@/components/sync/syncPreviewView';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

/** 一个固定时间点，避免测试依赖真实时钟。 */
const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const at = (offsetMs: number) => new Date(NOW - offsetMs).toISOString();

const lastCheck = (
  over: Partial<NonNullable<StoredWebDavConfig['lastCheck']>> = {}
): NonNullable<StoredWebDavConfig['lastCheck']> => ({
  at: at(60_000), // 1 分钟前
  ok: true,
  conditionalWrites: true,
  groups: 7,
  ...over,
});

describe('A6 上次测试结果：只在有效期内播种（否则就是又一个假绿灯）', () => {
  it('刚测过的绿灯 ⇒ 播种（这是本缺陷要恢复的事实）', () => {
    const seeded = checkResultFromLastCheck(lastCheck(), NOW);
    assert.ok(seeded, '近期结果必须能被播种 —— 否则绿灯活不过重开页面');
    assert.equal(seeded.ok, true);
    assert.equal(seeded.groups, 7);
    assert.equal(seeded.conditionalWrites, true);
  });

  it('刚测过的红灯 ⇒ 也播种（失败信息同样是事实）', () => {
    const seeded = checkResultFromLastCheck(
      lastCheck({ ok: false, groups: 0, conditionalWrites: false, message: 'HTTP 401' }),
      NOW
    );
    assert.ok(seeded);
    assert.equal(seeded.ok, false);
    assert.equal(seeded.message, 'HTTP 401', '失败原因不能丢：用户要靠它判断该改什么');
  });

  it('超过 TTL ⇒ 不播种（不得把陈年绿灯当现状）', () => {
    assert.equal(checkResultFromLastCheck(lastCheck({ at: at(LAST_CHECK_TTL_MS + 1000) }), NOW), null);
    assert.ok(
      checkResultFromLastCheck(lastCheck({ at: at(LAST_CHECK_TTL_MS - 1000) }), NOW),
      '边界内侧必须仍可播种，否则 TTL 形同虚设'
    );
  });

  it('没有记录 / 时间不可解析 / 时钟异常 ⇒ 不播种（fail-honest）', () => {
    assert.equal(checkResultFromLastCheck(null, NOW), null);
    assert.equal(checkResultFromLastCheck(undefined, NOW), null);
    assert.equal(checkResultFromLastCheck(lastCheck({ at: 'not-a-date' }), NOW), null);
    // 未来时间：时钟被拨过的两种方向都不可信。
    assert.equal(checkResultFromLastCheck(lastCheck({ at: at(-LAST_CHECK_TTL_MS - 1000) }), NOW), null);
  });

  it('groups 非法 ⇒ 不播种（isLastCheck 只校验了三个字段，没管它）', () => {
    assert.equal(checkResultFromLastCheck(lastCheck({ groups: Number.NaN }), NOW), null);
    assert.equal(checkResultFromLastCheck(lastCheck({ groups: -3 }), NOW), null);
    // 合法小数会被向下取整，而不是被拒：它确实是一个可展示的数量。
    assert.equal(checkResultFromLastCheck(lastCheck({ groups: 3.7 }), NOW)?.groups, 3);
  });

  it('返回的快照带着 at，UI 才能标「上次测试」而不是假装刚刚测的', () => {
    const seeded = checkResultFromLastCheck(lastCheck({ at: at(3 * 60 * 60 * 1000) }), NOW);
    assert.ok(seeded);
    assert.equal(seeded.at, at(3 * 60 * 60 * 1000));
  });
});

describe('A6 接线：mount 播种 + 测试后持久化（源码护栏）', () => {
  const UI = read('src/components/sync/WebDavSettings.tsx');
  const CODE = UI.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  it('mount effect 从 lastCheck 播种 check 状态', () => {
    const mountStart = CODE.indexOf('loadWebDavConfig()');
    assert.ok(mountStart > -1, '应能找到 mount effect 里的 loadWebDavConfig');
    const mount = CODE.slice(mountStart, mountStart + 1200);
    assert.match(mount, /checkResultFromLastCheck\(cfg\.lastCheck\)/, '必须用带 TTL 的纯函数播种');
    assert.match(mount, /setCheck\(\{/, '播种必须落到 check 状态上');
    assert.match(mount, /fromStorage: true/, '必须标记「来自上次」，否则用户以为刚测过');
  });

  it('测试成功与失败都要持久化（fire-and-forget，失败只 logWarn）', () => {
    const testStart = CODE.indexOf('const handleTest = useCallback(');
    const testEnd = CODE.indexOf('const handleSave = useCallback(');
    const body = CODE.slice(testStart, testEnd);
    const calls = body.match(/persistLastCheck\(/g) ?? [];
    assert.ok(
      calls.length >= 3,
      `成功与失败各写一次（含定义共 ≥3 处），实际 ${calls.length} 处 —— 只写成功会让「上次是绿灯」在下一次失败后继续误导`
    );
    assert.match(body, /\.catch\(/, 'fire-and-forget：落盘失败不得把成功的测试报成失败');
  });

  it('清除配置时一并失效上次结果（否则会播种一个不属于任何配置的绿灯）', () => {
    const forget = CODE.slice(
      CODE.indexOf('const handleForget = useCallback('),
      CODE.indexOf('const handleLock = useCallback(')
    );
    assert.match(forget, /setSavedCfg\(null\)/, '磁盘配置已无，本组件手上的 cfg 也要清');
    assert.match(forget, /setCheck\(\{ kind: 'idle' \}\)/, '上次测试结果必须一起失效');
  });
});

describe('A8 downloadReasonCopy 必须覆盖 backend_unknown（不得退化成裸枚举）', () => {
  it('SYNC_REASON_COPY 已登记 backend_unknown，且文案是人话', () => {
    const copy = SYNC_REASON_COPY.backend_unknown;
    assert.ok(typeof copy === 'string' && copy.length > 0, 'B 组登记的条目不能凭空消失');
    assert.match(copy, /读不到同步设置/, '口径必须与 syncPreviewView 保持一致');
    assert.doesNotMatch(copy, /^[a-z_]+$/, '不得是裸枚举');
  });

  it('面板的下载失败文案解析：backend_unknown ⇒ 人话而不是枚举原文', () => {
    const out = resolveSyncFailureCopy({
      reason: 'backend_unknown',
      fallbackMessage: '同步未成功，原因未如实报出；请稍后重试',
    });
    assert.equal(out, SYNC_REASON_COPY.backend_unknown, '必须命中同一份登记表');
    assert.ok(!out.includes('backend_unknown'), '用户不该看到机器码');
  });

  it('未登记的裸枚举 ⇒ 回退到人话（未来的新 reason 不会漏成枚举）', () => {
    const out = resolveSyncFailureCopy({
      reason: 'some_future_guard_code',
      fallbackMessage: '同步未成功，原因未如实报出；请稍后重试',
    });
    assert.ok(!out.includes('some_future_guard_code'), '未登记时也不得把机器码弹给用户');
    assert.match(out, /重试/);
  });

  it('组件不再自己维护第二张文案表', () => {
    const UI = read('src/components/sync/WebDavSettings.tsx');
    const CODE = UI.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    assert.match(
      CODE,
      /resolveSyncFailureCopy\(/,
      'downloadReasonCopy 必须委托 syncPreviewView 的唯一真源'
    );
    assert.ok(
      !/recent_upload_guard:\s*'/.test(CODE),
      '本地那张表不得复活 —— 两张表只在「有人同时改两处」时才一致'
    );
  });
});
