/**
 * 商店上架文案的**诚实度**守卫（2026-10-23，第 43 轮）。
 *
 * ── 这个文件防的具体事故 ──────────────────────────────────────────────────
 *
 * 2026-10-23 主审抓公开页发现：线上 Chrome Web Store 的 Detailed Description
 * 是**旧版**文案，它写着：
 *   · 「分组管理：拖拽整理标签页，自动折叠空分组」—— 而**会话分组/文件夹
 *     早已被产品拍板为「暂缓、明确不做」**（见 docs/audit-2026-10-22-product-director.md
 *     的「减法 #2」；`TabGroup` 类型里**没有** folder/分组字段）。
 *   · 「数据仅在你授权的云端存储（Supabase）」—— 而产品**已经支持自带存储
 *     （WebDAV，不经过我们的服务器）**，线上这句话是**错的**（漏了一个后端）。
 *   · 完全没有提「保存即关闭」—— 这是产品最核心的差异化（保存 = 剪切），
 *     线上文案读起来像个普通的标签备份器。
 *
 * 根因不是「谁写错了字」，而是：**没有任何机制保证线上文案与仓库文案一致**。
 * 仓库里 `CHROMEWEBSTORE.md` 是上架信息的单一事实来源，但它与**线上实际展示**
 * 之间隔着一道人工提交 —— 提交之后过审、上架，仓库改了线上不会自动跟上；
 * 线上过审后仓库也可能还停在旧版本。
 *
 * ── 本守卫能做什么、不能做什么 ────────────────────────────────────────────
 *
 * ✅ 能做：守住**仓库里**的那份文案 —— 不许它宣传产品没有的功能
 *   （「分组管理」「文件夹」），不许它漏掉产品**已实现**的关键能力
 *   （自带存储 / 保存即关闭 / 撤销 / 无数量上限）。
 *   这是**发布前的最后一道闸**：文案写错了，提交前就红。
 *
 * ❌ 不能做：验证**线上**那份。线上是 Google 商店的内容，本仓没有它的写权限，
 *   抓取也不是可靠的判据（页面是动态渲染的，版本状态会自己变）。
 *   ⇒ 线上漂移只能靠**人**定期抓公开页核对（这个动作本轮做过一次，
 *   结果是仓库的「发布状态」那几行过期了）。
 *
 * ── 纪律：钉**不变量**，不钉字面量 ──────────────────────────────────────────
 *
 * 不写「文案里必须出现『自带存储』这四个字」—— 改一次措辞就红。
 * 写的是「**产品支持的后端种类**（从代码里现场数出来）必须**逐一**在文案里
 * 有对应的说法」：加一个后端（第三种），这条守卫会要求文案跟着改；
 * 删一个后端，文案里那句话会变成**吹牛**，守卫会红。
 *
 * 同理，「不许宣传分组」这条钉的是**产品代码里没有 folder 字段**这个事实，
 * 而不是钉某一句中文 —— 将来真做了分组，这条守卫要能自动放行。
 *
 * ── 本守卫的检测力（已实测，2026-10-23）────────────────────────────────────
 *
 * 第一版写完后逐条做了变异测试，结果**两条是零检测力**（守卫始终绿）：
 *   · 「不许宣传分组」—— 判据里的 `groupId` 命中了 `Tab.groupId`（那条标签属于
 *     哪个会话的**归属外键**，不是文件夹）⇒ 判据恒为「有分组」⇒ 永远放行。
 *     改成只认**会话级**的父级/文件夹字段（`productHasFolderConcept()`）。
 *   · 「必须说清保存即关闭」—— 判据 `保存.{0,12}并关闭` 命中的是**快捷键说明**
 *     （「保存整窗并关闭」）⇒ 即便把概念性说明全删掉，守卫仍然绿。
 *     改成只认**概念性**表述（「保存即关闭」「把窗口腾空」「clears the window」…）。
 *
 * 修正后的变异测试（每条都要变红）：
 *   ① 塞入「分组管理：拖拽整理标签页，自动折叠空分组」 ⇒ 红 2 条
 *   ② 塞入「数据仅在你授权的云端存储（Supabase）」      ⇒ 红 1 条
 *   ③ 删掉描述里所有「自带存储 / WebDAV / 自己的云盘」 ⇒ 红 1 条
 *   ④ 删掉「没有数量上限」                              ⇒ 红 1 条
 *   ⑤ 删掉描述里所有「撤销」（中英两侧）                ⇒ 红 1 条
 *   ⑥ 删掉中英两侧的概念性「保存即关闭」表述            ⇒ 红 1 条
 *
 * ⚠️ 写变异测试时踩的坑：**只改一处不够**。文案是中英双语的，英文段落里
 * 也有 "saving is a cut" / "and clears the window" —— 只改中文那一侧，
 * 守卫仍然是绿的（那正是它该绿的原因：英文侧还说着这件事）。
 * ⇒ 变异必须**两侧同时**改，否则测的是「英文还在说」而不是「守卫瞎了」。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const STORE = read('CHROMEWEBSTORE.md');
const TAB_TYPES = read('src/types/tab.ts');

/** 剥掉 HTML 注释：注释里提到旧文案不算「还在宣传」。 */
const stripHtmlComments = (md: string): string => md.replace(/<!--[\s\S]*?-->/g, ' ');

/** Detailed Description 那一段（`---` 分隔的中英文之间）。 */
function detailedDescription(md: string): string {
  const start = md.indexOf('**Detailed Description**');
  assert.ok(start !== -1, 'CHROMEWEBSTORE.md 必须有 Detailed Description 段');
  const body = md.slice(start);
  // 到「数据使用表」或下一个 `**` 标题为止
  const end = body.search(/\n\*\*[A-Za-z]/);
  return end === -1 ? body : body.slice(0, end);
}

/**
 * 产品里**真的**有「会话分组 / 文件夹」这个概念吗？
 *
 * ⚠️ 判据必须**只认会话级**的分组字段，不能拿 `Tab.groupId` 当数 ——
 * `Tab.groupId` 是「这条标签属于哪个会话」的**归属外键**，不是「会话属于哪个文件夹」。
 * 第一版把 `groupId` 列进探测名单，结果：守卫的判据恒为「有分组」⇒
 * 「不许宣传分组」这条**永远放行**（零检测力）—— 正好是它本该防的那类漂移。
 *
 * 判据：会话类型（TabGroup）上有没有**指向另一个会话/文件夹**的字段。
 */
function productHasFolderConcept(): boolean {
  // 只看 TabGroup 这一个接口的字段（Tab 的 group_id / groupId 不算）。
  const m = TAB_TYPES.match(/export interface TabGroup \{([\s\S]*?)\n\}/);
  if (!m) return false;
  const fields = m[1];
  // 「指向父级」或「文件夹 id」⇒ 真的存在分组层级
  return /^\s*(folder|folderId|parentFolderId|parentId)\??\s*:/m.test(fields);
}

describe('商店文案 · 不得宣传产品没有的功能', () => {
  it('不许宣传「会话分组 / 文件夹」—— 除非产品真的有这个字段', () => {
    // 【产品事实】TabGroup 上有没有分组字段？现场看类型定义。
    const hasFolderField = productHasFolderConcept();
    // 【文案事实】文案里有没有把这东西当卖点？
    const claimsFolder = /(分组管理|会话分组|文件夹)/.test(stripHtmlComments(detailedDescription(STORE)));

    if (hasFolderField) {
      // 将来真做了分组 → 这条自动放行（不再要求文案删掉它）
      return;
    }
    assert.ok(
      !claimsFolder,
      '文案宣传了「分组/文件夹」，但 TabGroup 类型里没有这个字段 —— ' +
        '产品已拍板「暂缓、明确不做」。宣传一个不存在的能力 = 骗用户。' +
        '（若产品决定要做，请先加字段再改文案，并同步更新这条守卫的判据来源。）'
    );
  });

  it('不许宣传「自动折叠空分组」—— 除非产品真的有这个行为', () => {
    // 「空会话自动清理」是有的（dropEmptyGroups），但那是**清掉**空会话，
    // 不是「自动折叠空分组」（分组是另一个东西，不存在）。
    const claimsAutoCollapse = /自动折叠/.test(stripHtmlComments(detailedDescription(STORE)));
    const hasFolderField = productHasFolderConcept();
    assert.ok(
      !claimsAutoCollapse || hasFolderField,
      '文案承诺「自动折叠空分组」，但产品没有分组概念（也没有这个字段）'
    );
  });
});

describe('商店文案 · 必须说清产品已经实现的关键能力', () => {
  const desc = () => stripHtmlComments(detailedDescription(STORE));

  it('必须说清「保存即关闭」—— 这是产品最核心的差异化，不能只说「保存」', () => {
    // 产品的模型是「保存 = 剪切」（保存后浏览器标签被关掉）。
    // 只写「保存」「打包保存」会让用户以为是**备份**（复制），
    // 于是装上之后第一次用就被「窗口怎么空了」吓一跳。
    //
    // ⚠️ 判据不能只认「保存即关闭」四个字：第一版写成
    // `保存.{0,12}并关闭`，而「保存整窗并关闭」这种**快捷键说明**也命中它 ⇒
    // 即便把「保存即关闭 / 并把窗口腾空」这两处**概念性**说明全删掉，
    // 守卫仍然是绿的 —— 零检测力。
    // 现在要求命中的是**概念性**表述（说清「保存会关掉窗口」这件事本身），
    // 快捷键列表里顺带出现的「并关闭」不算数。
    const d = desc();
    const conceptLevel = [
      /保存即关闭/,
      /并把窗口腾空/,
      /保存.{0,24}(?:关掉|关闭).{0,12}标签页/,
      /(?:关掉|关闭).{0,12}标签页.{0,16}保存/,
      /clears the window/i,
      /saving is a cut/i,
    ];
    assert.ok(
      conceptLevel.some(p => p.test(d)),
      'Detailed Description 必须说清「保存 = 关闭当前窗口的标签页」（保存即关闭）—— ' +
        '只说「保存」会被理解成备份，用户第一次用就会以为产品坏了。' +
        '（判据只认概念性表述：快捷键列表里顺带出现的「并关闭」不算。）'
    );
  });

  it('产品支持的后端，每一种都必须在文案里出现', () => {
    // 【产品事实】从代码现场数出支持哪些后端 —— 不写死清单。
    const backends = new Set<string>();
    if (/supabase/i.test(read('src/sync-backend/supabaseAdapter.ts'))) backends.add('supabase');
    if (/webdav/i.test(read('src/sync-backend/webdav/adapter.ts'))) backends.add('webdav');

    assert.ok(backends.size > 0, '应至少能从一个后端适配器里认出来');

    const d = desc();
    for (const b of backends) {
      if (b === 'supabase') {
        assert.ok(/TapStack 云端|云端账号|Supabase/i.test(d), '文案必须提到云端后端');
      } else if (b === 'webdav') {
        assert.ok(
          /自带存储|WebDAV|自己的云盘/.test(d),
          '产品支持自带存储（WebDAV，不经过我们的服务器），文案必须说到它 —— ' +
            '漏掉它等于把「数据只在我们的服务器」当成唯一可能，而那句话对自带存储用户是**错的**'
        );
      }
    }
  });

  it('不许说「数据仅在 Supabase / 只在我们的服务器」这种一刀切的话', () => {
    // 这句话对用自带存储的用户是**假的**（他们的数据根本不经过我们的服务器）。
    const d = desc();
    assert.ok(
      !/数据仅在.{0,20}Supabase|仅存储在.{0,20}Supabase/.test(d),
      '不许写「数据仅在 Supabase」—— 产品支持自带存储（WebDAV），数据可以不经过我们的服务器。' +
        '一刀切的措辞对自带存储用户是假话。'
    );
  });

  it('必须说清「没有数量上限」—— 否则会被当成试用版', () => {
    // 竞品（OneTab 等）按数量收费，商店页读者第一反应是「这个免费版能存几个」。
    const d = desc();
    assert.ok(
      /没有数量上限|不限数量|想存多少存多少|无数量限制/.test(d),
      'Detailed Description 必须写明「没有数量上限」—— ' +
        '否则读者默认这是试用版（竞品正是按数量收费的）'
    );
  });

  it('必须说清「恢复即消费」以及它有退路（撤销）', () => {
    // 「恢复后会话就没了」是产品最反直觉、也最需要提前讲清的规则；
    // 而 1.24.1 之后它有退路（撤销），这正是本产品的成熟度证明。
    const d = desc();
    assert.ok(
      /恢复后即从列表移除|恢复后即消费|恢复.*从列表移除|移除.*锁定.*保留/.test(d),
      'Detailed Description 必须说清「恢复一个未锁定的会话 = 它从列表里消失」（消费语义）—— ' +
        '用户不知道这件事会以为数据丢了'
    );
    assert.ok(
      /撤销/.test(d),
      'Detailed Description 必须提到「撤销」—— 恢复即消费是删除，必须有一条退路，' +
        '这也是与竞品的核心差异'
    );
  });
});

describe('商店文案 · 发布状态不能只靠人工台账', () => {
  it('必须标注「发布状态以公开页为准」的提示', () => {
    // 2026-10-23 实测：仓库里写「线上还是 1.24.1、1.25.1 在审核队列」，
    // 而公开页早已显示 1.25.1 ⇒ 台账漂了。漂了之后没人知道。
    // 守卫要求：文档里必须写明「发布状态只能靠抓公开页确认」。
    assert.ok(
      /公开页|公开商店页/.test(STORE) && /(以公开页为准|只能靠抓公开页|不要相信本表|抓公开页)/.test(STORE),
      'CHROMEWEBSTORE.md 必须写明「发布状态要以公开页为准，不能相信本表」—— ' +
        '2026-10-23 实测：人工台账的「线上版本」漂了（写着 1.24.1，线上已是 1.25.1）'
    );
  });
});
