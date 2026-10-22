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
 *        = **只有保存规则的第一档**（主导域名），取不到域名时回落到「导入的会话 N」——
 *        而保存路径有**三档**（域名 → 页面标题 → 时间戳，
 *        `src/domain/tabGroup/sessionName.ts:269/273/277`）。
 *    ⇒ 「同一套规则」**两档都不成立**：JSON 那档根本不命名，OneTab 那档只实现了 1/3。
 *
 * ③ **「删除会同步到其他设备」**（删除确认框）
 *    —— 真相：`markCloudGroupsAsDeleted` 的墓碑号是
 *    `max(本机 Lamport 号, 云端那行当时的 seq + 1)`，而**对方离线编辑的号来自
 *    它自己的计数器** ⇒ 两个**互不相关**的计数器裸比数值决定胜负
 *    ⇒ **删除可能被撤销**（DS-3，P0）。而确认框写的是「其他登录设备将同步删除」。
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
import { readFileSync } from 'node:fs';
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

/** 保存路径的命名有**几档**回落？ */
function saveNamingFallbackTiers(source: string): number {
  // 判据数「主导域名 / 首个有意义标题 / 时间戳」这三档是否都在。
  const tiers = [
    /deriveDominantHost\(/.test(source),
    /isMeaningfulTabTitle/.test(source),
    /buildTimestampSessionName/.test(source),
  ];
  return tiers.filter(Boolean).length;
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

/** 「删除可能被撤销」这件事，文案里可以接受的说法。 */
const MENTIONS_DELETE_MAY_BE_UNDONE = [
  /删除可能被撤销/,
  /删除.{0,20}被.{0,6}撤销/,
  /delete.{0,30}(?:can be|may be) (?:undone|revoked)/i,
  /your deletion.{0,30}may (?:not|be undone)/i,
];

/** **不成立**的具体规则 —— 文案不许说。 */
const FALSE_LAST_SAVED_CLAIM = [
  /以最后保存的一方为准/,
  /以\*\*最后保存的一方\*\*为准/,
  /以最后保存的一方赢/,
  /后保存方整组赢/,
  /以最后保存的一方为准/,
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

  it('保存路径的命名确实有三档回落（OneTab 只实现了第一档）', () => {
    assert.equal(
      saveNamingFallbackTiers(SESSION_NAME),
      3,
      'src/domain/tabGroup/sessionName.ts 的命名回落档数变了 —— ' +
        '文案说「OneTab 只实现了保存规则的第一档」，这个「一」要跟着变'
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

describe('文案 ③：删除可能被撤销这件事必须说清', () => {
  it('README 必须说清「删除 vs 同时编辑」的删除可能被撤销', () => {
    assert.ok(
      MENTIONS_DELETE_MAY_BE_UNDONE.some(p => p.test(README)),
      'README 必须说清「一台设备删除、另一台同时离线编辑时，删除可能被撤销」—— ' +
        '删除没有回收站、不可逆，而确认框却写着「其他设备将同步删除」'
    );
  });

  it('商店文案的 Known Issues 必须说清「删除可能被撤销」', () => {
    assert.ok(
      MENTIONS_DELETE_MAY_BE_UNDONE.some(p => p.test(storeKnownIssues())),
      '商店文案的 Known Issues 必须说清「删除可能被撤销」'
    );
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
});
