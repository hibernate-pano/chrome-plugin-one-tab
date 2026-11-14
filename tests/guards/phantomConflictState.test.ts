/**
 * 守卫：冲突提示必须建立在**共同祖先基线**上，且不许退回「假统计量」的老路
 * （2026-10-23 审计 DS-43-18；2026-11-14 P0-1 冲突提示落地后改写）。
 *
 * ── 历史（为什么当初禁止，又为什么现在解禁）──────────────────────────────
 *
 * 最初（DS-43-18）代码里有一个永不出现的 `syncStatus: 'conflict'` 和一个
 * 恒为 0 的 `stats.conflicts` —— 那是对用户的**假承诺**：它说「本产品能表示 /
 * 统计冲突」，而合并是整组 LWW（`src/core/opStampMerge.ts`），败方标签被丢却
 * 一句提示都没有。恒为 0 的统计量比没有更坏：它让人以为冲突从没发生过。
 *
 * ⚠️ 当时明确**不做**真冲突提示的理由：那需要**共同祖先**（三方合并的基线）
 * 才能区分「云端只是比你新」与「两边同时改、有一边被覆盖」——没有基线只能靠猜，
 * 猜错就是误报，而误报会教用户不信任同步。
 *
 * 2026-11-14（P0-1）：基线**已经有了**——每轮 download 合并成功后把双方一致的
 * 组印记写进 `sync_stamp_ledger`，下一轮拿它当共同祖先（判定见
 * `src/core/mergeConflictDetect.ts` 的 `detectMergeConflicts`）。于是冲突提示
 * 从「不可能做对」变成「可以做对」，链路是
 * syncEngine（检测 + 清单）→ backgroundSync（落成待展示提示）→
 * popup 的 `SyncConflictNotifier`（读取并展示后清除）。
 *
 * ── 现在这条守卫钉什么（防止从「做对了」退回去）────────────────────────────
 *
 * ① `syncStatus` 联合类型里仍不许有 `'conflict'`：冲突是一次性**提示**，
 *    不是要持久化到标签上的状态 —— 别又把「冲突」塞回类型契约。
 * ② 不许退回**假统计量**：`conflicts` 只能是带明细的清单 `MergeConflict[]`，
 *    绝不能再出现 `conflicts: number` 这种恒为 0 的数字。
 * ③ **真实检测必须在**：syncEngine 必须调用 `detectMergeConflicts(` 并用到
 *    `MergeConflict`——只留注释、把检测删掉，承诺就又变假。
 * ④ 冲突必须**真的到达用户**：backgroundSync 必须把结果落成待展示提示
 *    （`setPendingConflictNotice`），而不是只塞进返回值没人看。
 * ⑤ **文档继续说真话**：README / 商店页必须仍写着「整组覆盖 + 败方标签会丢」
 *    并写明「同步后会给出冲突提示」——文档与代码不许一边改另一边不动。
 * ⑥ **台账不许失忆**：审计台账里必须还留着 DS-43-18。
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
const BACKGROUND_SYNC = stripComments(read('src/background/backgroundSync.ts'));
const README = read('README.md');
const STORE = read('CHROMEWEBSTORE.md');
const LEDGER = read('docs/audit-2026-10-23-data-safety.md');

/** 取出所有 `syncStatus?:` 声明后面的联合类型成员。 */
function syncStatusUnions(): string[][] {
  const out: string[][] = [];
  const re = /syncStatus\??\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(TAB_TYPES)) !== null) {
    out.push([...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]));
  }
  return out;
}

describe('DS-43-18：冲突提示必须建在基线上，且不许退回假统计量', () => {
  it('syncStatus 的联合类型里不许有 conflict（冲突是一次性提示，不是标签状态）', () => {
    const unions = syncStatusUnions();
    assert.ok(unions.length >= 2, `应当至少找到两处 syncStatus 声明，实际 ${unions.length} 处`);
    for (const members of unions) {
      assert.ok(
        !members.includes('conflict'),
        `syncStatus 联合类型里又出现了 'conflict' ⇒ 代码又在把「冲突」当标签状态承诺，` +
          `而它是一次性提示（SyncConflictNotifier），不该落进持久化契约。`,
      );
    }
  });

  it('不许退回恒为 0 的 conflicts: number 假统计量', () => {
    assert.ok(
      !/\bconflicts\s*:\s*number\b/.test(SYNC_ENGINE),
      'syncEngine 里又出现了 conflicts: number ⇒ 又退回一个恒为 0 的假统计量；' +
        '冲突上报必须是有明细的 MergeConflict[] 清单，不能是一个没有明细的数字。',
    );
  });

  it('真实冲突检测必须在（detectMergeConflicts + MergeConflict[]）', () => {
    assert.match(
      SYNC_ENGINE,
      /detectMergeConflicts\(/,
      'syncEngine 必须调用 detectMergeConflicts 做基于共同祖先基线的冲突检测 —— ' +
        '把它删掉，冲突提示就又成了一句空承诺。',
    );
    assert.match(
      SYNC_ENGINE,
      /MergeConflict\[\]/,
      'conflicts 必须声明成 MergeConflict[] 明细清单（只报真正丢数据的组），不能是数字。',
    );
  });

  it('冲突必须真的到达用户（backgroundSync 落成待展示提示）', () => {
    assert.match(
      BACKGROUND_SYNC,
      /setPendingConflictNotice\(/,
      'backgroundSync 必须把冲突清单落成待展示提示（setPendingConflictNotice）—— ' +
        '否则它只塞进返回值，用户在界面上永远看不到。',
    );
  });

  it('README 必须仍然写着：整组覆盖 + 败方标签会丢 + 同步后会给出冲突提示', () => {
    assert.match(README, /整组覆盖/, 'README 必须说明合并是整组覆盖（印记决胜）');
    assert.match(README, /败方/, 'README 必须说明败方那一侧会输');
    assert.match(
      README,
      /冲突提示/,
      'README 必须说明现在会给出同步冲突提示（P0-1 起，这是真话，不能退回「没有任何提示」）。',
    );
  });

  it('商店页必须仍然写着：整组覆盖 + 同步后会给出冲突提示', () => {
    assert.match(STORE, /整组覆盖/, '商店页必须说明合并是整组覆盖');
    assert.match(
      STORE,
      /冲突提示/,
      '商店页必须说明现在会提示冲突（写清楚比让人以为会丢得不明不白更诚实）。',
    );
  });

  it('审计台账里必须还留着 DS-43-18（不许把这条债悄悄抹掉）', () => {
    assert.match(LEDGER, /DS-43-18/, '台账里必须有 DS-43-18 这一条');
  });
});
