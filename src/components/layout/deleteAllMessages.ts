/**
 * 「删除所有会话」在菜单行与确认框里的同一份声明。
 *
 * 删除是核弹级且不可撤销的操作，而**删除意图会传到其他设备**：本地物理移除后，
 * 墓碑经上传队列广播到云端（Supabase 的 `markCloudGroupsAsDeleted` / WebDAV 的
 * `broadcastDeletes`），对端合并时服从墓碑 ⇒ 对端同名会话也消失。
 *
 * 两处声明的判据必须同源。此前确认框只看 `isAuthenticated`，而自带存储（WebDAV）
 * 用户没有 TapStack 账号、`isAuthenticated` 恒为 false —— 于是菜单行写着
 * 「其他登录设备同步删除」、确认框却一个字不提：**用户在更该看清的那一步被误导成
 * 「只删本机」**。反过来，没有同步后端的纯本地用户，菜单行那句又是假话。
 *
 * 判据与 syncEngine / backgroundSync 的门禁同口径：**有没有可用的同步后端**，
 * 而不是「有没有账号」。抽成纯函数是为了让两处调用同一个，边界（登录 / 自带存储 /
 * 纯本地）由单测钉死。
 */
export interface DeleteAllDisclosure {
  isAuthenticated: boolean;
  syncBackend: 'supabase' | 'webdav';
}

/** 这次删除会不会传到其他设备。 */
export const deleteReachesOtherDevices = (input: DeleteAllDisclosure): boolean =>
  input.isAuthenticated || input.syncBackend === 'webdav';

/**
 * 「删完全部之后，要不要立刻发一次覆盖上传」——**必须与
 * `deleteReachesOtherDevices` 同源**（2026-10-19 修真实缺陷）。
 *
 * 原实现直接读 `isAuthenticated`，而自带存储（WebDAV）用户没有 TapStack 账号、
 * 该值恒为 false ⇒ 确认框里写着「其他设备将同步删除」，实际却走了
 * 「用户未登录，跳过同步到云端」的分支：承诺与行为分裂，且跳过的恰是
 * 最需要这次加固的那个后端。删光本机后云端仍留着全部旧会话，
 * 换台设备登录/连盘就把它们原样拉回来。
 *
 * 判据取「有没有可用的同步后端」而非「有没有账号」，与本文件其余声明、
 * `syncIdentityCanRun`、backgroundSync 的门禁同一口径。
 */
export const deleteAllShouldPushOverwrite = deleteReachesOtherDevices;

/** 自带存储用户没有账号，说「登录设备」会指向一个他不需要也不存在的东西。 */
const otherDevicesLabel = (input: DeleteAllDisclosure): string =>
  input.syncBackend === 'webdav' ? '其他设备' : '其他登录设备';

/** 确认框正文（破坏性操作的最后一道说明）。 */
export const deleteAllConfirmMessage = (input: DeleteAllDisclosure & { groupCount: number }): string =>
  `将删除本地全部 ${input.groupCount} 个会话，删除后无法恢复` +
  (deleteReachesOtherDevices(input) ? `，${otherDevicesLabel(input)}将同步删除` : '') +
  '。确认继续吗？';

/** 菜单行副标题（点开菜单就能看到的那句）。 */
export const deleteAllMenuWarning = (input: DeleteAllDisclosure): string =>
  '将清空本地全部会话，删除后无法恢复' +
  (deleteReachesOtherDevices(input) ? `（${otherDevicesLabel(input)}同步删除）` : '') +
  '。';
