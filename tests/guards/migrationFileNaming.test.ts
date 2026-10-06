// 迁移文件名的机械校验（2026-10-06）。
//
// 【本文件要防的那类 bug】`20261005000000b_purge_expired_tombstones.sql`
// 的时间戳后多了一个字母 `b`，不符合 supabase CLI 要求的
// `<timestamp>_name.sql` 模式。后果是**三重静默失败**：
//
//   ① `supabase migration list` 只打一行
//      `Skipping migration ... (file name must match pattern)` 就略过——
//      不报错、不中断，混在 20 多行表格里极易被刷屏冲掉；
//   ② `scripts/supabase-migrate.mjs` 当时用 readdirSync 读全部 .sql、
//      不看文件名，照跑不误；
//   ③ 测试全绿、构建通过、`db push` 不报错。
//
// 叠加结果：迁移文件躺在仓库里、所有人都以为它执行过了，而生产库上
// `purge_expired_cloud_tombstones()` **根本没建**——于是 README 承诺的
// 「30 天自动清理」是空的，墓碑行无限堆积（体检报告 P0-2）。
//
// 这类错误**必须自动化拦住**：文件名是否合法，人眼在文件列表里是看不出来的
// （`20261005000000b` 看起来就像个时间戳），而漏检的代价是隐私承诺落空。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATIONS = resolve(ROOT, 'supabase/migrations');

/**
 * 合法命名：`<14位时间戳>_<snake_case>.sql`（supabase CLI 的标准格式）。
 *
 * 【为什么还允许 8 位日期前缀】仓库里有三个历史文件用的是
 * `20260826_`、`20260909_`、`20260910_` 这种「8 位日期 + 下划线」格式。
 * 它们**不是**错误：CLI 接受这种短版本号，且 `supabase migration list` 对它们
 * 正常列出、不报 Skipping，台账里也已登记（本地=远端），说明当年确实执行过。
 * 改名会让版本号与台账失配（台账里是 `20260909`，文件却叫 `20260909120000`），
 * 风险大于收益——所以这里**放行**，只拦「时间戳后多一个字母」这类真错误。
 */
const VALID = /^(\d{8,14})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

/**
 * 时间戳后多出字母的形态：`20261005000000b_…`。
 * 这才是本次事故的形态——CLI 判定非法并静默跳过，测试与构建却全绿。
 * 单独一条规则，让报错信息直接指向这个具体坑。
 */
const MALFORMED = /^\d+[a-z]+_/;

function sqlFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter(f => f.endsWith('.sql'))
    .sort();
}

describe('迁移文件名：必须匹配 <时间戳>_<snake_case>.sql', () => {
  it('目录下每个 .sql 文件名都合法', () => {
    const invalid = sqlFiles().filter(f => !VALID.test(f));
    assert.deepEqual(
      invalid,
      [],
      `非法迁移文件名：${invalid.join(', ')}\n` +
        '时间戳后多一个字母（如 20261005000000b）会被 supabase CLI 静默跳过，' +
        '该迁移永远不会执行且不报错。改成纯数字时间戳即可。'
    );
  });

  it('没有任何迁移是「时间戳后多字母」形态（回归本文件要防的具体那处）', () => {
    // 这条比上面的通用规则更直白：错误信息能直接点出「多了一个字母」这个坑，
    // 而通用规则只会说「不合法」，后人得自己猜是哪一类。
    const malformed = sqlFiles().filter(f => MALFORMED.test(f));
    assert.deepEqual(
      malformed,
      [],
      `这些文件名的时间戳后带了字母：${malformed.join(', ')}\n` +
        'supabase CLI 会判定非法并**静默跳过**（只打一行 Skipping，不报错），' +
        '于是该迁移永远不会执行，而测试、构建、db push 全部显示正常。'
    );
  });

  it('purge 迁移用的是合法时间戳文件名（回归本文件要防的具体那处）', () => {
    // 曾经的 20261005000000b 已于 2026-10-06 改名为 20261005000001。
    const names = sqlFiles();
    assert.ok(
      names.includes('20261005000001_purge_expired_tombstones.sql'),
      'purge 迁移应为 20261005000001_purge_expired_tombstones.sql'
    );
    assert.ok(
      !names.includes('20261005000000b_purge_expired_tombstones.sql'),
      '旧的非法文件名不应仍存在（它会被 CLI 静默跳过）'
    );
  });

  it('文件名里的时间戳不得重复（重复会让「顺序即语义」失效）', () => {
    const seen = new Map<string, string[]>();
    for (const f of sqlFiles()) {
      const m = VALID.exec(f);
      if (!m) continue; // 非法名由上一个用例负责报错
      const version = m[1];
      seen.set(version, [...(seen.get(version) ?? []), f]);
    }
    const dupes = [...seen.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([v, files]) => `${v}: ${files.join(', ')}`);
    assert.deepEqual(dupes, [], `时间戳重复：${dupes.join(' | ')}`);
  });

  it('没有任何迁移引用已改名的旧路径（改了名就得同步引用方）', () => {
    // 防的是「只 git mv 了文件、忘了改引用」——那会让守卫测试自己指向不存在的
    // 文件而报错（还算好），但 scripts/ 与 docs/ 里的引用会静默失效。
    // 这里直接扫源码里出现的迁移文件名，逐个确认目标存在。
    const existing = new Set(sqlFiles());
    const sources = [
      'tests/guards/migrationSqlSafety.test.ts',
      'tests/guards/migrationExecutionSafety.test.ts',
      'tests/guards/tombstoneTtlConsistency.test.ts',
      'scripts/supabase-migrate.mjs',
    ];
    const missing: string[] = [];
    for (const rel of sources) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      for (const m of src.matchAll(/(\d{14}[a-z]*_[a-z0-9_]+\.sql)/g)) {
        const name = m[1];
        // 只查看起来像迁移名的完整串；带 b 的旧名允许出现在注释里（史实记录）。
        if (!existing.has(name) && !name.includes('20261005000000b')) {
          missing.push(`${rel} → ${name}`);
        }
      }
    }
    assert.deepEqual(missing, [], `引用了不存在的迁移文件：${missing.join(', ')}`);
  });
});
