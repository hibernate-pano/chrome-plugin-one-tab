/**
 * 「清理旧会话」菜单必须真的走那条路（2026-11-03）。
 *
 * ── 这个文件防的具体事故 ──────────────────────────────────────────────────
 *
 * 「判据层写对了、界面没接上」是本仓反复出现过的形态：
 *   · 菜单不渲染行模型 ⇒ 新功能等于没有（用户根本看不到那一档）；
 *   · 行渲染了但点击走错路径 ⇒ 点「保留锁定」却把锁定的也删了（最贵的一种错）；
 *   · 确认前不读磁盘 ⇒ 用 Redux 快照算名单，用户看到 12 个、实际删 13 个；
 *   · 读磁盘失败还继续删 ⇒ 破坏性路径 fail-closed 被破。
 *
 * ── 为什么是源码层守卫 ────────────────────────────────────────────────────
 *
 * 组件渲染需要浏览器，本仓没有 DOM 测试环境 ⇒ 界面接线只能读源码。
 * ⚠️ **源码层守卫本身没有检测力**（「源码里出现了某段代码」不等于它被用上了），
 *   所以本文件的每条断言都配了对应的变异（`tests/guards/cleanupMutation.test.ts`）：
 *   改坏实现 ⇒ 这里必须变红。判据的**行为**部分在 `tests/cleanupMenuModel.test.ts`，
 *   那里是**真的调用**行模型。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

/** 去掉注释 —— 只看**会被渲染出来**的东西。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

const SRC = stripComments(read('src/components/layout/HeaderDropdown.tsx'));

describe('清理旧会话：界面接线', () => {
  it('菜单必须渲染**行模型**给的行（界面不许自己拼行文字）', () => {
    assert.ok(SRC.includes('cleanupMenuRows('), '必须调用 cleanupMenuRows');
    assert.ok(SRC.includes('row.label'), '必须渲染 row.label');
    assert.ok(
      !SRC.includes('cleanupTierLabel('),
      '行文字必须来自行模型 —— 界面自己挑标签就多了一套「挑哪个键」的规则'
    );
  });

  it('两档「全部」必须按 path 分派（含锁定那档走既有 deleteAllGroups）', () => {
    assert.ok(
      /row\.path === 'deleteAll'/.test(SRC),
      '必须按 row.path 分派：含锁定那档与时间档的后果相反，不能走同一条路'
    );
    assert.ok(SRC.includes('handleDeleteAllGroups()'), '「含锁定」那档必须走既有路径');
    assert.ok(SRC.includes('handleCleanupTier(row.tier)'), '其余档必须走 deleteGroups 路径');
  });

  it('确认前必须读磁盘真值，读不到就**中止**（fail closed）', () => {
    assert.ok(SRC.includes('storage.getGroupsForWrite()'), '必须读磁盘真值');
    assert.match(
      SRC,
      /catch \(error\)[\s\S]{0,240}showToast\(CLEANUP_READ_FAILED_MESSAGE, 'error'\)[\s\S]{0,40}return;/,
      '读失败必须中止（不许退回 Redux 快照继续删）'
    );
  });

  it('算出来 0 条时不弹确认框', () => {
    assert.match(SRC, /plan\.ids\.length === 0/, '必须有不弹确认框的短路');
    assert.ok(SRC.includes('CLEANUP_NOTHING_MESSAGE'), '0 条要说清「没有可清理的会话」');
  });

  it('执行必须按**确认时**的 id 清单（不许让 SW 现算）', () => {
    assert.match(
      SRC,
      /dispatch\(deleteGroups\(plan\.ids\)\)/,
      '必须按确认框里那批 id 执行 —— 名字就是承诺'
    );
  });

  it('菜单行的条数与确认框必须同源（都来自 planCleanup 的同一份结果）', () => {
    assert.ok(SRC.includes('planCleanup('), '六档计划必须由判据层算');
    assert.ok(
      /const cleanupPlans = useMemo/.test(SRC),
      '六档计划必须一次性算完并缓存（渲染里现算会让菜单与确认框对不上）'
    );
  });
});
