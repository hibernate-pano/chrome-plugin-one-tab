// 「哪些地址会被保存」必须与代码一致（2026-10-20 L-14）。
//
// ── 这个文件要防的具体事故 ────────────────────────────────────────────────
//
// 2026-10-20 复核商店文案时实测发现，商店页写的是：
//
//   「默认不保存「固定标签页」，也不保存浏览器内部页面与本地文件（可在设置里改）」
//   （英文：neither are browser internal pages or local files）
//
// 而代码的**真实**行为是：
//
//   · 固定标签页  → 默认不保存，且**确实有开关**（collectPinnedTabs）      ✔
//   · 浏览器内部页 → 不保存（chrome:// / edge:// / about: / chrome-extension://）✔
//   · 本地文件     → **照常保存**（file:// 在 STORABLE_TAB_PROTOCOLS 里）    ✘
//
// 2026-10-05 修「存得下、回不来」时，file: / blob: / devtools: / view-source:
// 被从「存储门」放行（只从「打开门」拒绝）—— 因为它们是用户保存时**确实打得开**
// 的真实地址，丢掉就等于「保存不完整」。
//
// 但**商店文案没跟着改**。于是：
//   ① 审核员按文案去核对，发现文案与实现不符 ⇒ 披露不实；
//   ② 更要紧的是隐私面：file:// 的地址里**含用户本机的文件夹路径与用户名**
//      （file:///Users/xxx/Documents/contract.pdf），它会随同步上云 ——
//      而隐私政策原文只说「页面标题、URL」，用户读不出「URL 里可能有我的
//      本地路径」这一层。
//
// ── 根因 ──────────────────────────────────────────────────────────────────
//
// 「保存策略」此前只有**一处**事实源（`isStorableTabUrl` 的协议表），
// 但**三份文档各写各的**：
//   · 商店页写「不保存本地文件」
//   · 隐私政策写「页面标题、URL」（没提本地路径这层）
//   · README 没提这层
//
// 文档不在任何测试的覆盖范围内 ⇒ 改代码的人不必改文档，
// 改文档的人不必看代码 ⇒ 两边可以无限期分叉。
//
// ── 这个文件守什么 ────────────────────────────────────────────────────────
//
// **不钉文案的字面量**，钉「文档说的那件事，代码里必须真的是那样」：
//   ① 代码里 file:// 属于「可存储」⇒ 文档**不得**说本地文件不保存；
//   ② 代码里 file:// 属于「打不开」⇒ 文档**应当**说明它在别的设备上
//      可能打不开（否则用户以为恢复一定会成功）；
//   ③ 代码里没有「是否保存本地文件」的设置项 ⇒ 文档**不得**说本地文件
//      这件事可以在设置里改（固定标签页才可以）。
//
// 判据从**代码**里取事实（协议表 + 设置项列表），不是从文档里取。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const STORE = read('CHROMEWEBSTORE.md');
const PRIVACY = read('src/legal/privacy.html');
const README = read('README.md');

/** 商店文档的「正文」：排除版本历史表（历史条目描述的是**当时**的行为）。 */
const storeBody = (): string =>
  STORE.split('## Version History')[0].split('## Review Notes')[0];

/**
 * ── 事实来源 ①：协议表 ──────────────────────────────────────────────────
 *
 * 「本地文件会不会被保存」这个问题的唯一真相是 `STORABLE_TAB_PROTOCOLS`
 * —— 它是落库前那道门（`isStorableTabUrl`）的依据。
 *
 * 【为什么从代码取、而不是在测试里写死 `'file:'`】
 * 写死的话，哪天有人把 file: 从表里挪走，这个守卫仍会绿 ——
 * 而那时文档**确实**该改。判据跟着代码走，才不会各说各话。
 */
const storableProtocols = (): Set<string> => {
  const src = read('src/utils/inputValidation.ts');
  const m = src.match(/STORABLE_TAB_PROTOCOLS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(m, '找不到 STORABLE_TAB_PROTOCOLS —— 判据锚点丢了');
  return new Set(
    [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1])
  );
};

/** 事实来源 ②：内部页前缀表。 */
const internalPrefixes = (): string[] => {
  const src = read('src/domain/tabGroup/filters.ts');
  const m = src.match(/INTERNAL_URL_PREFIXES\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(m, '找不到 INTERNAL_URL_PREFIXES —— 判据锚点丢了');
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
};

/**
 * 事实来源 ③：设置项里**没有**「是否保存本地文件」这一项。
 *
 * 这一条是给「（可在设置里改）」那半句话准备的：固定标签页有开关，
 * 本地文件没有 —— 两者不是一回事。
 */
const hasSettingForLocalFiles = (): boolean => {
  const types = read('src/types/tab.ts');
  const settingsBlock = types.match(/interface UserSettings\s*{([\s\S]*?)\n}/);
  assert.ok(settingsBlock, '找不到 UserSettings 接口 —— 判据锚点丢了');
  return /localFile|saveLocalFile|includeLocalFile/i.test(settingsBlock[1]);
};

describe('L-14 ①「保存了哪些地址」的文案必须与协议表一致', () => {
  it('（事实来源）本地文件（file:）确实在「可存储」协议表里', () => {
    // 这条断言是整个守卫的锚点：它把「文案该说什么」与「代码是什么」绑在一起。
    // 若哪天 file: 被挪出协议表（产品决定不再保存本地文件），
    // 这条会先变红，提醒「文档也要一起改」。
    assert.ok(
      storableProtocols().has('file:'),
      'file: 不在 STORABLE_TAB_PROTOCOLS 里 —— 若这是有意的产品改动，' +
        '商店文案/隐私政策/README 也要同步改（本地文件就不会再被保存了）。'
    );
  });

  it('（事实来源）file: 不在「打不开」协议表里 —— 即它存得下、只是打不开', () => {
    const src = read('src/utils/inputValidation.ts');
    const m = src.match(/OPENABLE_TAB_PROTOCOLS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    assert.ok(m, '找不到 OPENABLE_TAB_PROTOCOLS —— 判据锚点丢了');
    const openable = new Set([...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]));
    assert.ok(
      !openable.has('file:'),
      'file: 居然在「可打开」协议表里 —— 那它就不是「存得下打不开」那一类，' +
        '文档的措辞需要重新核对。'
    );
  });

  it('（事实来源）浏览器内部页确实在前缀表里', () => {
    const prefixes = internalPrefixes();
    assert.ok(prefixes.includes('chrome://'), 'chrome:// 应在内部页前缀表里');
    assert.ok(prefixes.includes('chrome-extension://'), '扩展页应被拒');
  });

  it('商店页不得说「不保存本地文件」（代码里它是存下来的）', () => {
    // 这条守卫的正向判据：本地文件**被保存** ⇒ 文档不得宣称它不被保存。
    assert.doesNotMatch(
      storeBody(),
      /不保存[^。；\n]{0,20}本地文件|本地文件[^。；\n]{0,20}不保存/,
      '商店页说「不保存本地文件」，但代码里 file:// 属于可存储协议（' +
        '本地文件会照常存下来，还可能随同步上云）—— 这是披露不实。' +
        '若产品决定改成不保存，请先改 isStorableTabUrl 的协议表，再改文案。'
    );
    assert.doesNotMatch(
      storeBody(),
      /neither are browser internal pages or local files|local files are not saved/i,
      '英文侧同上：代码里 file:// 会被保存，商店页不得说 local files 不保存。'
    );
  });

  it('隐私政策必须点出「本地文件的地址会被保存」这一层', () => {
    // 隐私政策原来只写「页面标题、URL」—— 用户读不出「URL 里可能有我的
    // 本地路径与用户名」。这层不说清楚 = 用户不知道自己的目录结构会上云。
    assert.match(
      PRIVACY,
      /file:\/\/|本地文件/i,
      '隐私政策必须说明本地文件地址（file://）会被保存 —— ' +
        '它可能包含用户本机的文件夹路径与用户名，属于应当披露的一层。'
    );
    assert.match(
      PRIVACY,
      /路径|用户名|文件夹/i,
      '隐私政策必须点出「本地文件地址里含本机路径/用户名」这一层，' +
        '否则用户无从知道自己的目录结构会随同步离开设备。'
    );
  });

  it('README 的「保存会话」一节也必须说清本地文件的去向', () => {
    /**
     * 【为什么必须限定在「保存会话」一节】
     * README 的「找回会话」一节里本来就有一句「本设备打不开的地址（本地文件、
     * 内部页面）会提示并保留记录」—— 那句说的是**恢复**时打不开，不是**保存**时
     * 存不存。若不限定小节，「README 里出现了『本地文件』」这个判据会被那句满足，
     * 于是把「保存会话」一节里的话删光，守卫仍然全绿 —— 判据的锚点选错了。
     *
     * 【为什么还要判「存」这个动作】光有「本地文件」四个字不够：那一节要说的是
     * 「会被存下来」，而不是「本地文件打不开」。所以要求该小节里「本地文件」的
     * 附近出现「存」的动作词。
     */
    const saveSection = (() => {
      const m = README.match(/###\s*保存会话([\s\S]*?)(?=\n###\s|\n##\s|$)/);
      assert.ok(m, 'README 里找不到「### 保存会话」小节 —— 判据锚点丢了');
      return m[1];
    })();

    const mentions = [...saveSection.matchAll(/本地文件|file:\/\//gi)];
    assert.ok(
      mentions.length > 0,
      'README 的「保存会话」一节必须说明本地文件（file://）会被保存 —— ' +
        '三份文档口径必须同源，否则读者按 README 理解会与实际行为不符。'
    );
    // 「本地文件」附近必须有「存」这个动作 —— 说「打不开」不算说清了保存行为。
    for (const m of mentions) {
      const idx = m.index ?? 0;
      const window = saveSection.slice(Math.max(0, idx - 60), idx + 60);
      assert.match(
        window,
        /存(下来|下|入|储)|保留|照常/,
        'README「保存会话」一节提到本地文件时必须说清它**会被存下来** —— ' +
          '只说「打不开」会让读者以为它没被保存。' +
          `（ offending 片段：${window}）`
      );
    }
  });
});

describe('L-14 ②「可在设置里改」这句话只对固定标签页成立', () => {
  it('（事实来源）设置项里没有「是否保存本地文件」这一项', () => {
    assert.equal(
      hasSettingForLocalFiles(),
      false,
      'UserSettings 里出现了疑似「是否保存本地文件」的字段 —— ' +
        '若这是真的加了开关，「可在设置里改」这句话反而有了依据，' +
        '但也要确认它真的被 UI 读到了（否则又是一个死设置）。'
    );
  });

  it('「（可在设置里改）」不得挂在本地文件/内部页这一句上', () => {
    /**
     * 判据是**邻接**，不是「同句出现」。
     *
     * 【为什么不能按句判】一条功能说明里常同时出现两者，且**各自都成立**：
     *   「默认不保存「固定标签页」（可在设置里改）；……本地文件（file://）的地址会照常存下来」
     * 前后两项说的是不同的东西，中间用分号隔开。
     * 若按「同一句里出现就判红」，**正确的文案会被判红** —— 这正是本仓
     * 反复吃过的亏（守卫钉错值 ⇒ 正确的改动被挡住）。
     *
     * 【为什么用窗口而不是分句】分句依赖作者恰好用了分号；写成一段长句时
     * 就会误判。窗口判据与「修饰语紧跟在被修饰对象后面」这个语言事实对齐：
     *   · **前向**窗口：从「本地文件」起，到下一个分隔符（；;。!?\n）止 ——
     *     覆盖了缺陷原文「本地文件（可在设置里改）」与英文
     *     「local files (both are changeable in settings)」两种形态；
     *   · **后向**窗口：紧邻的 20 个字符（更紧 —— 防止把「固定标签页」的
     *     那个开关误算到「本地文件」头上，两者隔着一整项）。
     */
    const LOCAL_FILE = /本地文件|local file/gi;
    const CONFIGURABLE = /可在设置里改|可以.{0,4}设置里改|changeable in settings|can be changed in settings/i;

    for (const [name, text] of [
      ['CHROMEWEBSTORE.md', storeBody()],
      ['README.md', README],
    ] as const) {
      for (const m of text.matchAll(LOCAL_FILE)) {
        const idx = m.index ?? 0;

        // 前向窗口：从「本地文件」之后到下一个分隔符。
        const forward = text.slice(idx, idx + 40).split(/[；;。!?\n]/)[0];
        assert.doesNotMatch(
          forward,
          CONFIGURABLE,
          `${name}：「本地文件」后面紧跟着「可在设置里改」，但设置项里没有这个开关 —— ` +
            '只有「固定标签页」有开关（collectPinnedTabs）。' +
            `（ offending 片段：${text.slice(Math.max(0, idx - 20), idx + 40)}）`
        );

        // 后向窗口：紧邻的 20 字符（只覆盖「本地文件（可配）」这种贴身写法）。
        const backward = text.slice(Math.max(0, idx - 20), idx);
        assert.doesNotMatch(
          backward,
          CONFIGURABLE,
          `${name}：「本地文件」前面紧挨着「可在设置里改」，但设置项里没有这个开关 —— ` +
            '只有「固定标签页」有开关（collectPinnedTabs）。' +
            `（ offending 片段：${text.slice(Math.max(0, idx - 20), idx + 40)}）`
        );
      }
    }
  });

  it('（正向锚点）文档必须仍然说明「固定标签页」可在设置里改', () => {
    // 【为什么要有这条】上面那条是「不得出现错误挂靠」，这条是「正确的挂靠必须在」——
    // 两者一起，这条守卫才不是「删掉就绿」的：把整句删光，前向/后向窗口都无从触发，
    // 但这条会红。
    assert.match(
      storeBody(),
      /固定标签页[^。；\n]{0,40}(可在设置里改|可在设置中更改)|(可在设置里改|可在设置中更改)[^。；\n]{0,20}固定标签页/,
      '商店页必须说明「固定标签页」可在设置里改（这是真的，有 collectPinnedTabs 开关）'
    );
    assert.match(
      storeBody(),
      /Pinned tabs are not saved by default \(changeable in settings\)/i,
      '英文侧同样要点明固定标签页可在设置里改'
    );
  });

  it('固定标签页确实有开关（否则连这一句也不成立）', () => {
    const slice = read('src/utils/storage.ts');
    assert.match(
      slice,
      /collectPinnedTabs:\s*false/,
      'collectPinnedTabs 默认 false（默认不保存固定标签页）'
    );
    const options = read('src/options/OptionsPage.tsx');
    assert.match(
      options,
      /checked=\{settings\.collectPinnedTabs\}/,
      '设置页必须有「保存固定标签页」的开关 —— 商店文案承诺了它可配。'
    );
  });
});

describe('L-14 ③ 内部页「一律不保存」这句必须仍然成立', () => {
  it('商店页说内部页不保存 ⇒ 代码里内部页确实被拒', () => {
    const prefixes = internalPrefixes();
    assert.ok(prefixes.length > 0, '内部页前缀表不应为空');
    // 至少 chrome:// 与 chrome-extension:// 必须在内（设置页与扩展页）
    for (const p of ['chrome://', 'chrome-extension://']) {
      assert.ok(
        prefixes.includes(p),
        `内部页前缀表缺 ${p} —— 若产品不再拒它，商店文案那句要改`
      );
    }
  });

  it('（事实来源）file: 不在内部页前缀表里（它靠协议表拒，不靠前缀表）', () => {
    assert.ok(
      !internalPrefixes().some(p => p.startsWith('file:')),
      'file: 出现在内部页前缀表里 —— 那它会被整体丢弃，' +
        '「本地文件会照常保存」这句就不成立了。'
    );
  });
});
