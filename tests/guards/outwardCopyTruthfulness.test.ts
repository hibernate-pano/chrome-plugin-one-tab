/**
 * 对外文案的诚实度守卫（2026-10-23，第 50 轮）。
 *
 * ── 这个文件防的具体事故 ──────────────────────────────────────────────────
 *
 * 第 43 轮把「文档在教一个不成立的预期」钉住了（`storeListingTruthfulness`），
 * 但那一轮**只钉文档**：README / 商店文案 / 官网。
 * ⇒ **应用里用户真正读到的那几行**没人查 ⇒ 三处谎话活到了第 50 轮：
 *
 * ① **同步弹窗**说「同一会话在两台设备上都改过时，以最后一次保存的一方为准」
 *    —— 真相：胜负由 (序号, 设备编号) 决胜（`src/core/opStamp.ts`），
 *    而两台设备的序号来自**各自独立**的计数器 ⇒ **先保存的那台完全可能赢**。
 *    败方那一组被**整组**替换，且零提示。
 * ② **同步弹窗**说「按当前同步策略把云端会话合并进本地」
 *    —— `settings.syncStrategy` 早已退役（`src/types/tab.ts` 的
 *    `RETIRED_SETTING_KEYS`），**零读取方**，合并恒走 `mergeOpStamped`
 *    ⇒ 用户照这句去设置里找「同步策略」，找不到。
 * ③ **发版台账**说撤销「10 秒内有效」—— 实现**一直是 8 秒**
 *    （`src/components/common/toastPolicy.ts` 的 `TOAST_ACTION_DURATION_MS`）。
 * ④ **manifest.json** 的短描述是一句英文泛化话
 *    —— 既没说「保存 = 剪切（并把标签页关掉）」，又跟商店主语言（中文）不一致。
 *    而它正是**线上商店简介那一行**的来源（线上那份是人工粘贴的，仓库改它
 *    不会自己同步到线上 ⇒ 线上仍需人工粘贴一次）。
 *
 * ── 纪律：钉**性质**，不钉整句 ─────────────────────────────────────────────
 *
 * 每条判据都写成「**代码事实 → 文案必须覆盖 / 必须不覆盖**」：
 *   · 时长**从常量反推**（不手写第二个数字）；
 *   · 合并口径**从 `mergeOpStamped` 的语义反推**（按 ID 合并 + 未命中的一侧保留）；
 *   · 退役设置**从 `RETIRED_SETTING_KEYS` 反推**（而不是钉死一句中文）。
 * ⇒ 换一种等价措辞不会红；改坏实现 / 改回谎话必红。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOAST_ACTION_DURATION_MS } from '@/components/common/toastPolicy';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const SYNC_BUTTON = read('src/components/sync/SyncButton.tsx');
const NOTES = read('docs/RELEASE-NOTES.md');
const TAB_TYPES = read('src/types/tab.ts');
const MANIFEST = JSON.parse(read('manifest.json')) as { description?: string; version?: string };

/** 去掉注释 —— **注释不是用户读到的文案**。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** 应用内文案：`src/` 下的每一个 `.tsx` 文件（**剥掉注释**）。 */
function appCopy(): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  const srcRoot = resolve(ROOT, 'src');
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.tsx')) continue;
      out.push({
        name: `src/${full.slice(srcRoot.length + 1)}`,
        text: stripComments(readFileSync(full, 'utf8')),
      });
    }
  };
  walk(srcRoot);
  return out;
}

/** 取源码里的单引号字符串字面量（用户看得见的文案基本都在这里）。 */
const quotedStrings = (src: string): string[] =>
  [...src.matchAll(/'([^'\n]*)'/g)].map(m => m[1]);

// ══════════════════════════════════════════════════════════════════════════
// ① 同步弹窗：不得指向**已退役**的设置
// ══════════════════════════════════════════════════════════════════════════

describe('同步弹窗不得指向已退役的设置', () => {
  /**
   * 已退役的设置键（**从 `src/types/tab.ts` 现场读出来**，不手写）。
   *
   * 为什么要反推：`RETIRED_SETTING_KEYS` 是这份名单的**真相源** ——
   * 以后再退役一个设置，这张名单自动变长，判据跟着变严；
   * 而手写一份名单会漂（漂了就等于没钉）。
   */
  const retiredKeys = ((): string[] => {
    const m = TAB_TYPES.match(/RETIRED_SETTING_KEYS[^=]*=\s*\[([\s\S]*?)\]/);
    assert.ok(m, 'src/types/tab.ts 里读不出 RETIRED_SETTING_KEYS —— 判据的锚点丢了');
    return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
  })();

  it('退役名单里确实有 syncStrategy（否则这条判据是在钉一个不存在的东西）', () => {
    assert.ok(
      retiredKeys.includes('syncStrategy'),
      `src/types/tab.ts 的 RETIRED_SETTING_KEYS 里没有 syncStrategy（读到的是 ${retiredKeys.join('、')}）—— ` +
        '若产品把它复活了，请把这条判据一起改掉'
    );
  });

  it('应用内文案不得出现「同步策略 / 合并策略」这种指向退役设置的措辞', () => {
    const offenders: string[] = [];
    for (const file of appCopy()) {
      // 钉**语义关键词**，不钉整句：换个说法（「按当前策略」「按同步方式」…）
      // 仍然是同一个错误指向。
      if (/(同步|合并|同步与合并)策略/.test(file.text)) offenders.push(file.name);
      if (/同步策略|合并策略/.test(file.text)) offenders.push(file.name);
    }
    assert.deepEqual(
      [...new Set(offenders)],
      [],
      `应用内文案仍然出现「同步策略 / 合并策略」：\n${offenders.join('\n')}\n` +
        '—— 那个设置早已退役（零读取方），合并恒走 mergeOpStamped；' +
        '用户照这句去设置里找「同步策略」，找不到。'
    );
  });

  it('应用内文案不得直接喊出退役设置键名', () => {
    const offenders: string[] = [];
    for (const file of appCopy()) {
      for (const key of retiredKeys) {
        // `settings.syncStrategy` 这类写法出现在**用户看得见的**文案里
        // ⇒ 用户会去找一个叫 syncStrategy 的设置项。
        if (new RegExp(`${key}`).test(file.text)) offenders.push(`${file.name}（${key}）`);
      }
    }
    assert.deepEqual(
      [...new Set(offenders)],
      [],
      `应用内文案出现了退役设置的键名：\n${offenders.join('\n')}\n—— 用户界面不该出现内部键名。`
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ② 同步弹窗：合并说明必须与 `mergeOpStamped` 的真实语义一致
// ══════════════════════════════════════════════════════════════════════════

describe('同步弹窗的合并说明必须说清真实语义', () => {
  /** 下载弹窗那一段（它的「合并模式」卡说明就在里面）。 */
  const downloadModal = ((): string => {
    const i = SYNC_BUTTON.indexOf('{showDownloadModal && (');
    assert.ok(i >= 0, 'SyncButton.tsx 里找不到下载弹窗 —— 判据的锚点丢了');
    return SYNC_BUTTON.slice(i);
  })();

  /** 上传弹窗那一段。 */
  const uploadModal = ((): string => {
    const i = SYNC_BUTTON.indexOf('{showUploadModal && (');
    assert.ok(i >= 0, 'SyncButton.tsx 里找不到上传弹窗 —— 判据的锚点丢了');
    return SYNC_BUTTON.slice(i, SYNC_BUTTON.indexOf('{showDownloadModal && ('));
  })();

  /** 某一侧弹窗里「合并模式」那张卡的说明文案。 */
  const mergeDescription = (modal: string): string => {
    const found = quotedStrings(modal).find(s => s.includes('合并') && s.length > 8);
    assert.ok(found, '这一侧弹窗里找不到「合并模式」那张卡的说明 —— 判据的锚点丢了');
    return found;
  };

  it('下载侧的合并说明必须说清「按 ID 合并」', () => {
    const desc = mergeDescription(downloadModal);
    assert.match(
      desc,
      /ID/,
      `下载侧的合并说明是「${desc}」—— 它没说清是**按会话 ID** 合并：` +
        '真实语义是 `mergeOpStamped`（按 id 配对，两端都有则整组由印记决胜）'
    );
  });

  it('下载侧的合并说明必须说清「未命中的本地会话会保留」', () => {
    const desc = mergeDescription(downloadModal);
    assert.match(
      desc,
      /(未命中|没有命中|云端没有)[^。\n]{0,20}(本地)?[^。\n]{0,8}(会话)?[^。\n]{0,6}(保留|留下|不动)/,
      `下载侧的合并说明是「${desc}」—— 它没说清「云端没有的那些本地会话会保留」：` +
        '`mergeOpStamped` 里「仅本地有 ⇒ 保留本地」'
    );
  });

  it('上传侧与下载侧的合并说明必须对称（两边都是「按 ID 合并 + 未命中的一侧保留」）', () => {
    const up = mergeDescription(uploadModal);
    const down = mergeDescription(downloadModal);
    for (const [name, desc] of [
      ['上传侧', up],
      ['下载侧', down],
    ] as const) {
      assert.match(desc, /ID/, `${name}的合并说明「${desc}」没说清是按会话 ID 合并`);
      assert.match(desc, /保留/, `${name}的合并说明「${desc}」没说清未命中的一侧会被保留`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ③ 发版台账里的「撤销窗口」秒数必须与实现一致（从常量反推）
// ══════════════════════════════════════════════════════════════════════════

describe('发版台账里的撤销窗口时长必须与实现一致', () => {
  it('台账里出现的每个「N 秒内有效」都必须等于实现的撤销窗口', () => {
    const seconds = TOAST_ACTION_DURATION_MS / 1000;
    // ⚠️ 扫的是**整份文件**的每一句「N 秒内有效」——**不区分**它出现在
    // 「当前承诺」那一节还是「历史轮次流水」那一节。
    //
    // 为什么不给历史节开个口子：一旦判据学会「在流水里写就不算」，
    // 它就多了一条**可被利用的豁免**（把谎话挪进流水里就没人管了），
    // 而这条判据要防的正是「谎话待在文档里活得很好」。
    // ⇒ 代价是：**复述旧错值时不要用承诺形状**（写「曾写成 10 秒」，
    // 别写「曾写『10 秒内有效』」）—— 这条要求已经写进台账那一节的注释里。
    const claims = [...NOTES.matchAll(/(\d+)\s*秒内有效/g)].map(m => ({
      text: m[0],
      seconds: Number(m[1]),
    }));
    assert.ok(
      claims.length > 0,
      '台账里找不到「N 秒内有效」这句话 —— 判据的锚点丢了（或那句话被删了/改了写法）'
    );
    for (const c of claims) {
      assert.equal(
        c.seconds,
        seconds,
        `台账写「${c.text}」，而实现的撤销窗口是 ${TOAST_ACTION_DURATION_MS}ms（${seconds} 秒）—— ` +
          '文档与实现必须同口径。（这条退路是**对外承诺**，改承诺时两边一起改。）'
      );
    }
  });

  it('实现常量本身不得被改短（这条退路是承诺，不是参数）', () => {
    assert.ok(
      TOAST_ACTION_DURATION_MS >= 8000,
      `撤销窗口只有 ${TOAST_ACTION_DURATION_MS}ms —— 它是「给了你一条退路」这句话的长度，` +
        '改短等于把承诺缩水（另有守卫 tests/guards/toastUndoReachability.test.ts 钉同一条）'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ④ manifest 的短描述：必须是中文，且说清「保存 = 剪切」
// ══════════════════════════════════════════════════════════════════════════

describe('manifest.json 的短描述必须与产品口径一致', () => {
  const desc = (): string => MANIFEST.description ?? '';

  it('短描述必须存在且不是空串', () => {
    assert.ok(desc().trim().length > 0, 'manifest.json 没有 description');
  });

  it('短描述必须是中文（商店主语言是中文（简体））', () => {
    assert.match(
      desc(),
      /[一-鿿]/,
      `manifest.description 是「${desc()}」—— 全英文，与商店主语言不一致：` +
        '它就是**线上商店简介那一行**的来源'
    );
  });

  it('短描述不得再是那句英文泛化话（它没说清产品最要紧的一条规则）', () => {
    assert.doesNotMatch(
      desc(),
      /Save browser work sessions/i,
      'manifest.description 仍是那句英文泛化话 —— 它既没说「保存 = 剪切」，' +
        '又与商店主语言不一致'
    );
  });

  it('短描述必须说清「保存会把标签页关掉」（保存 = 剪切，不是备份）', () => {
    assert.match(
      desc(),
      /(关闭|关掉|关上|腾空)/,
      `manifest.description 是「${desc()}」—— 它没说清「保存会把标签页关掉」：` +
        '这是这个产品最容易被误解的一条规则（保存 = 剪切，不是备份）'
    );
  });

  it('短描述必须用产品自己的词「会话」', () => {
    assert.match(
      desc(),
      /会话/,
      `manifest.description 是「${desc()}」—— 它必须用产品自己的词「会话」`
    );
  });

  it('短描述不得超长（Chrome 的 manifest.description 上限是 132 字符）', () => {
    assert.ok(
      desc().length <= 132,
      `manifest.description 有 ${desc().length} 个字符，超过 Chrome 的 132 上限 —— ` +
        '商店会截断，截断后多半正好把「并把标签页关掉」那一半切掉'
    );
  });
});
