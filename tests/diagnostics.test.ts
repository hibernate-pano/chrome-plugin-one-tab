// 诊断信息导出（工作包 B1）的脱敏与结构回归测试。
//
// 这份测试的第一职责不是「功能对不对」，而是「有没有泄露」：诊断文件会被用户
// 贴进公开的 GitHub issue 附件，里面出现任何一个标签 URL（含域名）、标题、
// 会话名、备注、记录 id、设备号或邮箱，代价都远大于诊断价值本身。
// 所以核心用例是：造一批带独特标记的原始数据，序列化后对**整段 JSON 字符串**
// 做全串搜索，标记一个都不许出现。
//
// 第二职责是把「输出结构」钉成不变量（直方图求和 = 会话总数、事件只按名字计数、
// 序列化是纯函数），这样实现策略微调时正确的测试不该被挡住。
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

before(async () => {
  register(LOADER_PATH);
});

// ── 唯一标记：任何一条漏进输出都会被下面的搜索抓到 ──────────────────────
const MARKERS = {
  url: 'https://zzmarker-host-9f3.example/private/quarterly-plan',
  host: 'zzmarker-host-9f3.example',
  title: 'ZZMARKER-TITLE-4b71',
  groupName: 'ZZMARKER-NAME-8c02',
  note: 'ZZMARKER-NOTE-1de5',
  groupId: 'ZZMARKER-GROUPID-aa11',
  tabId: 'ZZMARKER-TABID-bb22',
  deviceId: 'ZZMARKER-DEVICE-cc33',
  email: 'zzmarker-user@example.com',
  eventPayload: 'ZZMARKER-EVENTPAYLOAD-dd44',
  journalPayload: 'ZZMARKER-JOURNALPAYLOAD-ee55',
  journalDevice: 'ZZMARKER-JOURNALDEV-ff66',
  // v3 影子/门禁段：这几个标记专盯最容易漏的三处——
  // 对账差异里的**真实字段值**、sampleKey 里的 userId、影子日志的 error message。
  userId: 'ZZMARKER-USERID-gg77',
  auditField: 'ZZMARKER-AUDITFIELD-hh88',
  shadowOp: 'ZZMARKER-SHADOWOP-ii99',
  shadowSkip: 'ZZMARKER-SHADOWSKIP-jj00',
  shadowError: 'ZZMARKER-SHADOWERR-kk11',
} as const;

const NOW = new Date('2026-09-29T12:00:00.000Z');
const NOW_MS = NOW.getTime();

function daysAgo(days: number): string {
  return new Date(NOW_MS - days * 24 * 60 * 60 * 1000).toISOString();
}

function makeTab(i: number) {
  return {
    id: `${MARKERS.tabId}-${i}`,
    url: `${MARKERS.url}?tab=${i}`,
    title: `${MARKERS.title}-${i}`,
    createdAt: daysAgo(3),
    lastAccessed: daysAgo(1),
    pinned: false,
  };
}

function makeGroup(id: string, tabCount: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `${MARKERS.groupName}-${id}`,
    notes: `${MARKERS.note}-${id}`,
    tabs: Array.from({ length: tabCount }, (_, i) => makeTab(i)),
    createdAt: daysAgo(10),
    updatedAt: daysAgo(1),
    isLocked: false,
    isFavorite: false,
    user_id: MARKERS.email,
    device_id: MARKERS.deviceId,
    ...extra,
  };
}

function makeSources(overrides: Record<string, unknown> = {}) {
  return {
    groups: [
      makeGroup('g-empty', 0),
      makeGroup('g-small', 3),
      makeGroup('g-mid', 12),
      makeGroup('g-big', 150, { isFavorite: true }),
      makeGroup('g-locked', 60, { isLocked: true }),
    ],
    settings: {
      groupNameTemplate: '会话',
      showFavicons: true,
      showTabCount: true,
      confirmBeforeDelete: true,
      allowDuplicateTabs: false,
      syncEnabled: true,
      layoutMode: 'single',
      showNotifications: false,
      collectPinnedTabs: false,
      syncStrategy: 'newest',
      deleteStrategy: 'everywhere',
      themeMode: 'auto',
    },
    productEvents: [
      { name: 'session_saved', payload: { query: MARKERS.eventPayload }, createdAt: daysAgo(1) },
      { name: 'session_saved', payload: { query: MARKERS.eventPayload }, createdAt: daysAgo(2) },
      { name: 'search_performed', payload: { query: MARKERS.eventPayload }, createdAt: daysAgo(5) },
      // 窗口外（200 天前）
      { name: 'session_saved', payload: { query: MARKERS.eventPayload }, createdAt: daysAgo(200) },
      // 词表外的事件名 + 缺 createdAt
      { name: MARKERS.eventPayload, payload: {}, createdAt: daysAgo(1) },
      { name: 'session_note_saved' },
    ],
    journal: [
      {
        d: MARKERS.journalDevice,
        s: 1,
        ts: daysAgo(1),
        type: 'saveGroup',
        groupId: MARKERS.groupId,
        tabId: MARKERS.tabId,
        payload: { name: MARKERS.journalPayload },
      },
      { d: MARKERS.journalDevice, s: 2, ts: daysAgo(1), type: 'deleteGroup', groupId: MARKERS.groupId },
      // s > lastSyncedSeq：算「未确认」
      { d: MARKERS.journalDevice, s: 3, ts: daysAgo(1), type: 'saveGroup', groupId: MARKERS.groupId },
      // 词表外的 type：丢弃并记账
      { d: MARKERS.journalDevice, s: 4, ts: daysAgo(1), type: MARKERS.journalPayload },
    ],
    isAuthenticated: true,
    lastSyncTime: daysAgo(0.25), // 6 小时前
    lastSyncedSeq: 2,
    pendingDeleteCount: 0,
    pendingUpload: false,
    // 性能 span：默认空（观测数据缺失是正常态，不是错误态——见 diagnostics.ts
    // 的 DiagnosticsSources.perfSpans 注释，它刻意不进 unavailable）。
    perfSpans: [],
    environment: {
      extensionVersion: '1.22.0',
      userAgent: 'Mozilla/5.0 Chrome/141.0.0.0',
      platform: 'MacIntel',
      language: 'zh-CN',
    },
    ...overrides,
  };
}

describe('诊断导出：脱敏红线', () => {
  it('序列化后的 JSON 里不出现任何 URL / 域名 / 标题 / 会话名 / 备注 / id / 设备号 / 邮箱', async () => {
    const { buildDiagnosticsReport, serializeDiagnosticsReport } = await import('@/utils/diagnostics');
    const json = serializeDiagnosticsReport(buildDiagnosticsReport(makeSources() as never, NOW));

    for (const [label, marker] of Object.entries(MARKERS)) {
      assert.ok(
        !json.includes(marker),
        `诊断输出泄露了 ${label}：${marker}\n实际输出：\n${json}`
      );
    }
  });

  it('即使原始数据里的 URL 与会话名被塞进事件 payload / journal payload，也一样不外泄', async () => {
    const { buildDiagnosticsReport, serializeDiagnosticsReport, diagnosticsSummaryText } =
      await import('@/utils/diagnostics');
    const sources = makeSources();
    // 最恶劣的形态：payload 里直接带着浏览历史
    (sources.productEvents as unknown[]).push({
      name: 'search_performed',
      payload: { url: MARKERS.url, title: MARKERS.title },
      createdAt: daysAgo(0),
    });
    (sources.journal as unknown[]).push({
      d: MARKERS.deviceId,
      s: 99,
      ts: daysAgo(0),
      type: 'renameGroup',
      groupId: MARKERS.groupId,
      tabId: MARKERS.tabId,
      payload: { name: MARKERS.groupName, url: MARKERS.url, email: MARKERS.email },
    });

    const report = buildDiagnosticsReport(sources as never, NOW);
    const blob = serializeDiagnosticsReport(report) + '\n' + diagnosticsSummaryText(report);
    for (const [label, marker] of Object.entries(MARKERS)) {
      assert.ok(!blob.includes(marker), `诊断输出（含摘要）泄露了 ${label}：${marker}`);
    }
  });

  it('summary 文本（贴进 issue 的那段）同样不含标记', async () => {
    const { buildDiagnosticsReport, diagnosticsSummaryText } = await import('@/utils/diagnostics');
    const text = diagnosticsSummaryText(buildDiagnosticsReport(makeSources() as never, NOW));
    assert.ok(text.includes('TapStack 诊断摘要'));
    for (const marker of Object.values(MARKERS)) {
      assert.ok(!text.includes(marker), `诊断摘要泄露了：${marker}`);
    }
  });
});

describe('诊断导出：输出结构与不变量', () => {
  it('含版本号与会话/标签规模', async () => {
    const { buildDiagnosticsReport } = await import('@/utils/diagnostics');
    const report = buildDiagnosticsReport(makeSources() as never, NOW);
    assert.equal(report.environment.extensionVersion, '1.22.0');
    assert.equal(report.generatedAt, NOW.toISOString());
    assert.equal(report.data.sessionCount, 5);
    assert.equal(report.data.tabCount, 0 + 3 + 12 + 150 + 60);
    assert.equal(report.data.favoriteSessionCount, 1);
    assert.equal(report.data.lockedSessionCount, 1);
  });

  it('规模分布直方图所有桶相加 === 会话总数', async () => {
    const { buildDiagnosticsReport, TAB_COUNT_BUCKETS } = await import('@/utils/diagnostics');
    const report = buildDiagnosticsReport(makeSources() as never, NOW);
    const histogram = report.data.tabCountHistogram;
    assert.ok(histogram, '直方图不应为空');
    const sum = TAB_COUNT_BUCKETS.reduce((acc, bucket) => acc + (histogram[bucket] ?? 0), 0);
    assert.equal(sum, report.data.sessionCount);
    // 0 / 1-5 / 6-20 / 21-100 / >100 各归其位
    assert.equal(histogram['0'], 1);
    assert.equal(histogram['1-5'], 1);
    assert.equal(histogram['6-20'], 1);
    assert.equal(histogram['21-100'], 1);
    assert.equal(histogram['>100'], 1);
  });

  it('空数据源下直方图各桶为 0 且求和仍等于会话总数', async () => {
    const { buildDiagnosticsReport, TAB_COUNT_BUCKETS } = await import('@/utils/diagnostics');
    const report = buildDiagnosticsReport(makeSources({ groups: [] }) as never, NOW);
    const histogram = report.data.tabCountHistogram!;
    assert.equal(report.data.sessionCount, 0);
    assert.equal(
      TAB_COUNT_BUCKETS.reduce((acc, b) => acc + histogram[b], 0),
      0
    );
  });

  it('事件只按名字计数、不带 payload，且按窗口与词表过滤', async () => {
    const { buildDiagnosticsReport } = await import('@/utils/diagnostics');
    const report = buildDiagnosticsReport(makeSources() as never, NOW);
    const byName = Object.fromEntries(report.productEvents.byName.map(e => [e.name, e.count]));
    assert.equal(byName.session_saved, 2); // 窗口内两条；200 天前那条不计
    assert.equal(byName.search_performed, 1);
    assert.equal(byName['session_note_saved'], undefined); // 缺 createdAt → 不计
    assert.equal(report.productEvents.totalCount, 3);
    assert.equal(report.productEvents.outOfWindowCount, 2); // 200 天前 + 缺时间
    assert.equal(report.productEvents.droppedUnknownNameCount, 1); // 词表外名字
    // 事件条目只有 name/count 两个键——没有 payload 字段可漏
    for (const entry of report.productEvents.byName) {
      assert.deepEqual(Object.keys(entry).sort(), ['count', 'name']);
    }
  });

  it('journal 只按 op 类型计数，未确认数按 lastSyncedSeq 算', async () => {
    const { buildDiagnosticsReport } = await import('@/utils/diagnostics');
    const report = buildDiagnosticsReport(makeSources() as never, NOW);
    const byType = Object.fromEntries(report.journal.byType.map(e => [e.type, e.count]));
    assert.deepEqual(byType, { deleteGroup: 1, saveGroup: 2 });
    assert.equal(report.journal.entryCount, 4);
    assert.equal(report.journal.droppedUnknownTypeCount, 1);
    assert.equal(report.journal.unconfirmedCount, 1); // s=3 > lastSyncedSeq=2
    for (const entry of report.journal.byType) {
      assert.deepEqual(Object.keys(entry).sort(), ['count', 'type']);
    }
  });

  it('同步摘要：登录态、上次同步距今、待广播队列长度', async () => {
    const { buildDiagnosticsReport } = await import('@/utils/diagnostics');
    const report = buildDiagnosticsReport(makeSources() as never, NOW);
    assert.equal(report.sync.authenticated, true);
    assert.equal(report.sync.autoSyncEnabled, true);
    assert.equal(report.sync.syncStrategy, 'newest');
    assert.equal(report.sync.lastSyncAgeHours, 6);
    assert.equal(report.sync.pendingDeleteCount, 0);
    assert.equal(report.sync.pendingUpload, false);
  });

  it('设置里的同步策略不在词表内时记成 null，不原样透传存储内容', async () => {
    const { buildDiagnosticsReport, serializeDiagnosticsReport } = await import('@/utils/diagnostics');
    const sources = makeSources();
    (sources.settings as Record<string, unknown>).syncStrategy = MARKERS.groupName;
    const report = buildDiagnosticsReport(sources as never, NOW);
    assert.equal(report.sync.syncStrategy, null);
    assert.ok(!serializeDiagnosticsReport(report).includes(MARKERS.groupName));
  });
});

describe('诊断导出：降级与边界（不许崩、不许编数据）', () => {
  it('未登录 + 无待广播队列 + 从未同步：不崩，字段照常输出', async () => {
    const { buildDiagnosticsReport, serializeDiagnosticsReport } = await import('@/utils/diagnostics');
    const report = buildDiagnosticsReport(
      makeSources({
        isAuthenticated: false,
        pendingDeleteCount: 0,
        lastSyncTime: null,
        settings: null,
      }) as never,
      NOW
    );
    assert.equal(report.sync.authenticated, false);
    assert.equal(report.sync.lastSyncAgeHours, null);
    assert.equal(report.sync.pendingDeleteCount, 0);
    assert.equal(report.sync.autoSyncEnabled, null);
    assert.ok(report.unavailable.includes('settings'));
    assert.doesNotThrow(() => JSON.parse(serializeDiagnosticsReport(report)));
  });

  it('三个源读取失败时：计数为 null 并进 unavailable，而不是伪装成 0', async () => {
    const { buildDiagnosticsReport, serializeDiagnosticsReport } = await import('@/utils/diagnostics');
    const report = buildDiagnosticsReport(
      makeSources({ groups: null, settings: null, pendingDeleteCount: null }) as never,
      NOW
    );
    assert.equal(report.data.sessionCount, null);
    assert.equal(report.data.tabCount, null);
    assert.equal(report.data.tabCountHistogram, null);
    assert.equal(report.sync.pendingDeleteCount, null);
    assert.deepEqual(report.unavailable.sort(), ['groups', 'pendingDeleteIds', 'settings']);
    assert.doesNotThrow(() => JSON.parse(serializeDiagnosticsReport(report)));
  });

  it('畸形原始数据（空数组、null 条目、非对象事件）不崩且被记账', async () => {
    const { buildDiagnosticsReport } = await import('@/utils/diagnostics');
    const report = buildDiagnosticsReport(
      makeSources({
        groups: [{ id: 'g', tabs: null }],
        productEvents: [null, 'not-an-object', 42],
        journal: [null, { type: 123 }],
      }) as never,
      NOW
    );
    assert.equal(report.data.sessionCount, 1);
    assert.equal(report.data.tabCount, 0);
    assert.equal(report.productEvents.droppedUnknownNameCount, 3);
    assert.equal(report.journal.droppedUnknownTypeCount, 2);
  });

  it('采集层在没有浏览器环境时不崩（读到空值而不是抛错）', async () => {
    const { readDiagnosticsSources } = await import('@/utils/diagnostics');
    // node 环境没有 indexedDB / window.localStorage：KV 层一律返回 null，
    // 因此各 getter 交出空集合（getGroups → []，getSettings → 默认设置）。
    // 关键不变量是「导出通道不许因为读不到数据而挂掉」——用户在排障时最需要的
    // 就是还能导出一份文件。真正的「读失败」形态（抛错 → null → unavailable）
    // 由上面注入 sources 的用例覆盖。
    const sources = await readDiagnosticsSources(false);
    assert.ok(Array.isArray(sources.groups));
    assert.deepEqual(sources.productEvents, []);
    assert.deepEqual(sources.journal, []);
    assert.equal(sources.isAuthenticated, false);
    assert.equal(sources.pendingUpload, false);
    assert.equal(typeof sources.environment.extensionVersion, 'string');
  });
});


describe('诊断导出：可复现性与文件名', () => {
  it('序列化是纯函数：同样的输入 + 同样的 now ⇒ 逐字节相同的输出', async () => {
    const { buildDiagnosticsReport, serializeDiagnosticsReport } = await import('@/utils/diagnostics');
    const a = serializeDiagnosticsReport(buildDiagnosticsReport(makeSources() as never, NOW));
    const b = serializeDiagnosticsReport(buildDiagnosticsReport(makeSources() as never, NOW));
    assert.equal(a, b);
    // 换一个 now 才会变（generatedAt / 上次同步距今随之改变）
    const later = serializeDiagnosticsReport(
      buildDiagnosticsReport(makeSources() as never, new Date(NOW_MS + 3600_000))
    );
    assert.notEqual(a, later);
  });

  it('输出里的动态键是排序过的，两次导出可直接 diff', async () => {
    const { buildDiagnosticsReport } = await import('@/utils/diagnostics');
    const report = buildDiagnosticsReport(makeSources() as never, NOW);
    const names = report.productEvents.byName.map(e => e.name);
    assert.deepEqual(names, [...names].sort());
    const types = report.journal.byType.map(e => e.type);
    assert.deepEqual(types, [...types].sort());
  });

  it('文件名带版本号与日期戳（日期戳复用 formatExportStamp）', async () => {
    const { diagnosticsFileName } = await import('@/utils/diagnostics');
    // 2026-09-29T12:00:00Z → 本地时区日期由 formatExportStamp 决定
    const name = diagnosticsFileName('1.22.0', NOW);
    assert.match(name, /^tapstack-diagnostics-v1\.22\.0-\d{4}-\d{2}-\d{2}\.json$/);
    // 与单源日期戳函数一致（不复用就会重新长出第二种拼法）
    const { formatExportStamp } = await import('@/utils/exportStamp');
    assert.equal(name, `tapstack-diagnostics-v1.22.0-${formatExportStamp(NOW)}.json`);
  });
});
