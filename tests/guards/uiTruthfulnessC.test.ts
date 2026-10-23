// C 组：UI 层「说谎 / 不可发现」缺陷的回归守卫（2026-10-18）。
//
// 【本文件要防的回归类别】五条缺陷同属一类：界面要么**声称**了一件没发生的事，
// 要么把功能**藏**到用户无从发现，要么把一次成功的操作做成静默。
//   C1 同步入口：新装扩展默认后端是 supabase，未登录 ⇒ 工具栏整组按钮 return null
//      + 菜单状态卡整块不渲染 ⇒ 新用户完全不知道有同步这回事。
//      ⚠️ 最危险的连带项：放宽渲染而不同步处理 isOverwriteGateOpen 的入参，
//      未登录用户会经历「按钮出现 → 弹窗能开 → 点覆盖两下 → 毫无反应」。
//   C2 设置页 banner：判据只有 `syncBackend === 'webdav'` ⇒ 「已配置但本次会话
//      未解锁」也显示「已启用：数据同步到你自己的云盘」，而同步实际一次都不跑。
//   C3 设置页页首：把「9 项设置在菜单里都有对应入口」写成事实，实际菜单里只有
//      一行「设置…」（2026-10-14 设置已全部搬进独立选项页）。
//   C4 搜索页「恢复所有匹配标签」：全成功时**零反馈**，用户无法确证恢复了几个。
//   C5 PersonalizedWelcome：`{tabCount > 0 && (...)}` 与三条分档文案永不渲染
//      （唯一调用点只在空列表分支，tabCount 恒为 0）。
//
// 【测试形态的现实约束】本仓库没有 jsdom/happy-dom/@testing-library，也不为此装
// 依赖（见 tests/a11yDialogs.test.ts 顶部注释）。所以「行为级测试」的可行形态是：
// 把决策逻辑抽成不依赖 DOM 的**纯函数**（src/components/sync/syncPreviewView.ts、
// src/components/search/restoreAllFeedback.ts）并对其做行为断言；
// 源码字符串断言只作补充护栏，用来钉住「组件真的调用了这些纯函数」。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  WEB_DAV_BANNER_COPY,
  WEB_DAV_BANNER_TONE,
  decideSyncEntry,
  resolveMenuSyncStatus,
  resolveSyncFailureCopy,
  shouldRenderSyncControls,
  syncIdentityCanRun,
  webDavBannerKindOf,
  webDavBannerCopy,
  SYNC_REASON_COPY,
} from '@/components/sync/syncPreviewView';
import type { BackendStatusKind } from '@/components/layout/backendStatus';
import { MENU_LOGIN_LABEL } from '@/components/common/menuLabels';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');
/** 剥注释再断言：注释里提到旧文案不算「界面还这么写」。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** 拼出仓库内绝对路径（用于存在性断言）。 */
const p = (...parts: string[]): string => resolve(ROOT, ...parts);

const SYNC_BUTTON = 'src/components/sync/SyncButton.tsx';
const HEADER_DROPDOWN = 'src/components/layout/HeaderDropdown.tsx';
const WEBDAV_SETTINGS = 'src/components/sync/WebDavSettings.tsx';
const OPTIONS_PAGE = 'src/options/OptionsPage.tsx';
const SEARCH_LIST = 'src/components/search/SearchResultList.tsx';
const TAB_LIST = 'src/components/tabs/TabList.tsx';

const ALL_STATUS_KINDS: BackendStatusKind[] = [
  'ready',
  'locked',
  'unconfigured',
  'error',
  'unknown',
];

// ══════════════════════════════════════════════════════════════════════════
// C1（一）：工具栏同步按钮不再按登录态消失
// ══════════════════════════════════════════════════════════════════════════
describe('C1 同步入口可发现：渲染门禁只看后端，不看登录态', () => {
  it('云端未登录也要渲染（挡住「新装扩展顶栏空一格、不知道有同步」）', () => {
    assert.equal(shouldRenderSyncControls('supabase'), true);
  });

  it('自带存储照旧渲染（挡住「WebDAV 用户没有手动同步入口」的旧缺陷复活）', () => {
    assert.equal(shouldRenderSyncControls('webdav'), true);
  });

  it('身份判定按后端分流：WebDAV 不需要登录，云端需要', () => {
    assert.equal(syncIdentityCanRun({ syncBackend: 'webdav', auth: 'not_authenticated' }), true);
    assert.equal(syncIdentityCanRun({ syncBackend: 'supabase', auth: 'not_authenticated' }), false);
    assert.equal(syncIdentityCanRun({ syncBackend: 'supabase', auth: 'authenticated' }), true);
  });

  // ── 2026-10-23（第 50 轮）：「核不到」**不许**被拦成「去登录」─────────────
  // 修复前闸门收的是 `isAuthenticated: boolean` ⇒ 断网（核不到）与
  // 核到没登录同形 ⇒ 两者都被拦成「还没有登录 TapStack 云端，请先去登录」。
  // 那是两句错话：事实错（用户多半登录着），动作也错（断网时登录必然失败）。
  it('「核不到」那一档不得被拦（拦了就是把用户推向一个必然失败的动作）', () => {
    assert.equal(
      syncIdentityCanRun({ syncBackend: 'supabase', auth: 'unknown' }),
      true,
      '断网时不该拦 —— 真正的闸门在引擎里（ensureAuthenticated），它会按同一套四档说人话'
    );
    assert.equal(syncIdentityCanRun({ syncBackend: 'supabase', auth: 'backend_unavailable' }), true);
    assert.equal(syncIdentityCanRun({ syncBackend: 'supabase', auth: 'unchecked' }), true);
  });

  it('组件里不再有 `if (!canSync) return null` 这种按身份隐藏整组按钮的写法', () => {
    const src = stripComments(read(SYNC_BUTTON));
    assert.ok(
      !/if \(!canSync\)\s*\{/.test(src),
      '按身份隐藏整组按钮 = 新用户完全看不到同步（README 的手动入口承诺随之落空）'
    );
    assert.match(src, /if \(!shouldRenderSyncControls\(settings\.syncBackend\)\)/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// C1（二）：身份不足时**入口**就得说清下一步
//   这条是本组唯一的真实回归风险点：放宽渲染后若入口静默放行，未登录用户会
//   经历「按钮出现 → 弹窗能开 → 点覆盖两下 → 毫无反应」。
// ══════════════════════════════════════════════════════════════════════════
describe('C1 入口闸门：缺身份时不得静默放行', () => {
  it('云端未登录点上传/下载 ⇒ blocked，且文案指向登录', () => {
    const decision = decideSyncEntry({
      syncBackend: 'supabase',
      auth: 'not_authenticated',
      isBusy: false,
    });
    assert.equal(decision.type, 'blocked', '不得放行到弹窗：否则覆盖按钮点两下毫无反应');
    if (decision.type !== 'blocked') return;
    assert.match(decision.reason, /登录/, '必须指向下一步动作');
    assert.match(decision.reason, /登录 \/ 注册|菜单/, '必须告诉用户去哪儿登录');
  });

  it('自带存储未登录 ⇒ 放行（没有 TapStack 账号也能同步）', () => {
    assert.deepEqual(
      decideSyncEntry({ syncBackend: 'webdav', auth: 'not_authenticated', isBusy: false }),
      { type: 'open' }
    );
  });

  it('云端已登录 ⇒ 放行', () => {
    assert.deepEqual(
      decideSyncEntry({ syncBackend: 'supabase', auth: 'authenticated', isBusy: false }),
      { type: 'open' }
    );
  });

  it('同步进行中 ⇒ blocked（与旧行为一致：进行中不开新弹窗）', () => {
    const decision = decideSyncEntry({
      syncBackend: 'supabase',
      auth: 'authenticated',
      isBusy: true,
    });
    assert.equal(decision.type, 'blocked');
  });

  // ── 2026-10-23（第 50 轮）：入口闸门也不许把「核不到」说成「没登录」──────
  it('「核不到」时入口闸门不得拦，更不得说「去登录」', () => {
    const decision = decideSyncEntry({
      syncBackend: 'supabase',
      auth: 'unknown',
      isBusy: false,
    });
    assert.equal(
      decision.type,
      'open',
      '核不到时拦住 = 用户永远传不上去，且这一屏在教他去重新输密码'
    );
  });

  it('接线：两个按钮都走 openSyncModal，且闸门真的在它里面', () => {
    const src = stripComments(read(SYNC_BUTTON));
    assert.match(src, /const handleUpload = \(\) => openSyncModal\('upload'\)/);
    assert.match(src, /const handleDownload = \(\) => openSyncModal\('download'\)/);
    assert.match(
      src,
      /const decision = decideSyncEntry\(\{ \.\.\.identityGate, isBusy: isWorking \}\)/,
      '闸门入参必须来自按后端分流的身份判定'
    );
    // 模式卡片点击也要有兵底，否则「弹窗开着时登录态失效」这条路仍会静默。
    assert.match(
      src,
      /const entry = decideSyncEntry\(\{ \.\.\.identityGate, isBusy: isWorking \}\)/,
      'handleSyncActionClick 也要拦一次，保证没有任何路径能静默无反应'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// C1（三）：isOverwriteGateOpen 的入参语义
// ══════════════════════════════════════════════════════════════════════════
describe('C1 覆盖硬闸门：入参是「身份能否真跑」，不是「登录了没」', () => {
  it('组件传的是 identityCanRun（按后端分流），不是裸 isAuthenticated', () => {
    const src = stripComments(read(SYNC_BUTTON));
    assert.match(
      src,
      /isOverwriteGateOpen\(\{ mode, isConfirmed: isOverwriteConfirmed, isBusy: isWorking, isAuthenticated: identityCanRun \}\)/,
      '形参名沿用 isAuthenticated，但语义必须是 syncIdentityCanRun 的结果'
    );
    assert.ok(
      !/isAuthenticated: isAuthenticated\b/.test(src),
      '不得把裸登录态灌进这道闸门：WebDAV 用户没有账号会被整条拦死'
    );
  });

  it('identityCanRun 真值随后端变化（证伪「恒真/恒假」的实现）', () => {
    // 这个变量的两个来源都必须可达：若实现退化成常量，下面两条必有一条红。
    const src = stripComments(read(SYNC_BUTTON));
    assert.match(src, /const identityCanRun = syncIdentityCanRun\(\{/);
    assert.match(src, /syncBackend: settings\.syncBackend/);
    // ⚠️ 2026-10-23（第 50 轮）：入参从裸布尔 `isAuthenticated` 换成了
    // **那一档**（`state.auth.authStatusKind`）。这里断言的是「读的是哪一档」，
    // 而不是「变量叫什么」—— 改名不该让守卫变红（见记忆
    // stale-literal-guards-block-correct-fixes）。
    assert.match(
      src,
      /state\.auth\.authStatusKind/,
      '闸门的入参必须来自登录态的**那一档**，不能是「登录了没」这个布尔'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// C1（四）：失败文案 —— upload 方向也必须说「未登录」，并登记 backend_unknown
// ══════════════════════════════════════════════════════════════════════════
describe('C1 失败文案：两个方向都要可执行', () => {
  it('not_authenticated 在 upload 方向不得落到「上传失败，请重试」', () => {
    const shown = resolveSyncFailureCopy({
      reason: 'not_authenticated',
      fallbackMessage: '上传失败，请重试',
    });
    assert.notEqual(shown, '上传失败，请重试', '这句既没说是没登录、也没说下一步');
    assert.match(shown, /未登录/);
    assert.match(shown, /登录/, '必须给出可执行文案');
  });

  it('not_authenticated 在 download 方向同样可执行（不再只有两个字「未登录」）', () => {
    const shown = resolveSyncFailureCopy({
      reason: 'not_authenticated',
      fallbackMessage: '下载失败，请重试',
    });
    assert.match(shown, /登录 \/ 注册|菜单/, '要告诉用户去哪儿登录');
  });

  it('backend_unknown 已登记（B 组新增枚举不得退化成裸枚举）', () => {
    const shown = resolveSyncFailureCopy({
      reason: 'backend_unknown',
      fallbackMessage: '下载失败，请重试',
    });
    assert.notEqual(shown, 'backend_unknown', '裸枚举对用户等于没说');
    assert.notEqual(shown, '下载失败，请重试', '这不是「重试就好」，是设置读不到');
    assert.match(shown, /读不到同步设置/);
    assert.match(shown, /设置页/, '必须指向可执行的下一步');
  });

  it('backend_unknown 与「未登录」是两句话（不得混成一句）', () => {
    // B 组在 syncEngine 里显式把 null 从门禁里摘出来，就是为了不把「不知道传向哪儿」
    // 说成「没登录」。文案层不能又把它合回去。
    const unknown = resolveSyncFailureCopy({ reason: 'backend_unknown', fallbackMessage: 'x' });
    const anon = resolveSyncFailureCopy({ reason: 'not_authenticated', fallbackMessage: 'x' });
    assert.notEqual(unknown, anon);
  });

  it('原有条目一条不少（already_syncing / precheck_unknown / 空云端保护…）', () => {
    const cases: Array<[string, RegExp]> = [
      ['already_syncing', /正在进行中/],
      ['precheck_unknown', /本地存储读取失败/],
      ['recent_upload_guard', /刚完成上传/],
      ['pending_upload_failed', /未上传的本地改动/],
      ['snapshot_failed', /快照创建失败/],
      ['overwrite_empty_cloud_refused', /本地数据没有变化/],
    ];
    for (const [reason, pattern] of cases) {
      assert.match(
        resolveSyncFailureCopy({ reason, fallbackMessage: '兜底' }),
        pattern,
        `${reason} 的文案丢了`
      );
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// C1（五）：菜单状态卡不再藏起云端未登录用户
// ══════════════════════════════════════════════════════════════════════════
describe('C1 菜单状态卡：云端未登录也看得到，且不说谎', () => {
  const readyLike = { label: '已配置并解锁', tone: 'ok' as const, actionable: false };

  it('云端未登录：显示「未登录 · 去登录」，不转述后端的 ready', () => {
    const view = resolveMenuSyncStatus({
      syncBackend: 'supabase',
      auth: 'not_authenticated',
      userEmail: null,
      backend: readyLike,
    });
    assert.equal(view.headline, '未登录');
    assert.equal(view.label, '未登录');
    assert.equal(view.needsLogin, true);
    assert.equal(view.actionable, false, '未登录时「去设置」不是正确的下一步');
    // Supabase 分支永远没有 lockedReason ⇒ classifyBackendResolution 返回 ready。
    // 直接转述就是新的谎话（这是本条最容易写错的地方）。
    assert.ok(!view.label.includes('已配置'), '不得把 ready 转述给未登录用户');
  });

  it('云端已登录：抬头是邮箱，状态行按后端前缀 + 真实分类', () => {
    const view = resolveMenuSyncStatus({
      syncBackend: 'supabase',
      auth: 'authenticated',
      userEmail: 'a@b.c',
      backend: readyLike,
    });
    assert.equal(view.headline, 'a@b.c');
    assert.equal(view.prefix, 'TapStack 云端');
    assert.equal(view.label, '已配置并解锁');
    assert.equal(view.needsLogin, false);
    assert.equal(view.tone, 'ok');
  });

  it('自带存储未登录：不提示登录（没有 TapStack 账号），状态如实转述', () => {
    const view = resolveMenuSyncStatus({
      syncBackend: 'webdav',
      auth: 'not_authenticated',
      userEmail: null,
      backend: { label: '未解锁', tone: 'warn' as const, actionable: true },
    });
    assert.equal(view.headline, '自带存储');
    assert.equal(view.prefix, '自带存储');
    assert.equal(view.label, '未解锁');
    assert.equal(view.needsLogin, false);
    assert.equal(view.actionable, true, '未解锁时「去设置」才是正确的下一步');
  });

  it('云端未登录 + 后端锁定态：仍然只说「未登录」（登录才是第一位的）', () => {
    const view = resolveMenuSyncStatus({
      syncBackend: 'supabase',
      auth: 'not_authenticated',
      userEmail: null,
      backend: { label: '未解锁', tone: 'warn' as const, actionable: true },
    });
    assert.equal(view.label, '未登录');
    assert.equal(view.needsLogin, true);
  });

  it('组件接线：卡片无条件渲染 + 状态行来自 resolveMenuSyncStatus', () => {
    const src = stripComments(read(HEADER_DROPDOWN));
    assert.ok(
      !/\(\(isAuthenticated && user\) \|\| settings\.syncBackend === 'webdav'\)/.test(src),
      '旧条件会把云端未登录用户的整块状态藏掉'
    );
    assert.match(src, /const syncStatusView = resolveMenuSyncStatus\(\{/);
    assert.match(src, /\{syncStatusView\.headline\}/);
    // 未登录时缺的唯一入口。判据是**这个入口渲染出来的那句话**，
    // 不是源码里有没有「去登录」三个字 —— 那三个字已经抽成常量
    // （MENU_LOGIN_LABEL，2026-10-22 审计 P0-2），源码里自然搜不到。
    // 钉字面量的话，将来改一次文案守卫就红，而行为一点没变。
    assert.match(src, /\{MENU_LOGIN_LABEL\}/, '未登录时缺的唯一入口必须渲染出来');
    assert.equal(
      MENU_LOGIN_LABEL,
      '去登录',
      '菜单里这个入口的文案变了的话，引导 / 同步预览里指向它的三处也要一起变'
    );
    // handleQuickRefresh 已经是后端分流（:180 needsAccount），不该被改。
    assert.match(
      src,
      /const needsAccount = settings\.syncBackend !== 'webdav';/,
      '快速刷新门禁必须保持后端分流'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// C2：设置页 banner 不再「已配置就宣称已启用」
// ══════════════════════════════════════════════════════════════════════════
describe('C2 WebDAV banner：只有 ready 才允许说「已启用」', () => {
  it('locked（已配置但本次会话未解锁）⇒ 说「尚未解锁」，不说「已启用」', () => {
    const kind = webDavBannerKindOf('locked');
    assert.equal(kind, 'locked');
    const copy = webDavBannerCopy('locked');
    assert.ok(!copy.includes('已启用'), '未解锁时同步一次都不会跑，这条 banner 就是在说谎');
    assert.match(copy, /尚未解锁/);
    assert.match(copy, /应用密码/, '必须给出可执行的下一步（重新输入应用密码）');
  });

  it('unconfigured ⇒ 说「还没有配置云盘」', () => {
    assert.equal(webDavBannerKindOf('unconfigured'), 'unconfigured');
    assert.match(webDavBannerCopy('unconfigured'), /还没有配置云盘/);
    assert.ok(!webDavBannerCopy('unconfigured').includes('已启用'));
  });

  it('error / unknown ⇒ 不得落进 ready（读不到 ≠ 已启用）', () => {
    assert.notEqual(webDavBannerKindOf('error'), 'ready');
    assert.notEqual(webDavBannerKindOf('unknown'), 'ready');
    assert.ok(!webDavBannerCopy('error').includes('已启用'));
    assert.ok(!webDavBannerCopy('unknown').includes('已启用'));
  });

  it('只有 ready 的文案含「已启用」——五种分类逐一核对', () => {
    const sayingEnabled = ALL_STATUS_KINDS.filter(kind =>
      webDavBannerCopy(kind).includes('已启用')
    );
    assert.deepEqual(sayingEnabled, ['ready'], '「已启用」必须唯一对应 ready 态');
  });

  it('色档与文案同源：只有 ready 用「一切正常」的蓝底', () => {
    const blue = ALL_STATUS_KINDS.filter(kind =>
      WEB_DAV_BANNER_TONE[webDavBannerKindOf(kind)].includes('blue')
    );
    assert.deepEqual(blue, ['ready']);
    for (const kind of ALL_STATUS_KINDS) {
      assert.ok(
        WEB_DAV_BANNER_COPY[webDavBannerKindOf(kind)].length > 0,
        `${kind} 缺少文案`
      );
    }
  });

  it('组件接线：判据来自 classifyBackendResolution 的完整结果，不是只看 syncBackend', () => {
    const src = stripComments(read(WEBDAV_SETTINGS));
    assert.match(
      src,
      /setBackendKind\(classifyBackendResolution\(getLastBackendResolution\(\)\)\.kind\)/,
      'banner 必须读真实解析结果（含 lockedKind 的三态），不能自己再判一次 syncBackend'
    );
    assert.match(src, /webDavBannerKindOf\(backendKind \?\? 'unknown'\)/);
    assert.match(src, /WEB_DAV_BANNER_COPY\[webdavBannerKind\]/);
    // 反向：写死的「已启用」句子不得再出现在 JSX 里（那正是原缺陷）。
    assert.ok(
      !src.includes('已启用：数据同步到你自己的云盘。'),
      'banner 里不得再写死「已启用」——它必须由状态决定'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// C3：设置页页首不再声称「菜单里每项都有入口」
// ══════════════════════════════════════════════════════════════════════════
describe('C3 设置页页首文案：指向「设置…」入口，不谎称逐项对应', () => {
  const src = stripComments(read(OPTIONS_PAGE));

  it('不再声称「这里改的每一项都能在扩展图标菜单里找到对应入口」', () => {
    assert.ok(
      !src.includes('都能在') || !src.includes('里找到对应入口'),
      '菜单里与本页对应的只有一行「设置…」，9 项设置 0 项对应地点（2026-10-14 已全部搬走）'
    );
  });

  it('改为指向「设置…」入口（可再次进入本页）', () => {
    assert.match(src, /「设置…」/, '必须给出真实存在的那一个入口');
    assert.match(src, /可再次进入本页/);
  });

  it('反方向护栏：设置项没有被搬回 HeaderDropdown（256px 瞬态下拉放不下 WebDAV 表单）', () => {
    const menu = stripComments(read(HEADER_DROPDOWN));
    assert.match(menu, /设置…/, '菜单里必须保留「设置…」这一行');
    assert.match(menu, /handleOpenOptions/, '入口必须真的打开选项页');
    // WebDAV 表单的字段不该出现在菜单里。
    assert.ok(!menu.includes('应用密码'), 'WebDAV 表单不得被搬回 256px 的瞬态菜单');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// C4：搜索页「恢复所有匹配标签」全成功时也要出声
// ══════════════════════════════════════════════════════════════════════════
describe('C4 批量恢复成功反馈：条数用 matchingTabs.length', () => {
  const src = stripComments(read(SEARCH_LIST));

  it('全成功分支必须播报成功（挡住「对话框关了、窗口开了、只是几行消失」）', () => {
    // 2026-10-20 审计 A-1：措辞改用共享模块（restoreFeedbackCopy），
    // 调用形态从 showRestoreSuccess(matchingTabs.length) 变成
    // showRestoreSuccessMessage(restoreAllSearchSuccessMessage(...))。
    //
    // 2026-10-22 审计 P0-4：批量恢复多了一条退路（撤销），于是成功播报走
    // 共享 hook showConsumeToast（它内部再走 showRestoreSuccessMessage，
    // 额外挂一个「撤销」按钮）。两条路都是「出声了」——
    // 断言盯**不变量**（成功路径必须有一条成功播报，且必须带上条数），
    // 而不是盯某个已过时的调用写法 —— 后者会让「换了正确写法」变成红灯，
    // 那正是本仓文档守卫被审计批评的毛病（docsAlignment 硬编码旧基线）。
    assert.match(
      src,
      /show(?:RestoreSuccessMessage|ConsumeToast)\(\s*restoreAllSearchSuccessMessage\(/,
      '缺成功 toast：命中标签分散在多个会话时用户看不出恢复了几个'
    );
  });

  it('播报发生在 success:true 与 consume 之后（失败分支不得播报成功）', () => {
    const start = src.indexOf('const runRestoreAllSearchResults = () =>');
    assert.ok(start > 0, '应能找到 runRestoreAllSearchResults');
    const end = src.indexOf('const handleDeleteAllSearchResults', start);
    const body = src.slice(start, end === -1 ? src.length : end);

    // 成功播报有两种调用形态（直接播 / 走带撤销的共享 hook），都算「出声了」。
    const toastCall = /show(?:RestoreSuccessMessage|ConsumeToast)\(/;
    const guardAt = body.indexOf('r.success !== true');
    const toastAt = body.search(toastCall);
    assert.ok(guardAt !== -1 && toastAt !== -1);
    assert.ok(guardAt < toastAt, '成功播报必须排在失败出口之后');

    // 失败出口与「部分不可打开」出口都要 return，否则会出现成功+失败双 toast。
    const failBranch = body.slice(guardAt, toastAt);
    assert.match(failBranch, /return;/, '失败出口必须 return，不能继续往下播成功');
    // 「部分不可打开」那一分支也是部分失败出口：它自己已经报了条数，
    // 再往下走就会同时播「已恢复 N 个」与「另有 M 个打不开」（自相矛盾）。
    // ⚠️ 先断言子串确实存在，否则 -1 会让下一条比较恒真。
    const partialAt = body.indexOf('skippedUnopenable');
    assert.ok(partialAt !== -1, '应能找到「部分不可打开」分支');
    const partialReturnAt = body.indexOf('return;', partialAt);
    assert.ok(partialReturnAt !== -1, '应能找到 return');
    // 全成功那条播报必须排在「部分不可打开」分支的 return 之后。
    const fullToastAt = body.indexOf('restoreAllSearchSuccessMessage(');
    assert.ok(fullToastAt !== -1, '应能找到全成功分支的播报');
    assert.ok(
      partialReturnAt < fullToastAt,
      '「部分不可打开」分支也要 return，否则会同时播报「已恢复 N 个」和「另有 M 个打不开」'
    );
  });

  it('toastHelper 的成功文案带条数（不是一句「操作完成」）', () => {
    const helper = read('src/utils/toastHelper.ts');
    assert.match(helper, /已成功恢复 \$\{params\?\.count \|\| 0\} 个标签页/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// C5：空态的欢迎语与统计块
//
// 2026-10-19 审计 I-1：原先 PersonalizedWelcome 是一张独立的满宽大卡
// （主审真机实测 400×600 下高 258px，占视口 43%，却零操作价值），
// 与下面那张真正有 CTA 的空态卡上下叠成「两层大卡」。它已被整卡删除，
// 问候语降级为标题上的一行字（getEmptyStateGreeting）。
//
// 本组断言随之改成钉住**新结构的不变式**：
//   · 统计块（tabCount 分档文案、绿点「可恢复」）永久不得回来
//   · 空态只有一张卡
//   · 问候语仍然存在（功能没丢，只是换了位置）
// ══════════════════════════════════════════════════════════════════════════
describe('C5 空态：只有一张卡，问候语降级为标题的一部分', () => {
  it('统计块与分档文案永久不得回来', () => {
    assert.ok(!existsSync(p('src/components/common/PersonalizedWelcome.tsx')),
      '欢迎卡整卡已删（它占了 43% 视口高度却零操作价值）');
    const list = stripComments(read(TAB_LIST));
    assert.ok(!/PersonalizedWelcome/.test(list), '空态不再叠第二张欢迎卡');
    assert.ok(!/tabCount\s*>\s*0/.test(list), '统计块的条件永远不成立');
    assert.ok(!list.includes('个标签页'), '统计块的内容也随块删除');
    assert.ok(!list.includes('可恢复'), '绿点「可恢复」是一句未经任何数据检查的断言');
  });

  it('问候语仍然存在（删的是那张卡，不是问候这件事）', () => {
    const greeting = stripComments(read('src/components/common/emptyStateGreeting.ts'));
    assert.match(greeting, /早上好|下午好|晚上好/, '问候语按时间分档是真可达的分支');
    const list = stripComments(read(TAB_LIST));
    assert.match(list, /getEmptyStateGreeting/, '空态标题用问候语');
    assert.match(list, /先保存一个工作会话/, '标题仍要说清第一步要做什么');
  });

  it('空态分支只渲染一张卡', () => {
    const list = stripComments(read(TAB_LIST));
    // 2026-10-20 审计 A-14：空态分支的条件多了一个「没有生效的筛选条件」
    // （有筛选条件时要看筛选浏览视图，而不是「没有会话」的引导卡）。
    // 断言钉**不变量**（空态分支里只有一张 EmptyState 卡），不钉分支条件的写法 ——
    // 条件怎么写是实现细节，一张卡才是这个产品对用户的承诺。
    // 锚点用「空态标题用了问候语」这一行 —— 它只可能出现在「没有会话」那张卡上
    // （错误页那张卡没有问候语）。
    const titleAt = list.indexOf('getEmptyStateGreeting()');
    assert.ok(titleAt > -1, '空态分支必须存在');
    // 从这张卡的 <EmptyState 开始往后数（前面的锚点可能落在标签之后）。
    const cardAt = list.lastIndexOf('<EmptyState', titleAt);
    assert.ok(cardAt > -1, '应能找到空态那张 EmptyState 卡');
    const body = list.slice(cardAt);
    // 一张卡 = 一个 EmptyState；不允许多个并排的大卡
    const emptyStateCount = (body.match(/<EmptyState/g) ?? []).length;
    assert.equal(emptyStateCount, 1, `空态只允许一张 EmptyState 卡，实际 ${emptyStateCount} 张`);
  });
});

// ── C1（五）：快速刷新的失败弹窗必须复用同一张 reason 表 ──────────────────
// 原先这里写的是 `res.error === 'not_authenticated' ? '未登录' : (res.error || …)`，
// 只特判了一个枚举，其余原样透出 —— backend_unknown / precheck_unknown 这些
// 机器码会以裸枚举弹给用户（downloadReasonCopy 与 SyncButton 早已改成走
// resolveSyncFailureCopy，这里是最后一条没接上的路径）。
describe('C1（五）：菜单「从云端刷新」的失败弹窗不得透出裸枚举', () => {
  const src = stripComments(read(HEADER_DROPDOWN));

  it('快速刷新的失败弹窗接的是 resolveSyncFailureCopy', () => {
    assert.match(
      src,
      /message:\s*resolveSyncFailureCopy\(\{/,
      '这里若退回手写三元，新增的 reason 会以裸枚举透出'
    );
    assert.ok(
      !/res\.error === 'not_authenticated' \?/.test(src),
      '只剩一个枚举特判的旧写法：其余机器码会原样弹给用户'
    );
  });

  it('该路径的兜底文案是给人看的中文，不是枚举', () => {
    const idx = src.indexOf('message: resolveSyncFailureCopy({');
    assert.ok(idx > -1, '找不到接线点（锚点漂了）');
    const window = src.slice(idx, idx + 260);
    assert.match(window, /fallbackMessage:\s*'[^']*[\u4e00-\u9fa5]/, `兜底文案应含中文：${window}`);
  });

  it('反向：backend_unknown 经这条路径得到的不是它自己', () => {
    // 纯函数层面已经测过（见上方 C1 四），这里确认组件确实在用它 ——
    // 两条一起才排除「纯函数写对了但组件没接」。
    assert.equal(
      resolveSyncFailureCopy({ reason: 'backend_unknown', fallbackMessage: '无法从云端拉取数据' }),
      SYNC_REASON_COPY.backend_unknown
    );
  });
});
