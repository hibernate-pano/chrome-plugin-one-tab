/**
 * 多条提示**互相遮挡**这条回归不许再发生（2026-10-25）。
 *
 * ── 撞到这件事的经过 ────────────────────────────────────────────────────
 *
 * OneTab 导入的那条**必说披露**有 5 行（格式带不过去什么 + 后果 + 下一步 +
 * 「保存时间未知」那句）。真机探针（scripts/_probe-imported-save-time.mjs）
 * 截图发现：这条提示的**下半截被下面那条「完成」提示盖住了** ⇒
 * 用户读不到「列表里显示为「导入 · …」」那半句 ⇒ **说了等于没说**。
 *
 * 根因不在文案，在**堆叠算法**：旧实现把偏移写死成 `序号 * 76`
 * （= 一条**单行**提示的估计高度）。
 *
 * ⚠️ 遮挡的机制要说准（否则守卫会钉错东西）──────────────────────────────
 *
 *   · 当时提示锚在**底边**：`fixed bottom-4` + `marginBottom: 偏移`
 *     ⇒ 偏移越大越靠上，最新的那条在最下面。
 *   · 提示之间**没有 z-index** ⇒ DOM 里靠后的盖住靠前的 ⇒ 较新的画在较旧的之上。
 *   · 于是：较新的那条只要**比 76px 高**，它的顶边就会伸进较旧那条的底部
 *     ⇒ 较旧那条的**结尾**被盖住（真机截图里被盖的正是「注意」那条的末两行）。
 *
 * 2026-10-26 提示挪回**右上角**（`fixed right-4 top-4` + `marginTop`），
 * 方向翻过来：最新的贴着顶边，更旧的往下排。**算式一字未改** —— 它算的是
 * 「相邻两条要让开对方的高度 + 间距」，与锚在顶边还是底边无关。
 *
 * ⇒ 正确的不变式（与锚点无关）：**较旧那条的偏移 ≥ 较新那条的偏移 + 它的高度**
 *   （不是「偏移 ≥ 自己的高度」—— 那是另一个量纲，钉它会钉错）。
 *
 * ⚠️ 这个缺陷**早于**本次修复就存在（旧披露有 4 行，同样被盖）——
 * 实证：把打包产物里的那句提示删短、重跑同一个探针 ⇒ 照样被盖。
 * ⇒ 修的是**根因**（按实测高度堆叠），不是给长文案打补丁。
 *
 * ── 判据钉的是**不变式**，不是字面量 ──────────────────────────────────────
 *
 * 核心不变式用**任意队列**去验，而不是钉住「5 行那条必须是 200px」这种
 * 字面量 ⇒ 文案以后变长变短都不必改守卫。
 *
 * 另有一条**自证检测力**的断言：把**旧算法**（写死 76）拿进来算一遍，
 * 它**必须**违反那条不变式 ⇒ 证明这条守卫真的看得见旧缺陷
 * （否则它可能只是一条恒真的守卫 —— 见「守卫钉死字面量的陷阱」）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeToastStackOffsets,
  DEFAULT_TOAST_HEIGHT,
  TOAST_STACK_GAP,
} from '../../src/components/common/toastStack.ts';

interface Entry {
  id: number;
  height?: number;
}

/**
 * **旧算法**（2026-10-25 之前）：偏移 = 堆叠序号 × 76。
 *
 * 留在这里是为了**自证检测力**（见文件头）：守卫必须能判它红。
 */
const legacyOffsets = (queue: Entry[]): Map<number, number> => {
  const offsets = new Map<number, number>();
  queue.forEach((item, index) => {
    offsets.set(item.id, (queue.length - 1 - index) * 76);
  });
  return offsets;
};

const heightOf = (entry: Entry): number =>
  typeof entry.height === 'number' && entry.height > 0
    ? entry.height
    : DEFAULT_TOAST_HEIGHT;

/**
 * 不变式：**较旧那条的偏移 ≥ 较新那条的偏移 + 它的高度** ⇒ 谁也盖不住谁。
 *
 * 队列顺序 = 从旧到新 ⇒ queue[i] 较旧（靠下）、queue[i+1] 较新（靠上）。
 * 提示 i 的顶边 = 偏移(i)；提示 i+1 的底边 = 偏移(i+1) + 高度(i+1)。
 */
const noOverlapHolds = (queue: Entry[], offsets: Map<number, number>): boolean => {
  for (let i = 0; i < queue.length - 1; i += 1) {
    const olderTop = offsets.get(queue[i].id) ?? 0;
    const newerBottom = (offsets.get(queue[i + 1].id) ?? 0) + heightOf(queue[i + 1]);
    if (olderTop < newerBottom) return false;
  }
  return true;
};

describe('提示堆叠：谁也不许盖住谁', () => {
  it('最新的一条贴着顶边（它是用户刚看到的那个）', () => {
    const queue: Entry[] = [
      { id: 1, height: 60 },
      { id: 2, height: 200 },
      { id: 3, height: 40 },
    ];
    const offsets = computeToastStackOffsets(queue);

    assert.equal(offsets.get(3), 0, '最新那条（id=3）必须贴着顶边');
    assert.ok(
      (offsets.get(2) ?? 0) > 0 && (offsets.get(1) ?? 0) > (offsets.get(2) ?? 0),
      '越旧的那条必须越靠下（id=1 最低，id=3 最高）'
    );
  });

  it('不变式：较旧那条的偏移 ≥ 较新那条的偏移 + 它的高度', () => {
    // 队列顺序 = 从旧到新（与 ToastContext 里的数组一致）。
    const queue: Entry[] = [
      { id: 1, height: 200 }, // 一条 5 行的长披露
      { id: 2, height: 64 },
      { id: 3, height: 120 },
    ];
    const offsets = computeToastStackOffsets(queue);

    assert.ok(
      noOverlapHolds(queue, offsets),
      '有一条提示被相邻那条盖住了 ⇒ 用户读不到它的结尾'
    );
  });

  it('真机那个形状：5 行的披露与两行的提示相邻 ⇒ 谁也不许被盖', () => {
    // 真机截图里出现过的形状：一条 5 行的「注意」+ 一条 2 行的提示。
    const queue: Entry[] = [
      { id: 1, height: 200 },
      { id: 2, height: 99 },
    ];
    const offsets = computeToastStackOffsets(queue);

    assert.ok(
      noOverlapHolds(queue, offsets),
      '较新的那条（99px）压住了较旧那条的顶部 ⇒ 用户读不到它的开头'
    );
    // 旧算法：两条只隔 76px ⇒ 99px 这条会盖掉相邻那条 23px。
    assert.ok(
      (offsets.get(1) ?? 0) > 76,
      `偏移 ${offsets.get(1)} 必须大于旧算法写死的 76 ⇒ 旧的遮挡真的被修掉了`
    );
  });

  it('没量到高度时按 76px 兜底（= 旧值）⇒ 单行提示的观感与从前一致', () => {
    const queue: Entry[] = [{ id: 1 }, { id: 2 }];
    const offsets = computeToastStackOffsets(queue);

    assert.equal(offsets.get(2), 0, '最新那条贴顶边');
    assert.equal(
      offsets.get(1),
      DEFAULT_TOAST_HEIGHT + TOAST_STACK_GAP,
      '没量到高度时按兜底值算（这样首帧不会跳）'
    );
  });

  it('两条之间要留出间距（不是紧贴）', () => {
    const queue: Entry[] = [
      { id: 1, height: 50 },
      { id: 2, height: 50 },
    ];
    const offsets = computeToastStackOffsets(queue);

    assert.equal(offsets.get(1), 50 + TOAST_STACK_GAP, '较旧那条要让开「较新那条的高度 + 间距」');
    assert.ok(TOAST_STACK_GAP > 0, '间距必须是正数 ⇒ 两条不贴在一起');
  });

  it('自证检测力：旧算法（写死 76）必须违反那条不变式', () => {
    // 较新的那条比 76px 高 ⇒ 旧算法必然让它压住较旧那条的顶部。
    const queue: Entry[] = [
      { id: 1, height: 64 },
      { id: 2, height: 200 },
    ];

    assert.equal(
      noOverlapHolds(queue, legacyOffsets(queue)),
      false,
      '旧算法居然没被抓住 ⇒ 这条守卫没有检测力（守卫本身坏了）'
    );
    assert.equal(
      noOverlapHolds(queue, computeToastStackOffsets(queue)),
      true,
      '新算法必须守住那条不变式'
    );
  });
});
