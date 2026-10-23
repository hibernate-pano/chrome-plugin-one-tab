import { createSlice, createAsyncThunk, type PayloadAction } from '@reduxjs/toolkit';
import { AuthState, User } from '@/types/tab';
import type { AuthCheckState } from '@/types/tab';
import { accountScopeStore, authCache } from '@/utils/authCache';
import { createAccountScopeRecord, decideAccountBind } from '@/core/accountScope';
import {
  BackendUnavailableError,
  isBackendUnavailable,
  isBackendUnavailableError,
  readHttpStatus,
} from '@/core/backendUnavailable';
import { backendUnavailableAuthCopy, authUnknownCopy } from '@/components/sync/backendUnavailableCopy';
import { classifySessionFailure } from '@/core/sessionFailure';
import { storage } from '@/utils/storage';
import { loadSupabaseFacade, type SupabaseFacadeModule } from '@/utils/supabaseRuntime';
import { isDeadlineExceeded } from '@/utils/deadline';
import { logError, logInfo, logWarn } from '../../utils/log';

/**
 * 核对登录态的**等待上限**：5 秒（2026-10-23，第 51 轮）。
 *
 * ⚠️ 上限住在**读会话的唯一入口**（`utils/supabase/sessionRead.ts`），
 * 不在本文件 —— 同步路径读会话也要有同一个上限，两边各写一份会漂。
 * 为什么要上限、为什么是 5 秒：见 sessionRead.ts 的注释。
 *
 * ⚠️ 到了上限**不是**「没登录」，而是「**不知道**」——
 * 那一档由 rejected 分支记成 `unknown`，界面说「联系不上云端」，
 * 登录态**按缓存保留**（见本文件下方的 rejected 分支）。
 */

/**
 * 加载 Supabase 登录封装（**按需加载**）。
 *
 * ── 为什么不是静态 import ────────────────────────────────────────────────
 * `@/utils/supabaseFacade` 会把整条 Supabase 链拖进来：SDK（gzip 约 58KB）
 * + upload / download / probe / readback（约 140KB 源码）。
 * 而弹窗首屏（用户只想看本机会话列表）**不需要**它。
 *
 * 加载时机：登录 / 退出 / 校验登录态的那一刻（都是用户主动或恢复触发的
 * 异步动作）。首屏渲染**不等**它 ⇒ 首屏不必为它下载 58KB。
 *
 * 行为零变化：调用序列、错误语义、失败分支全部照旧；变的只是
 * 「什么时候把 SDK 拉进来」。
 *
 * ⚠️ **service worker 里不能用 `import()`**（Chrome 按 HTML 规范禁止），
 * 而 SW 侧的 `restoreAuth` 也要校验登录态 ⇒ 取法由
 * `utils/supabaseRuntime.ts` 统一：页面动态加载，SW 由入口注册静态加载器。
 */
async function loadSupabaseAuth() {
  const { auth } = await loadSupabaseFacade();
  return auth;
}

/* ── 认证错误的中文化（2026-10-20 审计 C-07）───────────────────────────────
 *
 * 缺陷：登录 / 注册失败时，界面直接把 Supabase 的英文原文弹给用户
 * （`Invalid login credentials` / `User already registered` / `Email not confirmed`）。
 * 全中文界面里冒出英文机器串：用户看不懂，也分不清是自己输错了还是服务出问题了。
 *
 * 口径（**原始英文只进 console 日志，不进 UI**）：
 *   1. 命中已知模式 ⇒ 对应的中文说明；
 *   2. 原文本来就是中文 ⇒ 原样透传（别把已经翻译好的说明再翻一遍）；
 *   3. 都不命中 ⇒ 通用中文兜底，**绝不**把英文原文透给用户。
 *
 * 之所以放在 slice 这一层而不是 LoginForm / RegisterForm：那两个组件是纯展示层，
 * 错误文案的真源应该与「错误从哪来」同处一地；组件拿到的已经是中文。
 */

/** 是否含中日韩统一表意文字（用来判断「原文已经是中文」）。 */
const HAS_CJK = /[一-鿿]/;

/**
 * 已知错误模式 → 中文文案。
 *
 * 用模式匹配而不是精确等值：Supabase 的文案随版本微调（大小写、标点、
 * 前缀），精确等值等于赌它永远不变——赌输了就把英文原文漏进界面。
 */
const AUTH_ERROR_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/invalid login credentials/i, '邮箱或密码不正确'],
  [/user already registered/i, '该邮箱已注册，请直接登录'],
  [/email not confirmed/i, '邮箱尚未完成验证，请先到邮箱点击验证链接后再登录'],
  [/password should be at least\s*(\d+)/i, '密码至少需要 $1 位'],
  [/unable to validate email address/i, '邮箱地址无法通过校验，请检查后重试'],
  [/invalid email|email address .* invalid/i, '邮箱地址格式不正确'],
  [/email rate limit exceeded|too many requests|rate limit/i, '操作太频繁，请稍后再试'],
  [/signups? not allowed|signup is disabled/i, '当前未开放注册，请直接登录已有账号'],
  [/failed to fetch|network\s*error|networkerror|load failed/i, '网络连接失败，请检查网络后重试'],
];

/**
 * 原始错误消息 → 用户可读的中文文案。
 *
 * 纯函数（不打日志）：原始消息的落盘由调用方负责，本函数只负责翻译。
 *
 * @param raw 原始错误消息（Supabase 英文原文或已翻译的中文）
 * @param fallback 无法识别时的中文兜底
 */
export const authErrorCopy = (
  raw: string | undefined | null,
  fallback = '操作失败，请稍后重试'
): string => {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return fallback;
  // 已经是中文 → 原样透传（幂等：重复调用不会二次翻译）
  if (HAS_CJK.test(text)) return text;
  for (const [pattern, copy] of AUTH_ERROR_PATTERNS) {
    const matched = text.match(pattern);
    if (matched) {
      return copy.replace(/\$(\d+)/g, (_, n: string) => matched[Number(n)] ?? n);
    }
  }
  // 未识别的英文 ⇒ 兜底，**不**把原文透给用户
  return fallback;
};

/** 从 Supabase 的 error 对象里取出 message（形状不稳定，取不到就返回 undefined）。 */
const supabaseErrorMessage = (error: unknown): string | undefined => {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message: unknown }).message;
    return typeof message === 'string' ? message : undefined;
  }
  return undefined;
};

/**
 * 账号相关的错误 → 中文文案（2026-10-22，402 收口）。
 *
 * ── 为什么要单独一个函数（而不是直接用 authErrorCopy）───────────────────
 * `authErrorCopy` 的兜底是「操作失败，请稍后重试」/「获取用户信息失败，请稍后重试」
 * —— 对**服务端项目被限制**（生产实测 402）来说是**错的方向**：
 *   ① 「请稍后重试」——重试一万次也一样（项目被封禁）；
 *   ② 更糟的是它把「服务端挂了」说成「获取用户信息失败」——用户会以为是
 *      自己的账号有问题，反复改密码、重新注册，而**他其实已经登录了**。
 *
 * 而这一层是**最要命**的一层：账号校验失败 ⇒ `getCurrentUser` thunk reject ⇒
 *   · syncEngine.ensureAuthenticated → restoreAuth 失败 ⇒ 整个同步说「用户未登录」；
 *   · backgroundSync 第 1 步 → 返回 not_logged_in ⇒ **后台每轮静默跳过**。
 * 也就是说：**在账号恢复这一层被吞掉的话，后面所有同步文案都修不好**。
 *
 * 判据用**机器字段**（HTTP 状态码 / 报文标记），不靠文案匹配 ——
 * 见 core/backendUnavailable.ts 的完整论证。
 */
export const authBackendUnavailableCopy = (error: unknown): string | null => {
  if (!isBackendUnavailable(error)) return null;
  return backendUnavailableAuthCopy();
};

/**
 * 「云端不可用」的错误 → **统一**成带机器标记的专用错误（2026-10-23，第 52 轮）。
 *
 * ── 为什么必须「统一」，而不是「命中就抛」──────────────────────────────
 * RTK 的 `miniSerializeError` 只保留 `name / message / stack / code`
 * ⇒ SDK 原始错误上的 `status`（402 / 503）**在 rejected action 里会丢**
 * ⇒ 上层只能靠 `code` 认出「云端不可用」这一档
 * ⇒ 抛出去的必须是带 `code: 'backend_unavailable'` 的那一个；
 *   否则这一档会掉回「登录失败，请稍后重试」—— **错方向**的那句话
 *   （用户会以为是自己密码错了 ⇒ 反复改密码、重新注册，而他其实没输错）。
 *
 * ⚠️ 判据必须喂**原始**错误：包装过的 `new Error(...)` 只剩 message，
 * 状态码（402 / 503）就看不见了 ⇒ 那一档就认不出来了。
 *
 * @returns 是「云端不可用」就返回统一后的错误；不是就返回 null（走普通失败）。
 */
const toBackendUnavailable = (error: unknown): BackendUnavailableError | null => {
  if (isBackendUnavailableError(error)) {
    // 已经是本仓的专用错误 ⇒ 原样带出（别把 httpStatus 弄丢）。
    if (error instanceof BackendUnavailableError) return error;
    // 是 SDK 的原始错误（status 在，但序列化会丢）⇒ 换成带 code 的那一个。
    return new BackendUnavailableError(
      backendUnavailableAuthCopy(),
      readHttpStatus(error) ?? undefined,
    );
  }
  const copy = authBackendUnavailableCopy(error);
  if (!copy) return null;
  return new BackendUnavailableError(copy, readHttpStatus(error) ?? undefined);
};

const initialState: AuthState = {
  user: null,
  isAuthenticated: false,
  isLoading: false,
  error: null,
  // ⚠️ 还没核过（不是「没登录」）。见 AuthCheckState 的注释。
  authStatusKind: 'unchecked',
};

/**
 * 登录这一刻给本机会话「认账」（2026-10-22 审计 DS-1：跨账号数据泄露）。
 *
 * ── 为什么必须有这一步 ──────────────────────────────────────────────────
 * 退出账号 A、再登录账号 B 时，本机残留的 A 的会话会原样留在列表里；
 * 随后一次上传会用 **B 的 userId 作 user_id、用 B 的 userId 派生密钥加密**，
 * 把 A 的私有数据写进 B 的账号行里 —— 零提示。
 *
 * 本机那批会话存在**一个**不分账号的键里（`tab_groups`），而云端按 user_id
 * 分行 —— 「本机这批会话属于谁」这个事实必须有人记着，否则每次上传都只能
 * 「拿当前账号盖上去」。
 *
 * ── 这一步做什么 ───────────────────────────────────────────────────────
 * 1. 读归属记录（chrome.storage.local 的独立键，见 utils/authCache.ts）；
 * 2. 读本机现有会话 id；
 * 3. 用 core/accountScope 的纯函数判定：首次绑定 / 同一个账号 / 换账号；
 * 4. 换账号 ⇒ 本机旧会话认账给上一个账号 + 生成一条要告知用户的提示。
 *
 * ── 失败不许阻断登录 ───────────────────────────────────────────────────
 * 登录本身已经成功了，为一条「归属记录」把用户踢回登录页是更糟的结果。
 * 认账失败的后果是**上传闸门更保守**（归属记录没更新 ⇒ 旧归属仍在 ⇒
 * 旧会话在新账号下被挡住），方向是安全的。
 */
export async function bindLocalSessionsToAccount(userId: string): Promise<void> {
  try {
    const record = await accountScopeStore.read();
    // 已经是这个账号 ⇒ 什么都不用改（也不必枚举本机会话：99% 的路径走这里）。
    if (record && record.ownerUserId === userId) return;

    const scope = record ?? createAccountScopeRecord();
    // 读-改-写口径的快照（先落盘 pending 写、失效 30s 缓存）：
    // 用 getGroups() 的缓存快照会漏掉「刚保存、还没落盘」的会话。
    const groups = await storage.getGroupsForWrite();
    // ── 2026-10-23 审计 R-1 / DS-43-1：删除意图队列里的 id 也要参与认账 ──
    // 一条被**物理删除**的会话不在 getGroupsForWrite() 里（v1.22.0 起删除即
    // 物理清除），但它的**删除意图**还在队列里，而那条意图**要发给它的真正
    // 主人**。若不把它算进认账，这条会话的归属事实（属于上一个账号）会在
    // 换账号时**当场丢失** ⇒ 换账号后它的删除意图被发给**新账号**：
    // ① 越权写（往新账号的云端写了一行不属于它的墓碑）；
    // ② 读回校验把「云端没这行」判成「意图已达成」（missingAsAchieved）
    //    ⇒ 删除意图被清队 ⇒ 那条会话在它真正的主人账号下**复活**（零提示）。
    //
    // 队列读不出来时**不吞**：让这一整个认账失败（catch 里记日志）⇒ 归属记录
    // 保持原样（旧归属仍在 ⇒ 闸门更保守）⇒ 方向是安全的。
    const pendingDeleteIds = await storage.getPendingDeleteIds();
    const decision = decideAccountBind(
      scope,
      userId,
      groups.map(g => g.id),
      Date.now(),
      pendingDeleteIds
    );
    await accountScopeStore.write({
      ...decision.nextScope,
      // 已有提示不许被这次认账抹掉（还没告知用户的提示必须留着 ⇒ 不许静默）。
      pendingNotice: decision.notice ?? scope.pendingNotice,
    });

    if (decision.kind === 'account-switch') {
      logWarn(
        `[auth] 检测到换账号：本机 ${decision.residualCount} 个会话属于上一个账号` +
          `（其中 ${decision.previousOwnedCount} 个），它们不会被上传到当前账号` +
          '（提示已备好，登录后会告知用户）'
      );
    }
  } catch (error) {
    logError('[auth] 认账本机会话归属失败:', error);
  }
}

export const signUp = createAsyncThunk(
  'auth/signUp',
  async ({ email, password }: { email: string; password: string }) => {
    try {
      const supabaseAuth = await loadSupabaseAuth();
      const { data, error } = await supabaseAuth.signUp(email, password);
      if (error) {
        logError('注册错误:', error);
        // ── 2026-10-23（第 52 轮）：**先问「是不是云端不可用」** ──────────
        // 「注册失败，请稍后重试」是**错的方向**：项目被限制（生产实测 402）时
        // 重试一万次也一样，而用户会以为自己填错了邮箱 ⇒ 白折腾。
        // ⇒ 命中「云端不可用」就抛**带机器标记**的专用错误，让上层走
        //   `backend_unavailable` 那一档（等我们恢复），而不是「你失败了」。
        const unavailable = toBackendUnavailable(error);
        if (unavailable) throw unavailable;
        throw new Error(authErrorCopy(supabaseErrorMessage(error), '注册失败，请稍后重试'));
      }

      if (data.user) {
        return {
          id: data.user.id,
          email: data.user.email!,
          lastLogin: new Date().toISOString(),
        } as User;
      }

      throw new Error('注册失败，请稍后重试');
    } catch (err) {
      logError('注册异常:', err);
      // ⚠️ 「云端不可用」**不许**在这里被降级成普通 Error：
      //    降级后机器标记（code）就丢了 ⇒ 上层读不到 `backend_unavailable`
      //    ⇒ 那一档掉回「注册失败，请稍后重试」（本轮要消灭的那句错方向的话）。
      //    这一支同时兜住「SDK 直接抛」的情况（auth-js 遇到 503 会抛
      //    `AuthRetryableFetchError`，不一定走 `{error}` 返回值那条路）。
      const unavailable = toBackendUnavailable(err);
      if (unavailable) throw unavailable;
      if (err instanceof Error) {
        throw new Error(authErrorCopy(err.message, '注册失败，请稍后重试'));
      } else {
        throw new Error('注册失败，请稍后重试');
      }
    }
  }
);

export const signIn = createAsyncThunk(
  'auth/signIn',
  async ({ email, password }: { email: string; password: string }) => {
    try {
      const supabaseAuth = await loadSupabaseAuth();
      const { data, error } = await supabaseAuth.signIn(email, password);
      if (error) {
        logError('登录错误:', error);
        // ── 2026-10-23（第 52 轮）：**先问「是不是云端不可用」** ──────────
        // 「登录失败，请稍后重试」是**错方向**的那句话（`core/authSdkStatus.ts`
        // 自己就是这么判的）：项目被限制（生产实测 402）时重试一万次也一样，
        // 而用户会以为**自己密码错了** ⇒ 反复改密码、重新注册 —— 而他没输错。
        //
        // ⚠️ 为什么这一条现在更要紧：第 51 轮修好之后**会话活下来了**
        // ⇒ 用户更可能真的走到「登录」这一步 ⇒ 撞上这句话的概率更高了。
        //
        // ⇒ 命中「云端不可用」就抛**带机器标记**的专用错误，让上层走
        //   `backend_unavailable` 那一档（等我们恢复），而不是「你失败了」。
        const unavailable = toBackendUnavailable(error);
        if (unavailable) throw unavailable;
        throw new Error(authErrorCopy(supabaseErrorMessage(error), '登录失败，请稍后重试'));
      }

      if (data.user) {
        // DS-1：登录这一刻必须给本机会话「认账」——本机那批会话属于上一个账号
        // 还是这个账号，是后面所有上传闸门的依据。
        await bindLocalSessionsToAccount(data.user.id);
        return {
          id: data.user.id,
          email: data.user.email!,
          lastLogin: new Date().toISOString(),
        } as User;
      }

      throw new Error('登录失败，请稍后重试');
    } catch (err) {
      logError('登录异常:', err);
      // ⚠️ 「云端不可用」**不许**在这里被降级成普通 Error：
      //    降级后机器标记（code）就丢了 ⇒ 上层读不到 `backend_unavailable`
      //    ⇒ 那一档掉回「登录失败，请稍后重试」（本轮要消灭的那句错方向的话）。
      //    这一支同时兜住「SDK 直接抛」的情况（auth-js 遇到 503 会抛
      //    `AuthRetryableFetchError`，不一定走 `{error}` 返回值那条路）。
      const unavailable = toBackendUnavailable(err);
      if (unavailable) throw unavailable;
      if (err instanceof Error) {
        throw new Error(authErrorCopy(err.message, '登录失败，请稍后重试'));
      } else {
        throw new Error('登录失败，请稍后重试');
      }
    }
  }
);





/**
 * 「已从本机登出」这句话（2026-10-23，第 52 轮）。
 *
 * ⚠️ 为什么**不说**「已退出登录」：`scope: 'local'` 撤的是**这一台**
 * ⇒ 说「已退出登录」会被理解成「所有设备都退了」—— 那是**假的**
 * （别的设备上的会话还在云端，仍是登录态）。
 *
 * ⚠️ 这一句是**降级档**才说的（云端不可用 ⇒ 服务端那一侧压根没撤成）。
 * 正常登出时界面自己会说「已退出登录」，那一档由组件负责（见
 * `components/layout/HeaderDropdown.tsx`），本仓的组件不在本轮范围内。
 */
const LOCAL_SIGNOUT_COPY =
  '已从本机登出。TapStack 云端暂时不可用，其它设备可能仍是登录状态。';

/**
 * 原始 SDK 的 auth 客户端（`facade.supabase.auth`）。
 *
 * ⚠️ 为什么不用门面里那个包装对象（`supabase/auth.ts` 的 `auth`）：
 * 它的 `signOut()` **不收参数** ⇒ 恒是默认的 `scope: 'global'`
 * ⇒ 撤的是**所有设备**的会话 ⇒ 用户看到的「已退出登录」会被读成
 * 「所有设备都退了」（假的）。要传 scope 就得拿**原始客户端**。
 */
type SupabaseAuthClient = SupabaseFacadeModule['supabase']['auth'];

/** 「服务端登出」的结果（哪些撤成了、哪些没撤成）。 */
interface ServerSignOutOutcome {
  /** 服务端那一侧撤成了吗？ */
  revoked: boolean;
  /** 没撤成的原因是「云端不可用」吗？（这一档要说「等我们恢复」） */
  cloudUnavailable: boolean;
  /** 原始错误（只进日志，不面向用户）。 */
  error: unknown;
}

/**
 * 服务端登出：**尽力而为**，失败**不许**挡住「本机登出」。
 *
 * ── 借 `readSessionSafely` 的**两道闸门**（2026-10-23，第 52 轮）───────
 * 这里借的是它的闸门，不是它的语义：
 *   · `requireCloudAvailable` ⇒ **云端明确不可用就不碰 SDK**
 *     （SDK 的 signOut 会先去刷新会话 ⇒ 刷新撞上故障 ⇒ 连打 8 次、
 *      退避 25.4 秒 ⇒ 界面卡 25 秒；而且刷新失败时它**直接早退**，
 *      连本机会话都不清 ⇒ 用户换不了账号）；
 *   · `withDeadline`（5 秒）⇒ 竞态（云端刚好在探活之后挂掉）也不卡界面。
 *
 * ⚠️ 为什么**只能**借它：popup 首屏的静态闭包不许 import `src/utils/supabase/**`
 * （构建期首屏准入闸门，见 `core/firstScreenPolicy.ts`）
 * ⇒ 那两道闸门在本文件里**只能**从按需加载的门面取。
 * ⇒ 数据位放一个空会话、错误位放登出的错误 —— 借闸门不借语义。
 */
const bestEffortServerSignOut = async (
  facade: SupabaseFacadeModule,
  client: SupabaseAuthClient,
): Promise<ServerSignOutOutcome> => {
  try {
    const result = await facade.readSessionSafely(
      async () => {
        // ⚠️ `scope: 'local'` ⇒ **只撤这一台**（其它设备的会话不动）。
        const r = await client.signOut({ scope: 'local' });
        return { data: { session: null }, error: r.error };
      },
      '退出登录',
    );
    if (result.error) {
      // 服务端那一侧撤不成 —— 但**本机照登**（见 signOut 的注释）。
      logWarn('[auth] 服务端登出没成（本机照登）:', result.error);
      return {
        revoked: false,
        cloudUnavailable: isBackendUnavailable(result.error),
        error: result.error,
      };
    }
    return { revoked: true, cloudUnavailable: false, error: null };
  } catch (err) {
    if (isBackendUnavailableError(err)) {
      // 探活判的「云端不可用」⇒ 服务端那一侧压根没碰（SDK 也没被碰）。
      logWarn('[auth] 云端不可用，服务端登出没做（本机照登）:', err);
      return { revoked: false, cloudUnavailable: true, error: err };
    }
    if (isDeadlineExceeded(err)) {
      // 到期限了 ⇒ 服务端那一侧我们**不等了**（本机照登）。
      // ⚠️ 底层那个 SDK 调用**仍在跑**（`withDeadline` 不取消）——
      //    但它只是「撤会话」，不会把会话写回来 ⇒ 不会把本机登出撤销掉。
      logWarn('[auth] 服务端登出超过期限，不等了（本机照登）:', err);
      return { revoked: false, cloudUnavailable: false, error: err };
    }
    logWarn('[auth] 服务端登出异常（本机照登）:', err);
    return { revoked: false, cloudUnavailable: false, error: err };
  }
};

/**
 * 清掉**本机**的 Supabase 会话（**不联网**）。
 *
 * ── 为什么必须我们自己清（2026-10-23，第 52 轮）──────────────────────
 * auth-js 2.118 的 `_signOut`（`GoTrueClient.js:3427`）**先**走 `_useSession`
 * ⇒ `__loadSession` ⇒ 本地会话过期时它**先去刷新**
 * ⇒ 刷新撞上云端故障（402 → 翻译成 503）⇒ `_useSession` 返回一个 error
 * ⇒ `_signOut` **直接早退**（`GoTrueClient.js:3434-3436`）
 * ⇒ **`_removeSession()` 压根没被调用** ⇒ 本机会话原样留着
 * ⇒ 用户想换个账号时**登不出去**（界面还显示他登录着）。
 *
 * ⚠️ 这与 scope **无关**：`scope` 只决定「撤服务端哪几个会话」与
 * 「要不要清本机」（`scope !== 'others'`），**不决定要不要先读会话**
 * ⇒ 换成 `scope: 'local'` 一样会先刷新 ⇒ 一样会早退 ⇒ 一样清不掉。
 *
 * `_removeSession`（`GoTrueClient.js:4421`）是**纯本地**的：删会话键 +
 * PKCE 校验器 + 用户键，并广播 `SIGNED_OUT`。
 * ⚠️ 它是 SDK 的**私有**方法 ⇒ 用 `typeof` 守卫；将来 SDK 改名/删掉时，
 * 这里返回 false ⇒ 那一层如实报「退出登录失败」（而不是假装登出了）。
 * 守卫见 `tests/guards/authOutageUserFacing.test.ts`。
 */
const clearLocalSession = async (client: SupabaseAuthClient): Promise<boolean> => {
  const remove = (client as unknown as { _removeSession?: () => Promise<void> })
    ._removeSession;
  if (typeof remove !== 'function') {
    logWarn('[auth] SDK 没有本地清理方法（_removeSession 不在了）—— 本机会话可能还在');
    return false;
  }
  await remove.call(client);
  return true;
};

/**
 * 退出登录（2026-10-23，第 52 轮：**云端故障期间也必须登得出去**）。
 *
 * ── 原来为什么登不出去 ──────────────────────────────────────────────────
 * ① `signOut()` 默认 `scope: 'global'` ⇒ 撤的是**所有设备**的会话；
 * ② auth-js 2.118 的 `_signOut`（`GoTrueClient.js:3427`）**先**走 `_useSession`
 *    ⇒ 本地会话过期时它**先去刷新** ⇒ 刷新撞上云端故障（402 → 翻译成 503）
 *    ⇒ `_useSession` 返回 error ⇒ `_signOut` **直接早退**
 *    （`GoTrueClient.js:3434-3436`）⇒ **`_removeSession()` 没被调用**
 *    ⇒ 本机会话原样留着 ⇒ 用户想换个账号时**登不出去**。
 *
 * ⚠️ **换 scope 解决不了 ②**（这是查 SDK 源码得出的，不是凭印象）：
 * `_signOut` 无条件走 `_useSession`，`scope` 只决定「撤服务端哪几个会话」
 * 与「要不要清本机」⇒ **`scope: 'local'` 一样会先刷新、一样会早退**。
 * ⇒ 真正要补的是「本机这一侧由我们自己保证」（`clearLocalSession`）。
 *
 * ── 现在怎么做（三步，顺序有理由）──────────────────────────────────────
 * ① **服务端登出：尽力而为** —— `scope: 'local'`（只撤**这一台** ⇒ 别的设备
 *    仍登录 ⇒ 用户看到的文案因此只能说「已从本机登出」）。
 * ② **本机登出：必须发生** —— 不管 ① 成不成功，本机这一台一定要登出去
 *    （用户的目的就是「换账号」⇒ 登不出去 = 这一步白做）。
 * ③ **文案说准** —— 见 `LOCAL_SIGNOUT_COPY`。
 */
export const signOut = createAsyncThunk(
  'auth/signOut',
  async () => {
    try {
      // 移除实时同步功能，简化逻辑
      logInfo('已简化同步逻辑，只保留手动同步功能');

      // 门面（**按需加载**）：见文件头「为什么是按需加载」。
      const facade = await loadSupabaseFacade();
      // ⚠️ 用**原始 SDK 客户端**（不是门面里那个包装对象）：包装对象的
      // `signOut()` 不收参数 ⇒ 恒是 `scope: 'global'`（撤所有设备）。
      const client = facade.supabase.auth;

      // ① 服务端登出：尽力而为（失败**不许**挡住本机登出）。
      const server = await bestEffortServerSignOut(facade, client);

      // ② 本机登出：**必须发生**。
      const localCleared = await clearLocalSession(client);

      if (!localCleared) {
        // 本机这一侧真的没清掉 ⇒ 如实报失败（不许假装「已登出」）。
        throw new Error(
          authErrorCopy(supabaseErrorMessage(server.error), '退出登录失败，请稍后重试'),
        );
      }

      logInfo(
        server.revoked
          ? '退出登录成功（服务端与本机都撤了）'
          : '已从本机登出（服务端那一侧没撤成：云端不可用或请求失败）',
      );
      return { serverRevoked: server.revoked, cloudUnavailable: server.cloudUnavailable };
    } catch (err) {
      logError('退出登录异常:', err);
      if (err instanceof Error) {
        throw new Error(authErrorCopy(err.message, '退出登录失败，请稍后重试'));
      } else {
        throw new Error('退出登录失败，请稍后重试');
      }
    }
  }
);

export const getCurrentUser = createAsyncThunk(
  'auth/getCurrentUser',
  async () => {
    // 门面模块（**按需加载**）：见下面「为什么绕这一下」。
    let facade: SupabaseFacadeModule | null = null;
    try {
      // ── 2026-10-23（第 51 轮）：读会话走**唯一入口** ──────────────────────
      // 【那一层做三件事】
      // ① **先问一句「云端在吗」**：明确不可用（402/503/52x）就**不碰 SDK**
      //    ⇒ 用户的会话**连读都没被读**，更没机会被 SDK 删掉
      //    （SDK 把一次云端故障当成「刷新令牌已死」⇒ 一次故障 = 一次全员登出）；
      //    而且 SDK 是**惰性加载**的 ⇒ 云端挂着时设置页连那 ≈75KB 都不用下。
      // ② **等待有上限**（5 秒，见 utils/supabase/sessionRead.ts）：
      //    auth SDK 的刷新失败会连打 8 次、退避 25.4 秒 ⇒ 没有上限的话，
      //    云端一挂，弹窗/设置页就卡 25 秒，而「云端暂时不可用」这句话
      //    **根本来不及送到界面上**（用户只看到「转圈」）。
      // ③ **失败原样带出**：判据（402 / 401 / 断网）不被丢掉 ⇒ 下面能按
      //    **失败原因**分流，而不是把「核不到」读成「没登录」。
      //
      // ⚠️ **为什么绕这一下（从门面取，而不是静态 import）**：
      // `src/utils/supabase/` 整个目录都在弹窗首屏的**禁止组**里
      // （构建期闸门 `firstScreenPolicyGate`：首屏不许下载整条云端栈），
      // 而本文件在首屏的**静态**闭包里 ⇒ 它**不许**静态 import 那目录里的
      // 任何东西 ⇒ 「读会话的唯一入口」与「不可用观测」都从**按需加载**的
      // 门面取（首屏不下载它们）。
      const f = await loadSupabaseFacade();
      facade = f;
      const { data: sessionData, error: sessionError } = await f.readSessionSafely(
        () => f.auth.getSession(),
        '读取会话'
      );

      // ── 2026-10-23（第 50 轮）：**读会话失败 ≠ 「没登录」**───────────────
      // 【原来的缺陷】`const { data: sessionData } = await getSession();`
      // **只取 data、丢掉 error** ⇒ 刷新失败时 session 是 null、失败原因被丢掉
      // ⇒ 这一层返回 null ⇒ 上游读成「服务端明确说没有会话」
      // ⇒ ① 界面说「未登录」；② `authCache.clearAuthState()` 把本机缓存清空。
      //
      // 【为什么这是本轮最重的一个缺陷】用户明明登录着（只是刷新令牌过期了、
      // 网络断了、云端 402），却被告知「没登录」并被要求重新输密码 ——
      // 而重新登录在断网/402 时**必然失败** ⇒ 死循环。
      // 旧代码对这一格免疫：它先 `getSession()`，**有会话才去核**，
      // 失败时旧路径只是「核不到」，不会被读成「没登录」。
      //
      // 【现在怎么做】按**失败原因**分流（判据见 core/sessionFailure.ts）：
      //   · 会话真的死了（刷新令牌被吊销/已被用过）⇒ 确实没登录 ⇒ 返回 null；
      //   · 服务端整体不可用（402）⇒ 抛 BackendUnavailableError（机器标记要活着）；
      //   · 核不到（断网等）⇒ 抛出去 ⇒ thunk **reject**
      //     ⇒ 登录态**按缓存保留**，界面说「现在联系不上云端」，**不说「未登录」**。
      if (sessionError) {
        const failure = classifySessionFailure(sessionError);
        if (failure.kind === 'session_expired') {
          // 会话真的死了 ⇒ 确实没登录（这一档说「未登录」是**诚实的**）。
          logInfo('[auth] 会话已失效（刷新令牌无效），按未登录处理:', failure.detail);
          return null;
        }
        if (failure.kind === 'backend_unavailable') {
          // 机器标记必须活着（下游认 `code: 'backend_unavailable'`），
          // 状态码只用于日志。
          throw new BackendUnavailableError(
            `读取会话失败：${failure.detail}`,
            failure.httpStatus,
          );
        }
        // 核不到（断网 / 超时 / 通道断了）⇒ 抛出去。
        // ⚠️ 抛出去 ⇒ thunk reject ⇒ 走 rejected 分支 ⇒ **不清缓存、不归零**。
        throw new Error(`读取会话失败：${failure.detail}`);
      }

      // 如果没有会话，直接返回 null，不触发错误
      if (!sessionData || !sessionData.session) {
        logInfo('没有活跃会话，用户未登录');
        return null;
      }

      // 如果有会话，才获取用户信息
      // ⚠️ 复用上面已经加载好的门面（`facade`）：别再 `loadSupabaseFacade()` 一次
      // —— 那是一次额外的动态 import（虽然模块会被浏览器缓存）。
      const { data, error } = await facade!.auth.getCurrentUser();
      if (error) {
        logError('获取用户信息错误:', error);
        // ── 2026-10-22（402）：服务端项目被限制 ⇒ 专用人话（不降级成「请重试」）──
        // 判据喂**原始** error（它带 status / http_status）；这里还是第一层，
        // 机器字段还没被包装掉。
        const unavailableCopy = authBackendUnavailableCopy(error);
        if (unavailableCopy) {
          throw new BackendUnavailableError(unavailableCopy, readHttpStatus(error) ?? undefined);
        }
        throw new Error(authErrorCopy(supabaseErrorMessage(error), '获取用户信息失败，请稍后重试'));
      }

      if (data.user) {
        // DS-1：会话被恢复（浏览器重启 / SW 冷启动）时同样要认账。
        // 走的是「没有登录动作」的路径，但账号可能已经换了
        // （比如用户在另一处换了账号，这台机器的会话还在）。
        await bindLocalSessionsToAccount(data.user.id);
        return {
          id: data.user.id,
          email: data.user.email!,
          lastLogin: new Date().toISOString(),
        } as User;
      }

      return null;
    } catch (err) {
      logError('获取用户信息异常:', err);
      // 确保返回一个字符串错误消息，而不是对象
      if (err instanceof Error) {
        // ── 2026-10-22（402）：catch 分支**也要**认机器判据 ─────────────────
        // 上面那一支已经处理了 402；这一支是「别处抛的同类错误」与
        // 「包装过程中丢掉的判据」的兜底。少了它，BackendUnavailableError
        // 会在这一层被 authErrorCopy 降级成「获取用户信息失败，请稍后重试」
        // —— 正是本次要消灭的那句错方向的话。
        if (isBackendUnavailableError(err)) {
          throw err;
        }
        // ── 2026-10-23（第 51 轮）：**等到期限** ≠ 「核不到」 ─────────────
        // 期限到了只说明「我们不等了」；若我们已经**观测到**「云端不可用」
        // （状态码判据），那一档就是「云端不可用」—— 说成「核不到」会把
        // 「等我们恢复」说成「检查你的网络」，指错了下一步。
        if (isDeadlineExceeded(err) && facade?.outageTracker.isUnavailableRecently()) {
          throw new BackendUnavailableError('云端项目不可用（核对未在期限内完成）', 402);
        }
        throw new Error(authErrorCopy(err.message, '获取用户信息失败，请稍后重试'));
      } else {
        throw new Error('获取用户信息失败，请稍后重试');
      }
    }
  }
);

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    clearError: (state) => {
      state.error = null;
    },

    // 从缓存设置认证状态
    setFromCache: (
      state,
      action: PayloadAction<{
        user: User | null;
        isAuthenticated: boolean;
        /**
         * 这一档是**核到了的**还是**没核过**（缺省 = `unchecked`）。
         * 见 reducer 里的注释。
         */
        statusKind?: AuthCheckState;
        /** 「这一档在界面上怎么说」（用户可见；null = 无话可说）。 */
        notice?: string | null;
      }>,
    ) => {
      state.user = action.payload.user;
      state.isAuthenticated = action.payload.isAuthenticated;
      state.isLoading = false;
      state.error = null;
      // ── 2026-10-23（第 50 轮）：这一动作有两个**不同**的来源 ──────────
      //   · **本机缓存**（弹窗冷启动）⇒ 只是「暂定事实」，**没核过**
      //     ⇒ 这一档是 `unchecked`（不是「没登录」！）；
      //   · **服务端核到了**（恢复登录态之后）⇒ `authenticated`。
      // 两者共用一个 action，若不显式带上「这一档是什么」，
      // 调用方就只能靠猜 ⇒ 界面会把「还没核」说成「未登录」。
      // ⚠️ 缺省是 `unchecked`（**fail-closed**：宁可说「还没核」，
      // 也不说「没登录」）。
      state.authStatusKind = action.payload.statusKind ?? 'unchecked';
      // 「这一档在界面上怎么说」——核到了（authenticated / not_authenticated）
      // 就没有话可说 ⇒ 清掉上一轮留下的提示。
      state.notice = action.payload.notice ?? null;
    },

    /**
     * 只更新「核到哪儿了」与「这一档在界面上怎么说」。
     *
     * ⚠️ 为什么要有这个**独立**动作（而不是复用 setFromCache）：
     * `setFromCache` 的语义是「把某个用户放进 store」——
     * 而「核不到」这一档**不引入任何用户**（用户那份来自缓存，已经在 store 里了）。
     * 用 setFromCache 顺带重发一次缓存用户，会让「缓存用户被 dispatch 进 store」
     * 这件事出现**两次** ⇒ 那条守卫（冷启动必须立刻把缓存登录态送进 store）
     * 就再也分不出「冷启动那一次」⇒ **零检测力**。
     */
    setAuthCheckState: (
      state,
      action: PayloadAction<{ statusKind: AuthCheckState; notice?: string | null }>,
    ) => {
      state.authStatusKind = action.payload.statusKind;
      state.notice = action.payload.notice ?? null;
    },
  },
  extraReducers: (builder) => {
    builder
      // 注册
      .addCase(signUp.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(signUp.fulfilled, (state, action) => {
        state.isLoading = false;
        state.user = action.payload;
        // ⚠️ **注册不等于登录**：signUp 只回一个账号记录（data.user），本机并没有会话。
        // 原先这里把 isAuthenticated 一起置真 ⇒ 邮箱待确认（或自动登录失败）时，顶栏立刻
        // 显示「退出登录」、同步按钮解锁，而注册表单那边正说「自动登录失败，请手动登录」——
        // 同一屏两种事实。登录态只由 signIn.fulfilled 建立（它还会写 authCache；
        // signUp 这条路径从来没写过缓存，所以那个假的「已登录」刷新后又会自己消失）。
      })
      .addCase(signUp.rejected, (state, action) => {
        state.isLoading = false;
        // ── 2026-10-23（第 52 轮）：「云端不可用」**不许**说成「注册失败」──
        // 「注册失败，请稍后重试」是**错的方向**：项目被限制时重试一万次也一样，
        // 而用户会以为自己填错了邮箱 ⇒ 白折腾。
        if (isBackendUnavailableError(action.error)) {
          state.error = backendUnavailableAuthCopy();
          state.backendUnavailable = true;
          state.authStatusKind = 'backend_unavailable';
          logWarn('[auth] 注册失败的原因是「云端不可用」—— 不说「注册失败」（方向错了）');
          return;
        }
        // 原始英文只留在 thunk 里的 console 日志；进 UI 的一律是中文
        state.error = authErrorCopy(action.error.message, '注册失败，请稍后重试');
      })

      // 登录
      .addCase(signIn.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(signIn.fulfilled, (state, action) => {
        state.isLoading = false;
        state.user = action.payload;
        state.isAuthenticated = !!action.payload;
        // 登录是**用户显式做**的 ⇒ 这一档是核到了的「已登录」。
        state.authStatusKind = action.payload ? 'authenticated' : 'not_authenticated';
        state.backendUnavailable = false;

        // 登录成功后缓存认证状态
        if (action.payload) {
          authCache.saveAuthState(action.payload, true);
          logInfo('登录成功 - 手动同步模式');
        }
      })
      .addCase(signIn.rejected, (state, action) => {
        state.isLoading = false;
        // ── 2026-10-23（第 52 轮）：「云端不可用」**不许**说成「登录失败」──
        // 「登录失败，请稍后重试」是**错方向**的那句话：项目被限制（402）时
        // 重试一万次也一样，而用户会以为**自己密码错了** ⇒ 反复改密码、
        // 重新注册 —— 而他其实没输错。
        //
        // ⇒ 这一档归到 `backend_unavailable`（等我们恢复），机器标记由
        //   `isBackendUnavailableError` 认（RTK 序列化只保留 `code`，
        //   所以 thunk 那边必须抛带 `code` 的专用错误）。
        if (isBackendUnavailableError(action.error)) {
          state.error = backendUnavailableAuthCopy();
          state.backendUnavailable = true;
          state.authStatusKind = 'backend_unavailable';
          logWarn('[auth] 登录失败的原因是「云端不可用」—— 不说「登录失败」（方向错了）');
          return;
        }
        // 原始英文只留在 thunk 里的 console 日志；进 UI 的一律是中文
        state.error = authErrorCopy(action.error.message, '登录失败，请稍后重试');
      })



      // 退出登录
      .addCase(signOut.pending, (state) => {
        state.isLoading = true;
      })
      .addCase(signOut.fulfilled, (state, action) => {
        state.isLoading = false;
        state.user = null;
        state.isAuthenticated = false;
        // 退出登录是**用户显式做**的 ⇒ 这一档是「没登录」（核到了的）。
        state.authStatusKind = 'not_authenticated';
        // ⚠️ 文案要说准（2026-10-23，第 52 轮）：`scope: 'local'` 撤的是
        // **这一台** ⇒ 正常登出时界面自己会说「已退出登录」（组件负责）；
        // 而「服务端那一侧没撤成」（云端不可用）那一档，**必须**说清
        // 「已从本机登出、别的设备可能仍是登录状态」——
        // 不说 ⇒ 用户会以为所有设备都退了（那是假的）。
        state.notice = action.payload?.cloudUnavailable ? LOCAL_SIGNOUT_COPY : null;

        // 退出登录后清除认证缓存
        authCache.clearAuthState();
      })
      .addCase(signOut.rejected, (state, action) => {
        state.isLoading = false;
        state.error = authErrorCopy(action.error.message, '退出登录失败，请稍后重试');
      })

      // 获取当前用户
      .addCase(getCurrentUser.pending, (state) => {
        state.isLoading = true;
      })
      .addCase(getCurrentUser.fulfilled, (state, action) => {
        state.isLoading = false;
        state.user = action.payload;
        state.isAuthenticated = !!action.payload;
        // ── 2026-10-23（第 50 轮）：这一档是**核到了** ──────────────────
        // fulfilled 只有两种可能（有账号 / 明确没有会话）——
        // 「核不到」一律走 rejected 分支 ⇒ 这里可以放心写死。
        state.authStatusKind = action.payload ? 'authenticated' : 'not_authenticated';
        state.backendUnavailable = false;

        // 更新认证缓存
        if (action.payload) {
          authCache.saveAuthState(action.payload, true);

          // 移除实时同步功能，简化逻辑
        } else {
          authCache.clearAuthState();
        }
      })
      .addCase(getCurrentUser.rejected, (state, action) => {
        state.isLoading = false;
        // ── 2026-10-22（402）：「服务端不可用」**不许**把登录态读成「没登录」──
        // 原先这里无条件 `authErrorCopy(...)` ⇒ 界面弹「获取用户信息失败，请稍后重试」。
        //
        // 但「服务端项目被限制」（生产实测 402）时，这句是**两重错**：
        //   ① 「请稍后重试」——重试一万次也一样（项目被封禁）；
        //   ② 更糟的是**登录态被读成 false**（见下）⇒ popup 的入口闸门
        //      （syncIdentityBlockedCopy）在用户点上传的**那一刻**就拦下，
        //      弹「还没有登录 TapStack 云端」—— 他明明登录着。
        //
        // ⚠️ 所以这里要分开处理两类失败：
        //   · **服务端不可用** ⇒ 保留**已缓存的登录态**（用户确实登录着，
        //     只是服务端暂时确认不了），并给出「等我们恢复」的人话；
        //   · **核不到**（断网 / 超时）⇒ 同样是「不知道」⇒ 同样保留登录态，
        //     但说的是另一句话（「现在联系不上云端」而不是「等我们恢复」）。
        //
        // 判据用**机器字段**（HTTP 状态码 / 报文标记），不靠文案匹配 ——
        // 见 core/backendUnavailable.ts。
        if (isBackendUnavailableError(action.error)) {
          state.error = backendUnavailableAuthCopy();
          // 登录态**保持原样**（不清零）：清零 = 告诉界面「你没登录」，
          // 而事实是「服务端暂时确认不了你的账号」。
          state.backendUnavailable = true;
          state.authStatusKind = 'backend_unavailable';
          logWarn('[auth] 云端项目不可用，无法验证账号（登录态按缓存保留，不告诉用户「未登录」）');
          return;
        }
        // ── 2026-10-23（第 50 轮）：核不到（断网等）——**也不许**说「未登录」──
        // 这一档以前落在下面那句 `state.error = authErrorCopy(...)` 里，
        // 而 `isAuthenticated` 保持原样 ⇒ 界面说「获取用户信息失败，请稍后重试」
        // —— 方向没错（确实是失败），但**没说清「本地数据没丢」**，
        // 也没把「这一档是 unknown」记进 store（界面分不出
        // 「核到没登录」和「没核到」）。
        state.authStatusKind = 'unknown';
        state.error = authUnknownCopy();
        logWarn('[auth] 核不到登录态（网络等原因），登录态按缓存保留（不说「未登录」）');
      });
  },
});

export const { clearError, setFromCache, setAuthCheckState } = authSlice.actions;

export default authSlice.reducer;
