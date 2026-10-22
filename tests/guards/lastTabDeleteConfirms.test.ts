// 删掉会话里最后一条标签时必须先确认（2026-10-18 round 22）。
//
// 【要防的回归类别】删除**整个会话**有确认开关（`confirmBeforeDelete`，默认开），
// 但同一张卡片上的 ✕（逐条删除）从不确认。而 `applyRemoveTab` 的语义是
// 「删掉未锁定组里最后一条活跃标签 ⇒ 整组物理移除」—— 于是用户在只有一条记录的会话上
// 点 ✕，**一次点击就不可撤销地销毁了整个会话**（v1.22.0 起无回收站），
// 而设置页当时还写着「单个标签页的 ✕ 永远直接删」。
//
// 主 agent 2026-10-18 已定的口径（state.md「已定的产品口味」#2）：
//   只有当这次删除会让整个会话消失时，才走 `confirmBeforeDelete`；普通逐条删除保持即时
//   （✕ 已带「无法恢复」提示，给日常单删加确认只会变噪音）。
//   判定条件**复用** `applyRemoveTab` 的同一份语义（`shouldAutoDeleteAfterTabRemoval`），不另写一套。
//
// 本守卫钉三件事：① 判据本身的行为（纯函数）；② 两个入口（列表页 / 搜索页）都走同一口径；
// ③ 设置页的文案必须与行为一致（声明必须等于行为 —— 这是本产品的核心理念）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldAutoDeleteAfterTabRemoval } from '@/core/tabGroupUtils';
import type { Tab, TabGroup } from '@/types/tab';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

const mkTab = (id: string, isDeleted?: true): Tab =>
  ({ id, url: `https://example.com/${id}`, title: id, createdAt: '2026-10-18T00:00:00.000Z', lastAccessed: '2026-10-18T00:00:00.000Z', ...(isDeleted ? { isDeleted } : {}) }) as Tab;

const mkGroup = (tabs: Tab[], isLocked = false): TabGroup =>
  ({ id: 'g-1', name: '会话', tabs, createdAt: '2026-10-18T00:00:00.000Z', updatedAt: '2026-10-18T00:00:00.000Z', isLocked }) as TabGroup;

/** 取出某个 handler 的函数体（从 `const handleDeleteTab` 到下一个顶层 `const` / `//` 注释）。 */
function handlerBody(source: string, marker: string): string {
  const at = source.indexOf(marker);
  assert.ok(at !== -1, `找不到 ${marker} —— 守卫前提变了`);
  const ends = ['\n  const ', '\n  // ']
    .map(sep => source.indexOf(sep, at + marker.length))
    .filter(i => i !== -1);
  return source.slice(at, ends.length ? Math.min(...ends) : source.length);
}

describe('shouldAutoDeleteAfterTabRemoval：这条删除会不会连整个会话一起带走', () => {
  it('未锁定组里删最后一条活跃标签 → true（整组物理移除）', () => {
    assert.equal(shouldAutoDeleteAfterTabRemoval(mkGroup([mkTab('t1')]), 't1'), true);
  });

  it('还有别的活跃标签 → false（普通逐条删除，不该弹确认）', () => {
    assert.equal(shouldAutoDeleteAfterTabRemoval(mkGroup([mkTab('t1'), mkTab('t2')]), 't1'), false);
  });

  it('锁定组 → false（锁定豁免，组留着等被再次填充）', () => {
    assert.equal(shouldAutoDeleteAfterTabRemoval(mkGroup([mkTab('t1')], true), 't1'), false);
  });

  it('墓碑标签不算「还有内容」——只剩墓碑时同样会整组消失', () => {
    const group = mkGroup([mkTab('t1'), mkTab('t2', true)]);
    assert.equal(shouldAutoDeleteAfterTabRemoval(group, 't1'), true);
  });
});

describe('两个入口（列表页 / 搜索页）都走同一口径', () => {
  const callSites = [
    ['src/components/tabs/TabGroup.tsx', '列表页'],
    ['src/components/search/SearchResultList.tsx', '搜索页'],
  ] as const;

  for (const [file, label] of callSites) {
    it(`${label}（${file}）的 ✕ 先问判据、命中才弹确认`, () => {
      const source = read(file);
      // 只钉「判据来自 core/tabGroupUtils」这**一件事** —— 不钉 import 的**长相**
      // （同一个模块再导入别的名字是常事，钉死名单会把无关的改动变成红灯）。
      assert.match(
        source,
        /import \{[^}]*\bshouldAutoDeleteAfterTabRemoval\b[^}]*\} from '@\/core\/tabGroupUtils'/,
        `${file} 没有复用 applyRemoveTab 的同一份判据（别另写一套）`
      );

      const body = handlerBody(source, 'const handleDeleteTab');

      // 只有一条删除路径，且它同时服务「直通」与「确认后」两处 —— 这样不可能出现
      // 「确认框弹了，但另一条路已经先删掉」这种假拦截。
      const dispatches = body.match(/dispatch\(deleteTabAndSync/g) ?? [];
      assert.equal(dispatches.length, 1, `${file}：handleDeleteTab 里有 ${dispatches.length} 条删除路径，只该有一条`);
      assert.match(body, /onConfirm: runDelete/, `${file}：确认框没有接上真正的删除动作`);
      assert.match(
        body,
        /if \(!confirmBeforeDelete \|\| !shouldAutoDeleteAfterTabRemoval\(group, tab/,
        `${file}：没有「开关关掉时直通、开着且命中判据才确认」这条闸门`
      );
      assert.match(
        body.slice(body.indexOf('shouldAutoDeleteAfterTabRemoval')),
        /runDelete\(\);/,
        `${file}：判据之后的直通路径没调 runDelete —— 普通单删会变成没反应`
      );
    });
  }
});

describe('设置页文案必须与行为一致', () => {
  it('「删除前确认」的说明写明了最后一条标签这一例外', () => {
    const source = read('src/options/OptionsPage.tsx');
    const at = source.indexOf('label="删除前确认"');
    assert.ok(at !== -1, '设置页找不到「删除前确认」开关，守卫前提变了');
    const hint = source.slice(at, source.indexOf('/>', at));
    assert.match(hint, /最后一条/, '文案没提「删掉最后一条标签会连整个会话一起删」这一例外');
    assert.doesNotMatch(
      hint,
      /永远直接删/,
      '文案又写成「✕ 永远直接删」—— 与现在的行为（最后一条会先确认）矛盾'
    );
  });
});
