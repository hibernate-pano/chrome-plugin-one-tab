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
// ── 这个文件守四半 ────────────────────────────────────────────────────────
//
// ① **静态半**：本地隐私政策必须覆盖 manifest 的**当前**权限集合
//    （含「已移除的权限不得再出现」这一条**反向**断言）。
//    这半不需要网络，任何时候都能跑。
//
// ② **在线半**（有网络才跑）：线上那份必须与仓库里的**关键事实**一致。
//    没网就跳过，**不假装通过**；但**404 是事故、不是「没网」** ——
//    服务器明确回答「没有」必须判红（2026-10-21 线上真 404 时，
//    旧写法把它当没网静默 skip，事故当时没有任何东西报警）。
//
// ③ **离线半**：同一套判据对**真实旧版快照**必须变红 ——
//    用来验证判据本身的检测力（「现在绿」不等于「它能变红」）。
//
// ④ **产物半**（L-13d）：**真的跑一遍** scripts/build-legal-site.mjs，
//    断言「部署产物 = 仓库里的隐私政策」且「产物里只有它一个文件」。
//    这半守的是「仓库 → 线上」那一段接缝的**前半**（构建这一步）；
//    在线的②守后半。缺了它，构建脚本写错了要等下一次部署才发现。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const PRIVACY = read('src/legal/privacy.html');
const STORE = read('CHROMEWEBSTORE.md');
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

    // 【下限不写死某一天，也不去查 git 历史】
    // 写死的下限（如 '2026-10-20'）有个隐蔽的失效模式：它只会在**改小**时报警，
    // 日期往前走之后它就永远成立、逐渐变成一句废话 —— 于是「这次改了隐私政策
    // 却忘了更新日期」这个真正要拦的失误，反而没人拦。
    // 也不查 git 历史：CI 是浅克隆（actions/checkout@v4 默认 depth=1），
    // 「最近一次改过该文件的日期」在浅克隆里取不到 —— 判据不能依赖它拿得到。
    //
    // 改用**仓库内的第二个记录点**：CHROMEWEBSTORE.md 的注释里标注了
    // 「privacy.html（最后更新 YYYY-MM-DD）」，那处标注是**独立写下的第二份记录**
    // （改了 privacy.html 却忘了改它，也是一种漂移，下面另有断言守）。
    // 用它当下限 ⇒ 两处日期必须同时推进，且不依赖任何外部环境。
    const store = STORE.match(/privacy\.html（最后更新 (\d{4}-\d{2}-\d{2})）/);
    assert.ok(store, 'CHROMEWEBSTORE.md 必须标注 privacy.html 的最后更新日期');
    assert.ok(
      m[1] >= store[1],
      `privacy.html 写「最后更新：${m[1]}」，而 CHROMEWEBSTORE.md 把它标成 ` +
        `${store[1]} —— 两处对不上，说明这次改动没有同步更新日期，` +
        '读者会以为看到的是最新版本。'
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
 *
 * 【「最后更新日期」为什么是动态的，而不是写死某一天】
 * 它守的是「**线上那份的日期 = 仓库那份的日期**」，不是「线上必须是某一天」。
 * 写死日期会有两个后果：① 每次改隐私政策都要手动改这个针脚，忘了就红；
 * ② 更糟的是**日期一改，线上与仓库的其余 7 条事实全部不再被检查** ——
 * 因为 `missing` 是用 `live.includes(needle)` 算的，日期针脚失配只说明
 * 「这一条缺」，但若哪天有人把整份清单重写成只剩日期那条，
 * 守卫照样绿 ⇒ 事实检查被偷换成日期检查。
 * ⇒ 从仓库动态取，日期改了自动跟上，且其余事实始终在查。
 */
const repoLastUpdated = (): string => {
  const m = PRIVACY.match(/最后更新：(\d{4}-\d{2}-\d{2})/);
  assert.ok(m, 'privacy.html 必须标注「最后更新：YYYY-MM-DD」');
  return m[1];
};

const facts = (): Array<{ label: string; needle: string }> => [
  { label: '最后更新日期', needle: `最后更新：${repoLastUpdated()}` },
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
   * 抓线上那份，**区分三种结果**。
   *
   * 【为什么必须区分「拿不到」与「拿到了但是坏的」】───���─────────────────────
   * 2026-10-21 实测踩到的：线上 404（部署被 Git 联动的自动部署顶掉了）
   * 时，这个函数返回 null（因为 `!res.ok`），于是测试**静默 skip** ——
   * 线上已经整个打不开，输出里却只有一行 skip，看着像「环境问题，算了」。
   *
   * 而线上这个地址**不是可选的**：商店的 Privacy Policy URL 指向它，
   * 审核员点开的就是它。它 404 ⇒ 商店页面里那个链接是死的。
   * 这属于**必须报警**，不能归入「没网」。
   *
   * 三态：
   *   · `ok`      —— 拿到了正文，继续逐条核对事实
   *   · `notFound`—— 服务器明确回答「没有」⇒ **判红**（线上坏了）
   *   · `offline` —— 真的连不上（DNS/网络/超时）⇒ 跳过（环境问题）
   *
   * 「拿不到」与「拿到了但是坏的」必须分开 —— 前者是环境，后者是事故。
   */
  const fetchLive = async (): Promise<
    { kind: 'ok'; body: string } | { kind: 'notFound'; status: number } | { kind: 'offline' }
  > => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(LIVE_URL, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.status === 404) return { kind: 'notFound', status: 404 };
      if (!res.ok) return { kind: 'notFound', status: res.status };
      return { kind: 'ok', body: await res.text() };
    } catch {
      return { kind: 'offline' };
    }
  };

  it('线上那份必须存在（404 = 商店的隐私政策链接是死的）', async t => {
    const r = await fetchLive();
    if (r.kind === 'offline') {
      t.skip('连不上线上（无网络）—— 本条未验证');
      return;
    }
    assert.notEqual(
      r.kind,
      'notFound',
      `线上隐私政策（${LIVE_URL}）返回 HTTP ${r.kind === 'notFound' ? r.status : ''} —— ` +
        '商店的 Privacy Policy URL 指向这个地址，它打不开 ⇒ 商店页面上的链接是死的，' +
        '审核员点开会看到 404。' +
        '常见原因：Vercel 项目的 Git 集成在 push 后自动部署，' +
        '把生产 alias 抢给了别的东西（2026-10-21 就发生过：自动部署服务的是扩展产物 dist/，' +
        '里面没有 privacy.html）。'
    );
  });

  it('线上那份不得落后于仓库（关键事实逐条核对）', async t => {
    const r = await fetchLive();
    if (r.kind === 'offline') {
      t.skip('连不上线上（无网络）—— 本条未验证');
      return;
    }
    assert.equal(r.kind, 'ok', `线上隐私政策（${LIVE_URL}）不可用 —— 详见上一条断言`);
    const live = r.body;
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
    const r = await fetchLive();
    if (r.kind === 'offline') {
      t.skip('连不上线上（无网络）—— 本条未验证');
      return;
    }
    assert.equal(r.kind, 'ok', `线上隐私政策（${LIVE_URL}）不可用 —— 详见「线上那份必须存在」那条`);
    assert.doesNotMatch(
      r.body,
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

/**
 * ── 离线也能验的那一段：仓库 → 部署产物 ──────────────────────────────────
 *
 * 【为什么需要这一段】──────────────────────────────────────────────────────
 * 上面 L-13b 守的是「**线上**那份 = 仓库那份」。但线上那份是从哪来的？
 * 2026-10-21 实测发现真相：Vercel 项目**连着 Git 集成**，每次 push 都会
 * 自动部署 —— 而自动部署服务的是**扩展的构建产物 dist/**（含 manifest.json、
 * popup.html，却没有 privacy.html）⇒ 线上 /privacy.html 直接 404，
 * **商店登记的隐私政策 URL 打不开**。
 *
 * ⇒ 「仓库 → 线上」这段接缝上，需要有东西守着「部署产物是什么」。
 * 本段**真的跑一遍** scripts/build-legal-site.mjs，然后断言：
 *   ① 产物里的 privacy.html 与 src/legal/privacy.html **逐字一致**；
 *   ② 产物里**只有**这一个文件（多出来的文件 = 线上多了一页没人知道）。
 *
 * 【为什么能离线跑】不碰网络、不碰 Vercel —— 只跑本地构建脚本。
 * 于是「构建脚本写错了」在 CI 里就会变红，而不是等下一次部署才发现线上是错的。
 */
describe('L-13d 部署产物必须与仓库逐字一致（离线：真的跑一遍构建脚本）', () => {
  const OUT_DIR = resolve(ROOT, 'dist-legal-site');

  it('跑一遍构建脚本，产物必须与 src/legal/privacy.html 逐字一致', () => {
    // 用子进程跑，而不是 import —— 脚本里有顶层副作用（重建产物目录），
    // import 会让「跑脚本」这件事发生在测试模块加载期，顺序不可控。
    const res = spawnSync(process.execPath, [resolve(ROOT, 'scripts/build-legal-site.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.equal(
      res.status,
      0,
      `构建脚本跑失败了：\n${res.stdout ?? ''}\n${res.stderr ?? ''}`
    );

    const built = readFileSync(resolve(OUT_DIR, 'privacy.html'), 'utf8');
    assert.equal(
      built,
      PRIVACY,
      '部署产物里的 privacy.html 与 src/legal/privacy.html 不一致 —— ' +
        '线上那份会与仓库不同 ⇒ 本地改对了但线上没改。'
    );
  });

  it('部署产物里**只有** privacy.html（多出来的文件 = 线上多了一页没人知道）', () => {
    // 先确保产物存在（上一条已经跑过脚本；这里再跑一次以免依赖测试顺序）
    spawnSync(process.execPath, [resolve(ROOT, 'scripts/build-legal-site.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const files = readdirSync(OUT_DIR).sort();
    assert.deepEqual(
      files,
      ['privacy.html'],
      `部署产物里应当只有 privacy.html，实际是：${files.join('、')} —— ` +
        '多出来的文件会被一起发布到线上（审核员看得到），' +
        '而扩展的构建产物（manifest.json / popup.html）绝不该出现在这里。'
    );
  });

  it('vercel.json 必须指向这个构建脚本（否则线上服务的是别的东西）', () => {
    const vcfg = JSON.parse(read('vercel.json')) as {
      buildCommand?: string;
      outputDirectory?: string;
    };
    assert.match(
      vcfg.buildCommand ?? '',
      /build-legal-site\.mjs/,
      'vercel.json 的 buildCommand 必须跑 scripts/build-legal-site.mjs —— ' +
        '这正是 2026-10-21 线上 404 的根因：Vercel 项目连着 Git 集成，' +
        'push 后自动部署会去跑项目配置里的构建命令；' +
        '那个命令曾经指向已删除的 build:web，后来被清空成「跑默认构建」⇒ ' +
        '服务的是扩展产物 dist/，里面没有 privacy.html。'
    );
    assert.equal(
      vcfg.outputDirectory,
      'dist-legal-site',
      'vercel.json 的 outputDirectory 必须是 dist-legal-site（构建脚本的产物目录）'
    );
  });
});
