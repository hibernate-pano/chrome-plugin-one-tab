// 「NOT NULL 违例」必须补值重试，而不是整条设置同步断掉
// —— 2026-10-20 审计 A-9 的相邻补丁（通用 23502 降级）。
//
// ── 真实缺陷 ────────────────────────────────────────────────────────────
// `user_settings` 里有几列可能是 **NOT NULL 且没有默认值**。那样 Postgres
// 在 upsert 的 INSERT 阶段就抛 `23502 not_null_violation` —— 哪怕这一行已存在、
// 最终走的是 `ON CONFLICT DO UPDATE` 分支，INSERT 阶段的检查先发生 ⇒
// **整条设置同步死掉**。
//
// A-9 把五个退役列从上传载荷里去掉了。「不再写」这件事本身**扩大**了 23502
// 的暴露面：以前我们写它们，写的是一个非 null 值；现在不写了，数据库那一列
// 就成了 null。
//
// 修复前这里是一份**硬编码的五个列名名单**，用「错误文本里包含列名」来判定
// 撞的是哪一列。两个问题：
//   ① **只认这几个列**。任何别的 NOT NULL 无默认列撞上 23502 时降级不命中
//      ⇒ 错误原样抛出 ⇒ 整条同步断掉。
//   ② **子串匹配整个错误文本** ⇒ 可能补错列。
//
// ── 修法 ────────────────────────────────────────────────────────────────
// 从错误里**认出撞的是哪一列** → 用**我们确实知道**的那个值补齐 → 重试；
// 重试还撞 23502 就再补一列（Postgres 一次只报一列撞规）。
// 我们**不知道**默认值的列不在表里 ⇒ 撞上时宁可失败，也不瞎填一个类型不对
// 的值（那等于换个姿势失败，还把库里那一行改坏了）。
//
// 判定与补值抽成纯逻辑 + 可测的上传包装（`utils/supabase/notNullFallback.ts`），
// 这样能直接用替身驱动**真实行为**。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildNotNullFallbackBody,
  collectNotNullErrorText,
  extractNotNullColumn,
  isNotNullViolation,
  upsertWithNotNullFallback,
  type UpsertOutcome,
} from '../src/utils/supabase/notNullFallback.ts';
import { SETTINGS_COLUMN_DEFAULTS } from '../src/utils/storage.ts';
import { RETIRED_SETTING_COLUMN_DEFAULTS } from '../src/types/tab.ts';

const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/**
 * 造一个「云端库」的替身：notNullColumns 里的列是 NOT NULL 且无默认值。
 *
 * 【关键：23502 的语义】Postgres 抛 23502 = 那一列的值是 **null**。
 * 一列值是 null 只有两种可能：载荷里**没有**它，或载荷里显式给了 null。
 * **载荷里带着非 null 值的那一列永远不会撞 23502。**
 * （这正是「按 payload 里出现的列名判定」对 23502 是反的：撞规的列
 *  恰恰是**不在** payload 里的那个。）
 */
function makeFakeUpsert(notNullColumns: string[]) {
  const attempts: Array<Record<string, unknown>> = [];
  const upsert = async (body: Record<string, unknown>): Promise<UpsertOutcome> => {
    attempts.push({ ...body });
    for (const column of notNullColumns) {
      const value = body[column];
      if (value === undefined || value === null) {
        return {
          data: null,
          error: {
            code: '23502',
            message: `null value in column "${column}" of relation "user_settings" violates not-null constraint`,
            details: `Failing row contains (${column})`,
            hint: '',
          },
        };
      }
    }
    return { data: [{ user_id: body.user_id }], error: null };
  };
  return { upsert, attempts };
}

const PAYLOAD: Record<string, unknown> = {
  user_id: 'u-1',
  device_id: 'd-1',
  last_sync: '2026-10-20T00:00:00.000Z',
  show_favicons: true,
  show_tab_count: true,
  confirm_before_delete: true,
  layout_mode: 'single',
  show_notifications: false,
  theme_mode: 'auto',
  theme_style: 'legacy',
  collect_pinned_tabs: false,
};

/**
 * 载荷里**没有**某一列时，它在数据库那一列上就是 null ⇒ 若该列 NOT NULL
 * 且无默认值，就撞 23502。
 *
 * 退役列的真实形状就是这样：A-9 之后我们**不再写**它们了 ⇒ 载荷里没有
 * ⇒ 值是 null ⇒ 撞 23502。
 */
function withoutColumn(payload: Record<string, unknown>, column: string): Record<string, unknown> {
  const next = { ...payload };
  delete next[column];
  return next;
}

describe('认出「撞 NOT NULL 的那一列」', () => {
  it('能认出带引号的列名（Postgres 的标准报文）', () => {
    assert.equal(
      extractNotNullColumn({
        code: '23502',
        message:
          'null value in column "theme_style" of relation "user_settings" violates not-null constraint',
      }),
      'theme_style'
    );
  });

  it('能认出不带引号的列名', () => {
    assert.equal(
      extractNotNullColumn({ code: '23502', message: 'null value in column group_name_template ' }),
      'group_name_template'
    );
  });

  it('认不出时返回 null（不瞎猜）', () => {
    assert.equal(extractNotNullColumn({ code: '23502', message: '随便什么' }), null);
    assert.equal(extractNotNullColumn(null), null);
  });

  it('details 里列出了整行时，必须认 message 里那一列', () => {
    // Postgres 的 23502 报文长这样：
    //   message: null value in column "theme_style" of relation "user_settings" ...
    //   details: Failing row contains (show_favicons, show_tab_count, ..., theme_style)
    // 「子串匹配整段错误文本」的实现会挑**第一个**出现在文本里的列名
    // （details 里排第一的 show_favicons）⇒ 补错列 ⇒ 白改一行还改错。
    // 撞规的那一列只写在 message 的 "null value in column" 后面。
    assert.equal(
      extractNotNullColumn({
        code: '23502',
        message:
          'null value in column "theme_style" of relation "user_settings" violates not-null constraint',
        details:
          'Failing row contains (show_favicons, show_tab_count, confirm_before_delete, theme_style)',
      }),
      'theme_style'
    );
  });

  it('只认 23502 —— 别的错误码不是「撞 NOT NULL」', () => {
    assert.ok(isNotNullViolation({ code: '23502' }));
    assert.ok(!isNotNullViolation({ code: '42703' }));
    assert.ok(!isNotNullViolation({ code: '42501' })); // RLS 拒绝
    assert.ok(!isNotNullViolation(null));
  });

  it('错误文本收集会把 message / details / hint 都算进去', () => {
    const text = collectNotNullErrorText({
      message: 'null value in column "x"',
      details: 'DETAIL',
      hint: 'HINT',
    });
    assert.match(text, /null value in column "x"/);
    assert.match(text, /detail/);
    assert.match(text, /hint/);
  });
});

describe('补值时的安全边界', () => {
  it('不知道默认值的列不补（宁可失败，也不瞎填）', () => {
    // 瞎填一个值可能写进类型不对的列（text 列写 boolean）⇒
    // 换个姿势失败，还把库里那一行改坏了。
    assert.equal(
      buildNotNullFallbackBody({ ...PAYLOAD }, 'some_unknown_column', SETTINGS_COLUMN_DEFAULTS),
      null,
      '我们不知道默认值的列不许瞎填'
    );
  });

  it('补值不改原载荷（返回的是新对象）', () => {
    // 撞 23502 的列在载荷里是**没有**的（值才是 null）⇒ 用它验「不就地改」
    const body = withoutColumn(PAYLOAD, 'group_name_template');
    const next = buildNotNullFallbackBody(body, 'group_name_template', SETTINGS_COLUMN_DEFAULTS);
    assert.ok(next);
    assert.equal(next.group_name_template, 'Group %d');
    assert.equal(body.group_name_template, undefined, '原载荷不许被就地改');
    assert.ok(!('group_name_template' in body), '原载荷不许被就地加字段');
  });

  it('补的值必须是类型对的（活列取当前默认值）', () => {
    const next = buildNotNullFallbackBody(
      withoutColumn(PAYLOAD, 'collect_pinned_tabs'),
      'collect_pinned_tabs',
      SETTINGS_COLUMN_DEFAULTS
    );
    assert.ok(next);
    assert.equal(next.collect_pinned_tabs, false);
    assert.equal(typeof next.collect_pinned_tabs, 'boolean');
  });
});

describe('上传降级：撞 NOT NULL 就补值再试', () => {
  it('退役列是 NOT NULL 无默认时：补上历史默认值后上传成功', async () => {
    // 修复前的场景：A-9 移除了这些列的写入 ⇒ 数据库那一列成了 null ⇒ 23502。
    const { upsert, attempts } = makeFakeUpsert(['group_name_template']);

    const result = await upsertWithNotNullFallback(
      upsert,
      withoutColumn(PAYLOAD, 'group_name_template'),
      SETTINGS_COLUMN_DEFAULTS
    );

    assert.equal(result.error, null, '撞 NOT NULL 不该让整条设置同步断掉');
    assert.deepEqual(result.filledColumns, ['group_name_template']);
    assert.equal(attempts.length, 2, '第一次失败 → 补值后重试一次');
    assert.equal(
      (attempts[1] as Record<string, unknown>).group_name_template,
      'Group %d',
      '补的值必须是旧客户端曾经写上去的那个'
    );
  });

  it('活列撞 NOT NULL 时也要能降级（原先只认退役列 ⇒ 这里会断）', async () => {
    // 这一条是「只认五个列名」那个缺陷形状的直接反例：
    // theme_style 是**我们自己写出去的活列**，但修复前的名单里没有它 ⇒
    // 降级不命中 ⇒ 错误原样抛出 ⇒ 整条同步断掉。
    const { upsert } = makeFakeUpsert(['theme_style']);

    const result = await upsertWithNotNullFallback(
      upsert,
      withoutColumn(PAYLOAD, 'theme_style'),
      SETTINGS_COLUMN_DEFAULTS
    );

    assert.equal(result.error, null, '活列撞 NOT NULL 也必须能降级');
    assert.deepEqual(result.filledColumns, ['theme_style']);
  });

  it('同时撞两列时两列都要补（Postgres 一次只报一列）', async () => {
    const { upsert, attempts } = makeFakeUpsert(['theme_style', 'collect_pinned_tabs']);
    const payload = withoutColumn(withoutColumn(PAYLOAD, 'theme_style'), 'collect_pinned_tabs');

    const result = await upsertWithNotNullFallback(upsert, payload, SETTINGS_COLUMN_DEFAULTS);

    assert.equal(result.error, null);
    assert.deepEqual(result.filledColumns.sort(), ['collect_pinned_tabs', 'theme_style']);
    assert.equal(attempts.length, 3, '两次失败 → 两次补值 → 第三次成功');
  });

  it('不是 23502 的错误不许补值（真故障必须原样冒出去）', async () => {
    const rlsError = { code: '42501', message: 'new row violates row-level security policy' };
    let calls = 0;
    const upsert = async (): Promise<UpsertOutcome> => {
      calls += 1;
      return { data: null, error: rlsError };
    };

    const result = await upsertWithNotNullFallback(upsert, { ...PAYLOAD }, SETTINGS_COLUMN_DEFAULTS);

    assert.equal(result.error, rlsError, 'RLS 拒绝必须原样抛出去');
    assert.equal(calls, 1, '不该重试');
    assert.deepEqual(result.filledColumns, []);
  });

  it('不知道默认值的列撞规时：不补、不重试、错误原样抛出', async () => {
    let calls = 0;
    const upsert = async (): Promise<UpsertOutcome> => {
      calls += 1;
      return {
        data: null,
        error: {
          code: '23502',
          message: 'null value in column "mystery_column" violates not-null constraint',
        },
      };
    };

    const result = await upsertWithNotNullFallback(upsert, { ...PAYLOAD }, SETTINGS_COLUMN_DEFAULTS);

    assert.ok(result.error, '错误必须冒出去');
    assert.deepEqual(result.filledColumns, []);
    assert.equal(calls, 1);
  });

  it('循环有界：永远撞同一列时不会无限转', async () => {
    let calls = 0;
    const upsert = async (): Promise<UpsertOutcome> => {
      calls += 1;
      return {
        data: null,
        error: {
          code: '23502',
          message: 'null value in column "theme_style" violates not-null constraint',
        },
      };
    };

    const result = await upsertWithNotNullFallback(
      upsert,
      withoutColumn(PAYLOAD, 'theme_style'),
      SETTINGS_COLUMN_DEFAULTS
    );

    assert.ok(result.error, '永远失败时错误必须冒出去');
    assert.ok(calls <= 9, `重试次数必须有界（实际 ${calls} 次）`);
    assert.deepEqual(result.filledColumns, ['theme_style'], '同一列不该被补两次');
    assert.equal(calls, 2, '补过一次还撞同一列 ⇒ 补值没解决问题 ⇒ 立刻停');
  });
});

describe('默认值的来源必须是一份', () => {
  it('活列与退役列的默认值都在同一张表里', () => {
    // 修复前有三份**没有编译期关联**的手抄清单：
    //   · types/tab.ts 的 RETIRED_SETTING_KEYS（驼峰）
    //   · upload.ts 的 RETIRED_COLUMN_FALLBACKS（云端列名 + 默认值）
    //   · download.ts 的 retiredColumns（云端列名）
    // 改一处忘另一处 ⇒ 要么把退役键又带上了云，要么把一个**还活着的**列
    // 当成退役列静默跳过（设置悄悄丢一项）。
    assert.equal(SETTINGS_COLUMN_DEFAULTS.theme_style, 'legacy', '活列必须有默认值');
    assert.equal(SETTINGS_COLUMN_DEFAULTS.collect_pinned_tabs, false);
    for (const [column, value] of Object.entries(RETIRED_SETTING_COLUMN_DEFAULTS)) {
      assert.equal(
        SETTINGS_COLUMN_DEFAULTS[column],
        value,
        `${column} 的默认值必须在同一张表里（两份手抄清单迟早漂移）`
      );
    }
  });

  it('退役列的默认值必须与旧客户端写上去的一致', () => {
    // 值必须与旧 DEFAULT_SETTINGS 里的原值一致 —— 这样降级路径写回云端的行
    // 与老客户端写出来的行没有区别。
    assert.equal(RETIRED_SETTING_COLUMN_DEFAULTS.group_name_template, 'Group %d');
    assert.equal(RETIRED_SETTING_COLUMN_DEFAULTS.allow_duplicate_tabs, false);
    assert.equal(RETIRED_SETTING_COLUMN_DEFAULTS.delete_strategy, 'everywhere');
    assert.equal(RETIRED_SETTING_COLUMN_DEFAULTS.sync_strategy, 'newest');
    assert.equal(RETIRED_SETTING_COLUMN_DEFAULTS.reorder_mode, false);
  });

  it('设备级字段不在表里（补它们没有意义）', () => {
    // syncBackend / syncEnabled / syncIntervalMinutes 以本机为准，不上云。
    for (const column of ['sync_backend', 'sync_enabled', 'sync_interval_minutes']) {
      assert.ok(
        !(column in SETTINGS_COLUMN_DEFAULTS),
        `${column} 是设备级字段，不该在补值表里`
      );
    }
  });

  it('upload.ts 不得再有硬编码的退役列名单', () => {
    const upload = read('src/utils/supabase/upload.ts');
    assert.ok(
      !/RETIRED_COLUMN_FALLBACKS/.test(upload),
      '硬编码名单已被统一来源取代 —— 留着它就还是「按名单特判」'
    );
    assert.match(upload, /upsertWithNotNullFallback\(/, 'upload.ts 必须调用通用 23502 降级');
  });

  it('download.ts 的退役列名单必须来自统一来源', () => {
    const download = read('src/utils/supabase/download.ts');
    assert.match(
      download,
      /RETIRED_SETTING_COLUMNS/,
      'download.ts 必须用统一来源的退役列名单'
    );
    assert.ok(
      !/const retiredColumns = new Set\(\s*['"]group_name_template/.test(download),
      'download.ts 不得再手抄一份退役列名单'
    );
  });

  it('驼峰→列名的转换只有一份定义', () => {
    const upload = read('src/utils/supabase/upload.ts');
    assert.match(upload, /settingKeyToColumn\(key\)/, 'upload.ts 必须用统一转换');
    assert.ok(
      !/key\.replace\(\/\(\[A-Z\]\)\/g/.test(upload),
      'upload.ts 不得再手抄一份驼峰转列名的规则'
    );
    const types = read('src/types/tab.ts');
    assert.match(types, /export function settingKeyToColumn\(/, '转换函数必须在统一来源处');
  });
});
