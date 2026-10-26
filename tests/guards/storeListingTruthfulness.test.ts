/**
 * 商店文案 / README / 官网里**三条曾经说错的口径**的守卫（2026-10-23，第 43 轮）。
 *
 * ── 这个文件防的具体事故 ──────────────────────────────────────────────────
 *
 * 2026-10-23 主审抓出三处「文档教了一个不成立的预期」。它们的共同形状是：
 * **文案说的规则与代码真正执行的规则不是同一条**，而**没有任何测试会变红**。
 *
 * ① **「以最后保存的一方为准」**（`README.md` / `CHROMEWEBSTORE.md` / 官网 / 三份计划文档）
 *    —— 真相：胜负由 `compareStamps` 决定 = **序号大者赢，序号相同按设备编号字典序**
 *    （`src/core/opStamp.ts:22-26`）。而**两台设备的序号来自各自独立的计数器**
 *    （`src/utils/seqRegistry.ts` 的头注释自己写着「序号只在同一设备内单调，
 *    跨设备裸比数值毫无意义」）⇒ **先保存的那台完全可能赢**。
 *    ⇒ 文案教用户「我后保存的就赢」，而实际不是。**这是最坏的一类漂移**：
 *    它让用户基于错误前提做决策（以为后保存就安全，于是放心地并发编辑）。
 *
 * ② **「导入的会话也按内容命名（和保存时同一套规则）」**（商店文案中英两侧）
 *    —— 真相：**两条导入路径的命名规则根本不同**：
 *      · JSON 备份导入 ⇒ **保留文件里的会话名**（`normalizeTabsData.ts:181`
 *        `name: typeof g.name === 'string' && g.name.trim() ? g.name : '导入的会话'`）
 *        ⇒ **一个字都不改**；
 *      · OneTab 文本导入 ⇒ `deriveImportedGroupName`（`oneTabFormatParser.ts:33-36`）
 *        = **按「出现最多的域名」命名**（主导域名），取不到域名时回落到
 *        「导入的会话 N」—— 而保存路径**只有一档**（保存时刻，
 *        `src/domain/tabGroup/factory.ts`）。
 *        ⚠️ 导入这条规则**必须**与保存路径不同：导入的组名进**幂等指纹**
 *        ⇒ 必须是确定性的（不能用时间戳）⇒ 也不能按内容猜
 *        （跨站的组会改名 ⇒ 老文件重新导入时判不出重 ⇒ 多一整份副本）。
 *    ⇒ 「同一套规则」**两档都不成立**：JSON 那档根本不命名，
 *      OneTab 那档是**它自己的一套**（可复现的域名），与保存路径无关。
 *
 * ③ **「删除会同步到其他设备」**（删除确认框）
 *    —— 真相（**2026-10-24 DS-3 修完之后**）：云端墓碑**一律赢** ⇒ 删除
 *    **一定**传播；对方离线期间改过也一样会被删除（代价：对方那份编辑也没了）。
 *    ⚠️ 旧口径是「删除**可能**被撤销」—— 当时是真的（两台设备无关计数器的
 *    数值比大小决定胜负 ⇒ 有半边概率删除被撤销）。DS-3 修完后旧口径**已不成立**，
 *    对外文案必须跟着改（继续说「可能不生效」＝把修好的缺陷当成还存在的）。
 *    判据因此从「必须提到『可能被撤销』」换成「必须提到『删除优先』」＋
 *    「不得再说『可能被撤销』」。
 *
 * ── 纪律：钉**不变量**，不钉字面量 ──────────────────────────────────────────
 *
 * 不写「文案里必须出现『印记』这两个字」—— 改一次措辞就红。
 * 写的是**代码事实 → 文案必须覆盖**：
 *   ① 真相源的**判据**（从 `opStamp.ts` / `normalizeTabsData.ts` /
 *      `oneTabFormatParser.ts` / `sessionName.ts` **现场读出来**），
 *      文案必须**提到这件事**（用一组可接受的措辞）；
 *   ② 反向：**文案不得说「以最后保存的一方为准」这种具体的不成立规则** ——
 *      那是「承诺比实现多」的另一面：**承诺了一个实现不保证的保证**。
 *
 * 同理，若将来产品真的改成「按墙钟时间决胜」（DS-3 修法①给删除加语义优先级位
 * 之后也许会走到那一步），判据①会检测到 `opStamp.ts` 的比较口径变了 ⇒
 * 守卫要求文案跟着改，而不是让文案继续教一个已经废弃的预期。
 *
 * ── 本守卫的检测力（已做变异实测，2026-10-23）────────────────────────────
 *
 * 判据写成**纯函数**（吃源码文本 / 文档文本，吐结构）⇒ 可以直接喂它一段
 * 「文案被改回旧说法」的文本，断言它**看得见**。见文件末尾的自证用例。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const STORE = read('CHROMEWEBSTORE.md');
const README = read('README.md');
const PROMO = read('promo-site/index.html');

const OP_STAMP = read('src/core/opStamp.ts');
const NORMALIZE = read('src/core/normalizeTabsData.ts');
const ONETAB = read('src/core/oneTabFormatParser.ts');
const SESSION_NAME = read('src/domain/tabGroup/sessionName.ts');
const FACTORY = read('src/domain/tabGroup/factory.ts');

/**
 * 扩展 id 的**真相源**：`scripts/store-listing-judge.mjs` 的 LIVE_LISTING_URL
 * （同一份 id 也写在 scripts/cws-publish.mjs 的 itemId 注释里）。
 *
 * ⚠️ **不在这里手写第二份**：手写的 id 会漂，而漂了的后果是
 * 「官网的商店链接又指回商店首页」—— 链接看着正常，点进去是别的页面。
 */
const EXTENSION_ID = (() => {
  const m = read('scripts/store-listing-judge.mjs').match(
    /chromewebstore\.google\.com\/detail\/([a-z]{32})/,
  );
  assert.ok(m, 'scripts/store-listing-judge.mjs 里读不出扩展 id —— 判据的锚点丢了');
  return m[1];
})();

/** 去掉注释 —— **注释不是用户读到的文案**，不该按文案判。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * 应用内文案：`src/` 下的每一个 `.tsx` 文件（**剥掉注释**）。
 *
 * ── 为什么要扫这一层（2026-10-23 第 50 轮补上）──────────────────────────
 * 原来这个守卫只扫文档（README / 商店文案 / 官网）⇒ **应用里用户真正读到的那
 * 几行**从来没人查。于是「同一会话两边都改过时，以最后一次保存的一方为准」
 * 这句谎话就住在同步弹窗里（`src/components/sync/SyncButton.tsx`），
 * 而守卫一路绿灯 —— 扫描面漏了「应用内」这一层。
 */
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

/** 商店文档的「正文」：排除版本历史表（历史条目描述的是**当时**的行为）。 */
const storeBody = (): string =>
  STORE.split('## Version History')[0].split('## Review Notes')[0];

/** 商店文档的「Known Issues / Limitations」段（用户读限制的地方）。 */
const storeKnownIssues = (): string => {
  const m = STORE.match(/### Known Issues \/ Limitations([\s\S]*)$/);
  assert.ok(m, 'CHROMEWEBSTORE.md 必须有「Known Issues / Limitations」段 —— 判据锚点丢了');
  return m[1];
};

// ────────────────────────────────────────────────────────────────────────────
// 判据 ①：真相源从代码现场读出来
// ────────────────────────────────────────────────────────────────────────────

/**
 * 「印记决胜」这件事，代码里到底是怎么比的？
 *
 * 纯函数：吃 `opStamp.ts` 的源码，吐出「比的是序号还是时间戳」这个事实。
 * 判据**不钉写法** —— 换成 `Math.sign(a.s - b.s)` 也算「比序号」，
 * 但如果哪天改成比 `updatedAt`，这条就会翻红 ⇒ 文案必须跟着改。
 */
function stampTiebreakReadsSequence(source: string): boolean {
  // 序号不同 → 比数值；序号相同 → 比设备编号字典序。
  // 两种写法都算「按序号决胜」。
  const byNumber = /a\.s\s*!==\s*b\.s[\s\S]{0,80}(a\.s\s*>\s*b\.s|a\.s\s*<\s*b\.s|Math\.sign)/;
  const byDevice = /a\.d\s*!==\s*b\.d[\s\S]{0,80}(a\.d\s*>\s*b\.d|a\.d\s*<\s*b\.d)/;
  return byNumber.test(source) && byDevice.test(source);
}

/** 真相源是不是**墙钟时间**？（那会让「最后保存的一方为准」成立。） */
function stampDecidesByWallClock(source: string): boolean {
  return /updatedAt|updated_at|Date\.now|getTime\(\)/.test(
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  );
}

/** JSON 导入是否**保留文件里的会话名**？ */
function jsonImportKeepsFileName(source: string): boolean {
  // 判据：会话名直接取自 `g.name`（文件里的字段），没有再走任何命名推导。
  return /name:\s*typeof\s+g\.name\s*===\s*'string'/.test(source);
}

/** OneTab 导入是否**按内容命名**（取主导域名）？ */
function oneTabImportNamesByContent(source: string): boolean {
  return /name:\s*deriveImportedGroupName\(/.test(source);
}

/** OneTab 导入是否**丢掉锁定状态**（那个格式里没有这个字段）？ */
function oneTabImportDropsLock(source: string): boolean {
  return /isLocked:\s*false/.test(source);
}

/**
 * 保存路径的默认名是不是**只有**「保存时刻」这一档？
 *
 * ⚠️ 2026-10-25 产品定案：默认名**一律**是保存时刻 ⇒ 只有一档。
 * 旧的「主导域名 → 有意义的标题 → 时间戳」三档、以及中途加的
 * 「全都同站 ⇒ 网站名」那一档，**全部**被推翻。
 *
 * 判据读的是**工厂里真正起名的那个表达式**（不是「源码里出现了某个
 * 函数名」—— 那种断言在被绕开时仍然是绿的）。
 */
function savePathNamesOnlyByTimestamp(factorySource: string): boolean {
  const line = factorySource.match(/const name = options\.name \?\? ([\s\S]*?);\n/);
  if (!line) return false;
  const expr = line[1];
  // 按内容命名的任何痕迹（域名、标题）都不许出现在这个表达式里
  const contentDerived = /deriveDominantHost|deriveSingleSiteHost|extractNamingHost|\.title\b/;
  return expr.includes('buildTimestampSessionName') && !contentDerived.test(expr);
}

// ────────────────────────────────────────────────────────────────────────────
// 判据 ②：文案必须覆盖 / 不得说错
// ────────────────────────────────────────────────────────────────────────────

/** 「印记决胜」这件事，文案里可以接受的说法（中英各一组）。 */
const MENTIONS_STAMP_DECIDES = [
  /操作印记/,
  /印记/,
  /序号\s*\+\s*设备编号/,
  /operation stamp/i,
  /stamp/i,
];

/** 「不是按最后保存」这件事，文案里可以接受的说法。 */
const MENTIONS_NOT_BY_WALL_CLOCK = [
  /不是.{0,12}最后保存/,
  /不是.{0,12}按.{0,6}谁保存得晚/,
  /先保存.{0,20}也可能赢/,
  /not.{0,20}last[- ]saved/i,
  /not.{0,20}who saved/i,
  /the one that saved first.{0,30}may also win/i,
];

/**
 * 「**删除优先于编辑**」这件事，文案里可以接受的说法。
 *
 * ⚠️ 2026-10-24 审计 DS-3：口径**变过一次**，这一组判据跟着换。
 * 旧口径是「删除可能被撤销」—— 当时**是真的**（两台设备无关计数器的数值
 * 比大小决定胜负 ⇒ 有半边概率删除被撤销）。DS-3 把判据改成
 * 「**云端墓碑一律赢**」⇒ 删除**一定**传播 ⇒ 旧口径已经不成立。
 */
const MENTIONS_DELETE_WINS = [
  /删除优先/,
  /删除.{0,16}(一律|总是|始终|必定|一定|统统).{0,12}(生效|赢|压过|先|管用|同步|传过去)/,
  /(离线|没同步|未同步).{0,30}(改过|修改|编辑).{0,44}(也|照样|仍然|依旧)?会被删除/,
  /delete.{0,30}(?:always|takes precedence|wins)/i,
];

/**
 * 「删除**可能**被撤销」—— DS-3 修完之后**已经不成立**，对外文案不许再说。
 *
 * ⚠️ 这是**反向**判据：它挡住的是「把已经修好的缺陷当成还存在的」那类文案
 *   （继续说「可能不生效」＝对着让用户低估后果的方向说假话）。
 *
 * ⚠️ 必须排除**否定形式**（「不会把删除撤销」「删除不会被撤销」）——
 *   那是**正确**说法的一部分，误伤它就会挡住正确的改动。
 *   ⇒ 用「否定词紧挨情态动词」的否定前瞻来区分。
 */
const FALSE_DELETE_MAY_BE_UNDONE = [
  /删除[^。；\n]{0,8}?(?<!不)(?<!未)(?<!没)(可能|也许|或许|有可能|会|能)[^。；\n]{0,6}(被)?撤销/,
  /delete.{0,30}(?:can be|may be|may not be) (?:undone|revoked)/i,
];

/**
 * **不成立**的具体规则 —— 文案不许说。
 *
 * ⚠️ 2026-10-23 第 50 轮：补上「**一次**」这个变体。
 * 原来只有 /以最后保存的一方为准/ 这一串，而同步弹窗里那句谎话写的是
 * 「以**最后一次**保存的一方为准」—— 多一个「一次」就**整套判据看不见它**
 * ⇒ 那条谎话才能在应用里住这么久。
 */
const FALSE_LAST_SAVED_CLAIM = [
  /以最后(?:一次)?保存的一方为准/,
  /以\*\*最后(?:一次)?保存的一方\*\*为准/,
  /以最后(?:一次)?保存的一方赢/,
  /后保存方整组赢/,
  /last saved (?:side|party|one) wins/i,
  /the last one saved wins/i,
  /whoever saved last/i,
];

describe('真相源 ①：代码里「印记决胜」这件事必须是真的', () => {
  it('opStamp.ts 的比较口径是「序号大者赢，序号相同按设备编号字典序」', () => {
    assert.ok(
      stampTiebreakReadsSequence(OP_STAMP),
      'src/core/opStamp.ts 的 compareStamps 看起来不再按（序号, 设备编号）比较了 —— ' +
        '若产品改成了别的决胜口径（尤其是墙钟时间），文档里「印记决胜」的表述要一起改'
    );
  });

  it('opStamp.ts 不得偷偷改用墙钟时间决胜', () => {
    assert.ok(
      !stampDecidesByWallClock(OP_STAMP),
      'src/core/opStamp.ts 里出现了 updatedAt / Date.now 之类的时间判据 —— ' +
        '「以最后保存的一方为准」若因此成立，文档要改回那句话；' +
        '若产品**故意**改成时间决胜，请先改这里的判据再改文案'
    );
  });
});

describe('真相源 ②：两条导入路径的命名规则确实不同', () => {
  it('JSON 导入保留文件里的会话名', () => {
    assert.ok(
      jsonImportKeepsFileName(NORMALIZE),
      'src/core/normalizeTabsData.ts 里 JSON 导入不再保留文件里的会话名 —— ' +
        '若产品改成「JSON 导入也按内容命名」，商店文案那句要改'
    );
  });

  it('OneTab 导入按内容命名（主导域名）', () => {
    assert.ok(
      oneTabImportNamesByContent(ONETAB),
      'src/core/oneTabFormatParser.ts 里 OneTab 导入不再走 deriveImportedGroupName —— ' +
        '文案里关于「OneTab 导入按域名命名」的描述要跟着改'
    );
  });

  it('OneTab 导入丢掉锁定状态（那个格式里没有这个字段）', () => {
    assert.ok(
      oneTabImportDropsLock(ONETAB),
      'src/core/oneTabFormatParser.ts 里 OneTab 导入不再固定 isLocked: false —— ' +
        '若产品改成保留锁定，文案里那句「导入的会话一律不带锁定状态」就成了假话'
    );
  });

  it('保存路径的默认名只有一档：保存时刻（没有任何按内容命名的分支）', () => {
    assert.ok(
      savePathNamesOnlyByTimestamp(FACTORY),
      'src/domain/tabGroup/factory.ts 里给会话起名的表达式不再是「保存时刻」—— ' +
        '默认名必须只有一档，且不得有任何按内容命名的分支'
    );
    assert.doesNotMatch(
      SESSION_NAME,
      /deriveSingleSiteHost/,
      '「全都同站 ⇒ 用网站名」这条例外已经被推翻，判据不该还留在代码里'
    );
  });
});

describe('文案 ①：不得宣称「以最后保存的一方为准」', () => {
  /** 会被用户读到的四处。 */
  const surfaces: Array<{ name: string; text: string }> = [
    { name: 'README.md', text: README },
    { name: 'CHROMEWEBSTORE.md（正文）', text: storeBody() },
    { name: 'CHROMEWEBSTORE.md（Known Issues）', text: storeKnownIssues() },
    { name: 'promo-site/index.html', text: PROMO },
  ];

  for (const s of surfaces) {
    it(`${s.name} 不得出现「最后保存的一方为准」`, () => {
      for (const p of FALSE_LAST_SAVED_CLAIM) {
        assert.ok(
          !p.test(s.text),
          `${s.name} 仍然宣称「以最后保存的一方为准」—— ` +
            '而代码里的决胜口径是**操作印记**（序号 + 设备编号）：两台设备的序号来自' +
            '各自独立的计数器，先保存的那台完全可能赢。' +
            '这段话在教用户一个不成立的预期（以为后保存就安全）。'
        );
      }
    });
  }

  it('README 必须说清「印记决胜」并且否掉「按谁保存得晚」', () => {
    assert.ok(
      MENTIONS_STAMP_DECIDES.some(p => p.test(README)),
      'README 必须说清冲突是「按操作印记（序号 + 设备编号）决胜」'
    );
    assert.ok(
      MENTIONS_NOT_BY_WALL_CLOCK.some(p => p.test(README)),
      'README 必须明确否掉「最后保存的一方赢」这个说法 —— ' +
        '只说「印记决胜」不够：用户会自己脑补成「后保存的赢」'
    );
  });

  it('商店文案的 Known Issues 必须说清「印记决胜」并且否掉「按谁保存得晚」', () => {
    const issues = storeKnownIssues();
    assert.ok(
      MENTIONS_STAMP_DECIDES.some(p => p.test(issues)),
      '商店文案的 Known Issues 必须说清冲突是「按操作印记（序号 + 设备编号）决胜」'
    );
    assert.ok(
      MENTIONS_NOT_BY_WALL_CLOCK.some(p => p.test(issues)),
      '商店文案的 Known Issues 必须明确否掉「最后保存的一方赢」'
    );
  });

  // ⚠️ 2026-10-23 第 50 轮补上：**应用内文案**这一层。
  // 原来这个守卫只扫文档 ⇒ 用户在同步弹窗里读到的那句谎话
  // （`src/components/sync/SyncButton.tsx`）从来没人查，守卫一路绿灯。
  it('应用内文案（src/**/*.tsx）不得出现「最后保存的一方为准」', () => {
    const offenders: string[] = [];
    for (const file of appCopy()) {
      for (const p of FALSE_LAST_SAVED_CLAIM) {
        if (p.test(file.text)) offenders.push(`${file.name}（命中 ${p}）`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `应用内文案仍然宣称「最后保存的一方为准」：\n${offenders.join('\n')}\n` +
        '—— 而代码里的决胜口径是**操作印记**（序号 + 设备编号）：两台设备的序号来自' +
        '各自独立的计数器，先保存的那台完全可能赢。' +
        '应用内文案比文档更致命：用户是照着弹窗里那行字做决定的。'
    );
  });

  it('应用内那行必须说清「印记决胜」+「败方整组被替换」', () => {
    const sync = appCopy().find(f => f.name === 'src/components/sync/SyncButton.tsx');
    assert.ok(sync, '找不到 src/components/sync/SyncButton.tsx —— 判据的锚点丢了');
    assert.match(
      sync.text,
      /印记/,
      '同步弹窗必须说清冲突由「操作印记」决胜 —— 否则用户会自己脑补成「后保存的赢」'
    );
    assert.match(
      sync.text,
      /整组(?:替换|覆盖)/,
      '同步弹窗必须说清败方那一组会被**整组**替换（合并听起来像两边都保留，不是）'
    );
  });
});

describe('文案 ②：导入命名不得说「同一套规则」', () => {
  it('商店文案不得说导入与保存「同一套规则」', () => {
    assert.ok(
      !/同一套规则/.test(storeBody()),
      '商店文案仍说导入与保存「同一套规则」—— 而两档都不成立：' +
        'JSON 导入保留文件里的名字（根本不命名），OneTab 导入只实现了保存规则的第一档。'
    );
  });

  it('商店文案必须同时说清两种导入路径各自的命名方式', () => {
    const body = storeBody();
    assert.ok(
      /JSON/.test(body) && /保留|原样/.test(body),
      '商店文案必须说清「JSON 备份导入保留文件里的会话名」'
    );
    assert.ok(
      /OneTab/.test(body) && /域名/.test(body),
      '商店文案必须说清「OneTab 文本导入按主导域名命名」'
    );
  });

  it('README 必须说清两种导入路径各自的命名方式', () => {
    assert.ok(
      /JSON/.test(README) && /原样保留|保留/.test(README),
      'README 必须说清「JSON 备份导入保留会话名」'
    );
    assert.ok(
      /OneTab/.test(README) && /域名/.test(README),
      'README 必须说清「OneTab 导入按主导域名命名」'
    );
  });

  it('README 不得再说「与保存时同一套规则」', () => {
    assert.ok(
      !/与保存时同一套规则/.test(README),
      'README 仍说导入命名「与保存时同一套规则」—— 那是假话'
    );
  });
});

describe('文案 ③：跨设备删除的后果必须说清（DS-3 修完之后：删除**优先**）', () => {
  it('README 必须说清「删除 vs 同时编辑」时删除照样生效', () => {
    assert.ok(
      MENTIONS_DELETE_WINS.some(p => p.test(README)),
      'README 必须说清「一台设备删除、另一台在离线期间改了它 ⇒ 删除照样生效」—— ' +
        '删除没有回收站、不可逆，而确认框写着「其他设备将同步删除」'
    );
  });

  it('README 不得再说「删除可能被撤销」（DS-3 之后那已经不成立）', () => {
    assert.ok(
      !FALSE_DELETE_MAY_BE_UNDONE.some(p => p.test(README)),
      '❌ 回归：云端墓碑已经一律赢了（DS-3），删除**一定**生效 —— ' +
        '继续说「删除可能被撤销」是把已经修好的缺陷当成还存在的'
    );
  });

  it('商店文案的 Known Issues 同样必须说清「删除优先」', () => {
    assert.ok(
      MENTIONS_DELETE_WINS.some(p => p.test(storeKnownIssues())),
      '商店文案的 Known Issues 必须说清跨设备删除的后果'
    );
  });

  it('商店文案的 Known Issues 不得再说「删除可能被撤销」', () => {
    assert.ok(
      !FALSE_DELETE_MAY_BE_UNDONE.some(p => p.test(storeKnownIssues())),
      '❌ 回归：删除现在一定生效，Known Issues 不得再写「可能被撤销」'
    );
  });
});

describe('文案 ④：对外文案不得**否定产品已有的能力**（2026-10-23 第 50 轮）', () => {
  // ── 这一类的危险与前三条不同 ──────────────────────────────────────────
  // 前三条是「承诺比实现多」（说了做不到的）；这一类是**反过来**：
  // 「说得比实现少」—— 读者据此以为产品**缺**这项能力，于是不用它、
  // 或者去找别的工具。而「诚实边界」那一节恰恰是用户读它的地方 ⇒
  // 在那里少说一句，代价最大。

  /**
   * 「锁定 ⇒ 删除入口消失」这类说法 —— 产品做不到。
   *
   * 真相（2026-10-20 审计 A-3，`src/components/tabs/TabGroup.tsx`）：
   * 锁定保护的是会话**内部**（不可重命名 / 不可逐条删 / 不可拖走 /
   * 不参与清理重复），**不是**「这张卡不许消失」——
   * 删除入口**始终渲染**，删锁定会话只是**多一道确认**。
   */
  const LOCK_HIDES_DELETE_CLAIM = [
    /删除[^。；\n]{0,10}(按钮|入口)[^。；\n]{0,12}(隐藏|不显示|看不见|消失|一并|一起|同时|没有)/,
    /(隐藏|不显示|看不见|消失|一并|一起|同时|没有|不提供)[^。；\n]{0,12}(删除|删掉)(按钮|入口)/,
    /(删除|删)(按钮|入口)[^。；\n]{0,8}(一并|一起|同时|都)[^。；\n]{0,8}(隐藏|不显示|不见|消失)/,
    // 「锁定 ⇒ 整个会话不能删」：只在**提到锁定**的句子里查，
    // 并排除「卡内不能逐条删」这种**真的**限制（逐条/标签/其中…）。
    /锁定[^。；\n]{0,24}?(不能|不可|没法|禁止|不让)(?![^。；\n]{0,8}(标签|条目|其中|里面|单条|单个|一条|逐条|之内|内部))[^。；\n]{0,4}?(删除|删掉)/,
  ];

  /** 「锁定会话整张卡仍然可以删除」—— 可接受的说法。 */
  const LOCK_STILL_DELETABLE = [
    /仍然可以删除/,
    /依然可以删除/,
    /照样可以删除/,
    /仍可删除/,
    /依然可删除/,
    /照样能删/,
    /仍然能删/,
    /也能删除/,
    /整张卡[^。；\n]{0,12}(可以|能|照样|仍然|依然|依旧)?[^。；\n]{0,4}删/,
  ];

  /**
   * 「没有撤销」—— 1.26.0 起产品**有**撤销（恢复 / 点开那一步，8 秒窗口）。
   *
   * ⚠️ 为什么不放行「删除没有撤销」这种**限定说法**：
   * 官网的「诚实边界」是**逐条**读的，一句「没有撤销」会被读成
   * 「整个产品没有撤销」⇒ 这条能力在读者眼里被整个抹掉。
   * ⇒ 口径统一成：删除那一步说「**没有退路**」，撤销只挂在恢复 / 点开上。
   */
  const NO_UNDO_CLAIM = [/没有撤销/, /无撤销/, /不提供撤销/, /没有\s*undo/i];

  /** 官网里的段落（按换行切；HTML 里一段就是一行）。 */
  const paragraphs = (): string[] => PROMO.split(/\n+/).filter(s => s.trim().length > 0);

  it('官网不得宣称「锁定会藏起删除入口」', () => {
    for (const p of LOCK_HIDES_DELETE_CLAIM) {
      assert.ok(
        !p.test(PROMO),
        `promo-site/index.html 仍然宣称锁定会让删除入口消失（命中 ${p}）—— ` +
          '而真相是：锁定保护的是会话**内部**（不可重命名 / 不可逐条删 / 不可拖走 / ' +
          '不被「清理重复标签」误伤），**删除入口始终在**，删锁定会话只是多一道确认。'
      );
    }
  });

  it('官网必须说清「锁定会话整张卡仍然可以删除」', () => {
    assert.ok(
      paragraphs().some(p => /锁定/.test(p) && LOCK_STILL_DELETABLE.some(re => re.test(p))),
      '官网必须在讲锁定的那一段里说清「整张卡仍然可以删除」—— ' +
        '只说「锁定保护会话内部」不够：读者会以为锁定 = 不可删除（A-3 修掉的正是这个误解）'
    );
  });

  it('官网不得宣称「没有撤销」', () => {
    for (const p of NO_UNDO_CLAIM) {
      assert.ok(
        !p.test(PROMO),
        `promo-site/index.html 仍然宣称「没有撤销」（命中 ${p}）—— ` +
          '而 1.26.0 起「恢复整个会话 / 点开单条标签」都带 8 秒的「撤销」。' +
          '删除那一步确实没有退路，但请写成「**删除这一步没有退路**」，' +
          '把「撤销」留给恢复 / 点开 —— 一句「没有撤销」会把这条能力整个抹掉。'
      );
    }
  });

  it('官网必须说清「恢复 / 点开那一步有撤销」', () => {
    assert.ok(
      paragraphs().some(p => /撤销/.test(p) && /恢复|点开/.test(p)),
      '官网必须说清「恢复 / 点开那一步有撤销（8 秒）」—— ' +
        '这一节是「我们不承诺的东西」，读者据此判断产品缺什么；' +
        '把已有的能力从这一节里抹掉，等于教读者「它没有这条退路」'
    );
  });

  it('官网里所有 Chrome 商店链接都必须指向带扩展 id 的详情页', () => {
    const links = [
      ...PROMO.matchAll(
        /https?:\/\/(?:chrome\.google\.com\/webstore|chromewebstore\.google\.com)\/[^\s"'<>)]*/g,
      ),
    ].map(m => m[0]);
    assert.ok(links.length > 0, '官网里至少要有一个商店链接 —— 判据的锚点丢了');
    for (const link of links) {
      assert.ok(
        link.includes(`/detail/${EXTENSION_ID}`),
        `商店链接「${link}」没有扩展 id —— 它会落到**商店首页**，而不是这个扩展的详情页`
      );
    }
  });
});

describe('自证检测力：把文案改回旧说法，守卫必须看得见', () => {
  it('判据能看出「最后保存的一方为准」这句话', () => {
    const fake = '多设备同时编辑同一会话时，以最后保存的一方为准（错峰使用不受影响）。';
    assert.ok(
      FALSE_LAST_SAVED_CLAIM.some(p => p.test(fake)),
      '判据连示例都抓不到 —— 判据失效'
    );
    assert.ok(
      !MENTIONS_STAMP_DECIDES.some(p => p.test(fake)),
      '假话不该命中「印记决胜」的正向判据'
    );
  });

  it('判据能区分「印记决胜」与「最后保存为准」', () => {
    const honest = '胜负由操作印记（序号 + 设备编号）决定，不是按最后保存的一方为准。';
    assert.ok(
      MENTIONS_STAMP_DECIDES.some(p => p.test(honest)),
      '诚实说法没命中正向判据'
    );
    assert.ok(
      MENTIONS_NOT_BY_WALL_CLOCK.some(p => p.test(honest)),
      '诚实说法里的「不是…最后保存」没命中 —— 判据太窄'
    );
    assert.ok(
      !FALSE_LAST_SAVED_CLAIM.some(p => p.test(honest)),
      '诚实说法被误判成假话 —— 判据太宽（它会挡住正确的改动）'
    );
  });

  it('判据能看出「同一套规则」这句话', () => {
    assert.ok(
      /同一套规则/.test('导入的会话也按内容命名（和保存时同一套规则）'),
      '判据连示例都抓不到'
    );
  });

  // ── 2026-10-24 审计 DS-3：删除口径换了 ⇒ 判据必须看得见旧口径 ────────────
  it('判据能看出「删除可能被撤销」这句**已经过时**的说法', () => {
    const stale = '一台设备删除会话、另一台在离线期间同时改了它时，删除可能被撤销。';
    assert.ok(
      FALSE_DELETE_MAY_BE_UNDONE.some(p => p.test(stale)),
      '判据连旧口径的示例都抓不到 —— 守卫失效'
    );
    assert.ok(
      !MENTIONS_DELETE_WINS.some(p => p.test(stale)),
      '旧口径不该命中「删除优先」的正向判据'
    );
  });

  it('判据不会误伤「删除不会被撤销」这种**否定**说法（正确改动不能被挡住）', () => {
    // 逐字取自 README / 商店 Known Issues 的现行说法（2026-10-24 DS-3 之后）。
    const honest =
      '删除优先（云端墓碑一律赢）—— 对方的离线编辑不会把删除撤销，那条会话在对方那儿也会消失。';
    assert.ok(
      !FALSE_DELETE_MAY_BE_UNDONE.some(p => p.test(honest)),
      '❌ 守卫太宽：它把「不会把删除撤销」也判成「说删除可能被撤销」⇒ 会挡住正确的改动'
    );
    assert.ok(
      MENTIONS_DELETE_WINS.some(p => p.test(honest)),
      '诚实说法没命中「删除优先」的正向判据'
    );
  });
});
