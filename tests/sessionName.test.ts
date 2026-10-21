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
// ③ 取不到域名时回落到时间戳（不给空名字，也不破坏既有行为）。
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
// 2. 取不到域名时必须回落时间戳（不能给空名字）
// ─────────────────────────────────────────────────────────────────────────

test('deriveSessionNameFromChromeTabs 没有可解析的 URL 时回落到时间戳', () => {
  assert.equal(
    deriveSessionNameFromChromeTabs([tab('not-a-url')], now),
    '标签组 5月11日 08:09'
  );
});

test('deriveSessionNameFromChromeTabs 内部页/扩展页不贡献域名', () => {
  assert.equal(
    deriveSessionNameFromChromeTabs(
      [tab('chrome://settings'), tab('chrome-extension://abc/options.html')],
      now
    ),
    '标签组 5月11日 08:09'
  );
});

test('deriveSessionNameFromChromeTabs localhost 与裸 IP 不贡献域名', () => {
  // 显示 "localhost" 是噪声；显示 127.0.0.1 更是 —— 它们都不是用户
  // 记忆工作现场时用的名字。
  assert.equal(
    deriveSessionNameFromChromeTabs(
      [tab('http://localhost:3000/app'), tab('http://127.0.0.1:8080/x')],
      now
    ),
    '标签组 5月11日 08:09'
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
