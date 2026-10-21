// OneTab 文本的**往返保真**（2026-10-20 审计 A-20）。
//
// ── 这个文件要防的具体事故 ────────────────────────────────────────────────
//
// OneTab 的行格式是 `URL | 标题`，而分隔符 `|` **同时可能出现在 URL 里
// 和标题里**。旧实现切**第一个** `|`（2026-10-06 修的「标题里的 | 被切开」）
// ⇒ 反过来把 **URL 截断**了：
//
//   导出：`https://ex.com/a|b?q=1|2 | 标题 | 带竖线`
//   导回：`url = https://ex.com/a`（被截断！）+ `title = "b?q=1|2 | 标题 | 带竖线"`
//
// ⇒ 用户存的标签页**变成了一个打不开的地址**，而且**没有任何提示**。
//
// 根因：`|` 在 RFC 3986 里不是合法的 URI 字符，但 **Chrome 地址栏不编码它**
// （`new URL('https://x.com/a|b').href` 原样保留）⇒ `?q=foo|bar`
// （GitHub 代码搜索的正例）能原封不动地存进会话。
//
// 另外两个同源缺陷：
//   · **标题含换行** ⇒ 导出文本多出一行 ⇒ 重新导入时一条标签被拆成两条，
//     标题被截断成「第一行」。
//   · **标题为空**（`url | `）⇒ 切分判据漏判 ⇒ 整行被丢弃
//     ⇒ **一条合法 URL 消失**。
//
// ── 这个文件守什么（断言**不变量**，不钉字面量）──────────────────────────
//
// ① **往返保真**：任意一组「URL + 标题」经 导出 → 导入 后，
//    标签**条数**不变、每条的 **URL 逐字相同**。
// ② **条数不变**：标题里的换行/竖线不得把一条标签拆成多条。
// ③ **不丢条**：URL 合法但标题为空时，那条标签必须还在。
//
// 【为什么断言「URL 逐字相同」而不是「URL 包含关系」】
// 截断（`https://ex.com/a` vs `https://ex.com/a|b`）是**包含**关系 ⇒
// 断言包含会放过这个 bug。必须是**相等**。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Tab, TabGroup } from '@/types/tab';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};
const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '../_alias-loader.mjs')
).href;

before(async () => {
  register(LOADER_PATH);
});

const NOW = '2026-10-20T10:00:00.000Z';

function mkTab(url: string, title: string): Tab {
  return {
    id: `t-${url}-${title}`,
    url,
    title,
    favicon: '',
    createdAt: NOW,
    lastAccessed: NOW,
    pinned: false,
  };
}

function mkGroup(tabs: Tab[]): TabGroup {
  return {
    id: 'g1',
    name: '会话 1',
    tabs,
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    isLocked: false,
  };
}

/**
 * 走一遍「导出 → 导入」，返回导入后的标签数组。
 */
async function roundTrip(tabs: Tab[]): Promise<Tab[]> {
  const { formatToOneTabFormat, parseOneTabFormat } = await import('@/core/oneTabFormatParser');
  const text = formatToOneTabFormat([mkGroup(tabs)]);
  const parsed = parseOneTabFormat(text);
  assert.equal(parsed.length, 1, '往返后应当还是 1 个会话');
  return parsed[0].tabs;
}

describe('OneTab 往返 ① URL 不得被截断', () => {
  it('URL 里的竖线原样往返（GitHub 代码搜索 ?q=foo|bar 是真实场景）', async () => {
    const url = 'https://github.com/search?q=foo|bar&type=code';
    const tabs = await roundTrip([mkTab(url, '搜索结果')]);

    assert.equal(tabs.length, 1, '一条标签必须还是一条');
    assert.equal(
      tabs[0].url,
      url,
      'URL 被截断了 —— 存进去的标签页变成了一个打不开的地址，且没有任何提示'
    );
  });

  it('URL 与标题**同时**含竖线时，两个都要原样保留', async () => {
    const url = 'https://ex.com/a|b?q=1|2';
    const title = '标题 | 带竖线';
    const tabs = await roundTrip([mkTab(url, title)]);

    assert.equal(tabs.length, 1);
    assert.equal(tabs[0].url, url, 'URL 被截断');
    assert.equal(tabs[0].title, title, '标题被错位了');
  });

  it('URL 末尾就是竖线时不得被吃掉', async () => {
    const url = 'https://ex.com/path|';
    const tabs = await roundTrip([mkTab(url, '尾竖线')]);

    assert.equal(tabs.length, 1);
    assert.equal(tabs[0].url, url);
  });
});

describe('OneTab 往返 ② 一条标签不得被拆成多条', () => {
  it('标题含换行时不得拆行（否则标题被截断成「第一行」）', async () => {
    const title = '第一行\n第二行';
    const tabs = await roundTrip([mkTab('https://ex.com/ok', title)]);

    assert.equal(tabs.length, 1, '标题里的换行把一条标签拆成了多条');
    assert.equal(tabs[0].url, 'https://ex.com/ok');
    assert.ok(
      tabs[0].title.includes('第二行'),
      `标题被截断了：${JSON.stringify(tabs[0].title)} —— 换行后的内容丢了`
    );
  });

  it('标题含竖线时不得拆行', async () => {
    const tabs = await roundTrip([mkTab('https://ex.com/ok', 'A | B')]);

    assert.equal(tabs.length, 1);
    assert.equal(tabs[0].title, 'A | B');
  });
});

describe('OneTab 往返 ③ 合法 URL 不得整条丢失', () => {
  it('标题为空时那条标签必须还在', async () => {
    const tabs = await roundTrip([mkTab('https://ex.com/x', '')]);

    assert.equal(
      tabs.length,
      1,
      '一条合法 URL 被整条丢弃了 —— 这是数据丢失（切分判据漏掉了行尾分隔符）'
    );
    assert.equal(tabs[0].url, 'https://ex.com/x');
  });

  it('空标题保持为空（不得回落成 URL —— 那是行为变更）', async () => {
    const { splitOneTabLine } = await import('@/core/oneTabFormatParser');

    // 旧实现：`sep === -1 ? url : slice(sep+1).trim()` ⇒ `url | ` 的标题是空串。
    // 回落成 URL 会把「用户没写标题」变成「标题显示成网址」。
    const parsed = splitOneTabLine('https://ex.com/x | ');
    assert.equal(parsed?.url, 'https://ex.com/x');
    assert.equal(parsed?.title, '', '空标题被回落成 URL 了');
  });

  it('多标签混合时条数与顺序都不变', async () => {
    const urls = [
      'https://ex.com/a|b',
      'https://ex.com/plain',
      'https://ex.com/c|d?q=1|2',
    ];
    const tabs = await roundTrip(urls.map((u, i) => mkTab(u, `标题 ${i}`)));

    assert.equal(tabs.length, urls.length, '标签条数变了');
    assert.deepEqual(
      tabs.map(t => t.url),
      urls,
      'URL 列表与顺序都变了'
    );
  });
});

describe('OneTab 切分器 ④ 判据本身', () => {
  it('危险协议整行丢弃（切分不得放宽安全边界）', async () => {
    const { splitOneTabLine } = await import('@/core/oneTabFormatParser');

    assert.equal(splitOneTabLine('javascript:alert(1) | 恶意'), null);
    assert.equal(splitOneTabLine('data:text/html,<h1>x</h1> | 恶意'), null);
  });

  it('没有分隔符的整行 URL 被当作「无标题标签」（旧行为）', async () => {
    const { splitOneTabLine } = await import('@/core/oneTabFormatParser');

    const parsed = splitOneTabLine('https://ex.com/x');
    assert.ok(parsed, '纯 URL 行必须能解析');
    assert.equal(parsed?.url, 'https://ex.com/x');
    // 旧实现是 `sep === -1 ? url : …` ⇒ 无分隔符时**用 URL 当标题**。
    // 这条行为不影响数据完整性，但它是既有契约 ⇒ 钉住，防止被顺手改掉
    // 导致「导入别人的 OneTab 文件」时标题从 URL 变成空白。
    assert.equal(parsed?.title, 'https://ex.com/x', '无分隔符时标题应当是 URL 本身');
  });

  it('标题里的竖线不会被误当成 URL 的一部分', async () => {
    const { splitOneTabLine } = await import('@/core/oneTabFormatParser');

    const parsed = splitOneTabLine('https://ex.com/x | A | B');
    assert.equal(parsed?.url, 'https://ex.com/x');
    assert.equal(parsed?.title, 'A | B');
  });
});

describe('OneTab 导入组名 ⑤ 用域名而不是序号', () => {
  /**
   * 【为什么这一条重要】OneTab 格式**本身不含组名**（社区标准如此）⇒
   * 导入时组名必然丢失，这是格式的固有限制。
   * 但「组名丢失」不等于「组名只能是『导入的会话 N』」——
   * 攒到 20 个导入的会话，列表就是一列分不清的序号，
   * 而产品的核心承诺是「保存 → 之后找回」。
   * ⇒ 用域名补上（与**保存路径**同一把尺子）。
   */
  it('导入的会话用主导域名命名', async () => {
    const { parseOneTabFormat } = await import('@/core/oneTabFormatParser');

    const parsed = parseOneTabFormat(
      [
        'https://github.com/a | PR',
        'https://github.com/b | Issues',
        'https://docs.google.com/c | Doc',
      ].join('\n\n')
    );

    assert.equal(
      parsed[0].name,
      'github.com',
      '导入的会话仍叫「导入的会话 N」—— 列表里分不清哪个是哪个，'
    );
  });

  it('取不到域名时回落到序号（**不得**用时间戳 —— 会破坏幂等指纹）', async () => {
    const { parseOneTabFormat } = await import('@/core/oneTabFormatParser');

    const parsed = parseOneTabFormat('file:///Users/me/paper.pdf | 论文');

    // 回落必须是**确定性**的：组名会进幂等指纹
    // （groupContentFingerprint = 组名 + URL 集合），
    // 非确定性的名字（时间戳）会让「同一份文件导两次」判重失效
    // ⇒ 产生整份副本。
    assert.match(
      parsed[0].name,
      /^导入的会话 \d+$/,
      '取不到域名时应当回落到确定性的序号，而不是时间戳'
    );
  });

  it('导入路径与保存路径用**同一把尺子**（同一组 URL ⇒ 同一个名字）', async () => {
    const { deriveImportedGroupName } = await import('@/core/oneTabFormatParser');
    const { deriveSessionNameFromChromeTabs } = await import('@/domain/tabGroup/sessionName');

    const urls = ['https://github.com/a', 'https://github.com/b', 'https://gitlab.com/c'];
    const importedName = deriveImportedGroupName(
      urls.map((url, i) => ({
        id: `t${i}`,
        url,
        title: url,
        favicon: '',
        createdAt: NOW,
        lastAccessed: NOW,
        pinned: false,
      })),
      0
    );
    const savedName = deriveSessionNameFromChromeTabs(
      urls.map(url => ({ url })) as any,
      NOW
    );

    assert.equal(
      importedName,
      savedName,
      '导入与保存给出了不同的名字 —— 同一个工作现场在两条路上叫两个名'
    );
  });

  it('主导域名按**出现次数**决定（不是取第一个）', async () => {
    const { deriveImportedGroupName } = await import('@/core/oneTabFormatParser');

    // 第一个出现的域名只有 1 个，第二个有 2 个 ⇒ 应当取第二个。
    // 【为什么这条要单独钉】「取出现最多的域名」是产品承诺
    // （README「取这批标签里出现最多的域名」）——
    // 若实现退化成「取第一个」，这条承诺就空了，而**看起来完全正常**
    // （大多数会话的第一个域名恰好就是最多的那个）。
    const name = deriveImportedGroupName(
      [
        'https://first.example.com/a',
        'https://major.example.com/b',
        'https://major.example.com/c',
      ].map((url, i) => ({
        id: `t${i}`,
        url,
        title: url,
        favicon: '',
        createdAt: NOW,
        lastAccessed: NOW,
        pinned: false,
      })),
      0
    );

    assert.equal(
      name,
      'major.example.com',
      '主导域名不是出现最多的那个 —— 「取出现最多的域名」这条承诺落空了'
    );
  });
});

describe('OneTab 组数 ⑥ 界面报的数必须与解析器一致', () => {
  /**
   * 【为什么这条独立】F-5 审计建立的契约是
   * 「source = imported + skippedExisting + 内容有问题」**恒成立**。
   * 而 `source` 的语义是「文件里有多少个会话」——
   * ⇒ 它必须是**解析器真实的组数**。
   *
   * 此前 UI 自己又数了一遍（`split('\n\n')`），而解析器用 `split(/\n\s*\n/)`
   * ⇒ 两条规则不同 ⇒ 数字对不上。
   *
   * **Windows 换行是重灾区**：`\r\n\r\n` 是 OneTab 在 Windows 上的默认导出格式，
   * 而 `split('\n\n')` 数出来是 1，解析器数出来是 2
   * ⇒ 界面弹「文件内共 1 个会话，成功导入 2 个」—— **自相矛盾**，
   * 用户会以为导入坏了。
   */
  const CASES: [string, string][] = [
    ['普通两个换行', 'https://a.com/1 | A\n\nhttps://b.com/2 | B'],
    ['三个换行', 'https://a.com/1 | A\n\n\nhttps://b.com/2 | B'],
    ['换行 + 空格 + 换行', 'https://a.com/1 | A\n \nhttps://b.com/2 | B'],
    ['含空格的空行', 'https://a.com/1 | A\n   \nhttps://b.com/2 | B'],
    ['Windows 换行', 'https://a.com/1 | A\r\n\r\nhttps://b.com/2 | B'],
    ['行尾空白', 'https://a.com/1 | A\n\nhttps://b.com/2 | B\n\n'],
    ['单组', 'https://a.com/1 | A'],
  ];

  for (const [label, text] of CASES) {
    it(`组数一致：${label}`, async () => {
      const { parseOneTabFormat, countOneTabGroups } = await import('@/core/oneTabFormatParser');

      assert.equal(
        countOneTabGroups(text),
        parseOneTabFormat(text).length,
        `界面报的组数与解析器解析出的组数不一致（${label}）—— ` +
          '「文件内共 N 个会话」这句话会与「成功导入 M 个」自相矛盾'
      );
    });
  }

  it('UI 不得自己重数（规则只写一处）', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, resolve } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const raw = readFileSync(resolve(ROOT, 'src/components/layout/HeaderDropdown.tsx'), 'utf8');

    // 【先剥掉注释再扫】本文件的头注释里就写着 `text.split('\n\n')` 作为
    // 「此前错在哪」的说明 —— 扫原文会把它当成残留 ⇒ 假红。
    // （这与 tests/guards/storeChangelogStructure.test.ts 剥注释同一口径。）
    const source = raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^\s*\/\/.*$/gm, ' ');

    // UI 里再写一遍切分规则 ⇒ 两条规则迟早会漂移（这次就是这么漂的）。
    assert.doesNotMatch(
      source,
      /split\('\\n\\n'\)/,
      'HeaderDropdown 里又出现了一遍 OneTab 的分组切分 —— ' +
        '规则只写一处（oneTabFormatParser.countOneTabGroups），UI 不重数'
    );
  });
});
