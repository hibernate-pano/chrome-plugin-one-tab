/**
 * 2026-10-19 专家评审 · 数据安全批的回归守卫。
 *
 * 覆盖本轮修掉的四条「说法与行为相反」或数据丢失路径：
 *   F-2 加载中的标签被存成 about:blank（真实网址永久丢失）
 *   F-5 重复导入时把「已存在」误报成「文件内容坏了」
 *   F-7 SW 回包的英文机器串直接弹给全中文界面
 *   F-8 写操作失败把底层异常原文拼给用户
 *
 * 【判据纪律】
 *   · 纯函数（resolveStorableUrl / applyImportGroups / 文案映射）直接跑**行为**断言；
 *   · 组件内的 .tsx 加载不了（仓库无 DOM 测试环境），用源码结构断言，
 *     沿用本仓既有惯例（见 guards/lockedTabDeleteGuard.test.ts）。
 *
 * 【为什么每条都要能变红】这批缺陷的共同形态是「一句话写错了」——
 * 一旦只测「函数存在」，把实现改回原样照样全绿。所以每条断言都钉住
 * **具体的错误输出形态**，而不是「有输出」。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isValidTab, resolveStorableUrl } from '../../src/domain/tabGroup/filters.ts';
import { createTabGroupFromChromeTabs } from '../../src/domain/tabGroup/factory.ts';
import { applyImportGroups, applyMoveTab } from '../../src/core/mutationOps.ts';
import { toServiceWorkerErrorCopy } from '../../src/utils/serviceWorkerErrorCopy.ts';
import { mutationErrorMessage, toMutationErrorCopy } from '../../src/components/tabs/mutationErrorCopy.ts';
import { sanitizeTabUrl } from '../../src/utils/inputValidation.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');
const code = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

// ══════════════════════════════════════════════════════════════════════════
// F-2：加载中的标签（url 为空 + pendingUrl 有值）
// ══════════════════════════════════════════════════════════════════════════
describe('F-2 加载中的标签必须用 pendingUrl 落盘，不能变成 about:blank', () => {
  const loading = { url: '', pendingUrl: 'https://example.com/slow', title: '正在加载…' };

  it('isValidTab 认得加载中的标签（它有真实的目标地址）', () => {
    assert.equal(isValidTab(loading as chrome.tabs.Tab), true);
  });

  it('resolveStorableUrl 优先取 pendingUrl', () => {
    assert.equal(
      resolveStorableUrl(loading as chrome.tabs.Tab),
      'https://example.com/slow',
      '加载中的标签必须保留它的目标地址'
    );
  });

  it('resolveStorableUrl 优先取正式 url（pendingUrl 只在 url 缺失时用）', () => {
    assert.equal(
      resolveStorableUrl({ url: 'https://real.com', pendingUrl: 'https://pending.com', title: 'x' } as chrome.tabs.Tab),
      'https://real.com'
    );
  });

  it('两者都空时返回空串（不兜底成 about:blank）', () => {
    assert.equal(
      resolveStorableUrl({ url: '', pendingUrl: '', title: 'x' } as chrome.tabs.Tab),
      '',
      'about:blank 是能存能同步能恢复的假地址，会让用户以为那个网页还在'
    );
  });

  it('危险协议与内部页即便在 pendingUrl 里也不存', () => {
    assert.equal(resolveStorableUrl({ url: '', pendingUrl: 'javascript:alert(1)', title: 'x' } as chrome.tabs.Tab), '');
    assert.equal(resolveStorableUrl({ url: '', pendingUrl: 'chrome://settings', title: 'x' } as chrome.tabs.Tab), '');
  });

  it('落盘结果里就是那个真实网址（端到端）', () => {
    const group = createTabGroupFromChromeTabs([loading as chrome.tabs.Tab], {
      now: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(group.tabs.length, 1);
    assert.equal(group.tabs[0].url, 'https://example.com/slow');
    assert.notEqual(group.tabs[0].url, 'about:blank');
  });

  it('网址与标题都取不到的标签被丢弃（不留一条空地址）', () => {
    const group = createTabGroupFromChromeTabs(
      [{ url: '', pendingUrl: '', title: '' } as unknown as chrome.tabs.Tab],
      { now: '2026-01-01T00:00:00.000Z' }
    );
    assert.equal(group.tabs.length, 0, '没有网址的标签不该落盘');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// F-5：重复导入的两种「跳过」必须分开计数
// ══════════════════════════════════════════════════════════════════════════
describe('F-5 重复导入时「已存在」与「内容有问题」分开计数', () => {
  const existing = {
    id: 'g1',
    name: '工作会话',
    notes: '',
    isFavorite: false,
    isLocked: false,
    isDeleted: false,
    tabs: [{ id: 't1', url: 'https://a.com', title: 'a', favicon: '', createdAt: '2026-01-01T00:00:00.000Z', lastAccessed: '2026-01-01T00:00:00.000Z', pinned: false }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
  } as never;

  // 用**真实的** sanitizeTabUrl：危险协议必须被它拒掉。
  // 用桩（`u ? u : null`）的话，javascript: 会被当成合法地址，
  // 这条测试就成了假绿。
  const deps = { genId: () => 'new-id', sanitizeUrl: sanitizeTabUrl };
  const stamp = { d: 'dev', s: 1 } as never;

  it('同一份内容重复导入 ⇒ imported=0 且 skippedExisting=1', () => {
    const r = applyImportGroups([existing], [existing], deps, '2026-01-02T00:00:00.000Z', stamp);
    assert.equal(r.imported.length, 0, '已存在的不该重复导入');
    assert.equal(r.skippedExisting, 1, '「已存在」必须被单独计数');
  });

  it('空会话 / 危险 URL 被丢掉时不算「已存在」', () => {
    const bad = {
      id: 'g2',
      name: '空的',
      notes: '',
      isFavorite: false,
      isLocked: false,
      isDeleted: false,
      tabs: [{ id: 't2', url: 'javascript:alert(1)', title: 'x', favicon: '', createdAt: '2026-01-01T00:00:00.000Z', lastAccessed: '2026-01-01T00:00:00.000Z', pinned: false }],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
    } as never;
    const r = applyImportGroups([], [bad], deps, '2026-01-02T00:00:00.000Z', stamp);
    assert.equal(r.imported.length, 0);
    assert.equal(r.skippedExisting, 0, '内容有问题不是「已存在」');
  });

  it('两者相加不超过 source（两个计数互斥）', () => {
    const r = applyImportGroups([existing], [existing], deps, '2026-01-02T00:00:00.000Z', stamp);
    assert.ok(r.imported.length + r.skippedExisting <= 1);
  });

  it('UI 用了能分开说的那套文案', () => {
    const dropdown = code('src/components/layout/HeaderDropdown.tsx');
    assert.match(dropdown, /importPartialMessage/, '导入提示必须走分开说的文案模块');
    assert.match(dropdown, /skippedExisting/, '必须把 skippedExisting 传进文案');
    assert.doesNotMatch(
      dropdown,
      /其余 \$\{[^}]*\} 个为空会话或只含无法保存的网址/,
      '旧的合并文案不得复活（它把幂等跳过说成文件坏了）'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// F-3：锁定会话的标签不得被拖走
// ══════════════════════════════════════════════════════════════════════════
describe('F-3 锁定会话的标签不可拖走', () => {
  it('DraggableTab 的 draggable 受 locked 约束', () => {
    const src = code('src/components/dnd/DraggableTab.tsx');
    assert.match(
      src,
      /draggable=\{!locked\}/,
      '锁定组的行根本不该能进入拖拽态 —— 拖出组 = 从本组移除，拖走最后一条 = 整组物理移除'
    );
    assert.doesNotMatch(
      src,
      /\n\s*draggable\s*\n/,
      '无条件的 draggable 不得复活'
    );
  });

  it('拖拽入口还有第二道闸（脚本触发拖拽时也拦得住）', () => {
    const src = code('src/components/dnd/DraggableTab.tsx');
    const at = src.indexOf('const handleDragStart = useCallback(');
    assert.ok(at !== -1, '找不到 handleDragStart');
    const body = src.slice(at, src.indexOf('const handleDragEnd', at));
    const lockAt = body.indexOf('if (locked)');
    const beginAt = body.indexOf('beginDragSession(');
    assert.ok(lockAt > -1, 'handleDragStart 必须先判锁定态');
    assert.ok(
      beginAt > lockAt,
      '锁定判断必须排在 beginDragSession 之前，否则会留下一个没有 dragend 收尾的拖拽会话'
    );
    assert.match(body.slice(lockAt, beginAt), /preventDefault\(\)/, '必须取消这次拖拽');
  });

  it('拦住时必须出声（不能静默 return）', () => {
    const src = code('src/components/dnd/DraggableTab.tsx');
    assert.match(src, /onLockedDragBlocked/, '必须有一个专门的回调负责出声');
  });

  it('TabGroup 传了这个回调，且说了为什么', () => {
    const src = code('src/components/tabs/TabGroup.tsx');
    assert.match(src, /onLockedDragBlocked=\{handleLockedDragBlocked\}/);
    assert.match(src, /会话已锁定，解锁后才能移动其中的标签/);
  });

  it('数据层：锁定组被搬空后仍然是 0 标签的锁定组（视图层会滤掉它）', () => {
    // 这条是**现状说明**，不是修复：数据层一直保留锁定组（不物理删），
    // 由视图层的 toActiveGroupsView 过滤。F-3 修的是「用户能不能把它拖空」。
    const L = {
      id: 'L', name: 'locked', isLocked: true, isDeleted: false,
      tabs: [{ id: 't1', url: 'https://a.com', title: 'a', favicon: '', createdAt: '2026-01-01T00:00:00.000Z', lastAccessed: '2026-01-01T00:00:00.000Z', pinned: false }],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', version: 1,
    } as never;
    const D = {
      id: 'D', name: 'dest', isLocked: false, isDeleted: false,
      tabs: [{ id: 't2', url: 'https://b.com', title: 'b', favicon: '', createdAt: '2026-01-01T00:00:00.000Z', lastAccessed: '2026-01-01T00:00:00.000Z', pinned: false }],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', version: 1,
    } as never;
    const r = applyMoveTab([L, D], { sourceGroupId: 'L', sourceIndex: 0, targetGroupId: 'D', targetIndex: 0 }, '2026-01-02T00:00:00.000Z', { d: 'x', s: 1 } as never);
    const locked = r.groups.find(g => g.id === 'L');
    assert.ok(locked, '锁定组在数据层必须还在（锁定 = 不物理删除）');
    assert.equal(locked!.isLocked, true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// F-7：SW 的机器码不得原样进界面
// ══════════════════════════════════════════════════════════════════════════
describe('F-7 SW 错误必须翻译成中文，不透出英文机器串', () => {
  it('no_valid_urls 有中文文案', () => {
    const out = toServiceWorkerErrorCopy('no_valid_urls', '兜底');
    assert.match(out, /[\u4e00-\u9fa5]/, '必须是人话');
    assert.doesNotMatch(out, /no valid URLs/i);
  });

  it('url_scheme_not_allowed 有中文文案', () => {
    const out = toServiceWorkerErrorCopy('url_scheme_not_allowed', '兜底');
    assert.match(out, /[\u4e00-\u9fa5]/);
    assert.doesNotMatch(out, /URL scheme/i);
  });

  it('历史英文原文（连字符变体）也能翻译', () => {
    assert.match(toServiceWorkerErrorCopy('no valid URLs', '兜底'), /[\u4e00-\u9fa5]/);
    assert.match(toServiceWorkerErrorCopy('URL scheme not allowed', '兜底'), /[\u4e00-\u9fa5]/);
  });

  it('已经是中文的句子原样透出', () => {
    const zh = '此标签在当前设备无法打开（本地文件/临时链接/浏览器内部页面），已保留在会话中';
    assert.equal(toServiceWorkerErrorCopy(zh, '兜底'), zh);
  });

  it('未登记的机器码落到兜底（不给用户看英文原文）', () => {
    const out = toServiceWorkerErrorCopy('some_internal_reason_code', '兜底文案');
    assert.equal(out, '兜底文案');
    assert.doesNotMatch(out, /some_internal_reason_code/);
  });

  it('空值 / 非字符串落到兜底', () => {
    assert.equal(toServiceWorkerErrorCopy(undefined, '兜底'), '兜底');
    assert.equal(toServiceWorkerErrorCopy('', '兜底'), '兜底');
    assert.equal(toServiceWorkerErrorCopy(123, '兜底'), '兜底');
  });

  it('SW 源码里不再有裸的英文机器串', () => {
    const sw = code('src/service-worker.ts');
    assert.doesNotMatch(sw, /'no valid URLs'/, 'SW 必须回稳定 reason 码');
    assert.doesNotMatch(sw, /'URL scheme not allowed'/, 'SW 必须回稳定 reason 码');
    assert.match(sw, /'no_valid_urls'/);
    assert.match(sw, /'url_scheme_not_allowed'/);
  });

  it('两个恢复入口都接了翻译层', () => {
    for (const rel of [
      'src/components/tabs/TabGroup.tsx',
      'src/components/search/SearchResultList.tsx',
    ]) {
      const src = code(rel);
      assert.match(src, /toServiceWorkerErrorCopy/, `${rel} 必须把 SW 的 error 翻译后再显示`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// F-8：写操作失败不得把底层异常原文拼给用户
// ══════════════════════════════════════════════════════════════════════════
describe('F-8 写操作失败的文案不得含内部 op 名与实现细节', () => {
  it('超时的错误给出「请重试」而不是协议原文', () => {
    const out = mutationErrorMessage('更新会话', new Error('操作超时（超过 30 秒无响应）：removeTab'));
    assert.match(out, /更新会话失败/);
    assert.match(out, /重试|响应/);
    assert.doesNotMatch(out, /removeTab/, '内部 op 名不得出现在界面上');
    assert.doesNotMatch(out, /30 秒无响应/, '协议细节不得出现在界面上');
  });

  it('存储不可用给出可行动的方向', () => {
    const out = mutationErrorMessage('保存会话', new Error('QUOTA_BYTES quota exceeded'));
    assert.match(out, /存储/);
    assert.doesNotMatch(out, /QUOTA_BYTES/);
  });

  it('未知错误落到通用兜底（不把原文透出去）', () => {
    const out = mutationErrorMessage('移动标签', new Error('Boom at src/core/thing.ts:42'));
    assert.match(out, /移动标签失败/);
    assert.doesNotMatch(out, /src\/core\/thing\.ts/);
  });

  it('raw 字段仍保留原文（供日志用）', () => {
    const copy = toMutationErrorCopy('更新会话', new Error('操作超时：removeTab'));
    assert.match(copy.raw, /removeTab/, '原文必须留给日志');
    assert.doesNotMatch(copy.message, /removeTab/, '但不得进界面');
  });

  it('会话卡片的失败提示全部走文案层', () => {
    const src = code('src/components/tabs/TabGroup.tsx');
    assert.doesNotMatch(
      src,
      /showDeleteError\(`[^`]*\$\{error\.message/,
      '不得把 error.message 直接拼进界面'
    );
    assert.doesNotMatch(
      src,
      /showRestoreError\(`[^`]*\$\{error\?\.message/,
      '不得把 error?.message 直接拼进界面'
    );
    assert.match(src, /mutationErrorMessage/, '必须走文案层');
  });

  it('搜索页的失败提示同样走文案层', () => {
    const src = code('src/components/search/SearchResultList.tsx');
    assert.doesNotMatch(src, /showDeleteError\(`[^`]*\$\{error\.message/);
    assert.match(src, /mutationErrorMessage/);
  });
});
