/**
 * DS-43-16：删掉**最后一条**标签页 = 删掉整个会话 —— 这件事必须**说出来**。
 *
 * ── 缺陷本体（2026-10-23 审计 DS-43-16）──────────────────────────────────
 * v1.22.0 起删除是**物理清除**（无回收站、无撤销）。而「删掉会话里的最后一条」
 * 等于「删掉整个会话」—— 整张卡从列表里消失。
 *
 * 「删除会话前确认」开关**打开**时，弹出的确认框写清了
 * 「这是该会话的最后一条标签页，删除后整个会话会从列表消失」（TabGroup.tsx）。
 * 但开关**关闭**时（默认关闭）**零确认** ⇒ 整张卡静默消失，
 * 而 ✕ 的提示只说「从会话中移除这条记录（无法恢复）」——
 * **没说整张会话卡会一起消失**。提示与现象对不上。
 *
 * ⇒ 后果必须写在**按钮自己身上**（`title` + `aria-label`）：
 *   读屏用户与视觉用户拿到同一句契约。
 *
 * ── 本文件钉住的三条 ──────────────────────────────────────────────────────
 * ① 文案层（纯函数 `removeTabEntryCopy`）：
 *    「会移除整个会话」与「只移除这条」是**两种不同的提示**，不能是同一句。
 * ② 判据层（`onlyActiveTabId` ↔ `shouldAutoDeleteAfterTabRemoval`）：
 *    新的 O(n) 判据必须与数据层那份 O(n) 判据**等价** ⇒ 否则提示会撒谎。
 * ③ 接线层（.tsx 源码断言）：
 *    ✕ 的 title/aria-label 必须来自那份文案；TabGroup 必须真的把
 *    「删掉这条会不会让整组消失」传下去；memo 比较必须带上它
 *    （忘了 ⇒ 提示会停留在旧值）。
 *
 * ── 为什么用源码断言 ─────────────────────────────────────────────────────
 * 本仓没有 DOM 测试环境（无 jsdom / @testing-library），node 单测加载不了 JSX。
 * 沿用本仓既有惯例（见 lockedDelete.test.ts、guards/audit20261019Ui.test.ts）。
 * 断言只钉**接线结构**，不钉 CSS 类名。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeTabEntryCopy } from '../../src/components/dnd/removeTabEntryCopy.ts';
import {
  onlyActiveTabId,
  shouldAutoDeleteAfterTabRemoval,
} from '../../src/core/tabGroupUtils.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');
/** 剥掉注释：源码断言必须判「代码结构」而不是「注释里提到的话」。 */
const code = (rel: string) =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

const DRAGGABLE_TAB = 'src/components/dnd/DraggableTab.tsx';
const TAB_GROUP = 'src/components/tabs/TabGroup.tsx';
const COPY_MODULE = 'src/components/dnd/removeTabEntryCopy.ts';

// ══════════════════════════════════════════════════════════════════════════
// 1. 文案层：两种后果必须是两种提示
// ══════════════════════════════════════════════════════════════════════════

describe('DS-43-16：删掉最后一条的提示必须说清「整个会话会消失」', () => {
  it('会移除整个会话时，提示点名「整个会话」', () => {
    const copy = removeTabEntryCopy({ removesWholeSession: true });
    assert.match(copy.title, /整个会话/, '提示必须说清整张会话卡会一起消失');
    assert.match(copy.action, /整个会话/, '可访问名的动作部分同样必须说清');
  });

  it('会移除整个会话时，仍然说清「无法恢复」（删除是物理清除）', () => {
    const copy = removeTabEntryCopy({ removesWholeSession: true });
    assert.match(copy.title, /无法恢复/, '必须说清不可撤销（无回收站、无撤销）');
    assert.match(copy.action, /无法恢复/);
  });

  it('只移除这一条时，提示**不**说「整个会话」（不许用恐吓文案凑数）', () => {
    const copy = removeTabEntryCopy({ removesWholeSession: false });
    assert.doesNotMatch(copy.title, /整个会话/, '不是最后一条就别提整组消失');
    assert.doesNotMatch(copy.action, /整个会话/);
  });

  it('只移除这一条时，仍然说清「无法恢复」', () => {
    const copy = removeTabEntryCopy({ removesWholeSession: false });
    assert.match(copy.title, /无法恢复/);
    assert.match(copy.action, /无法恢复/);
  });

  it('两种提示互不相同（不许塌成同一句）', () => {
    const whole = removeTabEntryCopy({ removesWholeSession: true });
    const single = removeTabEntryCopy({ removesWholeSession: false });
    assert.notEqual(whole.title, single.title);
    assert.notEqual(whole.action, single.action);
  });

  it('界面文案里不出现英文机器串（全中文界面）', () => {
    for (const removesWholeSession of [true, false]) {
      const copy = removeTabEntryCopy({ removesWholeSession });
      assert.doesNotMatch(
        copy.title + copy.action,
        /[A-Za-z]{4,}/,
        `文案里出现了英文串：${copy.title} / ${copy.action}`
      );
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 2. 判据层：新判据必须与数据层判据等价
// ══════════════════════════════════════════════════════════════════════════

/** 造一个组。`active` 是活跃标签数，`tombstones` 是墓碑数。 */
const mkGroup = (input: {
  id?: string;
  active: number;
  tombstones?: number;
  isLocked?: boolean;
}) => {
  const tabs = Array.from({ length: input.active }, (_, i) => ({
    id: `t${i}`,
    url: `https://example.com/${i}`,
    title: `t${i}`,
    createdAt: '2026-10-23T00:00:00.000Z',
    lastAccessed: '2026-10-23T00:00:00.000Z',
  }));
  const tombs = Array.from({ length: input.tombstones ?? 0 }, (_, i) => ({
    id: `d${i}`,
    url: `https://example.com/d${i}`,
    title: `d${i}`,
    createdAt: '2026-10-23T00:00:00.000Z',
    lastAccessed: '2026-10-23T00:00:00.000Z',
    isDeleted: true,
  }));
  return {
    id: input.id ?? 'g',
    name: input.id ?? 'g',
    isLocked: input.isLocked ?? false,
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
    tabs: [...tabs, ...tombs],
  } as never;
};

describe('DS-43-16：onlyActiveTabId 与数据层判据必须等价', () => {
  it('未锁定、只有一条活跃标签 ⇒ 那一条就是「删掉会让整组消失」的那条', () => {
    const group = mkGroup({ active: 1 });
    assert.equal(
      onlyActiveTabId(group),
      't0',
      'onlyActiveTabId 必须认出「唯一那条活跃标签」'
    );
    assert.equal(
      shouldAutoDeleteAfterTabRemoval(group, 't0'),
      true,
      '数据层说删掉它整组消失 —— 两份判据必须一致'
    );
  });

  it('未锁定、两条以上活跃标签 ⇒ 删任何一条都不会让整组消失', () => {
    const group = mkGroup({ active: 3 });
    assert.equal(
      onlyActiveTabId(group),
      null,
      '多条活跃标签时没有任何一条会让整组消失'
    );
    for (const tab of ['t0', 't1', 't2']) {
      assert.equal(
        shouldAutoDeleteAfterTabRemoval(group, tab),
        false,
        `数据层说删掉 ${tab} 不影响整组 —— 两份判据必须一致`
      );
    }
  });

  it('墓碑不算内容：一条活跃 + 一条墓碑 ⇒ 删掉那条活跃的仍然整组消失', () => {
    const group = mkGroup({ active: 1, tombstones: 1 });
    assert.equal(
      onlyActiveTabId(group),
      't0',
      '墓碑是同步用的删除意图，不是用户可见内容 —— 不许把它算成一条'
    );
    assert.equal(shouldAutoDeleteAfterTabRemoval(group, 't0'), true);
    assert.equal(
      shouldAutoDeleteAfterTabRemoval(group, 'd0'),
      false,
      '墓碑不是内容：删掉它不影响「用户可见的会话」'
    );
  });

  it('锁定组 ⇒ 不会因删最后一条而消失（锁定承诺不许放松）', () => {
    const group = mkGroup({ active: 1, isLocked: true });
    assert.equal(
      onlyActiveTabId(group),
      null,
      '锁定组不会因删最后一条而消失'
    );
    assert.equal(shouldAutoDeleteAfterTabRemoval(group, 't0'), false);
  });

  it('只有一条活跃标签的组里，删墓碑不会让整组消失', () => {
    const group = mkGroup({ active: 1, tombstones: 2 });
    assert.equal(
      shouldAutoDeleteAfterTabRemoval(group, 'd1'),
      false,
      '墓碑不是内容：删掉它不影响「用户可见的会话」'
    );
    assert.equal(
      onlyActiveTabId(group),
      't0',
      '唯一那条活跃标签仍然是唯一那条'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 3. 接线层：提示必须真的挂到 ✕ 上，判据必须真的传下去
// ══════════════════════════════════════════════════════════════════════════

describe('DS-43-16：✕ 的提示必须来自那份文案层', () => {
  const src = code(DRAGGABLE_TAB);

  it('删除按钮的 title 来自 removeCopy.title（不是写死的句子）', () => {
    assert.match(src, /title=\{removeCopy\.title\}/, 'title 必须来自文案层');
    assert.doesNotMatch(
      src,
      /title="从会话中移除/,
      '写死的 title 就是旧的（说谎的）那句 —— 文案只有一份'
    );
  });

  it('删除按钮的可访问名来自 removeCopy.action（读屏用户拿到同一句契约）', () => {
    assert.match(
      src,
      /aria-label=\{`\$\{removeCopy\.action\}: \$\{tabTitle\}`\}/,
      'aria-label 必须由文案层拼出'
    );
    assert.doesNotMatch(
      src,
      /aria-label=\{`从会话中移除/,
      '写死的 aria-label 就是旧的（说谎的）那句 —— 文案只有一份'
    );
  });

  it('removeCopy 由 removeTabEntryCopy 算出（判据不在组件里重写）', () => {
    assert.match(src, /removeTabEntryCopy\(\{\s*removesWholeSession\s*\}\)/);
  });
});

describe('DS-43-16：TabGroup 必须把「删掉这条会不会让整组消失」传下去', () => {
  const src = code(TAB_GROUP);

  it('DraggableTab 收到了 removesWholeSession', () => {
    assert.match(
      src,
      /<DraggableTab[\s\S]{0,600}?removesWholeSession=\{[^}]*\}/,
      '行组件必须收到这个判断，否则提示永远是「只移除这条」'
    );
  });

  it('这个判断来自 onlyActiveTabId（判据只有一份）', () => {
    assert.match(src, /onlyActiveTabId\(group\)/, '必须用共享判据');
  });

  it('判据只扫一次（不许每行扫一次 ⇒ O(n²)）', () => {
    const calls = src.match(/onlyActiveTabId\(/g) ?? [];
    assert.equal(
      calls.length,
      1,
      'onlyActiveTabId 在 TabGroup 里必须只调用一次 —— ' +
        '逐行调用是 O(n²)，而拖拽过程中每 100ms 就重渲一次'
    );
  });

  it('removesWholeSession 的值必须由那个判断算出来（不许写死）', () => {
    // 找出「由 onlyActiveTabId 算出来的那个局部变量」——
    // 不钉名字（钉名字就等于逼实现不许改写法）。
    const local = src.match(
      /([A-Za-z_$][\w$]*)\s*=\s*(?:useMemo\(\(\)\s*=>\s*)?onlyActiveTabId\(group\)/
    );
    assert.ok(local, '必须有一个由 onlyActiveTabId 算出来的局部变量');
    const localName = local![1];
    const prop = src.match(/removesWholeSession=\{([^}]*)\}/);
    assert.ok(prop, 'DraggableTab 必须收到 removesWholeSession');
    assert.match(
      prop![1],
      new RegExp(`\\b${localName}\\b`),
      `removesWholeSession 必须由 ${localName} 算出来 —— 写死 true/false 等于把判据废掉`
    );
  });

  it('memo 比较必须带上 removesWholeSession（忘了 ⇒ 提示停留在旧值）', () => {
    const draggable = code(DRAGGABLE_TAB);
    assert.match(
      draggable,
      /prevProps\.removesWholeSession === nextProps\.removesWholeSession/,
      'memo 比较漏了这个 prop ⇒ 删掉一条之后提示还停在旧值'
    );
  });

  it('文案层模块自己不含硬编码的旧句子（避免两处各写一份）', () => {
    const copySrc = code(COPY_MODULE);
    assert.match(copySrc, /export const removeTabEntryCopy/);
    // 旧句「从会话中移除这条记录」是本轮改掉的坏文案，不许再出现在任何地方。
    for (const rel of [DRAGGABLE_TAB, COPY_MODULE, TAB_GROUP]) {
      assert.doesNotMatch(
        code(rel),
        /从会话中移除这条记录/,
        `${rel} 里还留着旧的坏文案`
      );
    }
  });
});
