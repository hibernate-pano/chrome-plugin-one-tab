// 会话默认名的**唯一档位**：保存时刻的时间戳（2026-10-25 产品定案）。
//
// ── 规则是什么 ─────────────────────────────────────────────────────────────
//
//   保存 ⇒ 名字 = **保存那一刻**（`2026-10-25 14:30`）。
//
//   **没有例外**：不按域名、不按页面标题、不按「这批标签来自哪个网站」。
//
//   （中途加过一条「这批标签全都来自同一个网站 ⇒ 用网站名」的例外，
//   2026-10-25 由产品负责人**推翻** —— 那条例外本身也是「猜」：
//   它说的是**内容**的事实（「这批标签来自 github」），
//   却挂在**这次保存**的名字上（看起来像在说「这个会话是关于 github 的」）。
//   ⇒ 现在名字只说一件**我们真知道**的事：**什么时候存的**。
//   站点身份并没有丢 —— 标签行右侧本来就显示着每个标签的域名。
//
// 为什么不是「取出现次数最多的域名」（旧口径）：那是**猜**。3 个 github +
// 2 个 figma 时它会叫这个会话 `github.com` —— 而它其实是「github 上的那个
// figma 设计稿」，一半对一半不对。猜出来的名字会被当成事实钉在卡片上，
// 而改名的入口藏在菜单里。
//
// 为什么不是「有意义的标题当名字」（更旧的口径）：标题是**一次性**的
// （同一个工作现场第二次保存时标题变了 ⇒ 名字就变了 ⇒ 找回时对不上）。
//
// ── 这个文件守什么 ─────────────────────────────────────────────────────────
//
// ① 时间戳的**格式**（零填充的 `YYYY-MM-DD HH:mm`，不带秒）。
// ② 时间戳的**字典序 == 时间序** ⇒「按名称」排序顺带就是按时间排序。
// ③ 解析不出时间时给一个**非空**名字（卡片标题不能空着）。
// ④ **不带秒**：同一分钟里存两次就是两个同名会话 —— 这是刻意的取舍。
//
// 【「没有例外」这件事本身由 `tests/guards/sessionNaming.test.ts` 守】——
// 那一条必须**真的调用保存路径**（factory）才能证明：
// 同站 / 跨站 / 无域名 / 有标题 / 空列表 —— 一律是时间戳。
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTimestampSessionName } from '../src/domain/tabGroup/sessionName.ts';

// 用本地时区构造固定时间，断言与机器时区无关
const now = new Date(2026, 4, 11, 8, 9).toISOString();
const TIMESTAMP_NAME = '2026-05-11 08:09';

// ─────────────────────────────────────────────────────────────────────────
// 0. 时间戳格式
// ─────────────────────────────────────────────────────────────────────────

test('buildTimestampSessionName 用零填充的 `YYYY-MM-DD HH:mm`（不带秒）', () => {
  assert.equal(buildTimestampSessionName(now), TIMESTAMP_NAME);
  assert.equal(buildTimestampSessionName(new Date(2026, 0, 2, 3, 5).toISOString()), '2026-01-02 03:05');
});

test('buildTimestampSessionName 时间戳解析不出来时给一个非空名字', () => {
  // 不许给空串（卡片标题会空着，用户什么也看不到）
  assert.equal(buildTimestampSessionName('not-a-date'), '未命名会话');
});

test('时间戳的字典序 == 时间序（⇒「按名称」排序顺带就是按时间排序）', () => {
  // 旧格式「标签组 10月25日 14:30」按字典序把 10 月排在 9 月**后面**
  // （"1" < "9"）⇒ 按名称排序会乱。零填充格式没有这个问题。
  const earlier = buildTimestampSessionName(new Date(2026, 8, 20, 9, 0).toISOString());
  const later = buildTimestampSessionName(new Date(2026, 9, 25, 14, 30).toISOString());
  assert.ok(earlier < later, `${earlier} 应当排在 ${later} 前面`);
  assert.ok(earlier.startsWith('2026-09-'), '月份必须零填充');
});

test('不写秒：同一分钟里存两次 ⇒ 同名（写秒只是更长的噪声）', () => {
  // 同一分钟内两次保存 ⇒ 两个同名会话。
  // 这是**刻意**的取舍：名字要短、要在卡片上只占一行，
  // 而「同一分钟存两次」本来就是同一个工作现场的两次保存。
  const a = buildTimestampSessionName(new Date(2026, 9, 25, 14, 30, 1).toISOString());
  const b = buildTimestampSessionName(new Date(2026, 9, 25, 14, 30, 59).toISOString());
  assert.equal(a, b);
  assert.equal(a, '2026-10-25 14:30');
});

test('跨月跨年都要正确进位（月份/日期/小时/分钟各自都是两位）', () => {
  assert.equal(buildTimestampSessionName(new Date(2025, 11, 31, 23, 59).toISOString()), '2025-12-31 23:59');
  assert.equal(buildTimestampSessionName(new Date(2026, 0, 1, 0, 0).toISOString()), '2026-01-01 00:00');
});
