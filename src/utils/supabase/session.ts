/**
 * P0 手术 · 会话 single-source。
 * 原 `upload.ts` 内 migrateToJsonb / uploadTabGroups / uploadSettings 三处
 * 逐字重复的 getSession + getUser + 校验块收口于此。错误文案逐字保留，
 * 行为零变化。调用方只拿回校验过的 userId。
 */
import { supabase } from './client';
import {
  BackendUnavailableError,
  isBackendUnavailable,
  readHttpStatus,
} from '@/core/backendUnavailable';
import { readSessionSafely, SESSION_READ_DEADLINE_MS } from './sessionRead';
import { requireCloudAvailable } from './cloudAvailability';
import { isDeadlineExceeded, withDeadline } from '@/utils/deadline';

/**
 * 会话校验的**等待上限**（2026-10-23，第 51 轮）。
 *
 * 与「核对登录态」用的是同一个上限（见 utils/supabase/sessionRead.ts）：
 * auth SDK 的刷新失败会连打 8 次、退避 25.4 秒 ⇒ 同步操作不能等那么久
 * （popup 的协议上界是 30 秒，等满 25 秒再失败，用户看到的是「操作超时」）。
 */
export async function requireSessionUserId(): Promise<string> {
  // ── 2026-10-23（第 51 轮）：读会话走**唯一入口** ─────────────────────────
  // 那一层做三件事：① 先问「云端在吗」（不可用就**不碰 SDK** ⇒ 会话不会被删）；
  // ② 给等待一个上限（5 秒 ⇒ 不会卡满 25 秒的退避风暴）；
  // ③ 失败原样带出（判据不被丢掉）。
  const { data: sessionData, error: sessionError } = await readSessionSafely(
    () => supabase.auth.getSession(),
    '云端响应'
  );

  if (sessionError) {
    // ── 2026-10-22（402）：服务端项目被限制时**保留机器判据** ──────────────
    // 这里是「云端不可用」最早暴露的一层（上传/删除广播/列探测都经过它）。
    // 原先 `new Error(...)` 把错误**降级成一条普通 Error**：状态码与
    // 「项目被限制」的标记全丢 ⇒ 上游只能看到一句英文 ⇒ 用户看到
    // 「请重试」，而重试一万次也一样。
    //
    // 归一在**这里**做（而不是在 UI 层）：这一层还拿得到 SDK 的原始错误
    // 形状（`status` / `http_status` / 报文），过了这一层就只剩 message 了。
    //
    // ⚠️ 判据必须喂**原始**错误：包装后的 `new Error(...)` 只剩 message，
    // 状态码（402 / 503）就看不见了（报文标记还在 message 里，但状态码没了）。
    //
    // ⚠️ 顺带一条事实（第 51 轮起）：auth 端点上的「服务端不可用」在
    // `client.ts` 的咽喉被翻译成 **503** ⇒ 这条路上 SDK 看到的 `status`
    // 是 503 而不是 402（详见下面 `getUser` 那一支的注释）。
    // 「项目被限制」这条语义靠**报文标记**与 `isBackendUnavailable` 兜住，
    // 结论不变。
    const wrapped = new Error(`获取会话失败: ${sessionError.message}`);
    if (isBackendUnavailable(sessionError)) {
      throw new BackendUnavailableError(wrapped.message, readHttpStatus(sessionError) ?? undefined);
    }
    throw wrapped;
  }

  if (!sessionData.session) {
    throw new Error('用户未登录或会话已过期，请重新登录');
  }

  // ── 2026-10-23（第 52 轮）：**核账号也有上限** ──────────────────────────
  // 「核账号」这一步收口到 `requireSessionUser()`（同一文件下方）：
  // 它负责「先问云端在吗 + 5 秒上限 + 失败原样带出」三件事。
  // 为什么要拆出来（而不是就写在这里）：`download.ts` 的两处核账号
  // 也需要**同样**的三件事 ⇒ 拆出来才能**一处**实现、两处复用。
  const userId = await requireSessionUser();

  if (userId !== sessionData.session.user.id) {
    return sessionData.session.user.id;
  }

  return userId;
}

/**
 * 「核账号」的**收口入口**（2026-10-23，第 52 轮补）。
 *
 * ── 为什么要有这一层（这是第 52 轮漏掉的那一处的根因）─────────────────
 * `requireSessionUserId()` 做了三件事：
 *   ① 先问「云端在吗」（明确不可用 ⇒ **不碰 SDK** ⇒ 用户的会话不会被删）；
 *   ② 给「核账号」一个**上限**（5 秒 ⇒ 不会卡满 SDK 自带的 45 秒 fetch 超时）；
 *   ③ 失败**原样带出**（机器码 `deadline_exceeded` / `backend_unavailable` 活着）。
 *
 * 而 `download.ts` 的两处核账号（`downloadTabGroups` / `downloadSettings`）
 * 走的是**裸的** `supabase.auth.getUser()` ⇒ **三件事一件都没有**。
 *
 * ⇒ 实测（2026-10-23，断网 + 本地会话未过期）：
 *   `requireSessionUserId()` **5.0 秒**结束；
 *   `download.ts` 的裸 `getUser()` **45.0 秒**结束（SDK 自带的 fetch 超时）。
 * ⇒ 而同步管线的协议上界是 30 秒（`core/mutationProtocol.ts`）
 * ⇒ **打爆** ⇒ 用户只看到「操作超时」，真实原因却是「联系不上云端」
 * —— 又一句指错方向的谎。
 *
 * ⚠️ 为什么这条路径**特别容易**漏掉闸门（这才是根因）：
 * 断网时探活判「**不知道**」⇒ **放行**（那一档放行是对的：本地会话没过期时，
 * SDK 读它根本不需要联网）⇒ 于是「读会话」这一关**顺利通过**
 * ⇒ 看起来闸门生效了 ⇒ **真正需要上限的那一步**（核账号）却还是裸的。
 * ⇒ 闸门装在**错误的位置**（装在「读会话」上，而不是装在「核账号」上）。
 *
 * ⇒ 这一层把**核账号**单独收口：调用方拿到的仍然是「核到的账号」，
 * 但**等待有上限**、**失败带着机器判据**。
 *
 * ⚠️ **为什么不直接让调用方用 `requireSessionUserId()`**：
 * 那条路会把「读会话」也重做一遍 ⇒ 两次探活、两次 5 秒上限
 * ⇒ 总等待不再有界（本仓既有纪律：入口只有一处，不许叠两层闸门）。
 * ⇒ 而 `download.ts` 的两处**已经有**读会话的结果（`sessionData.session`）
 * ⇒ 只需要**核账号**这一步 ⇒ 正好是这一层提供的东西。
 *
 * ⚠️ **这一层不做「以会话为准」的调和**：
 * 两个调用点的调和规则**不一样**（`download.ts` 的 `downloadTabGroups`
 * 拿**第二次**读的会话调和，`downloadSettings` 拿**第一次**读的会话调和）
 * ⇒ 把调和搬进这一层会把两处的行为**悄悄改成一样** ⇒ 那是行为变更。
 * ⇒ 调和留在调用点；这里只管「核账号 + 有上限 + 失败带判据」。
 */
export async function requireSessionUser(): Promise<string> {
  // ① 先问一句「云端在吗」（与读会话那一层**同一个**闸门函数）。
  //    明确不可用就**不碰 SDK** ⇒ 不会撞上那阵 25.4 秒的退避风暴
  //    （`getUser` 走 `_useSession` ⇒ 本地会话过期时它会去刷新
  //      ⇒ 刷新撞上故障 ⇒ 连打 8 次、退避 25.4 秒）。
  await requireCloudAvailable('获取用户信息');
  // ② 给等待一个**上限**：`SESSION_READ_DEADLINE_MS`
  //    （**不另写一个数字** —— 两处各写一份会漂，
  //      而漂的方向永远是「某一处忘了加闸门」）。
  const userResult = await withDeadline(
    supabase.auth.getUser(),
    SESSION_READ_DEADLINE_MS,
    '获取用户信息',
  ).catch((err: unknown) => {
    // ⚠️ 「等到期限」**原样带出**（机器码 `deadline_exceeded` 要活着）：
    //   上游据此说「核不到」，而不是把它读成「没登录」
    //   （重登在弱网时必然失败 ⇒ 死循环）。
    if (isDeadlineExceeded(err)) throw err;
    // 别的失败 ⇒ 与其它失败**同一形状**（普通 Error）。
    throw new Error(
      `获取用户信息失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  const { data: { user }, error: userError } = userResult;

  if (userError) {
    // ── 2026-10-22（402）：**这一支才是账号态 402 的真实落点** ────────────
    // 实测（生产 402）：`/auth/v1/user` 同样返回 402。
    //
    // ⚠️ **但 SDK 看到的不是 402，是 503**（2026-10-23 第 51 轮起的事实，
    //    这里原先写的是「AuthApiError { status: 402 }」——**那是假的**）：
    //   · 「服务端现在不服务」的状态码在**唯一咽喉**（`client.ts` 的
    //     `injectHttpStatus`）被翻译成 **503**（判据见 `core/authSdkStatus.ts`）——
    //     翻译的**原因**是 auth-js 会把 402 当成「刷新令牌被拒」
    //     ⇒ `_removeSession()` ⇒ 一次云端故障 = 全员被静默登出；
    //   · 而 auth-js 的 `handleError`（`lib/fetch.js:35-89`）**只**把
    //     message / status / code 装进错误对象，**丢掉**响应体里的 `http_status`
    //     ⇒ **auth-js 的错误对象里读不到 402**（`readHttpStatus` 只能读到 503）。
    //
    // ⇒ 「402 = 项目被限制」这条语义在**本仓自己的判据层**仍然成立
    //   （那是 `readHttpStatus` 读**响应体**那条路：REST 端点上 402 照旧写进
    //   `http_status`）；但在 auth 这条路上，这一档读到的是 503
    //   —— **结论不变**（402 与 503 都在「服务端不可用」集合里）。
    //
    // 判据喂**原始**错误（它带 status / http_status），包装后的只剩 message。
    const wrapped = new Error(`获取用户信息失败: ${userError.message}`);
    if (isBackendUnavailable(userError)) {
      throw new BackendUnavailableError(
        wrapped.message,
        readHttpStatus(userError) ?? undefined,
      );
    }
    throw wrapped;
  }

  if (!user) {
    throw new Error('用户未登录');
  }

  if (!user.id) {
    throw new Error('用户ID无效');
  }

  return user.id;
}
