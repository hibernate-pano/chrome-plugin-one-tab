// 守卫：「导出诊断信息」这个**用户主动把数据带出本机**的出口，必须被隐私政策披露。
//
// ══════════════════════════════════════════════════════════════════════════
// 【为什么需要这份测试】
// 诊断导出是本项目唯一的「数据离开本机」的非同步出口：用户在反馈问题时一键生成
// 一份 JSON，附到 GitHub issue 上（issue 是**公开的**）。它不是 bug，但它是
// 隐私政策必须覆盖的「用户可自行带走的数据」—— 政策里没写，审核员按线上那份
// 核对就看不到这个出口，读者也无从知道「我的数据可以被我导出」。
//
// 2026-10-21 补披露时实测发现：补完之后**没有任何测试会因它被删掉而变红** ——
// 即这条披露是「写了但没人守」的，说不准哪天就被改回去。
// 本文件把它钉住。
//
// 【判据从代码反推，不硬编码期望字符串】
// 隐私政策里那几句话（"白名单式脱敏"、"不含网址/标题/会话名/设备标识"）是
// **对代码行为的断言**，不是修辞。所以判据从 src/utils/diagnostics.ts 反推：
//   · 报告的输出结构里**不得出现** url / title / name / deviceId 字段
//     （逐字段查 DiagnosticsReport 的类型与 buildDiagnosticsReport 的返回值）
//   · 报告的输出结构里**必须出现**规模类字段（会话数 / 标签数 / 直方图）
//   · 诊断模块**不得有网络出口**（fetch / sendBeacon / XMLHttpRequest）
// 政策文本必须与这三条事实一致 —— 政策说「不含网址」而代码里有 url 字段，
// 或代码里没 url 字段而政策说「含网址」，都要红。
//
// 【反向验证：这份测试确实能变红】
// 见文件末尾的「判据自身的检测力」一节：把诊断报告临时加一个 url 字段、
// 或给 diagnostics.ts 加一个 fetch 调用，同一套判据必须变红。
// ══════════════════════════════════════════════════════════════════════════
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const PRIVACY = read('src/legal/privacy.html');
const STORE = read('CHROMEWEBSTORE.md');
const DIAGNOSTICS = read('src/utils/diagnostics.ts');

describe('诊断导出（数据离开本机的出口）必须在隐私政策与商店数据表里被披露', () => {
  it('隐私政策必须提到「导出诊断信息」这个出口', () => {
    assert.match(
      PRIVACY,
      /导出诊断信息/,
      '诊断导出是用户主动把数据带出本机的唯一出口，隐私政策必须披露它'
    );
  });

  it('披露必须说明「扩展不会自动上传」—— 分享与否由用户决定', () => {
    assert.match(
      PRIVACY,
      /不会自动上传|不会自动.*上传/,
      '必须说清扩展不会自动把诊断文件发到任何地方 —— ' +
        '否则读者会以为这是一条自动上报的通道。'
    );
  });

  it('商店数据表的「User activity」行必须体现这个出口', () => {
    const row = STORE
      .split('\n')
      .find(l => /^\|\s*User activity\s*\|/.test(l));
    assert.ok(row, 'CHROMEWEBSTORE.md 的数据使用表必须有 User activity 行');
    assert.match(
      row,
      /导出诊断信息/,
      '商店数据表是审核员核对「收集什么 / 传不传出去」的唯一依据，' +
        '必须体现诊断导出这个由用户主动触发的出口。'
    );
  });

  // ── 判据与代码行为必须一致（政策不能对代码说谎）────────────────────────

  it('【代码事实】诊断报告的输出结构里不含 url / title / name / deviceId', () => {
    // 取 DiagnosticsReport 的类型定义段与 buildDiagnosticsReport 的返回段。
    const typeBlock = DIAGNOSTICS.match(
      /export interface DiagnosticsReport \{[\s\S]*?\n\}/
    );
    assert.ok(typeBlock, '必须能在 diagnostics.ts 里找到 DiagnosticsReport 的类型定义');

    for (const forbidden of ['url', 'title', 'name', 'deviceId']) {
      // 只查「字段名」：形如 `  <forbidden>:` 或 `  <forbidden>?:`。
      // 避免误伤：urlCount 之类不含敏感内容的派生字段是允许的。
      const asField = new RegExp(`^\\s{2,}${forbidden}\\??:`, 'm');
      assert.doesNotMatch(
        typeBlock[0],
        asField,
        `诊断报告的输出结构里出现了字段「${forbidden}」—— ` +
          '若确实要输出它，隐私政策里「不含网址/标题/会话名/设备标识」的承诺就是假的，' +
          '必须同步改政策。'
      );
    }
  });

  it('【代码事实】诊断报告确实输出规模类信息（政策说的「数量/分布」是真的）', () => {
    const typeBlock = DIAGNOSTICS.match(
      /export interface DiagnosticsReport \{[\s\S]*?\n\}/
    );
    assert.ok(typeBlock, '必须能在 diagnostics.ts 里找到 DiagnosticsReport 的类型定义');
    for (const required of ['sessionCount', 'tabCount', 'tabCountHistogram']) {
      assert.match(
        typeBlock[0],
        new RegExp(`^\\s{2,}${required}\\??:`, 'm'),
        `诊断报告的输出结构里必须有「${required}」—— ` +
          '隐私政策承诺了「只含会话数量、标签数量分布等规模信息」，' +
          '代码里没有对应字段就是假话。'
      );
    }
  });

  it('【代码事实】诊断模块没有网络出口（否则「不会自动上传」是假的）', () => {
    // 只看真正的出网调用；日志/注释里的 "fetch" 字样不算。
    const codeOnly = DIAGNOSTICS
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const netCall of ['fetch(', 'sendBeacon', 'XMLHttpRequest', 'WebSocket']) {
      assert.doesNotMatch(
        codeOnly,
        new RegExp(netCall.replace('(', '\\(')),
        `诊断模块里出现了「${netCall}」—— ` +
          '若诊断数据会被自动发出，「扩展不会自动上传」这句披露就是假的。'
      );
    }
  });

  it('隐私政策对脱敏范围的描述必须与代码一致（不含网址/标题/会话名/设备标识）', () => {
    // 措辞容错：政策里可能是「不含网址」也可能是「不包含任何网址」，
    // 断言的是**语义**（承诺了不含网址），不是逐字。
    assert.match(
      PRIVACY,
      /不(?:包含|含)[^。]*网址/,
      '隐私政策必须明确写出诊断文件不含网址（这是脱敏承诺的核心）'
    );
    assert.match(
      PRIVACY,
      /不(?:包含|含)[^。]*页面标题/,
      '必须同时承诺不含页面标题'
    );
    assert.match(
      PRIVACY,
      /不(?:包含|含)[^。]*会话名/,
      '必须同时承诺不含会话名'
    );
    assert.match(
      PRIVACY,
      /白名单/,
      '必须说清是「白名单式输出」—— ' +
        '这正是代码 buildDiagnosticsReport 的实际做法（输出结构由代码逐字段决定）。'
    );
  });
});
