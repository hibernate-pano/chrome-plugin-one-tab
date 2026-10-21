// 隐私政策必须覆盖 manifest 的**当前**状态（2026-10-20 L-13）。
//
// ── 这个文件要防的具体事故 ────────────────────────────────────────────────
//
// 2026-10-20 实测发现：仓库里的 `src/legal/privacy.html` 早已更新到
// 2026-10-20（IndexedDB、WebDAV、自带存储都在），但**线上那份**
// （`https://tapstack-two.vercel.app/privacy.html`）还停在 **2026-09-29**。
//
// 线上那份说的是：
//   · 「会话数据默认保存在您浏览器的 **chrome.storage** 中」
//     —— 早就搬到 IndexedDB 了（1.22.8 起）；
//   · 权限列表写着 `storage`、**`unlimitedStorage`**
//     —— `unlimitedStorage` 已在 1.25.1 **移除**，线上还在说它；
//   · **完全没有**「自带存储（WebDAV）」这一整节
//     —— 包括它的可选主机权限、加密方式、manifest 明文面；
//   · alarms 只说「定时在后台检查」，没说默认关闭、没说延迟上传；
//   · §3 说「不向任何第三方出售、出租**或共享**」+「唯一的第三方是 Supabase」
//     —— 与商店数据表的「Shared with Third Parties: Yes（带接收方说明）」口径不同。
//
// 后果不是「文档旧了一点」：**审核员按线上那份核对 manifest，会看到
// 一个已移除的权限、看不到一个已存在的可选权限、看到与数据表矛盾的表述**
// ⇒ 披露不实，是会被拒审的。
//
// ── 根因 ──────────────────────────────────────────────────────────────────
//
// 前面所有守卫读的都是**仓库里的文件**。
// 于是有一条**没人守的接缝**：本地改对了 ⇒ 守卫全绿 ⇒ **线上仍然是错的**。
// 「文档 = 行为」这条纪律此前只覆盖了「仓库内部」，没覆盖「仓库 → 线上」。
//
// ── 这个文件守两半 ────────────────────────────────────────────────────────
//
// ① **静态半**：本地隐私政策必须覆盖 manifest 的**当前**权限集合
//    （含「已移除的权限不得再出现」这一条**反向**断言）。
//    这半不需要网络，任何时候都能跑。
//
// ② **在线半**（可选、有网络才跑）：线上那份必须与仓库里的**关键事实**一致。
//    没网就跳过，**不假装通过**。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const PRIVACY = read('src/legal/privacy.html');
const MANIFEST = JSON.parse(read('manifest.json')) as {
  version: string;
  permissions: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
};

/**
 * 已被移除的权限 —— **反向**断言用。
 *
 * 为什么要记「移除过什么」：正向断言（manifest 里有的必须被披露）只能守住
 * 「**新增**的权限别忘了写」。而「**删掉**的权限还留在文档里」是反向的：
 * manifest 里没有了 ⇒ 正向断言全部通过 ⇒ 文档照样写着它 ⇒ 线上照样被审核员抓到。
 *
 * `unlimitedStorage` 是真实案例：会话数据早已搬到 IndexedDB（该权限对
 * IndexedDB 本来就无效，1.25.1 已移除），而线上那份政策一直列着它。
 */
const REMOVED_PERMISSIONS: ReadonlyArray<{ name: string; since: string }> = [
  { name: 'unlimitedStorage', since: '1.25.1' },
];

describe('L-13a 隐私政策必须覆盖 manifest 的当前权限（静态半）', () => {
  it('manifest 声明的每一个权限都必须被隐私政策逐项披露', () => {
    for (const perm of MANIFEST.permissions) {
      assert.ok(
        PRIVACY.includes(perm),
        `隐私政策未披露 manifest 的权限「${perm}」——商店「权限说明」要求逐项披露`
      );
    }
    for (const perm of MANIFEST.host_permissions ?? []) {
      assert.ok(
        PRIVACY.includes(perm),
        `隐私政策未披露 manifest 的主机权限「${perm}」`
      );
    }
  });

  it('**已移除**的权限不得再出现在隐私政策里（反向断言）', () => {
    for (const { name, since } of REMOVED_PERMISSIONS) {
      assert.doesNotMatch(
        PRIVACY,
        new RegExp(`<code>${name}</code>|${name}`),
        `权限「${name}」已在 ${since} 移除（会话数据在 IndexedDB 里，` +
          `该权限对它本来就无效），隐私政策却还在列它 —— ` +
          '审核员按线上那份核对 manifest，会看到一个已不存在的权限。'
      );
    }
  });

  it('可选主机权限必须在隐私政策里被说明（自带存储要用）', () => {
    const optional = MANIFEST.optional_host_permissions ?? [];
    assert.ok(optional.length > 0, 'manifest 应当声明了可选主机权限');
    assert.match(
      PRIVACY,
      /可选主机权限/,
      '隐私政策必须说明可选主机权限的存在与申请条件'
    );
    assert.match(
      PRIVACY,
      /自己填写的那个地址|单一来源/,
      '必须说清运行时只申请用户填的那一个 origin'
    );
  });

  it('隐私政策里的「最后更新」不得早于本轮改动过的日期', () => {
    const m = PRIVACY.match(/最后更新：(\d{4}-\d{2}-\d{2})/);
    assert.ok(m, '隐私政策必须写「最后更新：YYYY-MM-DD」');
    assert.ok(
      m[1] >= '2026-10-20',
      `隐私政策的最后更新日期是 ${m[1]}，但本轮（2026-10-20）实质改过它 —— ` +
        '日期不更新，读者会以为看到的是最新版本。'
    );
  });
});

/**
 * 「线上必须与仓库一致」的可判定事实清单。
 *
 * 【为什么是「事实」而不是「全文相等」】全文相等会把 HTML 的一点点
 * 格式变化也判成红（换行、缩进），而那些不是我们要守的东西。
 * 我们要守的是**审核员会核对的那些事实**：权限清单、存储位置、
 * 明文面、限定条件。⇒ 钉事实，不钉字节。
 *
 * 【为什么提到模块级】下面的 L-13c 要用**同一套**判据去验「判据本身的检测力」
 * —— 两处各写一份清单，就可能出现「在线那条用 8 条、离线那条用 5 条」，
 * 于是离线那条验的不是在线那条 ⇒ 验证了个寂寞。
 */
const facts = (): Array<{ label: string; needle: string }> => [
  { label: '最后更新日期', needle: '最后更新：2026-10-20' },
  { label: '会话数据在 IndexedDB（不是 chrome.storage）', needle: 'IndexedDB' },
  { label: '自带存储（WebDAV）这一节', needle: '自带存储（WebDAV）' },
  { label: 'manifest 的明文面', needle: '明文头部' },
  { label: '「开启同步之前」这个限定', needle: '在您开启同步之前' },
  { label: '界面偏好设置会被上传', needle: '界面偏好设置' },
  { label: '四个右键菜单项', needle: '保存其他标签并关闭' },
  { label: 'alarm 的 30 秒下限', needle: '30 秒' },
];

describe('L-13b 线上隐私政策必须与仓库一致（在线半，没网就跳过）', () => {
  const LIVE_URL = 'https://tapstack-two.vercel.app/privacy.html';

  /**
   * 抓线上那份。没网 / 超时 / 非 200 ⇒ 返回 null。
   *
   * 【为什么不 fail】这条断言依赖外网，而 CI 与本地都可能没有网。
   * 把「没网」判成失败会制造**假红**，而假红会让人习惯性忽略红 ⇒
   * 真出事那天没人看。
   * 但「没网」也不能算**通过** —— 所以用 `t.skip()` 显式标成 skipped，
   * 输出里看得到「这条没验」，而不是混在 pass 里。
   */
  const fetchLive = async (): Promise<string | null> => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(LIVE_URL, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  };

  it('线上那份不得落后于仓库（关键事实逐条核对）', async t => {
    const live = await fetchLive();
    if (live === null) {
      t.skip('拿不到线上隐私政策（无网络或非 200）—— 本条未验证');
      return;
    }
    const missing = facts().filter(f => !live.includes(f.needle)).map(f => f.label);
    assert.deepEqual(
      missing,
      [],
      `线上隐私政策（${LIVE_URL}）落后于仓库，缺这 ${missing.length} 项：${missing.join('、')}。` +
        '商店的隐私政策 URL 指向线上那份，审核员看的就是它 —— ' +
        '本地改对了但没部署，等于没改。'
    );

    // 反向：已移除的权限不得出现在线上那份。
    for (const { name, since } of REMOVED_PERMISSIONS) {
      assert.ok(
        !live.includes(name),
        `线上隐私政策仍写着已移除（${since}）的权限「${name}」`
      );
    }
  });

  it('线上那份不得出现「不共享」与商店数据表（Shared with Third Parties: Yes）矛盾的口径', async t => {
    const live = await fetchLive();
    if (live === null) {
      t.skip('拿不到线上隐私政策（无网络或非 200）—— 本条未验证');
      return;
    }
    assert.doesNotMatch(
      live,
      /不向任何第三方出售、出租或共享/,
      '线上那份说「不出租或共享」，而商店数据表如实写了接收方 Supabase —— ' +
        '两处口径必须一致（详见 docsAlignment 的 C-12）。'
    );
  });
});

/**
 * ── 离线也能验的那一半：把**真实抓到的旧版**钉进仓库 ──────────────────────
 *
 * 【为什么必须存快照】上面那条在线断言依赖外网，且它验的是「线上此刻的样子」——
 * 而**线上此刻已经是对的**（本轮刚部署过），于是这条断言永远绿，
 * 它的**检测力从未被验证过**。
 *
 * 本仓反复吃过的亏正是这个：**「现在绿」不等于「它能变红」**。
 * 所以把 2026-09-29 那份**线上真实快照**存成 fixture，
 * 用它当**反例**跑一遍同样的判据 —— 判据必须对它变红。
 * 这就让「检测力」本身变成可回归的东西，而不是靠信任。
 *
 * 这份快照是**真实抓取**的（2026-10-20 curl 生产 URL 所得），不是手写构造的
 * —— 手写的「旧版」可能比真实的旧版更旧或更新，验出来的东西不一样。
 */
describe('L-13c 在线判据的检测力本身必须被验证（离线，用真实旧版快照）', () => {
  const STALE = read('tests/fixtures/privacy-live-2026-09-29.html');

  it('这份快照确实是 2026-09-29 那份（否则它证明不了任何事）', () => {
    assert.match(STALE, /最后更新：2026-09-29/, '快照的日期不对');
    assert.match(STALE, /unlimitedStorage/, '快照应当含已移除的权限');
    assert.doesNotMatch(STALE, /自带存储（WebDAV）/, '快照应当没有 WebDAV 那一节');
  });

  it('同一套判据对这份真实旧版**必须变红**（否则在线断言是空的）', () => {
    const missing = facts().filter(f => !STALE.includes(f.needle)).map(f => f.label);
    assert.ok(
      missing.length >= 6,
      `这份真实旧版只缺 ${missing.length} 项（${missing.join('、')}）—— ` +
        '判据对真实旧版的检出力度不够，在线那条断言可能是空的。' +
        '事实清单必须覆盖旧版与新版之间**每一处**实质差异。'
    );
    for (const { name, since } of REMOVED_PERMISSIONS) {
      assert.ok(
        STALE.includes(name),
        `快照里应当含已移除的权限「${name}」（${since} 移除）—— 否则反向断言没被验证过`
      );
    }
    assert.match(
      STALE,
      /不向任何第三方出售、出租或共享/,
      '快照里应当含「不共享」那句矛盾口径 —— 否则那条断言没被验证过'
    );
  });
});
