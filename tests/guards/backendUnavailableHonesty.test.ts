/**
 * 「云端项目被限制 / 服务端不可用」的诚实性守卫（2026-10-22，402 收口）。
 *
 * ── 缺陷原形（生产实测）─────────────────────────────────────────────────
 * 2026-10-22 生产 Supabase **整个项目被封禁**（egress 配额超限）：
 * `/rest/v1/` 与 `/auth/v1/health` 全部返回 HTTP 402，body 是：
 *
 *   {"message":"Service for this project is restricted due to the following
 *    violations: exceed_egress_quota. The project owner must upgrade their
 *    plan or remove spend caps to restore service."}
 *
 * 用户看到的是「上传失败，请重试。若反复出现，请导出诊断信息」。三处都错：
 *   ① 「请重试」是**错的方向**（项目被封禁，重试一万次结果一样）；
 *   ② 「请导出诊断信息」是**甩锅给用户**（真正需要知道的是产品负责人）；
 *   ③ 「若反复出现」是废话（它**正在**反复出现）。
 *
 * 而且这条英文串**含中文判定会误判**：纯英文 ⇒ `looksLikeMachineError`
 * 命中「不含 CJK」⇒ 走中文兜底 ⇒ 原始信息（配额被限、这是服务端问题）**全丢**。
 *
 * ── 本守卫盯什么 ────────────────────────────────────────────────────────
 * ① **判据**：机器字段（HTTP 状态码 / 报文标记）能认出「服务端不可用」，
 *    且**不靠中英文案匹配**（改界面文案不会让判据失效）。
 * ② **话术性质**：文案满足「说清三件事」——
 *    ① 你的本地数据没有丢；② 这不是你的操作问题；③ 下一步是什么。
 *    并且**不含**「请重试」/「导出诊断信息」这类错方向的引导。
 * ③ **传递链**：错误码从产生点一路到 UI 不断层（防止某层又把它吞了）。
 * ④ **后台**：不可重试的失败**不推进退避阶梯**（那会烧 egress 配额）。
 *
 * 【为什么要钉「性质」而不是钉字面量】
 * 文案改写不该让守卫变红；而「又退回『请重试』」必须变红。所以断言的是
 * 性质（不含错方向的引导、含三件事的语义），不是逐字文案。
 *
 * 形状照抄 tests/guards/accountScopeReconcile.test.ts（那道守卫钉的正是
 * 「错误码的传递链」—— 同一个坑：某层吞了它，上游就拿不到判据）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { parseSource } from '../_helpers/sourceAst.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');
/** 剥注释再断言：注释里提到旧文案不算「界面还这么写」。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * 生产抓到的 402 报文（**原样**硬编码）。
 *
 * ⚠️ 为什么要原样而不是自己编一个形状：本仓有已知的坑「假服务器只吐自家
 * 解析器认得的形状，真实服务端能骗过全部单测」。这个字符串就是生产上
 * 真实返回的 body —— 判据必须在它**原样**的情况下也认得出来。
 */
const REAL_402_BODY =
  'Service for this project is restricted due to the following violations: ' +
  'exceed_egress_quota. The project owner must upgrade their plan or remove ' +
  'spend caps to restore service.';

/* ── ① 判据层：机器字段 ─────────────────────────────────────────────── */

describe('判据：机器字段能认出「服务端不可用」，且不靠文案匹配', () => {
  it('认 HTTP 402（REST 侧：postgrest-js 的错误体没有 code，只有注入的 http_status）', async () => {
    const { isBackendUnavailable } = await import('@/core/backendUnavailable');
    // postgrest-js 2.118 的真实形状：{ message, http_status }（http_status 由
    // client.ts 的 fetch 边界注入）。**不是** Error 实例。
    const restError = { message: REAL_402_BODY, http_status: 402 };
    assert.equal(isBackendUnavailable(restError), true, 'REST 侧 402 必须认得出来');
  });

  it('认 auth 侧的 AuthApiError { status: 402 }', async () => {
    const { isBackendUnavailable } = await import('@/core/backendUnavailable');
    const authError = Object.assign(
      new Error(REAL_402_BODY),
      { name: 'AuthApiError', status: 402 }
    );
    assert.equal(isBackendUnavailable(authError), true, 'auth 侧 402 必须认得出来');
  });

  it('认报文标记（网关改写了状态码时状态码判据会失效）', async () => {
    const { isBackendUnavailable } = await import('@/core/backendUnavailable');
    // 状态码被改成 400，但报文标记还在 —— 仍必须判成「服务端不可用」。
    assert.equal(
      isBackendUnavailable({ message: REAL_402_BODY, http_status: 400 }),
      true,
      '报文里的「项目被限制」标记必须独立成立'
    );
  });

  it('**不**把用户侧错误误判成「服务端不可用」', async () => {
    const { isBackendUnavailable } = await import('@/core/backendUnavailable');
    // 401/403/404/409 是**用户侧**的问题（令牌过期、RLS 没配、id 不存在），
    // 说成「服务端不可用」是甩锅给用户，还会掩盖真正的配置错误。
    for (const code of [400, 401, 403, 404, 409, 422]) {
      assert.equal(
        isBackendUnavailable({ message: 'something wrong', http_status: code }),
        false,
        `HTTP ${code} 是用户侧问题，不该被说成「服务端不可用」`
      );
    }
  });

  it('网络错误 / 超时 / 普通 5xx 不被误判（它们是「可重试」的另一类）', async () => {
    const { isBackendUnavailable } = await import('@/core/backendUnavailable');
    assert.equal(isBackendUnavailable(new TypeError('Failed to fetch')), false);
    assert.equal(isBackendUnavailable({ message: 'row level security policy', http_status: 403 }), false);
  });

  it('判据不依赖界面文案：改文案不会让判据失效', async () => {
    const { isBackendUnavailable } = await import('@/core/backendUnavailable');
    // 判据只读 status / http_status / 报文标记 —— 与中文文案无关。
    // 这一条钉的是「判据的输入集合」：把界面文案整个换掉，判据仍成立。
    const err = { message: REAL_402_BODY, http_status: 402 };
    assert.equal(isBackendUnavailable(err), true);
    // 纯中文的错误不可能被判成「服务端不可用」（没有状态码也没有标记）。
    assert.equal(
      isBackendUnavailable({ message: '云端暂时不可用，你的本地会话一个都没有丢' }),
      false,
      '不得靠中文文案反推（那是文案匹配，本仓纪律明令禁止）'
    );
  });
});

/* ── ② 话术层：三件事 + 不含错方向的引导 ───────────────────────────── */

describe('话术：说清「本地没丢 / 不是你的错 / 下一步是什么」', () => {
  it('上传方向的三件事都在', async () => {
    const { backendUnavailableCopy, LOCAL_DATA_INTACT, NOT_YOUR_FAULT, NEXT_STEP } =
      await import('@/components/sync/backendUnavailableCopy');
    const copy = backendUnavailableCopy('upload');
    assert.ok(copy.includes(LOCAL_DATA_INTACT), '必须说清「本地数据没丢」');
    assert.ok(copy.includes(NOT_YOUR_FAULT), '必须说清「这不是你的操作问题」');
    assert.ok(copy.includes(NEXT_STEP), '必须给出可执行的下一步');
  });

  it('下载方向同样三件事都在', async () => {
    const { backendUnavailableCopy, LOCAL_DATA_INTACT, NOT_YOUR_FAULT, NEXT_STEP } =
      await import('@/components/sync/backendUnavailableCopy');
    const copy = backendUnavailableCopy('download');
    assert.ok(copy.includes(LOCAL_DATA_INTACT));
    assert.ok(copy.includes(NOT_YOUR_FAULT));
    assert.ok(copy.includes(NEXT_STEP));
  });

  it('账号态与后台通知同样三件事都在', async () => {
    const {
      backendUnavailableAuthCopy,
      backendUnavailableBackgroundNotice,
      LOCAL_DATA_INTACT,
      NOT_YOUR_FAULT,
      NEXT_STEP,
    } = await import('@/components/sync/backendUnavailableCopy');
    for (const copy of [backendUnavailableAuthCopy(), backendUnavailableBackgroundNotice()]) {
      assert.ok(copy.includes(LOCAL_DATA_INTACT), '必须说清「本地数据没丢」');
      assert.ok(copy.includes(NOT_YOUR_FAULT), '必须说清「这不是你的操作问题」');
      assert.ok(copy.includes(NEXT_STEP), '必须给出可执行的下一步');
    }
  });

  it('**不含**错方向的引导：「请重试」/「导出诊断信息」/「若反复出现」', async () => {
    const {
      backendUnavailableCopy,
      backendUnavailableAuthCopy,
      backendUnavailableBackgroundNotice,
    } = await import('@/components/sync/backendUnavailableCopy');
    const copies = [
      backendUnavailableCopy('upload'),
      backendUnavailableCopy('download'),
      backendUnavailableAuthCopy(),
      backendUnavailableBackgroundNotice(),
    ];
    for (const copy of copies) {
      assert.doesNotMatch(copy, /请重试|请稍后重试/, '「重试」对被封禁的服务端无用');
      assert.doesNotMatch(copy, /导出诊断/, '诊断信息对用户毫无用处，是甩锅不是帮忙');
      assert.doesNotMatch(copy, /若反复出现/, '它**正在**反复出现，这句是废话');
    }
  });

  it('幂等：同一个失败反复发生时，文案稳定（逐字相同）', async () => {
    const { backendUnavailableCopy } = await import('@/components/sync/backendUnavailableCopy');
    assert.equal(backendUnavailableCopy('upload'), backendUnavailableCopy('upload'));
    assert.equal(backendUnavailableCopy('download'), backendUnavailableCopy('download'));
  });

  it('**不断言云端的数据还在**（覆盖上传的窄窗口里那是假的）', async () => {
    const { backendUnavailableCopy } = await import('@/components/sync/backendUnavailableCopy');
    const copy = backendUnavailableCopy('upload');
    // 覆盖上传：DELETE 已提交、upsert 撞 402 ⇒ 云端被清空而本机完好。
    // 所以文案只能承诺「本地」，绝不能承诺「云端也还在」。
    assert.doesNotMatch(copy, /云端(的)?(数据|会话).*(没丢|还在|完好)/,
      '不得承诺云端的状态 —— 覆盖上传的窄窗口里那是假的');
  });
});

/* ── ③ 传递链：错误码从产生点到 UI 不断层 ─────────────────────────── */

describe('传递链：机器判据一路到 UI 不断层', () => {
  it('产生点：fetch 边界把 HTTP 状态码注入错误体', () => {
    const src = read('src/utils/supabase/client.ts');
    // 判据：存在「把状态码写进错误体」的注入点，且注入的是 http_status
    // （**不是** code —— code 已被 PGRST204/42703/23502 消费）。
    assert.match(src, /http_status/, '必须注入 http_status 字段');
    assert.match(src, /res\.status/, '必须从响应上取 HTTP 状态码');
    // 注入必须只发生在错误响应上（2xx 不动）
    assert.match(src, /res\.ok\s*\|\|\s*res\.status\s*<\s*400/, '成功响应一个字节都不动');
  });

  it('上传路径：把「服务端不可用」归一后上浮（不降级成普通 Error）', () => {
    const src = read('src/utils/supabase/upload.ts');
    assert.match(src, /isBackendUnavailable\(/,
      'upload.ts 必须判「服务端不可用」并保留机器判据');
    assert.match(src, /new BackendUnavailableError\(/,
      '必须抛专用错误（带 code），否则上游拿不到判据');
  });

  it('会话校验路径：账号态 402 也保留机器判据', () => {
    const src = read('src/utils/supabase/session.ts');
    assert.match(src, /isBackendUnavailable\(/,
      'session.ts 必须判「服务端不可用」（账号校验是最先暴露 402 的一层）');
    assert.match(src, /new BackendUnavailableError\(/, '必须抛专用错误');
  });

  it('账号恢复路径：不把「服务端不可用」吞成「未登录」', async () => {
    // 这是本次最要命的一层：吞掉它 ⇒ 用户明明登录着却被告知「用户未登录」。
    //
    // ── 2026-10-23（第 50 轮）：判据从「源码里有没有 throw」改成**行为** ──
    // 闸门现在返回**四档判定**（core/authGuard.ts），不再抛异常 ⇒
    // 「原样上抛」这个形状已经不存在了。真正要钉的性质是：
    // **「服务端不可用」这一档，绝不能落进「没登录」那一档。**
    const { ensureAuthenticated } = await import('@/core/authGuard');
    const { BackendUnavailableError } = await import('@/core/backendUnavailable');

    const unavailable = await ensureAuthenticated({
      isAuthenticated: () => false,
      restoreAuth: async () => { throw new BackendUnavailableError('云端项目被限制', 402); },
    });
    assert.equal(unavailable.allowed, false);
    assert.equal(
      unavailable.allowed === false ? unavailable.kind : null,
      'backend_unavailable',
      '「服务端不可用」必须单独成一档 —— 混进「没登录」会让用户去重新登录（白折腾）'
    );

    // 对照组：普通的网络失败**不是** backend_unavailable，也**不是** not_authenticated。
    const netDown = await ensureAuthenticated({
      isAuthenticated: () => false,
      restoreAuth: async () => { throw new Error('network down'); },
    });
    assert.equal(
      netDown.allowed === false ? netDown.kind : null,
      'unknown',
      '断网是「不知道」，不是「服务端不可用」，更不是「没登录」'
    );

    // restoreAuth 里**不许**再有任何 catch（它一 catch 就把失败压成「恢复不出来」
    // ⇒ 「没登录」）。这是本轮修掉的第二个谎。
    const engine = stripComments(read('src/services/syncEngine.ts'));
    const restoreAt = engine.indexOf('private async restoreAuth(');
    assert.ok(restoreAt !== -1, '应能找到 restoreAuth');
    const restoreBody = engine.slice(restoreAt, restoreAt + 2000);
    assert.ok(
      !/\.catch\s*\(/.test(restoreBody),
      'restoreAuth 不许再 catch 任何失败 —— 「核不到」必须原样上抛，' +
        '由闸门分档（压成 null = 读成「没登录」）'
    );
  });

  it('引擎结果：带出 backendUnavailable 机器标记', () => {
    const engine = read('src/services/syncEngine.ts');
    assert.match(engine, /backendUnavailable:\s*true/,
      'UploadResult / MergeResult 必须带出机器标记');
    assert.match(engine, /backendUnavailable\?: boolean;/,
      '结果类型里必须有这个字段');
  });

  it('SW 回包：机器标记透传到界面', () => {
    const sw = read('src/service-worker.ts');
    assert.match(sw, /backendUnavailable:\s*true/,
      'SW 的 SYNC 回包必须把标记透出（否则界面选不对措辞）');
    assert.match(read('src/core/mutationProtocol.ts'), /backendUnavailable\?: boolean;/,
      'MutationResult 必须有该字段');
  });

  it('界面：把标记交给翻译层', () => {
    const btn = read('src/components/sync/SyncButton.tsx');
    assert.match(btn, /backendUnavailable:\s*res\.backendUnavailable\s*===\s*true/,
      'SyncButton 必须把机器标记传给 resolveSyncFailureCopy');
  });

  it('预览读云端失败时也说要人话（别只说「读不到预览」）', () => {
    // 真机探针挖出来的第六处漏层：上传/下载**预览**要读云端，读不到时
    // 弹的是「暂时无法读取云端会话预览」。而项目被封禁时这句话**特别误导**
    // （用户以为是自己云端数据有问题，反复点、或者干脆不敢同步）。
    const btn = read('src/components/sync/SyncButton.tsx');
    const occurrences = (stripComments(btn).match(/isBackendUnavailableError\(/g) ?? []).length;
    assert.ok(
      occurrences >= 2,
      '上传与下载两处预览的 catch 都必须判「服务端不可用」'
    );
    assert.match(btn, /backendUnavailableCopy\('upload'\)/,
      '上传预览失败要用上传方向的人话');
    assert.match(btn, /backendUnavailableCopy\('download'\)/,
      '下载预览失败要用下载方向的人话');
  });

  it('下载侧自己的会话/账号校验保留机器判据（会话两处 + 账号两处）', () => {
    // download.ts 有**自己的一份**会话/账号校验（downloadTabGroups /
    // downloadSettings 各两处），它原先把 402 降级成普通 Error ⇒
    // 上层只看到一句英文 ⇒ 用户看到「请重试」。
    //
    // ── 2026-10-23（第 52 轮）：「账号」那两处**搬走了** ────────────────
    // 原先这里是 4 处 `isBackendUnavailable(`（会话 2 + 账号 2）。
    // 第 52 轮把「核账号」收口到 `session.ts` 的 `requireSessionUser()`
    // （弱网时裸调 `getUser()` 会拖满 45 秒 ⇒ 打爆 30 秒协议上界）
    // ⇒ 账号那 2 处随之搬到了 `session.ts`。
    //
    // ⚠️ **判据跟着搬，不跟着「同一个文件里有几处」走**：
    // 原来这里钉的是「`download.ts` 里 ≥4 处」⇒ 收口（把重复实现合并到
    // 一处）反而会让它变红 ⇒ **逼着代码不许收口** ⇒ 那是「守卫钉字面量」
    // 那个坑的第四例（本仓已踩过三次，见 accountScopeReconcile 的头注）。
    // ⇒ 现在钉的是**性质**：
    //   · download.ts 自己那两处**读会话**的校验，判据不许丢；
    //   · 账号那两处在 `session.ts`（收口入口）里，判据也不许丢。
    const dl = read('src/utils/supabase/download.ts');
    const dlOccurrences = (stripComments(dl).match(/isBackendUnavailable\(/g) ?? []).length;
    assert.ok(
      dlOccurrences >= 2,
      `download.ts 的两处**读会话**校验都要保留机器判据（当前 ${dlOccurrences} 处）—— ` +
        '少了任何一处，那条路上 402 就又变回一句英文'
    );
    assert.match(dl, /new BackendUnavailableError\(/,
      '必须抛专用错误（带 code），否则上游拿不到判据');

    // 账号那两处（第 52 轮收口后住在 session.ts）—— 判据同样不许丢。
    //
    // ⚠️ **判据必须钉「哪一个」错误被判**，不是「文件里有几处」：
    //   只数「`session.ts` 里有 ≥1 处 `isBackendUnavailable(`」是**假绿** ——
    //   把**账号**那处拆掉，读会话那处还在，计数照样 ≥1 ⇒ 守卫全绿。
    //   （这是本条判据自己的第一版写法的漏洞，靠变异自证抓出来的。）
    // ⇒ 现在分别钉两个**不同的错误变量**：`sessionError`（读会话）
    //   与 `userError`（核账号）—— 少任何一处，断言立刻红。
    const session = read('src/utils/supabase/session.ts');
    assert.match(
      session,
      /isBackendUnavailable\(sessionError\)/,
      'session.ts 的「读会话」那处要判「服务端不可用」（丢了它，402 就变回一句英文）'
    );
    assert.match(
      session,
      /isBackendUnavailable\(userError\)/,
      'session.ts 的「核账号」那处要判「服务端不可用」（丢了它，账号态 402 就变回一句英文）'
    );
    assert.match(session, /new BackendUnavailableError\(/,
      '必须抛专用错误（带 code），否则上游拿不到判据');
  });

  it('popup 的登录态不被「服务端不可用」清掉（否则入口闸门说未登录）', () => {
    // 真机探针挖出来的第五处漏层：Redux 的 isAuthenticated 只在
    // getCurrentUser **fulfilled** 时置真，而 402 时它 reject ⇒ 登录态恒
    // false ⇒ popup 入口闸门在点击那一刻就拦下，弹「还没有登录 TapStack 云端」
    // —— 他明明登录着（会话还在、缓存里也有账号）。
    const slice = read('src/store/slices/authSlice.ts');
    const rejectedAt = slice.indexOf('getCurrentUser.rejected');
    assert.ok(rejectedAt !== -1, '应能找到 getCurrentUser.rejected 分支');
    const block = slice.slice(rejectedAt, rejectedAt + 1600);
    assert.match(block, /isBackendUnavailableError\(/,
      'rejected 分支必须判「服务端不可用」');
    assert.doesNotMatch(
      block,
      /state\.isAuthenticated\s*=\s*false/,
      '「服务端不可用」不许把登录态清成 false（那会让界面说「未登录」）'
    );

    // ── popup 侧：**只有「明确核到没登录」那一档才许归零** ─────────────
    //
    // 【为什么判据换了地方】2026-10-23（第 47 轮）：「核登录态」整件事搬到了
    // **service worker** —— 弹窗不再加载 Supabase SDK（每次开弹窗省 ≈75KB）。
    // 于是「服务端不可用 ⇒ 保留缓存那份」的判定落在**后台侧**：
    //   · `src/background/authStatus.ts` —— 判「服务端不可用」并把缓存那份带出来；
    //   · `src/core/authStatus.ts`       —— 纯判据（四档，见 authStatusJudgement）。
    //
    // 【弹窗侧剩下的唯一性质】**只有明确核到「没有会话」才许把登录态归零**。
    // 「服务端不可用」与「不知道」两档都**不许**归零 ——
    // 归零了，入口闸门就会在点击那一刻拦下并说「还没有登录 TapStack 云端」，
    // 而用户明明登录着（缓存里有账号，他做什么都没用）。
    //
    // ⚠️ 这里用**结构**判据（AST）而不是正则：
    //   · 局部变量改名 ⇒ 仍然绿（结构没变）；
    //   · 把归零挪到别的分支 / 再加一处归零 ⇒ 变红（性质破了）。
    const swReader = read('src/background/authStatus.ts');
    assert.match(
      swReader,
      /isBackendUnavailableError\(/,
      '后台侧必须判「服务端不可用」—— 这一档如今由后台判（弹窗不再联网核）'
    );
    assert.match(
      swReader,
      /cachedUser/,
      '后台侧必须把**本机缓存那份**登录态一起带出来（服务端确认不了时，用户其实登录着）'
    );

    const providerPath = resolve(ROOT, 'src/components/app/AuthProvider.tsx');
    const providerSrc = parseSource(providerPath, readFileSync(providerPath, 'utf8'));
    let zeroCount = 0;
    let zeroInsideNotAuthenticated = false;
    const visit = (node: ts.Node, inNotAuthenticated: boolean): void => {
      if (ts.isIfStatement(node)) {
        const cond = node.expression.getText(providerSrc.file);
        if (cond.includes('not_authenticated')) {
          // 这一支的 then 是「确实没登录」⇒ 允许归零；else 是「不可用/不知道」⇒ 不许。
          visit(node.thenStatement, true);
          if (node.elseStatement) visit(node.elseStatement, inNotAuthenticated);
          return;
        }
      }
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'isAuthenticated' &&
        node.initializer.kind === ts.SyntaxKind.FalseKeyword
      ) {
        zeroCount += 1;
        if (inNotAuthenticated) zeroInsideNotAuthenticated = true;
      }
      node.forEachChild(child => visit(child, inNotAuthenticated));
    };
    visit(providerSrc.file, false);

    assert.equal(
      zeroCount,
      1,
      `弹窗里「把登录态归零」只许有一处（当前 ${zeroCount} 处）—— ` +
        '每一处归零都是一次「说用户没登录」的断言；' +
        '「服务端不可用」那一档归零 ⇒ 明明登录着的人被要求重新登录（白折腾）'
    );
    assert.ok(
      zeroInsideNotAuthenticated,
      '那一处归零必须落在「明确核到没有会话」那一支里 —— ' +
        '「服务端不可用」与「不知道」两档都只是**确认不了**，不是没登录'
    );
  });

  it('**账号闸门**的四档必须被引擎**分别归一**（每一档有自己的收尾）', () => {
    // ── 为什么这条要改写（2026-10-23，第 50 轮）────────────────────────
    // 原判据钉的是「闸门被 try 就地包住 + catch 里判机器标记」——
    // 那是**旧契约**（闸门抛异常）。新契约：闸门**返回四档判定**
    // （core/authGuard.ts），引擎按档分流。
    //
    // 旧形状若还在，就是「判据层做对了、闸门层没接」的翻版 ——
    // 而这一层恰恰是生产实测里**最先** 402 的地方（账号校验
    // /auth/v1/user），也是最容易被静默吞掉的一层。
    // ⚠️ 必须**去掉注释**再找：注释里会提到 `.catch(`、旧契约的名字等，
    // 照抄进断言就成了「断言注释里写了什么」—— 那种守卫改一次注释就红。
    const engine = stripComments(read('src/services/syncEngine.ts'));
    for (const fn of ['async upload(', 'async downloadAndMerge(']) {
      const start = engine.indexOf(fn);
      assert.ok(start !== -1, `应能找到 ${fn}`);
      const body = engine.slice(start, start + 4000);
      const gateAt = body.indexOf('ensureAuthenticated(');
      assert.ok(gateAt !== -1, `${fn} 应当过账号闸门`);
      const gateBlock = body.slice(gateAt, gateAt + 1200);

      // ① 「服务端不可用」这一档 ⇒ 必须带出机器标记（否则界面选不对措辞）。
      assert.match(
        gateBlock,
        /gate\.kind === 'backend_unavailable'/,
        `${fn} 必须把闸门的「服务端不可用」单独分流 —— ` +
          '混进「未登录」会让用户去重新登录（而重试无用）'
      );
      assert.match(
        gateBlock,
        /backendUnavailable:\s*true/,
        `${fn} 的「服务端不可用」必须带出机器标记（它要一路到 UI）`
      );
      // ② 「核不到」这一档 ⇒ 必须是**独立**的 reason，绝不能落成 not_authenticated。
      assert.match(
        gateBlock,
        /'auth_unknown'/,
        `${fn} 必须给「核不到（断网等）」一个独立 reason —— ` +
          '落成 not_authenticated 就是那句更重的谎（用户去重新输密码，而重登必然失败）'
      );
      // ③ 核到没登录 ⇒ 仍然是 not_authenticated（这一档的语义不许被改掉）。
      assert.match(
        gateBlock,
        /'not_authenticated'/,
        `${fn} 必须保留「核到没登录」这一档`
      );
    }
  });

  it('upload_first 分支不把机器标记丢掉（否则后台会静默让路）', () => {
    const engine = read('src/services/syncEngine.ts');
    const start = engine.indexOf("decision.action === 'upload_first'");
    assert.ok(start !== -1, '应能找到 upload_first 分支');
    const branch = engine.slice(start, start + 1600);
    assert.match(branch, /backendUnavailable/,
      'upload_first 分支必须带出 upResult.backendUnavailable —— ' +
        '丢了它，后台会把「云端被限制」当成保护性跳过**静默让路**' +
        '（不报故障、不退避、不通知），比真失败更糟');
  });

  it('后台：**机器标记优先于**「保护性跳过」归类', () => {
    // 顺序错了 ⇒ pending_upload_failed 让路分支先命中 ⇒ 真故障被当正常状态。
    const src = read('src/background/backgroundSync.ts');
    const start = src.indexOf('const result = await enqueue(\'sync:download\'');
    assert.ok(start !== -1, '应能找到下载结果分支');
    const block = src.slice(start, start + 3000);
    const unavailableAt = block.indexOf('result.backendUnavailable');
    const yieldAt = block.indexOf("reason === 'pending_upload_failed'");
    assert.ok(unavailableAt !== -1, '下载结果分支必须判 backendUnavailable');
    assert.ok(yieldAt !== -1, '应能找到「保护性跳过」的让路分支');
    assert.ok(
      unavailableAt < yieldAt,
      '「云端不可用」的判定必须**排在**「保护性跳过」之前 —— ' +
        '否则 pending_upload_failed 会先命中让路分支，真故障被静默吞掉'
    );
  });

  it('SW 的通用 catch 也认机器标记（最后一道接缝）', () => {
    const sw = read('src/service-worker.ts');
    // 定位：SYNC 分支的 enqueue 之后的通用 catch。
    // ⚠️ 不要用「单行 `.catch(err => sendResponse({ ok: false, error: err?.message`
    // 这种写法定位 —— 那个 catch 现在是多行的（带判据），字面量一改就定位不到，
    // 而守卫会**假绿**（找不到 ⇒ 应当红，却因为定位失败而红在别处/被跳过）。
    // 改成结构化定位：找 SYNC 的 enqueue，再找它后面的 `.catch(`。
    const enqueueAt = sw.indexOf("enqueue(`sync:${data.op}`");
    assert.ok(enqueueAt !== -1, '应能找到 SYNC 的 enqueue');
    const catchAt = sw.indexOf('.catch(', enqueueAt);
    assert.ok(catchAt !== -1, 'SYNC 的 enqueue 之后应有 catch');
    const block = sw.slice(catchAt, catchAt + 1200);
    assert.match(block, /isBackendUnavailableError\(/,
      '通用 catch 必须认「服务端不可用」（队列里别的任务抛出的同类异常会落到这里）');
    assert.match(block, /backendUnavailable:\s*true/,
      '必须把机器标记带出这一层');
  });

  it('翻译层：标记优先于兜底', () => {
    const view = read('src/components/sync/syncPreviewView.tsx');
    assert.match(view, /if\s*\(input\.backendUnavailable\)/,
      'resolveSyncFailureCopy 必须先判机器标记');
    assert.match(view, /backendUnavailableCopy\(/, '命中时用专用文案');
  });
});

/* ── ④ 后台：不可重试的失败不推进退避阶梯 ─────────────────────────── */

describe('后台：不可重试的失败不推进退避阶梯（那会烧 egress 配额）', () => {
  it('handleAlarm：先早退，再 recordSyncFailure', () => {
    const src = read('src/background/backgroundSync.ts');
    const start = src.indexOf('async function handleAlarm');
    assert.ok(start !== -1, '应能找到 handleAlarm');
    const body = src.slice(start, src.indexOf('\n/**', start + 10));
    const guardAt = body.indexOf('outcome.backendUnavailable');
    const failureAt = body.indexOf('recordSyncFailure(');
    assert.ok(guardAt !== -1, '失败分支里必须有「服务端不可用」的早退');
    assert.ok(
      guardAt < failureAt,
      '「服务端不可用」必须在 recordSyncFailure **之前**早退 —— ' +
        '否则会按 1/2/5 分钟重试，而重试既无用**又烧配额**（配额超限正是封禁原因）'
    );
  });

  it('早退分支：不推进阶梯、拉长间隔、保持 alarm 存活', () => {
    const src = read('src/background/backgroundSync.ts');
    const start = src.indexOf('async function handleAlarm');
    const body = src.slice(start, src.indexOf('\n/**', start + 10));
    const guardAt = body.indexOf('outcome.backendUnavailable');
    const failureAt = body.indexOf('recordSyncFailure(');
    const branch = body.slice(guardAt, failureAt);
    assert.doesNotMatch(branch, /recordSyncFailure\(/,
      '早退分支里不许推进退避阶梯');
    assert.match(branch, /rescheduleAlarm\(/, '必须重排 alarm（保持存活，否则恢复后不自愈）');
    assert.match(branch, /BACKEND_UNAVAILABLE_RETRY_MINUTES/,
      '间隔必须用「不可重试」那一档（显著长于 1/2/5 分钟）');
  });

  it('间隔显著长于普通退避阶梯（1/2/5 分钟）', async () => {
    const { BACKEND_UNAVAILABLE_RETRY_MINUTES } = await import('@/background/backgroundSync');
    const { BACKOFF_LADDER_MINUTES } = await import('@/background/syncBackoff');
    const worst = Math.max(...BACKOFF_LADDER_MINUTES);
    assert.ok(
      BACKEND_UNAVAILABLE_RETRY_MINUTES > worst,
      `不可重试的间隔（${BACKEND_UNAVAILABLE_RETRY_MINUTES} 分钟）必须长于普通退避封顶（${worst} 分钟）`
    );
  });

  it('上传口与下载口都归类（漏一个就有一条路仍在烧配额）', () => {
    const src = read('src/background/backgroundSync.ts');
    const occurrences = (stripComments(src).match(/backendUnavailable:\s*true/g) ?? []).length;
    assert.ok(
      occurrences >= 2,
      '上传口与下载口都要归类成「服务端不可用」（漏一个就有一条路仍按 5 分钟重试）'
    );
  });
});

/* ── ⑤ 变异自证：把话术改回「请重试」必须变红 ─────────────────────── */

describe('变异自证：判据看得见「退退回请重试」', () => {
  /**
   * 判据函数：这段文案是否满足「说清三件事 + 不含错方向引导」。
   *
   * 做成**吃文案**的纯函数（而不是直接断言常量），这样下面的自证可以直接
   * 喂它一段「被改坏的文案」，断言它**看得见**这个破口 —— 比「改文件→跑→
   * 改回来」可靠，也不会在失败时留下半改的工作区。
   */
  function copySatisfiesProperties(copy: string): boolean {
    const hasLocalIntact = copy.includes('本地') && /没丢|没有丢|完好/.test(copy);
    const hasNotYourFault = /不是你的|与你无关/.test(copy);
    const hasNextStep = /恢复|自带存储|WebDAV/.test(copy);
    const noWrongAdvice = !/请重试|请稍后重试|导出诊断|若反复出现/.test(copy);
    return hasLocalIntact && hasNotYourFault && hasNextStep && noWrongAdvice;
  }

  it('当前文案满足这些性质', async () => {
    const {
      backendUnavailableCopy,
      backendUnavailableAuthCopy,
      backendUnavailableBackgroundNotice,
    } = await import('@/components/sync/backendUnavailableCopy');
    for (const copy of [
      backendUnavailableCopy('upload'),
      backendUnavailableCopy('download'),
      backendUnavailableAuthCopy(),
      backendUnavailableBackgroundNotice(),
    ]) {
      assert.equal(copySatisfiesProperties(copy), true, '当前文案必须满足这些性质');
    }
  });

  it('把话术改回「请重试」 ⇒ 判据必须变红', async () => {
    const { backendUnavailableCopy } = await import('@/components/sync/backendUnavailableCopy');
    const original = backendUnavailableCopy('upload');

    // 破口 1：退回到修复前那句「请重试」。
    const reverted = '上传失败，请重试。若反复出现，请导出诊断信息';
    assert.notEqual(reverted, original, '前提没成立：破口样本与当前文案相同');
    assert.equal(
      copySatisfiesProperties(reverted),
      false,
      '判据失效：退回「请重试」后仍被判定为合格'
    );

    // 破口 2：只说「云端有问题」，漏掉「本地没丢」这一件。
    const noLocalPromise = '云端暂时不可用，请稍后再试';
    assert.equal(
      copySatisfiesProperties(noLocalPromise),
      false,
      '判据失效：漏掉「本地数据没丢」仍被判定为合格'
    );

    // 破口 3：甩锅给用户（让他导出诊断）。
    const blameUser = '云端暂时不可用，你的本地会话一个都没有丢，这不是你的操作或数据的问题。请导出诊断信息。';
    assert.equal(
      copySatisfiesProperties(blameUser),
      false,
      '判据失效：「请导出诊断信息」仍被判定为合格'
    );

    // 破口 4：没有可执行的下一步。
    const noNextStep = '云端暂时不可用，你的本地会话一个都没有丢，这不是你的操作或数据的问题。';
    assert.equal(
      copySatisfiesProperties(noNextStep),
      false,
      '判据失效：没有下一步仍被判定为合格'
    );
  });

  it('把判据改回「文案匹配」⇒ 不得仍然成立（判据必须靠机器字段）', async () => {
    const { isBackendUnavailable } = await import('@/core/backendUnavailable');
    // 若有人把判据改成「消息里出现『不可用』就认」，那中文界面文案会
    // 互相污染（界面那句「云端暂时不可用」本身就会把错误判成服务端不可用）。
    assert.equal(
      isBackendUnavailable({ message: '云端暂时不可用，你的本地会话一个都没有丢' }),
      false,
      '判据不得认界面自己的中文文案（否则界面文案一改，判据就漂）'
    );
  });
});
