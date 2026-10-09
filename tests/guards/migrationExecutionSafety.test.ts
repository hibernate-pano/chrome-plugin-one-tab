// 迁移的**可执行性**门禁（2026-10-05 晚）。
//
// 【本文件要防的回归类别】今天下午我给 supabase/migrations 加了两条迁移，
// 静态检查（单引号配对、定界符配对）与 `--dry-run` 全部通过，
// 但**真连库执行时连续炸了三次**：
//
//   1. `REVOKE … FROM anon` 在 anon 角色不存在的库上直接
//      ERROR: role "anon" does not exist → 单事务回滚 → 留下「函数建了
//      但权限没收回」的半成品，比不跑更危险（它看起来跑过了）。
//   2. `RAISE NOTICE '已到期（>% 天）…', v_ttl, v_count` —— RAISE 把 % 当占位符，
//      `>%` 被解析成「> 加一个参数」⇒ ERROR: too few parameters。
//   3. `SELECT array_agg(r) … FROM unnest(ARRAY[…]) AS r WHERE … r.oid` ——
//      集合别名在同层 WHERE 不可见 ⇒ missing FROM-clause entry for table "r"。
//
// 而 supabase-migrate.mjs 的 verify 脚本自己也栽了两次（同样是"只读代码/静态
// 看不出来"）：
//   4. `ARRAY(SELECT rolname … WHERE r.oid = ANY(...))` —— 同 3。
//   5. **`pg_policy.polqual` 不是可读文本，是 pg_node_tree**：
//      USING (true) 存成 `{CONST :constvalue 1 [ 1 0 0 …]}`，所以
//      `polqual === 'true'` 永远不成立 ⇒ verify **漏检**，会报「profiles ✓」
//      而库里明明还有全放行策略。漏检比报错危险得多。
//
// 这类错误只有真连 PostgreSQL 才暴露。本文件把「能在不连库的情况下发现的」
// 全部固化成门禁，剩下的靠真实执行验证（见 docs 的执行记录）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

/** 剥注释：注释里写示例 SQL 很正常，不该被判为代码 */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const MIGRATION = 'supabase/migrations/20261005000001_purge_expired_tombstones.sql';

describe('迁移可执行性：REVOKE 必须容忍角色不存在', () => {
  it('不得对可能不存在的角色裸写 REVOKE/GRANT', () => {
    const src = code(MIGRATION);
    const bare = [...src.matchAll(/^\s*(REVOKE|GRANT)\s+EXECUTE[^;]*\b(anon|authenticated|service_role)\b[^;]*;/gim)];
    assert.deepEqual(
      bare.map(m => m[0].trim()),
      [],
      '这些语句在角色不存在的库上会 ERROR 并回滚整条迁移。' +
        '必须包在 DO $body$ … $body$ 里、用 pg_roles 判存在性后再 EXECUTE。'
    );
  });

  it('用了 DO 块 + 角色存在性判断', () => {
    const src = code(MIGRATION);
    assert.match(
      src,
      /IF NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'anon'\) THEN/,
      '必须先判断 anon 角色是否存在再 REVOKE'
    );
    assert.match(
      src,
      /EXECUTE 'REVOKE EXECUTE ON FUNCTION public\.purge_expired_cloud_tombstones\(\) FROM anon'/,
      '角色存在时用动态 EXECUTE 执行 REVOKE'
    );
  });

  it('PUBLIC 是内建角色、恒存在，允许裸写（但要写在一起以便审查）', () => {
    const src = code(MIGRATION);
    // PUBLIC 单独 REVOKE 是安全的，不要求进 DO 块
    assert.match(src, /REVOKE EXECUTE ON FUNCTION public\.purge_expired_cloud_tombstones\(\) FROM PUBLIC;/);
  });
});

describe('迁移可执行性：RAISE 的占位符数量必须与参数匹配', () => {
  it('不得在 RAISE 文案里出现裸 %> 或 %< （会被当占位符）', () => {
    const src = read(MIGRATION); // 保留注释：这里要连注释一起扫
    const lines = src.split('\n');
    const offenders: string[] = [];
    lines.forEach((l, i) => {
      if (!/RAISE\s+(NOTICE|WARNING|EXCEPTION)/i.test(l)) return;
      // 文案里除合法的 %s/%I/%L 与占位符 % 之外，不该有 % 紧跟 > < ( 等符号
      if (/%[><(){}]/.test(l)) {
        offenders.push(`第 ${i + 1} 行: ${l.trim().slice(0, 90)}`);
      }
    });
    assert.deepEqual(
      offenders,
      [],
      'RAISE 文案里的「%>」会被解析成「> 加一个参数」⇒ too few parameters。' +
        '改用中文「超过 N 天」这类不含 % 的表述。\n' + offenders.join('\n')
    );
  });

  it('文案里的 % 个数与参数个数一致（2026-10-05 修正后：3 个 % 对 3 个参数）', () => {
    const src = read(MIGRATION);
    const line = src.split('\n').find(l => l.includes('已到期'));
    assert.ok(line, '应能找到统计墓碑行数的那条 RAISE');
    // 去掉格式说明符 %s / %I / %L 后数占位符
    const placeholders = (line.match(/%(?!s\b|I\b|L\b)/g) || []).length;
    const args = (line.match(/,\s*v_\w+/g) || []).length;
    assert.equal(
      placeholders,
      args,
      `占位符 ${placeholders} 个 vs 参数 ${args} 个。例句：${line.trim().slice(0, 100)}`
    );
  });
});

describe('迁移可执行性：集合别名不得在同层 WHERE 引用', () => {
  it('不得写 unnest(...) AS r 后在 WHERE 里用 r.oid', () => {
    const src = read(MIGRATION);
    // unnest 的别名在同一层查询的 WHERE 里不可见 —— 必须用 FOREACH 循环
    const bad = /FROM\s+unnest\s*\([^)]*\)\s+AS\s+(\w+)[\s\S]{0,200}?WHERE[^;]*\b\1\./i.test(src);
    assert.ok(!bad, '集合别名在同层 WHERE 不可见 ⇒ missing FROM-clause entry。改用 FOREACH 循环。');
  });

  it('用的是 FOREACH 循环', () => {
    assert.match(code(MIGRATION), /FOREACH\s+\w+\s+IN\s+ARRAY/);
  });
});

describe('verify 脚本：必须真的能检出问题（不能漏检）', () => {
  it('用 pg_get_expr 渲染 polqual，而不是直接比较 pg_node_tree 文本', () => {
    const src = code('scripts/supabase-migrate.mjs');
    assert.match(
      src,
      /pg_get_expr\(pol\.polqual,\s*pol\.polrelid\)/,
      'pg_policy.polqual 是 pg_node_tree（二进制节点树），USING (true) 存成 ' +
        '{CONST :constvalue 1 […]}。直接比较字符串永远不成立 ⇒ verify 漏检。'
    );
    assert.ok(
      !/polqual\s*===\s*'true'/.test(src),
      "不得把 polqual 当文本比较 —— 那会让 verify 在有全放行策略时仍报「✓」"
    );
  });

  it('角色名查询用全限定名（ARRAY(SELECT…) 形式下没有别名可用）', () => {
    const src = code('scripts/supabase-migrate.mjs');
    assert.ok(
      !/ARRAY\(SELECT\s+rolname[^)]*WHERE\s+r\.oid/i.test(src),
      'ARRAY(SELECT…) 形式下 r.oid 无定义 ⇒ missing FROM-clause entry'
    );
    assert.match(src, /pg_roles\.oid\s*=\s*ANY\(pol\.polroles\)/);
  });

  it('三项检查全部执行完再汇总（不得早退，否则后面的检查被跳过）', () => {
    const src = code('scripts/supabase-migrate.mjs');
    const verifyBody = src.slice(src.indexOf('async function verify('), src.indexOf('async function verifyProfilesRls'));
    // op-stamp 的失败分支不得 return
    const earlyReturns = [...verifyBody.matchAll(/missing columns or trigger'\)\);[\s\S]{0,40}?return false;/g)];
    assert.deepEqual(
      earlyReturns.map(m => m[0].slice(0, 60)),
      [],
      'op-stamp 检查失败时不得 return —— 否则 profiles/purge 检查根本没跑，' +
        '输出会让人以为「只有 op-stamp 有问题」'
    );
  });

  it('VERIFY OK 必须取决于实际检查结果（不得无条件报成功）', () => {
    const src = code('scripts/supabase-migrate.mjs');
    // 【2026-10-09 修正：不要绑死在具体检查项的字符串上】
    // 旧写法是 `src.slice(src.lastIndexOf('if (!okRls || !okPurge)'))`，把定位
    // 钉死在那三个变量的**拼写**上。给 verify 加一项检查（okRlsTables）后，
    // lastIndexOf 返回 -1 ⇒ slice(-1) 取到最后一个字符 ⇒ 断言失配报假红。
    // 变量怎么变都该不影响这条守卫 —— 它要守的是「VERIFY OK 受 ok 保护」
    // 这个**意图**，不是那行的字面量。
    //
    // 按意图断言：从最后一个 `if (!ok)` 开始到函数结束，必须是
    //   if (!ok) { …; return false; }
    //   console.log('…VERIFY OK…');
    //   return true;
    // 三件事缺一不可：有保护、保护里会 return false、成功文案在保护之后。
    const guardIdx = src.lastIndexOf('if (!ok)');
    assert.ok(guardIdx > -1, 'verify 里找不到 `if (!ok)` 保护 —— VERIFY OK 可能已无条件打印');
    const tail = src.slice(guardIdx);

    assert.match(
      tail,
      /if\s*\(\s*!ok\s*\)\s*\{/,
      'VERIFY OK 的打印必须在 `if (!ok)` 保护块之后 —— 无条件报成功就是「对没发生的事报成功」'
    );
    // 保护块内必须真的 return false（只判断不返回 = 检查了照样往下打印成功）
    const guardEnd = tail.indexOf('return false;');
    assert.ok(guardEnd > -1, '`if (!ok)` 保护块里没有 return false —— 查了但不影响结论');
    // 成功文案必须出现在保护之后（同一个 if 块之后，而不是之前）
    const okLogIdx = tail.indexOf('VERIFY OK');
    assert.ok(okLogIdx > guardEnd, 'VERIFY OK 出现在 `if (!ok)` 的 return false 之前 —— 无条件报成功');
  });

  it('连接串支持关闭 SSL（本地裸库才能验证迁移）', () => {
    const src = code('scripts/supabase-migrate.mjs');
    assert.match(
      src,
      /SUPABASE_DB_SSL/,
      '硬编码 ssl 会让本地裸 Postgres 连不上（"server does not support SSL"），' +
        '导致「执行前先本地验证」这件事做不到'
    );
  });
});
