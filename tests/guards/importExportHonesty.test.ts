/**
 * 导入 / 导出这一条链的**诚实度**守卫（2026-10-23 · 数据安全审计 DS-43-4/5/6/9 + DS-15）。
 *
 * ── 这个文件防的具体事故 ──────────────────────────────────────────────────
 *
 * 这一批缺陷的共同形态不是「算错了」，而是**说错了**：
 *
 * | 编号 | 事故 | 用户被误导成什么 |
 * |---|---|---|
 * | DS-43-4 | 文件里**一个**组的时间戳越界 ⇒ 归一化抛 RangeError ⇒ 整批导入归零 | 「存储空间不足」⇒ 去清存储（没用） |
 * | DS-43-5 | 备份里的设置合并失败（只写日志）⇒ 导入照报「成功」 | 「整套状态都回来了」⇒ 主题/排序其实还是旧的 |
 * | DS-43-6 | 导出点了就下载，**零回执** | 「不知道有没有生成」⇒ 只能反复点 |
 * | DS-43-9 | 导入**无体积上限** ⇒ 大文件把弹窗读崩，或一条巨型消息发不出去 | 「文件坏了」⇒ 其实是自己机器扛不住 |
 * | DS-15 | 导入不覆盖 ⇒ 同名不同内容的会话**并存两份**，从不说 | 「导入出错了、重复了」⇒ 其实那是设计 |
 *
 * ── 【判据纪律】 ──────────────────────────────────────────────────────────
 *
 * · 文案与判据一律**抽成纯函数**（importResultCopy / importResultReasons /
 *   importLimits）⇒ 守卫直接断言它们的输出，不去猜源码里哪段 catch 对应哪条理由
 *   （那种断言改个位置就红，不红的时候也不代表诚实）。
 * · 接线用**源码结构断言**（仓库无 DOM 测试环境，组件加载不了），
 *   但断言的是「有没有接上」而不是「长什么样」—— 能被等价改写绕过的断言一律不写。
 * · 每条断言都要**能变红**：把实现改回原样，守卫必须响。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeImportedGroup,
  normalizeImportedGroupsIsolated,
} from '@/core/normalizeTabsData';
import { chunkGroups, dedupeByFileFingerprint } from '@/core/importChunking';
import type { Tab, TabGroup } from '@/types/tab';

/** 造一个最小可用的标签（Tab 的必填字段一个不少 —— 类型即约束）。 */
const mkTab = (url: string): Tab => ({
  id: `tab-${url}`,
  url,
  title: url,
  favicon: '',
  pinned: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastAccessed: '2026-01-01T00:00:00.000Z',
});
import {
  importFileUnreadableReason,
  importNoImportableGroupReason,
  importWriteFailedReason,
} from '@/core/importResultReasons';
import {
  importPartialMessage,
  importSuccessMessage,
  countUnusable,
} from '@/components/layout/importResultCopy';
import {
  MAX_IMPORT_FILE_BYTES,
  importFileTooLargeMessage,
  formatFileSize,
} from '@/core/importLimits';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');
/** 去掉注释的源码（注释里提到某个调用不算「有这个调用」）。 */
const code = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

// ══════════════════════════════════════════════════════════════════════════
// DS-43-4：一个坏时间戳不得让整批导入归零
// ══════════════════════════════════════════════════════════════════════════
describe('DS-43-4 归一化必须「永不抛 + 逐组隔离」', () => {
  it('越界的时间戳不抛异常（实测过：new Date(1e20).toISOString() 抛 RangeError）', () => {
    // 有限 ≠ Date 能表示：|ms| > 8.64e15 时 new Date() 是 Invalid Date。
    let group: TabGroup | null = null;
    let thrown: unknown = null;
    try {
      group = normalizeImportedGroup({
        name: '坏时间戳的会话',
        createdAt: 1e20,
        tabs: [mkTab('https://example.com/a')],
      });
    } catch (error) {
      thrown = error;
    }
    assert.equal(thrown, null, '越界时间戳把整批导入带崩了（这是本缺陷的原始形态）');
    assert.ok(group);
    assert.equal(
      Number.isNaN(new Date(group.createdAt).getTime()),
      false,
      '兜底时间戳必须是合法 ISO（不能是 Invalid Date）'
    );
  });

  it('正常时间戳不得被换成 now（原值必须保留）', () => {
    const group = normalizeImportedGroup({
      name: '好的会话',
      createdAt: '2026-01-02T03:04:05.000Z',
      tabs: [mkTab('https://example.com/a')],
    });
    assert.equal(group.createdAt, '2026-01-02T03:04:05.000Z');
  });

  it('一个组坏掉只丢这一个组，其余照常（逐组隔离）', () => {
    // 造一个「归一化时必然抛」的组：容器键是个会抛的 getter。
    const evil = {
      name: '坏组',
      get tabs(): never {
        throw new Error('boom');
      },
    };
    const good = { name: '好组', tabs: [mkTab('https://example.com/a')] };
    const result = normalizeImportedGroupsIsolated([evil, good] as unknown[]);
    assert.equal(result.failed, 1, '坏组必须被单独计数');
    assert.equal(result.groups.length, 1, '好组必须活下来（整批归零 = 数据丢失）');
    assert.equal(result.groups[0].name, '好组');
  });

  it('全都好时不许虚报失败数', () => {
    const result = normalizeImportedGroupsIsolated([
      { name: 'a', tabs: [mkTab('https://example.com/a')] },
    ]);
    assert.equal(result.failed, 0);
  });
});

describe('DS-43-4 失败理由必须与故障对得上', () => {
  it('「文件读不懂」不得甩锅存储空间（否则用户去清存储 = 白忙）', () => {
    const reason = importFileUnreadableReason(12);
    assert.doesNotMatch(reason, /存储空间|写入权限/, '读文件失败与存储空间无关');
    assert.match(reason, /读不懂|格式/, '必须说清是文件本身的问题');
  });

  it('「写盘失败」说的是存储，不许提文件坏了', () => {
    const reason = importWriteFailedReason(12);
    assert.match(reason, /存储空间|写入权限/, '写盘失败必须指向存储');
    assert.doesNotMatch(reason, /文件读不懂|格式不对/, '写盘失败与文件格式无关');
  });

  it('「全不可导入」的理由要带上「读不出来」的那几个', () => {
    const reason = importNoImportableGroupReason(10, 2);
    assert.match(reason, /2/, '坏掉的那几个必须被说出来');
    const noFailed = importNoImportableGroupReason(10, 0);
    assert.doesNotMatch(noFailed, /读不出来/, '没有坏组时不该提它');
  });

  it('storage 的两条失败路径必须各用各的理由（接线）', () => {
    const src = code('src/utils/storage.ts');
    assert.match(src, /importFileUnreadableReason\(/, '读文件失败那一路没接上');
    assert.match(src, /importWriteFailedReason\(/, '写盘失败那一路没接上');
    assert.match(src, /importNoImportableGroupReason\(/, '全不可导入那一路没接上');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// DS-43-5：设置没恢复，必须说出来
// ══════════════════════════════════════════════════════════════════════════
describe('DS-43-5 设置合并失败不得静默', () => {
  it('成功提示里带上「设置没恢复」', () => {
    const message = importSuccessMessage({
      source: 5,
      imported: 5,
      settingsMergeFailed: true,
    });
    assert.match(message, /设置/, '设置没恢复必须说出来');
    assert.match(message, /主题|布局|排序/, '要说清是哪些设置');
  });

  it('部分成功的提示里也带上', () => {
    const message = importPartialMessage({
      source: 5,
      imported: 3,
      skippedExisting: 1,
      settingsMergeFailed: true,
    });
    assert.match(message, /设置/);
  });

  it('设置没恢复时不能说「全部导入成功」就完事', () => {
    const withoutFailure = importSuccessMessage({ source: 5, imported: 5 });
    const withFailure = importSuccessMessage({
      source: 5,
      imported: 5,
      settingsMergeFailed: true,
    });
    assert.notEqual(withoutFailure, withFailure, '两种情况的话术必须不同');
  });

  it('storage 必须把设置合并的失败上报出来（接线）', () => {
    const src = code('src/utils/storage.ts');
    assert.match(src, /settingsMergeFailed\s*=\s*true/, '设置合并失败没有被上报');
    assert.match(src, /settingsMergeFailed,/, '上报的字段没进返回值');
  });

  it('界面必须把它传给文案（接线）', () => {
    const dropdown = code('src/components/layout/HeaderDropdown.tsx');
    assert.match(dropdown, /settingsMergeFailed/, '界面没把「设置没恢复」告诉文案');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// DS-43-6：导出必须有回执
// ══════════════════════════════════════════════════════════════════════════
describe('DS-43-6 导出成功必须有回执', () => {
  it('JSON 导出后必须提示（文件名 + 会话数）', () => {
    const dropdown = code('src/components/layout/HeaderDropdown.tsx');
    const handler = dropdown.slice(
      dropdown.indexOf('const handleExportData'),
      dropdown.indexOf('const handleExportOneTabFormat')
    );
    assert.match(handler, /showToast\(/, 'JSON 导出零回执');
    assert.match(handler, /个会话/, '回执里要带会话数（用户唯一的核对依据）');
    assert.match(handler, /fileName/, '回执里要带文件名（用户要在下载列表里找它）');
  });

  it('OneTab 导出后同样要提示', () => {
    const dropdown = code('src/components/layout/HeaderDropdown.tsx');
    const handler = dropdown.slice(
      dropdown.indexOf('const handleExportOneTabFormat'),
      dropdown.indexOf('const handleExportDiagnostics')
    );
    assert.match(handler, /showToast\(/, 'OneTab 导出零回执');
    assert.match(handler, /个会话/);
  });

  it('日期戳必须走单源（不许各写各的 padStart）', () => {
    const dropdown = code('src/components/layout/HeaderDropdown.tsx');
    assert.match(dropdown, /formatExportStamp\(/, '导出文件名没走单源的日期戳');
    assert.doesNotMatch(
      dropdown,
      /padStart\(2,\s*'0'\)/,
      '又出现了一份手写的日期格式化（历史上这里出过一次月/日写反）'
    );
  });

  it('blob URL 不得点完就撤（撤销与下载取数撞上 ⇒ 静默失败）', () => {
    const dropdown = code('src/components/layout/HeaderDropdown.tsx');
    const handlers = dropdown.slice(
      dropdown.indexOf('const handleExportData'),
      dropdown.indexOf('const handleExportDiagnostics')
    );
    assert.doesNotMatch(
      handlers,
      /a\.click\(\);[\s\S]{0,200}?URL\.revokeObjectURL\(url\)/,
      '导出仍然是「点完立刻撤销 blob URL」—— 下载可能取不到这个文件'
    );
    assert.match(
      dropdown,
      /revokeBlobUrlLater/,
      '延后释放的助手没被用上（导出仍然是点完就撤）'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// DS-43-9：导入要有体积上限，且上限之下要能真的导进去
// ══════════════════════════════════════════════════════════════════════════
describe('DS-43-9 导入的体积上限与分块', () => {
  it('超限时的说明必须说清「文件没问题」和「怎么办」', () => {
    const message = importFileTooLargeMessage(80 * 1024 * 1024);
    assert.match(message, /80\.0 MB/, '必须报出实际大小');
    assert.match(message, /OneTab/, '必须给出路（只说「太大了」等于没说）');
    assert.match(message, /没问题/, '必须说清这不是文件坏了');
  });

  it('体积上限是「一次导入的文件大小」，不是「能存多少个会话」', () => {
    assert.ok(MAX_IMPORT_FILE_BYTES > 0);
    assert.equal(typeof MAX_IMPORT_FILE_BYTES, 'number');
    assert.match(formatFileSize(512 * 1024), /KB/);
    assert.match(formatFileSize(2 * 1024 * 1024), /MB/);
  });

  it('界面必须在读文件之前就拦（读进来再拦，弹窗已经被撑过了）', () => {
    const dropdown = code('src/components/layout/HeaderDropdown.tsx');
    assert.match(dropdown, /MAX_IMPORT_FILE_BYTES/, '界面没接体积上限');
    assert.match(dropdown, /rejectTooLargeFile/, '界面没接体积上限');
    // 拦截必须发生在 FileReader 之前：两处输入框都要拦。
    const guards = dropdown.match(/rejectTooLargeFile\(file\)/g) ?? [];
    assert.ok(guards.length >= 2, '两个导入入口（JSON / OneTab）都得拦');
  });

  it('大文件必须能真的导进去 ⇒ 导入要分块（一条巨型消息必炸）', () => {
    const groups = Array.from({ length: 1200 }, (_, i) => ({
      name: `会话 ${i}`,
      tabs: [mkTab(`https://example.com/${i}`)],
    }));
    const chunks = chunkGroups(groups);
    assert.ok(chunks.length > 1, '1200 个组必须切成多块');
    assert.equal(
      chunks.reduce((sum, c) => sum + c.length, 0),
      1200,
      '分块不能丢组'
    );
  });

  it('分块后跨块的重复项仍然只导一份（幂等不被分块破坏）', () => {
    const one = { name: '重复的会话', tabs: [mkTab('https://example.com/a')] };
    const result = dedupeByFileFingerprint([one, { ...one }]);
    assert.equal(result.groups.length, 1, '同名 + 同内容的第二个必须被去掉');
    assert.equal(result.duplicates, 1, '去掉的个数必须被计入（否则计数对不上）');
  });

  it('storage 的导入路径必须走分块（接线）', () => {
    const src = code('src/utils/storage.ts');
    assert.match(src, /chunkGroups\(/, '导入没有分块（大文件会撞消息上限）');
    assert.match(src, /dedupeByFileFingerprint\(/, '分块前没去重（跨块会造副本）');
    // 两条路径必须消费**同一份**分块结果：各自分一次时，
    // 「源码里出现了 chunkGroups(」会被另一条路径的调用满足 ⇒
    // 「把其中一条偷偷改回整块发送」这个变异照样全绿（实测过）。
    assert.match(
      src,
      /for \(const chunk of chunks\)/,
      '本地兜底路径没有消费共享的分块结果（它可以偷偷改回整块发送）'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// DS-15：同名不同内容的会话会并存 —— 必须说
// ══════════════════════════════════════════════════════════════════════════
describe('DS-15 导入不覆盖这件事必须被说出来', () => {
  it('部分成功的提示里带这句说明', () => {
    const message = importPartialMessage({ source: 3, imported: 2, skippedExisting: 1 });
    assert.match(message, /同名/, '必须提到同名会话');
    assert.match(message, /并存|不覆盖/, '必须说清是「并存」而不是「重复导入错」');
  });

  it('全部成功的提示里也带（用户第一次看到两份同名会话就在这一刻）', () => {
    const message = importSuccessMessage({ source: 2, imported: 2 });
    assert.match(message, /同名/);
  });

  it('「读不出来」的那几个必须单独说（不能混进「为空会话」里）', () => {
    const message = importPartialMessage({
      source: 5,
      imported: 3,
      skippedExisting: 1,
      failedGroups: 1,
    });
    assert.match(message, /读不出来/);
    // 恒等式：source = imported + skippedExisting + unusable + failed
    assert.equal(countUnusable({ source: 5, imported: 3, skippedExisting: 1, failedGroups: 1 }), 0);
    assert.equal(countUnusable({ source: 6, imported: 3, skippedExisting: 1, failedGroups: 1 }), 1);
  });
});
