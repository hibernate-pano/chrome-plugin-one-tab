import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { AuthState, User } from '@/types/tab';
import { accountScopeStore, authCache } from '@/utils/authCache';
import { createAccountScopeRecord, decideAccountBind } from '@/core/accountScope';
import {
  BackendUnavailableError,
  isBackendUnavailable,
  isBackendUnavailableError,
  readHttpStatus,
} from '@/core/backendUnavailable';
import { backendUnavailableAuthCopy } from '@/components/sync/backendUnavailableCopy';
import { storage } from '@/utils/storage';
import { loadSupabaseFacade } from '@/utils/supabaseRuntime';
import { logError, logInfo, logWarn } from '../../utils/log';

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

const initialState: AuthState = {
  user: null,
  isAuthenticated: false,
  isLoading: false,
  error: null,
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
      if (err instanceof Error) {
        throw new Error(authErrorCopy(err.message, '登录失败，请稍后重试'));
      } else {
        throw new Error('登录失败，请稍后重试');
      }
    }
  }
);





export const signOut = createAsyncThunk(
  'auth/signOut',
  async () => {
    try {
      // 移除实时同步功能，简化逻辑
      logInfo('已简化同步逻辑，只保留手动同步功能');

      // 退出登录
      const supabaseAuth = await loadSupabaseAuth();
      const { error } = await supabaseAuth.signOut();
      if (error) {
        logError('退出登录错误:', error);
        throw new Error(authErrorCopy(supabaseErrorMessage(error), '退出登录失败，请稍后重试'));
      }

      logInfo('退出登录成功');
      return null;
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
    try {
      // 首先检查是否有活跃会话，避免未登录用户触发错误
      const supabaseAuth = await loadSupabaseAuth();
      const { data: sessionData } = await supabaseAuth.getSession();

      // 如果没有会话，直接返回 null，不触发错误
      if (!sessionData || !sessionData.session) {
        logInfo('没有活跃会话，用户未登录');
        return null;
      }

      // 如果有会话，才获取用户信息
      const { data, error } = await supabaseAuth.getCurrentUser();
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
    setFromCache: (state, action) => {
      state.user = action.payload.user;
      state.isAuthenticated = action.payload.isAuthenticated;
      state.isLoading = false;
      state.error = null;
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

        // 登录成功后缓存认证状态
        if (action.payload) {
          authCache.saveAuthState(action.payload, true);
          logInfo('登录成功 - 手动同步模式');
        }
      })
      .addCase(signIn.rejected, (state, action) => {
        state.isLoading = false;
        // 原始英文只留在 thunk 里的 console 日志；进 UI 的一律是中文
        state.error = authErrorCopy(action.error.message, '登录失败，请稍后重试');
      })



      // 退出登录
      .addCase(signOut.pending, (state) => {
        state.isLoading = true;
      })
      .addCase(signOut.fulfilled, (state) => {
        state.isLoading = false;
        state.user = null;
        state.isAuthenticated = false;

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
        //   · 其它失败（令牌过期 / 真的没登录 / 账号被删）⇒ 维持原行为
        //     （登录态读成 false）。
        //
        // 判据用**机器字段**（HTTP 状态码 / 报文标记），不靠文案匹配 ——
        // 见 core/backendUnavailable.ts。
        if (isBackendUnavailableError(action.error)) {
          state.error = backendUnavailableAuthCopy();
          // 登录态**保持原样**（不清零）：清零 = 告诉界面「你没登录」，
          // 而事实是「服务端暂时确认不了你的账号」。
          state.backendUnavailable = true;
          logWarn('[auth] 云端项目不可用，无法验证账号（登录态按缓存保留，不告诉用户「未登录」）');
          return;
        }
        // 确保错误消息是字符串而不是对象；且进 UI 的必须是中文
        state.error = authErrorCopy(action.error.message, '获取用户信息失败，请稍后重试');
        logInfo('自动登录失败，但这是正常的，用户可能未登录');
      });
  },
});

export const { clearError, setFromCache } = authSlice.actions;

export default authSlice.reducer;
