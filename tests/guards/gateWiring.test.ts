// 工程门禁接线自检（2026-10-05）。
//
// 体检发现三类「看起来有门禁、实际不拦人」的问题：
//
//   1. 体积门从未接线：report-y-bundle.mjs 超预算只打印 ALERT 并 exit 0，
//      而且没有出现在 package.json / validate / CI 的任何一环。
//      docs/v2-plan.md 却写着「超预算阻断发布」——承诺与实现不符。
//   2. 单测 glob 只覆盖顶层：tests/*.test.ts 会**静默跳过**子目录里的测试，
//      没有任何报警。往子目录放测试 → 看起来有测试，实际没跑。
//   3. cws-publish 的 publish 分支不校验 HTTP 状态（upload 分支校验了）：
//      「提交审核」失败时脚本 exit 0，看起来是发过了。
//
// 本文件钉住修复后的接线。它自己住在子目录 tests/guards/ —— 如果 glob 又退回
// 顶层-only，本文件会第一个被静默跳过。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));

describe('门禁接线：首屏体积门', () => {
  it('脚本存在且超预算会 exit 1（不是只打印）', () => {
    const src = read('scripts/report-bundle-size.mjs');
    assert.ok(existsSync(resolve(ROOT, 'scripts/report-bundle-size.mjs')));
    assert.match(
      src,
      /if \(total > BUDGET_KB\)[\s\S]*?process\.exit\(1\)/,
      '超预算必须 process.exit(1) —— 只打印 ALERT 的门不是门'
    );
  });

  it('已接进 validate（否则本地 validate 通过但体积已超）', () => {
    assert.ok(
      pkg.scripts.validate.includes('check:bundle'),
      `validate 必须包含 check:bundle，当前是：${pkg.scripts.validate}`
    );
  });

  it('check:bundle 脚本存在', () => {
    assert.ok(
      pkg.scripts['check:bundle']?.includes('report-bundle-size.mjs'),
      `check:bundle 应指向新的体积门脚本，当前是：${pkg.scripts['check:bundle']}`
    );
  });

  it('旧的 report-y-bundle.mjs 已删除（它测的三个包已随影子链下线）', () => {
    assert.ok(
      !existsSync(resolve(ROOT, 'scripts/report-y-bundle.mjs')),
      'report-y-bundle.mjs 测的是 yjs/y-indexeddb/dexie 的体积，那三个包已删除，' +
        '脚本留着就是一个「测不存在的东西」的空门'
    );
  });

  it('CI 里显式跑一次体积门（validate 已含，这一步是为了日志里有逐文件清单）', () => {
    const ci = read('.github/workflows/verify.yml');
    assert.match(
      ci,
      /run:\s*pnpm check:bundle/,
      'CI 应显式跑一次体积门，便于超预算时在日志里直接看到是哪个 chunk 变肥'
    );
  });
});

describe('门禁接线：发版结果校验', () => {
  it('cws-publish 的 publish 分支校验 HTTP 状态并 exit 1', () => {
    const src = read('scripts/cws-publish.mjs');
    const pubIdx = src.indexOf("cmd === 'publish'");
    assert.ok(pubIdx !== -1, '应能找到 publish 分支');
    const branch = src.slice(pubIdx);
    assert.match(
      branch,
      /res\.status < 200 \|\| res\.status >= 300[\s\S]*?process\.exit\(1\)/,
      'publish 必须校验 2xx —— 「提交审核」是发版最关键的一步，失败时不能 exit 0'
    );
  });

  it('publish 还识别「200 但是 no-op」（空草稿）', () => {
    const src = read('scripts/cws-publish.mjs');
    const pubIdx = src.indexOf("cmd === 'publish'");
    const branch = src.slice(pubIdx);
    assert.match(
      branch,
      /NOT_FOUND/,
      '空草稿时 publish 返回 200 但是 no-op（见文件头踩坑记录），必须一并识别'
    );
  });
});

describe('门禁接线：validate 的完整性', () => {
  it('validate 仍包含原有的五道门（没有被这次改动挤掉）', () => {
    const v = pkg.scripts.validate;
    for (const gate of [
      'validate-extension.mjs',
      'type-check',
      'type-check:tests',
      'lint',
      'lint:tests',
      'build',
    ]) {
      assert.ok(v.includes(gate), `validate 丢了 ${gate} —— 当前是：${v}`);
    }
  });
});
