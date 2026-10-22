// 会话默认名的推导（2026-10-20 审计 A-16）。
//
// ── 为什么这条值得单独守 ───────────────────────────────────────────────────
// 产品的承诺是「保存 → 之后找回」（README:26-28）。而「找回」这一步此前
// 没有任何产品级支撑：默认名只有时间戳，保存时也不能命名。
// 攒到 20 个会话，列表就是一列「标签组 9月12日 19:51」——
// 用户必须靠搜索，而搜索要能命中，前提是标题与 URL 还在。
//
// 于是「这是哪个工作现场」的唯一线索被丢弃在域名里，从不出现在列表上。
// 现在默认名从内容派生（域名），把线索放回用户真正会看的那一格。
//
// 判定依据（回归时按这三条）：① 域名取出现次数最多的那个；
// ② 并列时取最先出现的（结果稳定，不随标签顺序抖动）；
// ③ 取不到域名时回落到**有意义的标题**，再取不到才回落时间戳
//    （不给空名字，也不破坏既有行为）。
//
// ── 2026-10-22 审计 U-06：取值链扩了一级 ────────────────────────────────
//
// 旧链：`域名 ?? 时间戳` —— 中间没有别的，域名取不到就直接落时间戳。
// 新链：`域名 → 有意义的标题 → 时间戳`。
//
// 为什么加这一级：内网 / 本地 / 自建服务场景（`localhost:3000`、
// `192.168.1.5`、`[::1]:8080`）以前**全部**落进时间戳兜底 ⇒
// 一屏 10 张卡全是「标签组 10月22日 09:12」「标签组 10月22日 09:47」，
// 连站点身份都没有。现在它们**也**产出主机名（见 hostNamePolicy 守卫），
// 而标题这一级兜住「连主机名都没有」的那一格（`about:blank` + 有意义的标题）。
//
// 本文件守的是**取值链本身**；命名口径的细节（内网主机名的确切形态、
// `pickDominantTab` 的四条契约）在 `tests/guards/sessionNaming.test.ts`。
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTimestampSessionName, deriveSessionNameFromChromeTabs } from '../src/domain/tabGroup/sessionName.ts';

// 用本地时区构造固定时间，断言与机器时区无关
const now = new Date(2026, 4, 11, 8, 9).toISOString();

const tab = (url: string, title = 'Title', pendingUrl?: string) =>
  ({ url, title, pinned: false, pendingUrl } as chrome.tabs.Tab);

test('buildTimestampSessionName uses the short timestamp format without seconds', () => {
  assert.equal(buildTimestampSessionName(now), '标签组 5月11日 08:09');
});

test('buildTimestampSessionName pads minutes and handles invalid dates', () => {
  assert.equal(buildTimestampSessionName(new Date(2026, 0, 2, 3, 5).toISOString()), '标签组 1月2日 03:05');
  assert.equal(buildTimestampSessionName('not-a-date'), '标签组');
});

// ─────────────────────────────────────────────────────────────────────────
// 1. 域名派生
// ─────────────────────────────────────────────────────────────────────────

test('deriveSessionNameFromChromeTabs 取出现次数最多的域名', () => {
  assert.equal(
    deriveSessionNameFromChromeTabs(
      [
        tab('https://github.com/a'),
        tab('https://github.com/b'),
        tab('https://figma.com/design'),
      ],
      now
    ),
    'github.com'
  );
});

test('deriveSessionNameFromChromeTabs 去掉 www. 前缀', () => {
  assert.equal(
    deriveSessionNameFromChromeTabs([tab('https://www.example.com/x')], now),
    'example.com'
  );
});

test('deriveSessionNameFromChromeTabs 并列时取最先出现的那个（结果不随顺序抖动）', () => {
  // 同样是 1 次，必须取第一个 —— 否则同一批标签换个顺序就得到不同的名字，
  // 「重命名后保存」这类操作会看起来像随机行为。
  assert.equal(
    deriveSessionNameFromChromeTabs(
      [tab('https://alpha.com/1'), tab('https://beta.com/2')],
      now
    ),
    'alpha.com'
  );
  assert.equal(
    deriveSessionNameFromChromeTabs(
      [tab('https://beta.com/2'), tab('https://alpha.com/1')],
      now
    ),
    'beta.com'
  );
});

test('deriveSessionNameFromChromeTabs 只有一个域名时就是那个域名', () => {
  assert.equal(
    deriveSessionNameFromChromeTabs([tab('https://github.com/a')], now),
    'github.com'
  );
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 取不到域名时必须回落（不能给空名字）
//
// 【口径变更 2026-10-22 U-06】回落链从「直接落时间戳」变成
// 「有意义的标题 → 时间戳」。所以下面这几条要么给出**空标题**（逼它
// 落到时间戳），要么明确断**标题**这一级 —— 断「域名不贡献」这个事实。
// ─────────────────────────────────────────────────────────────────────────

test('deriveSessionNameFromChromeTabs 没有可解析的 URL 时回落到时间戳', () => {
  // 标题必须是空的：否则新链会取标题当名字（那是**正确**行为，
  // 不是缺陷）。这里要验的是「连标题都没有 ⇒ 落时间戳」。
  assert.equal(
    deriveSessionNameFromChromeTabs([tab('not-a-url', '')], now),
    '标签组 5月11日 08:09'
  );
});

test('deriveSessionNameFromChromeTabs 内部页/扩展页不贡献域名', () => {
  // 断的是「不贡献域名」这个事实：内部页既不产生主机名，
  // 也不该把别的域名稀释成并列。标题留空 ⇒ 名字落回时间戳。
  assert.equal(
    deriveSessionNameFromChromeTabs(
      [tab('chrome://settings', ''), tab('chrome-extension://abc/options.html', '')],
      now
    ),
    '标签组 5月11日 08:09'
  );
});

test('deriveSessionNameFromChromeTabs 没有域名时取首个有意义的标题当会话名', () => {
  // U-06 新增的中间级：连域名都没有（内部页 / about:blank）时，
  // 标题比时间戳有信息量得多 —— 「设计稿评审」比「标签组 5月11日 08:09」强。
  assert.equal(
    deriveSessionNameFromChromeTabs(
      [tab('about:blank', '设计稿评审 - 2026 迭代')],
      now
    ),
    '设计稿评审 - 2026 迭代'
  );
});

test('deriveSessionNameFromChromeTabs 浏览器默认标题不算数（落回时间戳）', () => {
  // 「New Tab」/「新标签页」是**浏览器给的空白页标题**，不含任何站点信息 ——
  // 拿它当会话名，只是把「一屏时间戳」换成「一屏 New Tab」，信息量一样是零。
  for (const title of ['New Tab', '新标签页', '新标签', 'New Tab Page', '']) {
    assert.equal(
      deriveSessionNameFromChromeTabs([tab('about:blank', title)], now),
      '标签组 5月11日 08:09',
      `默认标题「${title}」被当成了会话名`
    );
  }
});

test('deriveSessionNameFromChromeTabs localhost 与裸 IP 用主机名当会话名', () => {
  // U-06 的核心：对自建服务而言，主机名**就是**用户记忆工作现场的方式。
  // 以前这两者都退化成时间戳 ⇒ 一屏内网会话卡长得一模一样。
  assert.equal(
    deriveSessionNameFromChromeTabs(
      [tab('http://localhost:3000/app'), tab('http://127.0.0.1:8080/x')],
      now
    ),
    'localhost:3000',
    '内网会话名退化成了时间戳 —— U-06 没修好'
  );
});

test('deriveSessionNameFromChromeTabs 空标签列表回落到时间戳', () => {
  assert.equal(deriveSessionNameFromChromeTabs([], now), '标签组 5月11日 08:09');
});

test('deriveSessionNameFromChromeTabs 取不到域名时仍用有效的 URL 参与统计', () => {
  // 混合场景：3 个内部页 + 2 个 github ⇒ 域名来自 github，
  // 且内部页不能把 github 稀释成「并列」（内部页根本不计数）。
  assert.equal(
    deriveSessionNameFromChromeTabs(
      [
        tab('chrome://settings'),
        tab('https://github.com/a'),
        tab('chrome://extensions'),
        tab('https://github.com/b'),
        tab('about:blank'),
      ],
      now
    ),
    'github.com'
  );
});

// ─────────────────────────────────────────────────────────────────────────
// 3. 加载中的标签：用 pendingUrl（与 factory 的 resolveStorableUrl 同源）
// ─────────────────────────────────────────────────────────────────────────

test('deriveSessionNameFromChromeTabs 加载中的标签用 pendingUrl 取域名', () => {
  // Chrome 在标签仍在加载时给出 url:'' + pendingUrl:'https://…'。
  // 若这里只看 url，命名就会退回时间戳 —— 恰好是加载中的标签最需要
  // 一个可读名字的时候。
  assert.equal(
    deriveSessionNameFromChromeTabs(
      [{ url: '', pendingUrl: 'https://github.com/x', title: 'PR', pinned: false } as chrome.tabs.Tab],
      now
    ),
    'github.com'
  );
});
