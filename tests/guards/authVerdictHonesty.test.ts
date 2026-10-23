/**
 * 守卫：**「核不到」在任何一环都不许被读成「未登录」**（2026-10-23，第 50 轮）。
 *
 * ── 这条性质为什么是「一条性质」而不是「几个断言」 ──────────────────────
 * 本轮修掉的是同一个谎在**七个地方**的七次显形：
 *   ① 读会话失败被压成「没有会话」        （store/slices/authSlice.ts）
 *   ② 判据层靠「失败原因的长相」区分事实   （core/authStatus.ts）
 *   ③ 闸门把所有失败压成「没登录」          （core/authGuard.ts）
 *   ④ 同步引擎把「核不到」说成「用户未登录」（services/syncEngine.ts）
 *   ⑤ 失败文案的翻译表里没有这一档        （components/sync/syncPreviewView.tsx）
 *   ⑥ 设置页把「核不到」说成「尚未登录」，**还把开关锁死**
 *      （options/OptionsPage.tsx + components/layout/backendStatus.ts）
 *   ⑦ 菜单把「核不到」渲染成「未登录 + 去登录」
 *      （components/sync/syncPreviewView.tsx 的 resolveMenuSyncStatus）
 *
 * 逐个钉 ⇒ 下一轮新增一环又会漏。所以这里钉的是**性质**：
 * **凡是「核不到」的输入，穿过整条链之后，任何面向用户的文案都不得说「未登录 /
 * 请重新登录」。**
 *
 * ── 判据为什么不靠文案匹配 ──────────────────────────────────────────────
 * 本仓纪律：文案匹配让 UI 分类取决于另一处文件里的措辞。这里反过来 ——
 * 判据要检查的**就是**文案（因为「说谎」这件事的定义就是文案），
 * 但**只检查「未登录 / 重新登录」这两个词是否出现在该出现的地方**，
 * 而分类的依据一律是**机器字段**（状态码 / 错误码 / 判据层的 kind）。
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const LOADER_PATH = pathToFileURL(resolve(ROOT, 'tests/_alias-loader.mjs')).href;
before(async () => {
  register(LOADER_PATH);
});

/** 「不许说未登录」的判据：这些词出现在面向用户的文案里就是撒谎。 */
const FORBIDDEN_IN_UNKNOWN_COPY = /未登录|没有登录|请重新登录|重新登录|登录已过期/;

describe('第 50 轮：登录态四档 ——「核不到」永远不说「未登录」', () => {
  it('① 读会话失败的分类：三种失败含义互不串味', async () => {
    const { classifySessionFailure } = await import('@/core/sessionFailure');
    const { BackendUnavailableError } = await import('@/core/backendUnavailable');

    // 服务端不可用（402）——「等我们恢复」，不是「请重新登录」。
    const unavailable = classifySessionFailure(
      new BackendUnavailableError('云端项目被限制', 402)
    );
    assert.equal(unavailable.kind, 'backend_unavailable');

    // 刷新令牌被吊销 —— 会话**真的死了** ⇒ 确实没登录（这一档说「未登录」是诚实的）。
    const revoked = classifySessionFailure({
      name: 'AuthApiError',
      code: 'refresh_token_not_found',
      status: 400,
      message: 'Invalid Refresh Token: Refresh Token Not Found',
    });
    assert.equal(revoked.kind, 'session_expired');

    // 断网 —— **不知道**。
    const netDown = classifySessionFailure({
      name: 'AuthRetryableFetchError',
      status: 0,
      message: 'TypeError: Failed to fetch',
    });
    assert.equal(netDown.kind, 'unknown');

    // ⚠️ 顺序不能换：402 的报文里也可能带 code，
    // 若先判「会话死了」⇒ 402 会被读成「请重新登录」⇒ 那正是本轮要消灭的谎。
    const unavailableWithCode = classifySessionFailure({
      name: 'AuthApiError',
      code: 'refresh_token_not_found',
      status: 402,
      message: 'Service for this project is restricted',
    });
    assert.equal(
      unavailableWithCode.kind,
      'backend_unavailable',
      '「服务端不可用」必须优先于「会话死了」'
    );
  });

  it('② 判据层：只有「明确核到没有会话」才是不 Authenticated', async () => {
    const { decideAuthStatus } = await import('@/core/authStatus');
    const cached = { id: 'u1', email: 'a@b.c' };

    const verifiedNone = decideAuthStatus({
      verifiedUser: null,
      cachedUser: cached,
      verifiedNoSession: true,
    });
    assert.equal(verifiedNone.kind, 'not_authenticated');
    assert.equal(verifiedNone.user, null, '真没登录时缓存那份必须丢掉');

    // 核不到（断网）⇒ 绝不能是 not_authenticated。
    const unknown = decideAuthStatus({
      verifiedUser: null,
      cachedUser: cached,
      failureDetail: 'network error',
    });
    assert.equal(
      unknown.kind,
      'unknown',
      '「核不到」绝不能被读成「没登录」—— 那是本轮修掉的那个谎'
    );
    assert.equal(unknown.user?.id, 'u1', '「不知道」时保留缓存那份（暂定事实）');

    // 服务端不可用 ⇒ 也绝不是 not_authenticated。
    const unavailable = decideAuthStatus({
      verifiedUser: null,
      cachedUser: cached,
      backendUnavailable: true,
    });
    assert.equal(unavailable.kind, 'backend_unavailable');

    // ⚠️ **没有任何事实**时也必须是「不知道」——
    // 修复前这里靠 `failureDetail` 的真伪区分，于是「没核到」被读成「没登录」。
    const nothing = decideAuthStatus({ verifiedUser: null, cachedUser: cached });
    assert.equal(
      nothing.kind,
      'unknown',
      '「什么都没问到」绝不能被读成「没登录」—— 那是本轮修掉的那个谎'
    );
  });

  it('③ 闸门：恢复失败 ⇒ 三种失败各自一档，绝不落到 not_authenticated', async () => {
    const { ensureAuthenticated } = await import('@/core/authGuard');
    const { BackendUnavailableError } = await import('@/core/backendUnavailable');

    const netDown = await ensureAuthenticated({
      isAuthenticated: () => false,
      restoreAuth: async () => { throw new Error('network down'); },
    });
    assert.equal(netDown.allowed, false);
    assert.equal(
      netDown.allowed === false ? netDown.kind : null,
      'unknown',
      '断网 ⇒ 「不知道」，不是「没登录」'
    );

    const unavailable = await ensureAuthenticated({
      isAuthenticated: () => false,
      restoreAuth: async () => { throw new BackendUnavailableError('云端项目被限制', 402); },
    });
    assert.equal(
      unavailable.allowed === false ? unavailable.kind : null,
      'backend_unavailable'
    );

    // 核到没会话（restoreAuth 返回 false）⇒ 这一档**就是** not_authenticated。
    const verifiedNone = await ensureAuthenticated({
      isAuthenticated: () => false,
      restoreAuth: async () => false,
    });
    assert.equal(
      verifiedNone.allowed === false ? verifiedNone.kind : null,
      'not_authenticated',
      '「核到没会话」这一档必须保留（它是唯一能说「未登录」的档）'
    );
  });

  it('④ 失败文案的翻译表：必须登记「核不到」这一档，且话里不许出现「登录」', async () => {
    const { SYNC_REASON_COPY, resolveSyncFailureCopy } = await import(
      '@/components/sync/syncPreviewView'
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(SYNC_REASON_COPY, 'auth_unknown'),
      '「核不到」这一档必须在翻译表里登记 —— 否则它会落到兜底「上传失败，请重试」'
    );
    const copy = resolveSyncFailureCopy({
      reason: 'auth_unknown',
      fallbackMessage: '上传失败，请重试',
    });
    assert.ok(
      !FORBIDDEN_IN_UNKNOWN_COPY.test(copy),
      `「核不到」的文案不许出现「未登录 / 重新登录」类措辞（实测：${copy}）—— ` +
        '用户会去重新输密码，而断网时那必然失败'
    );
    assert.match(copy, /本地/, '必须说清「本地数据没丢」（同步失败时用户第一反应是「我的会话没了」）');

    // 对照：「核到没登录」那一档**允许**说登录。
    const notAuthed = resolveSyncFailureCopy({
      reason: 'not_authenticated',
      fallbackMessage: '上传失败，请重试',
    });
    assert.match(notAuthed, /登录/, '「核到没登录」那一档必须说清下一步是去登录');
  });

  it('⑤ 设置页：核不到时开关**不得**被锁死，账号区**不得**渲染登录表单', async () => {
    const { canEnableAutoSync, autoSyncBlockedCopy } = await import(
      '@/components/layout/backendStatus'
    );
    const { accountPanelMode } = await import('@/options/optionsAccount');

    const cloud = {
      kind: 'ready' as const,
      tone: 'ok' as const,
      label: '已配置并解锁',
      actionable: false,
      backendId: 'supabase' as const,
    };

    // 只有「核到没登录」才锁。
    assert.equal(canEnableAutoSync(cloud, 'not_authenticated'), false);
    assert.equal(canEnableAutoSync(cloud, 'authenticated'), true);
    assert.equal(
      canEnableAutoSync(cloud, 'unknown'),
      true,
      '「核不到」时锁死开关 = 用户永远开不了自动同步（这是唯一能配它的地方）'
    );
    assert.equal(canEnableAutoSync(cloud, 'backend_unavailable'), true);
    assert.equal(canEnableAutoSync(cloud, 'unchecked'), true);

    // 拒绝文案只在「核到没登录」时提登录。
    const blocked = autoSyncBlockedCopy(cloud, 'not_authenticated', '本页');
    assert.match(blocked, /登录/);
    assert.equal(
      FORBIDDEN_IN_UNKNOWN_COPY.test(autoSyncBlockedCopy(cloud, 'unknown', '本页')),
      false,
      '「核不到」时不得说「未登录」'
    );

    // 账号区：核不到 ⇒ 不得渲染登录表单（渲染它 = 界面在说「你没登录」）。
    assert.equal(accountPanelMode('supabase', 'not_authenticated'), 'signed-out');
    assert.equal(
      accountPanelMode('supabase', 'unknown'),
      'unverified',
      '「核不到」时渲染登录表单 = 把用户推向一个必然失败的动作'
    );
    assert.equal(accountPanelMode('supabase', 'backend_unavailable'), 'unverified');
    // 「还没核」是**第四种**情形：不是「核不到」（说「联系不上云端」是假话），
    // 更不是「核到没登录」（给登录表单是说「你没登录」）。
    assert.equal(
      accountPanelMode('supabase', 'unchecked'),
      'pending',
      '「还没核」必须自己一档 —— 说「联系不上云端」是假话，给登录表单是更重的假话'
    );
    assert.notEqual(
      accountPanelMode('supabase', 'unchecked'),
      'signed-out',
      '「还没核」时渲染登录表单 = 把用户推向一个必然失败的动作'
    );
  });

  it('⑥ 菜单：核不到时不得渲染成「未登录 + 去登录」', async () => {
    const { resolveMenuSyncStatus } = await import('@/components/sync/syncPreviewView');
    const backend = { label: '已配置并解锁', tone: 'ok' as const, actionable: false };

    const unknown = resolveMenuSyncStatus({
      syncBackend: 'supabase',
      auth: 'unknown',
      userEmail: null,
      backend,
    });
    assert.equal(unknown.needsLogin, false, '「核不到」时不得给「去登录」入口（那是错的下一步）');
    assert.notEqual(unknown.label, '未登录', '「核不到」不得渲染成「未登录」');
    assert.notEqual(unknown.headline, '未登录', '「核不到」不得渲染成「未登录」');

    const unavailable = resolveMenuSyncStatus({
      syncBackend: 'supabase',
      auth: 'backend_unavailable',
      userEmail: null,
      backend,
    });
    assert.equal(unavailable.needsLogin, false);
    assert.notEqual(unavailable.label, '未登录');

    // 对照：核到没登录 ⇒ 仍然是「未登录 + 去登录」。
    const notAuthed = resolveMenuSyncStatus({
      syncBackend: 'supabase',
      auth: 'not_authenticated',
      userEmail: null,
      backend,
    });
    assert.equal(notAuthed.label, '未登录');
    assert.equal(notAuthed.needsLogin, true);
  });

  it('⑦ 「这一档在界面上怎么说」必须真的被生产代码调用（不许是死代码）', () => {
    // 判据层的 `authStatusCopy` 早就写好了两档的措辞，
    // 但修复前**零调用** ⇒ 界面一句话都不说（用户不知道云端此刻 402 / 断网）。
    const provider = read('src/components/app/AuthProvider.tsx');
    assert.match(
      provider,
      /authStatusCopy\(/,
      'AuthProvider 必须调用 authStatusCopy —— 判据层写好的措辞要真的到达用户'
    );
    // 而且它接到的必须是**生产**的措辞（不是测试里的）。
    assert.match(
      provider,
      /backendUnavailable:\s*backendUnavailableAuthCopy\(\)/,
      '必须用生产文案模块里的措辞（测试里的假文案不算）'
    );
  });
});
