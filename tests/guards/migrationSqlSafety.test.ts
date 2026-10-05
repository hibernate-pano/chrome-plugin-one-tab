// 迁移 SQL 的机械安全性（2026-10-05）。
//
// 【本文件要防的那类 bug】20261005000000b 最初在 RAISE NOTICE 的字符串里写了
// 一段带 dollar-quote 定界符的示例命令（`$$SELECT …$$`）。而
// scripts/supabase-migrate.mjs 的切分器**只认 `$$` 作定界符、不看上下文**
// —— 字符串里再出现一次，就会在那个位置把整条语句切成两半，迁移在
// Dashboard 上执行时直接语法错误。
//
// 当时是安全审计 agent 发现的（我在写迁移时恰好用 `$$` 作定界符，习惯性
// 写进了示例里，dry-run 看着「正常」因为它只打印不执行）。
//
// 这类错误**必须自动化拦住**：人眼审 SQL 不会去数字符串里的定界符，而
// 「迁移在生产库上炸掉」的后果是隐私承诺（30 天清理）直接落空。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATIONS = resolve(ROOT, 'supabase/migrations');
const DOLLAR = '$$';

function sqlFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter(f => f.endsWith('.sql'))
    .map(f => join(MIGRATIONS, f));
}

describe('迁移 SQL：dollar-quote 定界符必须配对', () => {
  it('每个迁移文件里 `$$` 的出现次数是偶数（切分后不会产生裸露片段）', () => {
    for (const f of sqlFiles()) {
      const src = readFileSync(f, 'utf8');
      const count = src.split(DOLLAR).length - 1;
      assert.ok(
        count % 2 === 0,
        `${f}：\`$$\` 出现 ${count} 次（奇数）。切分器按 \`$$\` 切分且不看上下文，` +
          '字符串或注释里再出现一次会把语句切成两半，迁移执行时语法错误。' +
          '示例命令里请改用 $q$…$q$ 等不同定界符。'
      );
    }
  });

  it('每个语句片段里的单引号必须自闭合（腰斩会留下孤立引号）', () => {
    // 这比「首 token 是不是 SQL 关键字」本质得多：dollar-quote 从中间切开时，
    // 必然在某一段留下**未配对的单引号**（字符串被劈成两半），
    // 执行时报 unterminated quoted string。
    for (const f of sqlFiles()) {
      const src = readFileSync(f, 'utf8');
      const parts = src.split(DOLLAR);
      for (let i = 0; i < parts.length; i += 2) {
        // 去掉整行注释（注释里的引号会干扰计数）
        const codeOnly = parts[i]
          .split('\n')
          .filter(l => !l.trim().startsWith('--'))
          .join('\n');
        const quotes = (codeOnly.match(/'/g) || []).length;
        assert.ok(
          quotes % 2 === 0,
          `${f}：第 ${i / 2 + 1} 条语句里有 ${quotes} 个单引号（奇数）—— ` +
            '字符串被 dollar-quote 劈开了，执行时会报 unterminated quoted string。' +
            '片段内容：' + codeOnly.trim().slice(0, 100).replace(/\n/g, ' ')
        );
      }
    }
  });

  it('20261005000000b 的示例命令用 $q$ 而非 $$（回归本文件要防的具体那处）', () => {
    const f = join(MIGRATIONS, '20261005000000b_purge_expired_tombstones.sql');
    const src = readFileSync(f, 'utf8');
    assert.ok(
      src.includes('$q$SELECT public.purge_expired_cloud_tombstones()$q$'),
      'pg_cron 示例应用 $q$…$q$ 包裹内层命令'
    );
  });
});

describe('迁移 SQL：SECURITY DEFINER 函数必须收回 PUBLIC 的 EXECUTE', () => {
  /**
   * 为什么要这条：PostgreSQL 给新函数默认授予 EXECUTE 给 PUBLIC，而 PUBLIC
   * 包含 anon 与 authenticated。anon key 随扩展产物公开（设计如此），
   * 所以一个 SECURITY DEFINER + 真 DELETE 的函数若不 REVOKE，
   * 任何人都能通过 PostgREST /rest/v1/rpc/<fn> 让它替**所有账号**删数据。
   */
  it('20261005000000b 显式 REVOKE 了 PUBLIC / anon / authenticated', () => {
    const src = readFileSync(
      join(MIGRATIONS, '20261005000000b_purge_expired_tombstones.sql'),
      'utf8'
    );
    // 2026-10-05 晚更新：anon/authenticated 的 REVOKE 改用 **动态 EXECUTE**
    // （包在 DO 块里、判角色存在性后执行）—— 因为裸写 `REVOKE … FROM anon`
    // 在角色不存在的库上会 ERROR 并回滚整条迁移。所以这里匹配两种形态：
    //   ① 裸写：REVOKE EXECUTE ON FUNCTION … FROM anon;
    //   ② 动态：EXECUTE 'REVOKE EXECUTE ON FUNCTION … FROM anon'
    for (const role of ['PUBLIC', 'anon', 'authenticated']) {
      const bare = new RegExp(
        `REVOKE EXECUTE ON FUNCTION public\\.purge_expired_cloud_tombstones\\(\\) FROM ${role};`
      );
      const dynamic = new RegExp(
        `EXECUTE 'REVOKE EXECUTE ON FUNCTION public\\.purge_expired_cloud_tombstones\\(\\) FROM ${role}'`
      );
      assert.ok(
        bare.test(src) || dynamic.test(src),
        `必须 REVOKE ${role} —— 否则公开的 anon key 就能调用这个 DEFINER 函数删数据`
      );
    }
    // 调度器仍要能调
    assert.match(
      src,
      /(GRANT EXECUTE ON FUNCTION public\.purge_expired_cloud_tombstones\(\) TO service_role;|EXECUTE 'GRANT EXECUTE ON FUNCTION public\.purge_expired_cloud_tombstones\(\) TO service_role')/,
      '必须给 service_role 授权，否则调度器调不动'
    );
  });

  it('每个 SECURITY DEFINER 函数都要有对应的 REVOKE（同上风险的通用规则）', () => {
    // ⚠️ REVOKE 可能写在**后续**的加固迁移里（这正是本仓的既有做法：
    // 20260525151413_fix_security_definer_function.sql 与
    // 20260913132928_harden_guard_functions.sql 都补过 handle_new_user 的 REVOKE），
    // 所以必须扫描**全部**迁移文件，而不是只看定义所在那一个。
    //
    // 匹配两种形态（2026-10-05 晚）：① 裸写 `REVOKE … FROM x`；
    // ② 包在 DO 块里的动态 `EXECUTE 'REVOKE … FROM x'`（角色存在性判断后执行）。
    const allSql = sqlFiles().map(f => ({ f, src: readFileSync(f, 'utf8') }));
    const revoked = new Set<string>();
    for (const { src } of allSql) {
      // 形态 ①
      for (const m of src.matchAll(/REVOKE EXECUTE ON FUNCTION\s+([\w.]+)\s*\(\s*\)/gi)) {
        revoked.add(m[1].toLowerCase());
      }
      // 形态 ②：EXECUTE 'REVOKE EXECUTE ON FUNCTION x() FROM ...'
      for (const m of src.matchAll(
        /EXECUTE\s+'REVOKE EXECUTE ON FUNCTION\s+([\w.]+)\s*\(\s*\)/gi
      )) {
        revoked.add(m[1].toLowerCase());
      }
    }

    for (const { f, src } of allSql) {
      if (!/SECURITY\s+DEFINER/i.test(src)) continue;
      for (const m of src.matchAll(/CREATE OR REPLACE FUNCTION\s+([\w.]+)/g)) {
        const fn = m[1];
        if (!/SECURITY\s+DEFINER/i.test(src.slice(m.index, m.index + 600))) continue;
        assert.ok(
          revoked.has(fn.toLowerCase()),
          `${f}：${fn} 是 SECURITY DEFINER，但全部迁移里都没有对应的 REVOKE EXECUTE。` +
            '新函数默认对 PUBLIC（含 anon）可执行。若它确实该被客户端直接调用，' +
            '请显式 GRANT 给自己需要的角色，而不是靠默认的 PUBLIC。'
        );
      }
    }
  });
});
