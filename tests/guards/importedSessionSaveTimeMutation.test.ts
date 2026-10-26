/**
 * 变异自证：「保存时间未知的会话不许被说成刚保存的」这条守卫必须真的看得见破口。
 *
 * 五条变异分别打五个不同的破口：
 *
 * · 变异一 —— 导入器**不打**标记 ⇒ 必须变红（下面四条全靠它撑着）。
 * · 变异二 —— 显示层又拿 `createdAt` 去格式化 ⇒ 必须变红。
 * · 变异三 —— 排序层把「未知 ⇒ 靠后」那一支删掉 ⇒ 必须变红。
 * · 变异四 —— 筛选层不再把导入件排除出「24 小时内」⇒ 必须变红。
 * · 变异五 —— 筛选层把判据换成**等价的内联写法** ⇒ 必须**仍然绿**
 *   （守的是「导入件不混进时间桶」这件事，不是逐字长相）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/importedSessionSaveTime.test.ts';
/** Supabase 上行侧那半（同一条守卫的另一半，单独一个文件）。 */
const SUPABASE_GUARD = 'tests/guards/importedSessionSaveTimeSupabase.test.ts';
const PARSER = 'src/core/oneTabFormatParser.ts';
const PRESENTATION = 'src/utils/sessionPresentation.ts';
const SORT = 'src/core/sessionSort.ts';
const SEARCH = 'src/utils/search.ts';
const WEBDAV_LAYOUT = 'src/sync-backend/webdav/layout.ts';
const UPLOAD = 'src/utils/supabase/upload.ts';

describe('变异自证：「保存时间未知」这条守卫必须看得见破口', () => {
  it('变异一：导入器不打标记 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'OneTab 导入不再打「保存时间未知」的标记',
        testFile: GUARD,
        targets: [
          {
            path: PARSER,
            mutate: source => {
              const original = '      importedAt: now,';
              if (!source.includes(original)) {
                throw new Error('变异前提没成立：找不到导入器里的 importedAt');
              }
              return source.replace(original, '      // 变异：不再打标记');
            },
          },
        ],
        expectRed: true,
        expectedFailure: '导入出来的每个会话都带 importedAt',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '导入器不打标记');
  });

  it('变异二：显示层又拿 createdAt 去格式化 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '时间位退回「只按 createdAt 格式化」',
        testFile: GUARD,
        targets: [
          {
            path: PRESENTATION,
            mutate: source => {
              const original = `  if (hasUnknownSaveTime(group) && group.importedAt) {
    return \`导入 · \${formatRelativeTime(group.importedAt)}\`;
  }
`;
              if (!source.includes(original)) {
                throw new Error('变异前提没成立：找不到「导入 · …」那一支');
              }
              return source.replace(original, '');
            },
          },
        ],
        expectRed: true,
        expectedFailure: '列表页卡片：导入件显示「导入 · …」',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '显示层退回只按 createdAt 格式化');
  });

  it('变异三：排序层删掉「未知 ⇒ 靠后」那一支 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '「最近保存」不再把导入件排到已知保存时间的会话之后',
        testFile: GUARD,
        targets: [
          {
            path: SORT,
            mutate: source => {
              const original = `    const leftUnknown = hasUnknownSaveTime(left);
    const rightUnknown = hasUnknownSaveTime(right);
    // 先判等再相减：\`-Infinity - (-Infinity)\` 是 \`NaN\`，会把「相等」变成「不确定」。
    if (leftUnknown !== rightUnknown) {
      return leftUnknown ? 1 : -1;
    }
`;
              if (!source.includes(original)) {
                throw new Error('变异前提没成立：找不到排序里「未知 ⇒ 靠后」那一支');
              }
              return source.replace(original, '');
            },
          },
        ],
        expectRed: true,
        expectedFailure: '导入件的 createdAt 更新（刚导入），也排在已知保存时间的会话之后',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '排序层删掉「未知 ⇒ 靠后」');
  });

  it('变异四：筛选层不再排除导入件 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '「24 小时内」把导入件也算进去',
        testFile: GUARD,
        targets: [
          {
            path: SEARCH,
            mutate: source => {
              const original = `  if (hasUnknownSaveTime(group)) {
    return savedWithin === 'unknown';
  }
`;
              if (!source.includes(original)) {
                throw new Error('变异前提没成立：找不到筛选里「未知 ⇒ 只进 unknown 桶」那一支');
              }
              return source.replace(original, '');
            },
          },
        ],
        expectRed: true,
        expectedFailure: '导入件不匹配「24h」',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '筛选层不再排除导入件');
  });

  it('变异五：筛选层换成等价的内联写法 ⇒ 守卫必须仍然绿', () => {
    const [outcome] = runMutationCases([
      {
        name: '判据换成等价的内联写法（不 import hasUnknownSaveTime）',
        testFile: GUARD,
        targets: [
          {
            path: SEARCH,
            mutate: source => {
              const original = `  if (hasUnknownSaveTime(group)) {
    return savedWithin === 'unknown';
  }
`;
              if (!source.includes(original)) {
                throw new Error('变异前提没成立：找不到筛选里那一支');
              }
              return source.replace(
                original,
                `  if (typeof group.importedAt === 'string' && group.importedAt.length > 0) {
    return savedWithin === 'unknown';
  }
`
              );
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '筛选层换成等价的内联写法');
  });
});

// ════════════════════════════════════════════════════════════════════════
// 同步层的两个变异（WebDAV 分片 / Supabase 上行）
//
// 这两条守卫盯的是**行为**（往返后标记还在不在、上行那一行带没带那个列），
// 所以变异必须打在**那条数据流**上 —— 打在「源码里出现了 importedAt 这个词」
// 上是零检测力。
// ════════════════════════════════════════════════════════════════════════

describe('变异自证（同步层）：标记必须真的跟着走', () => {
  it('变异六：WebDAV 编码时丢掉标记 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'WebDAV 的 encodeGroup 不再写 importedAt',
        testFile: GUARD,
        targets: [
          {
            path: WEBDAV_LAYOUT,
            mutate: source => {
              const original =
                '    ...(group.importedAt === undefined ? {} : { importedAt: group.importedAt }),\n';
              if (!source.includes(original)) {
                throw new Error('变异前提没成立：找不到 encodeGroup 里写标记的那一行');
              }
              return source.replace(original, '');
            },
          },
        ],
        expectRed: true,
        expectedFailure: 'WebDAV 往返保留 importedAt',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, 'WebDAV 编码时丢掉标记');
  });

  it('变异七：Supabase 上行**永远**不带那一列 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'Supabase 的上行行里永远没有 imported_at',
        testFile: SUPABASE_GUARD,
        targets: [
          {
            path: UPLOAD,
            mutate: source => {
              const original = `    ...(opts.importedAtSupported && group.importedAt
      ? { imported_at: group.importedAt }
      : {}),
`;
              if (!source.includes(original)) {
                throw new Error('变异前提没成立：找不到 buildTabGroupRow 里写标记的那一块');
              }
              return source.replace(original, '');
            },
          },
        ],
        expectRed: true,
        expectedFailure: '那一行**必须**带上 imported_at',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, 'Supabase 上行永远不带那一列');
  });

  it('变异八：Supabase 上行**不看**云端有没有这一列 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'Supabase 的上行行里总是带上 imported_at（哪怕云端没这一列）',
        testFile: SUPABASE_GUARD,
        targets: [
          {
            path: UPLOAD,
            mutate: source => {
              const original = `    ...(opts.importedAtSupported && group.importedAt
      ? { imported_at: group.importedAt }
      : {}),
`;
              if (!source.includes(original)) {
                throw new Error('变异前提没成立：找不到 buildTabGroupRow 里写标记的那一块');
              }
              return source.replace(
                original,
                `    ...(group.importedAt ? { imported_at: group.importedAt } : {}),
`
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: '那一行**不许**出现 imported_at 这个键',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, 'Supabase 上行不看云端有没有这一列');
  });

  it('变异九：等价的正确写法（值过一层 String）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '上行那一行的值写成 String(group.importedAt)（等价）',
        testFile: SUPABASE_GUARD,
        targets: [
          {
            path: UPLOAD,
            mutate: source => {
              const original = `    ...(opts.importedAtSupported && group.importedAt
      ? { imported_at: group.importedAt }
      : {}),
`;
              if (!source.includes(original)) {
                throw new Error('变异前提没成立：找不到 buildTabGroupRow 里写标记的那一块');
              }
              return source.replace(
                original,
                `    ...(opts.importedAtSupported && group.importedAt
      ? { imported_at: String(group.importedAt) }
      : {}),
`
              );
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '上行那一行的值过一层 String');
  });
});
