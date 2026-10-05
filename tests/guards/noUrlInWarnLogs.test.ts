// 生产日志不得包含完整 URL（2026-10-05）。
//
// 【为什么这条门禁值得存在】
// vite.config.ts 只 drop 了 console.log / info / debug —— **logWarn 与
// logError 直通生产构建的 console**。这意味着用户报障时把控制台截图贴到
// 公开 issue（GitHub issue / 论坛 / 客服聊天），就等于公开他访问过哪些站点。
//
// favicon 的 URL 列表本身就是浏览历史的一部分：`https://intranet.corp/internal/
// hr/salary?year=2026` 这一条就同时泄露了「他在一家公司」+「他看薪资页」。
// 虽然它没出网，但用户会认为「日志都是本地的话贴出来没关系」—— 这个假设
// 是错的，而我们的隐私政策承诺的是「不上传浏览记录」。
//
// 【规则】logWarn / logError 的参数里不得直接出现完整 URL 变量；
// 允许的两种形态：
//   ① 域名级（origin）：`https://example.com` —— 排障够用，路径与查询串已剥掉
//   ② 结构性描述：如「危险协议 data:」—— 不含任何用户数据
//
// 这不是「理论上不安全」，是**一次用户报障就会发生**的泄露。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 剥掉注释（注释里讨论 URL 是正常的） */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 变量名里带 url/path/href 的一律视为「可能含用户地址」 */
const URLISH = /\b(rawUrl|singleUrl|cleanUrl|tabUrl|theUrl|pageUrl|href|src)\b/;

describe('生产日志脱敏：logWarn / logError 不得带完整 URL', () => {
  const files = walk(join(ROOT, 'src'));

  it('扫到零处「把 URL 变量直接拼进 logWarn/logError」', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = relative(ROOT, f);
      // 日志实现自身与诊断导出（白名单式、已逐字段控制）豁免
      if (rel === 'src/utils/log.ts') continue;
      const lines = stripComments(readFileSync(f, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        if (!/log(Warn|Error)\(/.test(line)) return;
        if (!URLISH.test(line)) return;
        // 形如 `${origin}` / `${safeLabel(...)}` 的是已脱敏的产物，放过
        if (/\$\{[^}]*\}/.test(line) && !/\$\{\s*(rawUrl|singleUrl|cleanUrl|tabUrl|theUrl|pageUrl|href|src)\s*\}/.test(line)) {
          return;
        }
        offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 90)}`);
      });
    }
    assert.deepEqual(
      offenders,
      [],
      '这些日志会把完整 URL（可能含路径与查询串 = 浏览历史）写进用户可见的控制台：\n' +
        offenders.join('\n') +
        '\n\n修法：只打 origin（`${u.protocol}//${u.host}`），或打不含用户数据的结构性描述。'
    );
  });

  it('vite 只 drop log/info/debug —— 因此 warn/error 确实直达用户控制台（本门禁的前提）', () => {
    // 如果哪天改成全量 drop，这条门禁的前提就变了（可以放宽），但先让它显式失败，
    // 免得悄悄失效。
    const vite = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
    assert.match(vite, /drop/, 'vite 应仍在 drop 生产 console 方法');
    // 确认 drop 列表里**没有** warn / error
    const dropBlock = vite.slice(vite.indexOf('drop'), vite.indexOf('drop') + 400);
    assert.ok(
      !/['"]\s*(warn|error)\s*['"]/.test(dropBlock),
      '如果 warn/error 也被 drop，这条门禁的前提需要重新评估（脱敏仍值得做，但不再是「一次报障就泄露」）'
    );
  });

  it('favicon 日志已脱敏为 origin（回归本文件要防的那具体一处）', () => {
    const src = stripComments(readFileSync(join(ROOT, 'src/utils/faviconUtils.ts'), 'utf8'));
    const logLines = src.split('\n').filter(l => /logWarn\(/.test(l));
    assert.ok(logLines.length >= 2, '应有多处 favicon 日志');
    for (const l of logLines) {
      assert.ok(
        !/\$\{cleanUrl\}/.test(l),
        `favicon 日志仍打完整 URL：${l.trim().slice(0, 80)}`
      );
    }
    assert.match(src, /safeLabel/, '应有 safeLabel 之类的 origin 提取函数');
  });

  it('TabManager.openTab 的通知与日志都不含完整 URL', () => {
    const src = stripComments(readFileSync(join(ROOT, 'src/background/TabManager.ts'), 'utf8'));
    const start = src.indexOf('async openTab(');
    assert.ok(start !== -1);
    const body = src.slice(start, start + 1200);
    assert.ok(
      !/message:[\s\S]{0,120}\$\{url\}/.test(body) && !/\$\{shown\}/.test(body),
      '通知文案里不得直接展示完整 URL（路径/查询串对判断「为什么打不开」没有增量）'
    );
    assert.match(body, /origin/, '应提取 origin 后再展示');
  });
});
