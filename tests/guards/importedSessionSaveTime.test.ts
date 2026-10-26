/**
 * 「保存时间未知的会话」不许被说成「刚保存的」（2026-10-25）。
 *
 * ── 这个文件要防的回归类别 ────────────────────────────────────────────────
 *
 * OneTab 格式**不带时间戳**（社区标准就是 `URL | 标题` + 空行分组）
 * ⇒ 导入出来的会话**没有保存时间**。旧实现把 `createdAt` 写成「导入那一刻」
 * ⇒ 界面在**四个地方**同时说假话：
 *
 *   ① 卡片上写着「今天」（而这些标签页是两年前存的）；
 *   ② 默认排序「最近保存」把它们**顶到列表最上面**；
 *   ③ 「保存时间 = 24 小时内」把它们**全算进去**；
 *   ④ 换一台设备（云端）⇒ 标记没跟过去 ⇒ 谎话在另一台设备上复活。
 *
 * ⇒ 修法是让「保存时间未知」成为一个**显式的事实**（`TabGroup.importedAt`），
 *   并让**显示 / 排序 / 筛选 / 同步**四处都按它说真话。
 *
 * ── 判据钉的是**语义**，不是字面量 ────────────────────────────────────────
 *
 *   · 导入器**必须**打上标记（否则下面三条全塌）；
 *   · 显示层**必须**说「导入」而不是「今天」；
 *   · 排序层**必须**让它们排在已知保存时间的会话**之后**（哪怕它们 `createdAt` 更新）；
 *   · 筛选层**必须**不让它们混进任何「有多新」的桶，且**必须**能被检索到；
 *   · 同步层**必须**把标记带上云（否则换设备又变回普通会话）；
 *   · JSON 备份导入**不得**打标记（那份 `createdAt` 是**真的**保存时间）。
 *
 * ── 为什么不把「保存时间」算进 `ONETAB_LOST_FIELDS` ────────────────────────
 *
 * 那个清单的语义是「往返一次原值不再保留」；而保存时间**从来就没有过**
 * ⇒ 说它「丢了」是假的。所以它是**独立的一条事实**，单独披露（见
 * `oneTabImportNoticeText`）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseOneTabFormat } from '../../src/core/oneTabFormatParser.ts';
import { normalizeImportedGroup } from '../../src/core/normalizeTabsData.ts';
import { sortSessions } from '../../src/core/sessionSort.ts';
import { applySearchFilters, type SearchResult } from '../../src/utils/search.ts';
import {
  formatRelativeTime,
  formatSessionTimeLabel,
  getSessionResultSummary,
} from '../../src/utils/sessionPresentation.ts';
import { encodeGroup, decodeGroup } from '../../src/sync-backend/webdav/layout.ts';
import { oneTabImportNoticeText } from '../../src/core/oneTabFormatLimits.ts';
import type { TabGroup } from '../../src/types/tab.ts';

const NOW_ISO = '2026-10-25T08:00:00.000Z';
const OLD_ISO = '2024-01-02T03:04:05.000Z';

const tab = (url: string) => ({ id: `t-${url}`, url, title: url, favicon: '', createdAt: NOW_ISO, lastAccessed: NOW_ISO, pinned: false });

const group = (over: Partial<TabGroup> = {}): TabGroup => ({
  id: over.id ?? 'g1',
  name: over.name ?? '会话',
  tabs: over.tabs ?? [tab('https://a.example/one')],
  createdAt: over.createdAt ?? NOW_ISO,
  updatedAt: over.updatedAt ?? over.createdAt ?? NOW_ISO,
  isLocked: over.isLocked ?? false,
  ...(over.importedAt === undefined ? {} : { importedAt: over.importedAt }),
});

/** 一个搜索结果（筛选判据吃的是 tab + group 一对）。 */
const result = (g: TabGroup): SearchResult => ({
  tab: g.tabs[0],
  group: g,
  score: 1,
  matches: [],
});

// ─────────────────────────────────────────────────────────────────────────
// 1. 导入器：必须打上「保存时间未知」的标记
// ─────────────────────────────────────────────────────────────────────────

describe('OneTab 导入：来源不带时间戳 ⇒ 必须标记「保存时间未知」', () => {
  it('导入出来的每个会话都带 importedAt（且是合法 ISO）', () => {
    const groups = parseOneTabFormat(
      'https://a.example/1 | 甲\n\nhttps://b.example/2 | 乙'
    );
    assert.equal(groups.length, 2);
    for (const g of groups) {
      assert.equal(
        typeof g.importedAt,
        'string',
        `导入的会话没有 importedAt ⇒ 界面会把它当成「保存于导入那一刻」` +
          '（列表最上面塞满旧会话、卡片写「今天」、24 小时内把它算进去）'
      );
      assert.ok(
        !Number.isNaN(new Date(g.importedAt as string).getTime()),
        'importedAt 必须是能解析的时间戳'
      );
    }
  });

  it('标记的值 = 导入那一刻（不是「会话的保存时间」）', () => {
    const before = Date.now();
    const [g] = parseOneTabFormat('https://a.example/1 | 甲');
    const after = Date.now();
    const marked = new Date(g.importedAt as string).getTime();
    assert.ok(
      marked >= before - 1000 && marked <= after + 1000,
      'importedAt 应当是导入时刻 —— 它是「什么时候进到本机」，不是「什么时候保存的」'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. JSON 备份导入：**不得**打标记（那份 createdAt 是真的保存时间）
// ─────────────────────────────────────────────────────────────────────────

describe('JSON 备份导入：不得凭空制造「保存时间未知」', () => {
  it('文件里没有 importedAt ⇒ 归一化后也没有（保存时间是已知的）', () => {
    const normalized = normalizeImportedGroup({
      id: 'g1',
      name: '备份里的会话',
      tabs: [tab('https://a.example/one')],
      createdAt: OLD_ISO,
      updatedAt: OLD_ISO,
    });
    assert.equal(
      normalized.importedAt,
      undefined,
      'JSON 备份里的 createdAt 是**真的**保存时间 ⇒ 打上「未知」标记就是谎话'
    );
  });

  it('文件里带着 importedAt ⇒ 原样保留（备份往返不能把标记弄丢）', () => {
    const normalized = normalizeImportedGroup({
      id: 'g2',
      name: '导入件的备份',
      tabs: [tab('https://a.example/one')],
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
      importedAt: NOW_ISO,
    });
    assert.equal(normalized.importedAt, NOW_ISO);
  });

  it('文件里的 importedAt 解析不出来 ⇒ 整个键去掉（不许当「未知」以外的怪东西）', () => {
    const normalized = normalizeImportedGroup({
      id: 'g3',
      name: '手改过的备份',
      tabs: [tab('https://a.example/one')],
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
      importedAt: '昨天',
    });
    assert.equal(
      normalized.importedAt,
      undefined,
      '一个解析不出来的 importedAt 会被 `hasUnknownSaveTime` 当成「未知」⇒ 必须先归一化掉'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. 显示层：卡片与搜索页都不许说「今天」
// ─────────────────────────────────────────────────────────────────────────

describe('显示层：保存时间未知 ⇒ 说「导入」，不说「今天」', () => {
  it('列表页卡片：导入件显示「导入 · …」，而不是光秃秃的「今天」', () => {
    const createdAt = new Date().toISOString();
    const label = formatSessionTimeLabel(group({ createdAt, importedAt: createdAt }));
    assert.match(
      label,
      /^导入 · /,
      `卡片写「${label}」= 说的是「今天保存的」—— 而这些标签页是两年前存的`
    );
    assert.notEqual(
      label,
      formatRelativeTime(createdAt),
      '导入件的时间位必须与「保存时间」的写法区分开，否则用户读到的就是「今天保存的」'
    );
  });

  it('普通会话照旧显示相对时间（不是「导入」）', () => {
    const label = formatSessionTimeLabel(group({ createdAt: new Date().toISOString() }));
    assert.doesNotMatch(label, /导入/, '普通会话不是导入件');
    assert.match(label, /今天/);
  });

  it('时间戳解析不出来时显示「时间未知」，**不得**出现「Invalid Date」', () => {
    const label = formatSessionTimeLabel(group({ createdAt: '不是时间' }));
    assert.doesNotMatch(
      label,
      /Invalid Date/,
      '界面上出现字面的「Invalid Date」是旧实现的老毛病（非法时间戳一路落到 toLocaleDateString）'
    );
    assert.match(label, /时间未知/);
  });

  it('搜索页 meta 行：导入件说「导入于 …」，普通会话说「保存于 …」', () => {
    const imported = getSessionResultSummary(
      group({ createdAt: NOW_ISO, importedAt: NOW_ISO, tabs: [tab('https://a.example/one')] }),
      1
    );
    assert.match(imported, /导入于/);
    assert.doesNotMatch(imported, /保存于/, '说「保存于」就是在替一个未知的时间编一个值');

    const normal = getSessionResultSummary(
      group({ createdAt: NOW_ISO, tabs: [tab('https://a.example/one')] }),
      1
    );
    assert.match(normal, /保存于/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. 排序层：「最近保存」下，导入件排在已知保存时间的会话之后
// ─────────────────────────────────────────────────────────────────────────

describe('排序层：「最近保存」不得让导入件霸占列表顶部', () => {
  it('导入件的 createdAt 更新（刚导入），也排在已知保存时间的会话之后', () => {
    const known = group({ id: 'known', name: '真的保存过', createdAt: OLD_ISO });
    const imported = group({ id: 'imported', name: '导入来的', createdAt: NOW_ISO, importedAt: NOW_ISO });
    const sorted = sortSessions([imported, known], 'saved');
    assert.equal(
      sorted[0].id,
      'known',
      '导入件的 createdAt 是「导入那一刻」（比真的保存时间新）⇒ ' +
        '若直接按它排，它会霸占列表顶部 —— 那正是本缺陷'
    );
  });

  it('多个导入件之间保持**源文件顺序**（用户在 OneTab 里排的顺序不能丢）', () => {
    const a = group({ id: 'a', name: 'A', createdAt: NOW_ISO, importedAt: NOW_ISO });
    const b = group({ id: 'b', name: 'B', createdAt: NOW_ISO, importedAt: NOW_ISO });
    const c = group({ id: 'c', name: 'C', createdAt: NOW_ISO, importedAt: NOW_ISO });
    const sorted = sortSessions([a, b, c], 'saved');
    assert.deepEqual(
      sorted.map(s => s.id),
      ['a', 'b', 'c'],
      '同一批导入的会话 createdAt 完全相同 ⇒ 排序的稳定性必须保住源文件顺序'
    );
  });

  it('两次导入的两批之间按导入时刻倒序（后导入的在前）', () => {
    const older = group({ id: 'older', name: '先导入的', createdAt: '2026-10-20T00:00:00.000Z', importedAt: '2026-10-20T00:00:00.000Z' });
    const newer = group({ id: 'newer', name: '后导入的', createdAt: NOW_ISO, importedAt: NOW_ISO });
    const sorted = sortSessions([older, newer], 'saved');
    assert.deepEqual(sorted.map(s => s.id), ['newer', 'older']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. 筛选层：不许混进「有多新」的桶，但必须能被检索到
// ─────────────────────────────────────────────────────────────────────────

describe('筛选层：「保存时间」不许把导入件算成「刚保存的」', () => {
  const imported = group({ id: 'imported', createdAt: NOW_ISO, importedAt: NOW_ISO });
  const known = group({ id: 'known', createdAt: NOW_ISO });

  for (const bucket of ['24h', '7d', '30d', 'older'] as const) {
    it(`导入件不匹配「${bucket}」`, () => {
      const kept = applySearchFilters([result(imported)], { savedWithin: bucket });
      assert.equal(
        kept.length,
        0,
        `导入件在「${bucket}」里出现 = 用户按「我最近保存的」找，找出来全是老东西`
      );
    });
  }

  it('导入件出现在「时间未知」这个桶里（不许被时间筛选静默藏起来）', () => {
    const kept = applySearchFilters([result(imported)], { savedWithin: 'unknown' });
    assert.equal(kept.length, 1, '保存时间未知的会话必须**可被检索到**');
  });

  it('普通会话不匹配「时间未知」', () => {
    const kept = applySearchFilters([result(known)], { savedWithin: 'unknown' });
    assert.equal(kept.length, 0);
  });

  it('普通会话照旧按真实保存时间分桶', () => {
    assert.equal(applySearchFilters([result(known)], { savedWithin: '24h' }).length, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. 同步层：标记必须跟着上云（否则换设备又变回普通会话）
// ─────────────────────────────────────────────────────────────────────────

describe('同步层：「保存时间未知」的标记必须跟着走', () => {
  it('WebDAV 往返保留 importedAt', () => {
    const encoded = encodeGroup(group({ importedAt: NOW_ISO }));
    const decoded = decodeGroup(encoded);
    assert.ok(decoded);
    assert.equal(
      decoded.importedAt,
      NOW_ISO,
      '标记没上云 ⇒ 换一台设备下载回来，它又变成一条「保存于导入那一刻」的普通会话'
    );
  });

  it('老分片（没有这个键）⇒ 解出来也没有（保存时间是已知的）', () => {
    const decoded = decodeGroup({
      id: 'g-old',
      name: '老分片',
      createdAt: OLD_ISO,
      updatedAt: OLD_ISO,
      isLocked: false,
      tabs: [],
    });
    assert.ok(decoded);
    assert.equal(decoded.importedAt, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 7. 对外文案：导入提示必须说清「保存时间未知」是什么意思
// ─────────────────────────────────────────────────────────────────────────

describe('对外文案：导入提示必须说清「导入 · …」是什么意思', () => {
  it('OneTab 导入提示必须点出「保存时间未知」', () => {
    const text = oneTabImportNoticeText();
    assert.match(
      text,
      /保存时间未知/,
      '用户看到卡片上的「导入 · …」时，得知道那是什么意思 —— ' +
        '不说 = 界面上出现一个没人解释过的说法'
    );
    assert.match(text, /导入 · /, '提示里要给出界面上那个说法的样子');
  });

  it('提示里必须点出「时间未知」这个筛选桶（否则用户找不到那些会话）', () => {
    assert.match(oneTabImportNoticeText(), /时间未知/);
  });
});
