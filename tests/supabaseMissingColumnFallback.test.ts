// 「云端缺列」必须降级重试，而不是整条设置同步断掉
// —— 2026-10-20 审计 A-9 的相邻补丁（通用 42703 降级）。
//
// ── 真实缺陷 ────────────────────────────────────────────────────────────
// `user_settings` 这张表是早期直接在 Supabase Dashboard 建的，仓库里**没有
// CREATE TABLE**，它的列靠一份份 ALTER 迁移往上加：
//
//   theme_style            —— 20260125071141_add_theme_style_to_user_settings.sql
//   collect_pinned_tabs    —— 20260210072717_add_collect_pinned_tabs_to_user_settings.sql
//   sync_interval_minutes  —— 20261011190000_add_sync_interval_minutes_to_user_settings.sql
//
// 没跑迁移的库**没有那一列**，而 PostgREST 的 upsert 把整行一次发过去 ⇒
// Postgres 抛 `42703 undefined_column` ⇒ **整条设置同步死掉**
// （用户看到的是「设置同步失败」，而真实原因只是库里少一列）。
//
// 修复前只有 `collect_pinned_tabs` 一列有降级分支
// （`mentionsCollectPinned` 那个 if），`theme_style` 与
// `sync_interval_minutes` 缺列的库照样断。
// 而 `download.ts` 的注释写着「上传侧有 42703 降级（缺列则忽略该字段重试），
// 所以迁移前后都不阻塞同步」—— **那句话对除 collect_pinned_tabs 外的列不准确**。
//
// ── 修法 ────────────────────────────────────────────────────────────────
// 通用规则：认出缺的是哪一列 → 剔掉 → 重试；重试还报 42703 就再剔一列
// （Postgres 只报**第一个**缺列，同时缺两列时一次只剔一列会卡在第二列上）。
// 受保护列（user_id / device_id / last_sync）永不剔除 —— user_id 是主键兼
// upsert 的冲突键，剔了就不是 upsert 了。
//
// 判定与剔除抽成纯函数 + 可测的上传包装（`utils/supabase/missingColumn.ts`），
// 这样能直接用替身驱动**真实行为**，而不是靠读源码猜。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildDowngradedBody,
  collectErrorText,
  extractMissingColumn,
  findDroppableColumn,
  isProtectedColumn,
  isUndefinedColumnError,
  MAX_COLUMN_DOWNGRADE_ATTEMPTS,
  PROTECTED_UPLOAD_COLUMNS,
  upsertWithMissingColumnFallback,
  type UpsertOutcome,
} from '../src/utils/supabase/missingColumn.ts';

const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/**
 * 造一个「云端库」的替身：只有 dbColumns 里的列存在。
 * 发过去的 body 里只要有它不认识的列，就报 42703 并点名那一列。
 */
function makeFakeUpsert(dbColumns: string[]) {
  const attempts: Array<Record<string, unknown>> = [];
  const upsert = async (body: Record<string, unknown>): Promise<UpsertOutcome> => {
    attempts.push({ ...body });
    for (const key of Object.keys(body)) {
      if (!dbColumns.includes(key)) {
        return {
          data: null,
          error: {
            code: '42703',
            message: `column user_settings.${key} does not exist`,
            details: '',
            hint: '',
          },
        };
      }
    }
    return { data: [{ user_id: body.user_id }], error: null };
  };
  return { upsert, attempts };
}

const FULL_PAYLOAD: Record<string, unknown> = {
  user_id: 'u-1',
  device_id: 'd-1',
  last_sync: '2026-10-20T00:00:00.000Z',
  show_favicons: true,
  show_tab_count: true,
  confirm_before_delete: true,
  sync_interval_minutes: 10,
  sync_enabled: false,
  layout_mode: 'single',
  show_notifications: false,
  theme_mode: 'auto',
  theme_style: 'legacy',
  collect_pinned_tabs: false,
};

describe('认出「云端缺的那一列」', () => {
  it('能认出 PostgREST 报文里的列名（带表名前缀）', () => {
    assert.equal(
      extractMissingColumn({
        code: '42703',
        message: 'column user_settings.sync_interval_minutes does not exist',
      }),
      'sync_interval_minutes'
    );
  });

  it('能认出带引号、不带表名前缀的列名', () => {
    assert.equal(
      extractMissingColumn({ code: '42703', message: 'column "theme_style" does not exist' }),
      'theme_style'
    );
  });

  it('能认出 error.column 里直接给的列名', () => {
    assert.equal(
      extractMissingColumn({ code: '42703', column: 'collect_pinned_tabs' }),
      'collect_pinned_tabs'
    );
  });

  it('认不出时返回 null（不瞎猜）', () => {
    assert.equal(extractMissingColumn({ code: '23502', message: 'null value in column "x"' }), null);
    assert.equal(extractMissingColumn(null), null);
    assert.equal(extractMissingColumn('随便什么'), null);
  });

  it('只认 42703 —— 别的错误码不是「缺列」', () => {
    assert.ok(isUndefinedColumnError({ code: '42703' }));
    assert.ok(!isUndefinedColumnError({ code: '23502' }));
    assert.ok(!isUndefinedColumnError({ code: '42501' })); // RLS 拒绝
    assert.ok(!isUndefinedColumnError(null));
  });

  it('错误文本收集会把 message / details / hint 都算进去', () => {
    const text = collectErrorText({
      message: 'column A does not exist',
      details: 'DETAIL',
      hint: 'HINT',
    });
    assert.match(text, /column a does not exist/);
    assert.match(text, /detail/);
    assert.match(text, /hint/);
  });
});

describe('剔除时的安全边界', () => {
  it('受保护列永不被剔', () => {
    for (const column of PROTECTED_UPLOAD_COLUMNS) {
      assert.ok(isProtectedColumn(column), `${column} 必须受保护`);
      const body = { ...FULL_PAYLOAD };
      assert.equal(buildDowngradedBody(body, column), null, `${column} 不许被剔`);
      assert.ok(column in body, `${column} 必须留在载荷里`);
    }
  });

  it('剔列不改原载荷（返回的是新对象）', () => {
    const body = { ...FULL_PAYLOAD };
    const next = buildDowngradedBody(body, 'theme_style');
    assert.ok(next);
    assert.equal(next.theme_style, undefined);
    assert.ok('theme_style' in body, '原载荷不许被就地改');
  });

  it('载荷里没有的列不剔（否则重试会带着同样的错误）', () => {
    assert.equal(buildDowngradedBody({ ...FULL_PAYLOAD }, 'no_such_column'), null);
  });

  it('兜底找列时也不会挑中受保护列', () => {
    const error = {
      code: '42703',
      message: 'column user_settings.user_id does not exist',
    };
    assert.equal(findDroppableColumn(error, { ...FULL_PAYLOAD }), null);
  });

  it('认不出是哪一列时不得瞎删一列（那会删掉一个还活着的列）', () => {
    // 变异验证：把「认不出」改成「随便挑一个非受保护的列删掉」。
    // 那样会在报文根本没说缺哪列时删掉 theme_mode 之类**还活着**的列 ——
    // 设置悄悄少了一项，而用户毫不知情。
    //
    // 【为什么要用一个「活列排在前面」的载荷】真实载荷里 user_id /
    // device_id / last_sync 总是排在最前，所以「瞎挑第一个」很可能挑到
    // 受保护列 ⇒ 被保护名单挡下 ⇒ 这个缺陷形状碰巧不发作。
    // 要真正测到它，载荷必须让**活列**排在受保护列前面。
    const error = {
      code: '42703',
      message: 'undefined column', // 没说缺哪一列
    };
    const bodyWithLiveColumnFirst = {
      show_favicons: true,
      theme_style: 'legacy',
      user_id: 'u-1',
      device_id: 'd-1',
    };
    assert.equal(
      findDroppableColumn(error, bodyWithLiveColumnFirst),
      null,
      '认不出是哪一列时必须返回 null —— 不许瞎删一个还活着的列'
    );
  });

  it('认出来的列必须真的是错误提到的那一列（不许与报文无关）', () => {
    // 上面那条的加强版：**任何**载荷下，返回的列都必须在错误文本里被提到过。
    // 这是「删列」这件事唯一能站得住的理由 ——
    // 删一个错误没提到的列 = 删掉一个还活着的设置。
    const error = {
      code: '42703',
      message: 'column user_settings.theme_style does not exist',
    };
    const column = findDroppableColumn(error, { ...FULL_PAYLOAD });
    assert.ok(column);
    assert.match(
      String(error.message),
      new RegExp(column, 'i'),
      '认出来的列必须在错误文本里被提到过 —— 否则就是瞎删'
    );
  });

  it('报文提到列名、但不是「does not exist」句式时也必须认得出', () => {
    // 兜底路径（按列名做子串匹配）存在的理由：PostgREST / 网关层报出的
    // 缺列文案不止一种句式。只要报文里提到了载荷中的列名，就该认出来。
    // 变异验证：把兜底改回「只认 collect_pinned_tabs 一列」——
    // 这正是修复前的缺陷形状（只有一列能降级，其余缺列的库照样断）。
    const error = {
      code: '42703',
      message: "schema cache has no entry for 'theme_style'",
    };
    assert.equal(
      findDroppableColumn(error, { ...FULL_PAYLOAD }),
      'theme_style',
      '报文提到哪个列名，就得认出哪个 —— 不能只认某一列'
    );
  });
});

describe('上传降级：缺列就剔掉再试', () => {
  it('缺 theme_style 的库：剔掉该列后上传成功', async () => {
    const dbColumns = Object.keys(FULL_PAYLOAD).filter(c => c !== 'theme_style');
    const { upsert, attempts } = makeFakeUpsert(dbColumns);

    const result = await upsertWithMissingColumnFallback(upsert, { ...FULL_PAYLOAD });

    assert.equal(result.error, null, '缺一列不该让整条设置同步断掉');
    assert.deepEqual(result.droppedColumns, ['theme_style']);
    assert.equal(attempts.length, 2, '第一次失败 → 剔列后重试一次');
    assert.ok(!('theme_style' in (attempts[1] as Record<string, unknown>)));
  });

  it('缺 sync_interval_minutes 的库：剔掉该列后上传成功', async () => {
    // 这一列是修复前**完全没有**降级分支的（只有 collect_pinned_tabs 有）——
    // 迁移 20261011190000 没跑的库会直接断掉整条设置同步。
    const dbColumns = Object.keys(FULL_PAYLOAD).filter(c => c !== 'sync_interval_minutes');
    const { upsert } = makeFakeUpsert(dbColumns);

    const result = await upsertWithMissingColumnFallback(upsert, { ...FULL_PAYLOAD });

    assert.equal(result.error, null);
    assert.deepEqual(result.droppedColumns, ['sync_interval_minutes']);
  });

  it('原来的 collect_pinned_tabs 降级不能被改坏', async () => {
    const dbColumns = Object.keys(FULL_PAYLOAD).filter(c => c !== 'collect_pinned_tabs');
    const { upsert } = makeFakeUpsert(dbColumns);

    const result = await upsertWithMissingColumnFallback(upsert, { ...FULL_PAYLOAD });

    assert.equal(result.error, null);
    assert.deepEqual(result.droppedColumns, ['collect_pinned_tabs']);
  });

  it('同时缺两列时两列都要剔掉（Postgres 只报第一个缺列）', async () => {
    // 一次只剔一列的话，第二次重试会在另一列上再报 42703 ——
    // 而那一列没有降级分支的话，整条同步照断。
    const dbColumns = Object.keys(FULL_PAYLOAD).filter(
      c => c !== 'theme_style' && c !== 'sync_interval_minutes'
    );
    const { upsert, attempts } = makeFakeUpsert(dbColumns);

    const result = await upsertWithMissingColumnFallback(upsert, { ...FULL_PAYLOAD });

    assert.equal(result.error, null);
    assert.deepEqual(result.droppedColumns.sort(), ['sync_interval_minutes', 'theme_style']);
    assert.equal(attempts.length, 3, '两次失败 → 两次降级 → 第三次成功');
  });

  it('不是 42703 的错误不许降级（真故障必须原样冒出去）', async () => {
    const rlsError = { code: '42501', message: 'new row violates row-level security policy' };
    let calls = 0;
    const upsert = async (): Promise<UpsertOutcome> => {
      calls += 1;
      return { data: null, error: rlsError };
    };

    const result = await upsertWithMissingColumnFallback(upsert, { ...FULL_PAYLOAD });

    assert.equal(result.error, rlsError, 'RLS 拒绝必须原样抛出去');
    assert.equal(calls, 1, '不该重试');
    assert.deepEqual(result.droppedColumns, []);
  });

  it('缺的是受保护列时：不剔、不重试、错误原样抛出', async () => {
    let calls = 0;
    const upsert = async (): Promise<UpsertOutcome> => {
      calls += 1;
      return {
        data: null,
        error: { code: '42703', message: 'column user_settings.user_id does not exist' },
      };
    };

    const result = await upsertWithMissingColumnFallback(upsert, { ...FULL_PAYLOAD });

    assert.ok(result.error, '错误必须冒出去');
    assert.deepEqual(result.droppedColumns, []);
    assert.equal(calls, 1, '受保护列不许剔 ⇒ 一次就停');
  });

  it('循环有界：永远报同一个缺列时不会无限转', async () => {
    let calls = 0;
    const upsert = async (): Promise<UpsertOutcome> => {
      calls += 1;
      return {
        data: null,
        error: { code: '42703', message: 'column user_settings.theme_style does not exist' },
      };
    };

    const result = await upsertWithMissingColumnFallback(upsert, { ...FULL_PAYLOAD });

    assert.ok(result.error, '永远失败时错误必须冒出去');
    assert.ok(
      calls <= MAX_COLUMN_DOWNGRADE_ATTEMPTS + 1,
      `重试次数必须有界（实际 ${calls} 次）—— 不能变成无限循环`
    );
  });

  it('降级不得就地改调用方的载荷', async () => {
    const payload = { ...FULL_PAYLOAD };
    const dbColumns = Object.keys(FULL_PAYLOAD).filter(c => c !== 'theme_style');
    const { upsert } = makeFakeUpsert(dbColumns);

    await upsertWithMissingColumnFallback(upsert, payload);

    assert.equal(payload.theme_style, 'legacy', '调用方的载荷不许被就地改');
  });

  it('**任意**设置列缺了都要能降级（不许只认某一列）', async () => {
    // 变异验证：把兜底认列改回「只认 collect_pinned_tabs 一列」
    // —— 那正是修复前的缺陷形状（只有一列有降级分支）。
    // 这条把**每一列**都跑一遍，任何一列不被认出来就红。
    const settingColumns = Object.keys(FULL_PAYLOAD).filter(
      c => !PROTECTED_UPLOAD_COLUMNS.includes(c as never)
    );
    assert.ok(settingColumns.length >= 8, `设置列不该只有这几列（实际 ${settingColumns.length}）`);

    for (const column of settingColumns) {
      const dbColumns = Object.keys(FULL_PAYLOAD).filter(c => c !== column);
      const { upsert } = makeFakeUpsert(dbColumns);

      const result = await upsertWithMissingColumnFallback(upsert, { ...FULL_PAYLOAD });

      assert.equal(
        result.error,
        null,
        `缺 ${column} 的库必须能降级上传 —— 只认某一列会让其余缺列的库整条同步断掉`
      );
      assert.deepEqual(
        result.droppedColumns,
        [column],
        `缺 ${column} 时应当只剔掉那一列`
      );
    }
  });
});

describe('接线：上传路径必须走通用降级', () => {
  it('upload.ts 必须用通用降级包装', () => {
    const upload = read('src/utils/supabase/upload.ts');
    assert.match(
      upload,
      /from '\.\/missingColumn'/,
      'upload.ts 必须引入通用缺列降级'
    );
    assert.match(
      upload,
      /upsertWithMissingColumnFallback\(/,
      'upload.ts 必须调用通用降级包装'
    );
  });

  it('upload.ts 里不得再有「只认 collect_pinned_tabs」的单列分支', () => {
    // 那正是原缺陷的形状：只有一列有降级，其余缺列的库照样断。
    const upload = read('src/utils/supabase/upload.ts');
    assert.ok(
      !/mentionsCollectPinned/.test(upload),
      '单列特判已被通用规则取代 —— 留着它会让「只有一列能降级」的错觉继续存在'
    );
    assert.ok(
      !/unusedCollectPinnedTabs/.test(upload),
      '单列特判的残留变量必须一并清掉'
    );
  });

  it('download.ts 的注释不得再宣称「上传侧有 42703 降级」却不说范围', () => {
    // 原来那句注释对除 collect_pinned_tabs 外的列不准确 ——
    // 注释在骗人比没有注释更糟。
    const download = read('src/utils/supabase/download.ts');
    const index = download.indexOf('上传侧有 42703 降级');
    assert.ok(index > 0, 'download.ts 里应有「上传侧有 42703 降级」这句说明');
    const around = download.slice(Math.max(0, index - 200), index + 300);
    assert.ok(
      /任意|任何/.test(around),
      '注释必须说清降级覆盖的是**任意**缺列，而不是只有某一列'
    );
  });
});
