/**
 * 跨设备删除的**唯一一份声明**（2026-10-24 审计 DS-3 收口）。
 *
 * ── 为什么抽到一处 ────────────────────────────────────────────────────────
 * 「删除会传到其他设备」这件事有**两个**入口要对用户说：
 *   · 「删除所有会话」（`components/layout/deleteAllMessages.ts`）
 *   · 「删除单个会话」（`components/tabs/lockedDeleteCopy.ts`）
 * 历史 bug 正是两处各写一份判据、各写一份措辞 ⇒ 一处说有、一处不说，
 * 用户在更该看清的那一步被误导成「只删本机」。⇒ 判据与措辞都必须只有一份。
 *
 * ── 判据：有没有可用的同步后端，不是「有没有账号」 ──────────────────────
 * 自带存储（WebDAV）用户没有 TapStack 账号，`isAuthenticated` 恒为 false ——
 * 但他们的删除意图同样以墓碑广播（WebDAV `broadcastDeletes`）⇒ 必须算
 * 「会传到其他设备」。反过来，没有同步后端的纯本地用户，删除**只**发生在本机，
 * 就不该出现跨设备那句。
 *
 * 与 `syncEngine` / `backgroundSync` 的门禁同口径（那边问的是「能不能跑同步」）。
 *
 * ── 措辞：删除**一定**会生效（2026-10-24 审计 DS-3 修完后的真相）────────────
 * 旧措辞是「（另一台设备若在离线时改过它，删除可能不生效）」—— 那是**真的**
 * （那时胜负由两个无关计数器的数值大小决定），但它已经被修掉了：
 * 现在**云端墓碑一律压过本地活跃副本**（`core/opStampMerge.ts` /
 * `core/remoteAdjudication.ts` / `utils/supabase/upload.ts` 三处同口径），
 * 对方离线期间改过也一样会被删除。
 *
 * ⇒ 继续留着「可能不生效」就是**说假话**（而且是朝着让用户低估后果的方向）；
 *   删掉它而不补上「也会删掉对方改过的」也是说假话（用户会以为对方那份还在）。
 * ⇒ 新措辞必须说出**真实的后果**：删除会同步过去，**对方那份离线编辑也一起没**。
 */
export interface CrossDeviceDeleteInput {
  /** 用户是否已登录 TapStack 云端。 */
  isAuthenticated: boolean;
  /** 跟谁同步。 */
  syncBackend: 'supabase' | 'webdav';
}

/** 这次删除会不会传到其他设备。 */
export const deleteReachesOtherDevices = (input: CrossDeviceDeleteInput): boolean =>
  input.isAuthenticated || input.syncBackend === 'webdav';

/** 自带存储用户没有账号，说「登录设备」会指向一个他不需要也不存在的东西。 */
export const otherDevicesLabel = (input: CrossDeviceDeleteInput): string =>
  input.syncBackend === 'webdav' ? '其他设备' : '其他登录设备';

/**
 * 跨设备删除的**补充说明**（括号里的那半句）。
 *
 * 「删除可能不生效」已经不成立（DS-3 已修：云端墓碑一律赢）⇒ 这半句改成
 * 说出**真实的后果**：对方离线期间改过的那份，也一起被删掉。
 *
 * ⚠️ 这句话是**后果**，不是免责声明 —— 它告诉用户「对方那份也没了」，
 *    好让用户在按确认键之前知道这件事，而不是等同步完才发现。
 */
export const crossDeviceDeleteCaveat = '（对方离线期间改过它也一样会被删除）';

/**
 * 「删除单个会话」的跨设备那一句（**完整句**，可直接接在正文后面）。
 *
 * 与「删除所有会话」用**同一个** caveat ⇒ 两处说的是同一件事、同一句话。
 */
export const crossDeviceDeleteSentence = (input: CrossDeviceDeleteInput): string =>
  `${otherDevicesLabel(input)}上的这条会话也会同步删除${crossDeviceDeleteCaveat}。`;
