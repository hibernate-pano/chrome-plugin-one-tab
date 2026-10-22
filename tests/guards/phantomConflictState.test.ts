/**
 * 守卫：代码不许承诺「冲突检测」，而产品其实不检测（2026-10-23 审计 DS-43-18 残留）。
 *
 * ── 这个文件防的具体事故 ──────────────────────────────────────────────────
 *
 * 合并是**整组 LWW**（`src/core/opStampMerge.ts`）：两台设备同时改同一个会话时，
 * 由操作印记（序号 + 设备编号）决胜，**赢的一方整组覆盖另一方**，败方新增的标签
 * 会丢，且**界面上没有任何提示**。这一点 README「整组覆盖」与商店页
 * 「Known Issues」都如实写着 —— 文档这一半早就是真的。
 *
 * 但**代码那一半是假的**：类型里摆着一个永远不会出现的取值
 * `syncStatus: 'conflict'`，统计里有一个恒为 0 的字段 `stats.conflicts`。
 *
 * 后果不是「多一个没用的字段」这么轻：
 *   · `syncStatus` 的联合类型是**对外的契约**——它说「本产品能表示冲突状态」；
 *   · `stats.conflicts` 是一个**统计量**——统计量的语义是「这里发生过几次」，
 *     恒为 0 的统计量说的是「一次都没发生过」，而它明明发生过（败方标签被丢）。
 *
 * ⇒ 一个恒为 0 的统计量，比没有这个统计量**更坏**：它让人以为这件事不存在。
 * （本仓已有一处先例：`displayOrder` 死字段被删时，也是同样的理由 ——
 *  与其补一个读取方，不如承认它不兑现。）
 *
 * ── 判据钉什么 ────────────────────────────────────────────────────────────
 *
 * ① **代码不许再出现那个承诺**：`syncStatus` 的联合类型里不许有 `'conflict'`；
 *    `stats` 里不许有 `conflicts`。判据剥掉注释再查（注释里可以解释为什么删）。
 * ② **文档必须继续说真话**：README 与商店页必须仍然写着「整组覆盖 + 败方标签
 *    会丢 + 没有任何提示」。这一条是①的**替代品**——删掉代码里的假承诺之后，
 *    真相只能待在文档里；文档哪天把这句话删了，守卫就要红。
 * ③ **台账不许失忆**：审计台账里必须还留着 DS-43-18 这一条。
 *
 * ⚠️ 为什么不直接把「冲突提示」做出来：那需要**共同祖先**（三方合并的基线）
 *    才能区分「云端只是更新了」与「两边同时改了、有一边被覆盖」——
 *    没有基线，任何「检测冲突」的实现都只能靠猜，猜错就是**误报**，
 *    而误报的冲突提示会教用户不信任同步。这是协议级改动，不在一条守卫的范围里。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

/** 去掉注释 —— 只看**会被编译进去**的东西。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

const TAB_TYPES = stripComments(read('src/types/tab.ts'));
const SYNC_ENGINE = stripComments(read('src/services/syncEngine.ts'));
const README = read('README.md');
const STORE = read('CHROMEWEBSTORE.md');
const LEDGER = read('docs/audit-2026-10-23-data-safety.md');

/** 取出所有 `syncStatus?:` 声明后面的联合类型成员。 */
function syncStatusUnions(): string[][] {
  const out: string[][] = [];
  const re = /syncStatus\??\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(TAB_TYPES)) !== null) {
    out.push(
      [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]),
    );
  }
  return out;
}

describe('DS-43-18：代码不许承诺「冲突检测」这个产品并不具备的能力', () => {
  it('syncStatus 的联合类型里不许有 conflict（它从不被赋值）', () => {
    const unions = syncStatusUnions();
    assert.ok(unions.length >= 2, `应当至少找到两处 syncStatus 声明，实际 ${unions.length} 处`);
    for (const members of unions) {
      assert.ok(
        !members.includes('conflict'),
        `syncStatus 联合类型里又出现了 'conflict' ⇒ 代码又在承诺「会标记冲突」，` +
          `而合并是整组 LWW（src/core/opStampMerge.ts），全仓没有任何一处会赋出它。`,
      );
    }
  });

  it('stats 里不许有恒为 0 的 conflicts 统计量', () => {
    assert.ok(
      !/\bconflicts\b/.test(SYNC_ENGINE),
      'syncEngine 里又出现了 conflicts ⇒ 又有一个恒为 0 的统计量在对用户撒谎' +
        '（真要统计冲突，得先有共同祖先的基线）。',
    );
  });

  it('没有 stats.conflicts 的消费方（类型删了字段，调用方也不能还在读）', () => {
    // 全仓（除 syncEngine 自身）不该再有人读 .conflicts。
    const callers = ['src/background/backgroundSync.ts', 'src/service-worker.ts'].map(read);
    for (const src of callers) {
      assert.ok(
        !/\.conflicts\b/.test(src),
        '还有调用方在读 stats.conflicts ⇒ 删字段会把它变成 undefined（运行时静默）。',
      );
    }
  });

  it('README 必须仍然写着：整组覆盖 + 败方新增的标签会丢 + 没有任何提示', () => {
    assert.match(README, /整组覆盖/, 'README 必须说明合并是整组覆盖（印记决胜）');
    assert.match(README, /败方/, 'README 必须说明败方那一侧会输');
    assert.match(README, /没有任何提示/, 'README 必须说明冲突没有任何提示（这是真话，不是缺陷掩饰）');
  });

  it('商店页必须仍然写着：界面上看不到冲突提示', () => {
    assert.match(STORE, /整组覆盖/, '商店页必须说明合并是整组覆盖');
    assert.match(
      STORE,
      /看不到冲突提示|没有冲突提示|不做冲突提示/,
      '商店页必须说明本产品不提示冲突（写清楚比让人以为会提示更诚实）',
    );
  });

  it('审计台账里必须还留着 DS-43-18（不许把这条债悄悄抹掉）', () => {
    assert.match(LEDGER, /DS-43-18/, '台账里必须有 DS-43-18 这一条');
  });
});
