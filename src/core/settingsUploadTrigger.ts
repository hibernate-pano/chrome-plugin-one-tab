/**
 * 「这次动作该不该排一次上传」——判据的**唯一**出处（纯函数；中间件只做转发）。
 *
 * ── 为什么这里不能用前缀 ────────────────────────────────────────────────
 *
 * 原判据是 `action.type.startsWith('settings/')`。前缀匹配把**读**和**写**
 * 当成同一类动作：`loadSettings` 是 `createAsyncThunk`，它 dispatch 的是
 * `settings/loadSettings/{pending,fulfilled,rejected}` —— 三条都以
 * `settings/` 开头。于是**每一次读设置**都被当成「设置变了」，排一次上传。
 *
 * 读设置不是罕见事件，它是常态：
 *   · 管理器页每次打开都 dispatch 一次 loadSettings（MainApp 挂载）；
 *   · 后台每一轮轮询都 dispatch 一次 loadSettings（backgroundSync）；
 *   · 设置页 / 顶栏菜单挂载时各一次。
 *
 * 而上传是**出站流量**：Supabase 按 egress 计费，本仓自己在
 * `background/backgroundSync.ts` 里写着「自动同步每轮都是出站流量，
 * 60s 全量轮询是配额见底的主因」。把「读」当成「写」，等于按用户的每一次
 * 开页 / 每一次后台轮询买一次全量上传 —— 而中间件排的那次上传**没有**
 * 增量白名单（`scheduleUpload` 不带 changedGroupIds ⇒ 传全部活跃会话）。
 *
 * 前缀匹配注定会漏：将来再加一个**读类** thunk，它的 lifecycle action
 * 同样以 `settings/` 开头 ⇒ 又一次「读 = 写」。白名单不会：不在名单里的
 * 读类动作，永远不会被当成改动 —— 这正是本文件用白名单而不是前缀的原因。
 *
 * ── 为什么名单里只有「写盘点」那一条 ───────────────────────────────────
 *
 * 名单是白名单，不是「所有看起来像改动的动作」的合集。判据只有一条：
 * **这个 action 是不是「设置真的写到了盘上」的信号。**
 *
 * settingsSlice 里唯一把设置写进存储的用户路径是 `saveSettings` 这个 thunk
 * （`storage.setSettings`，见 slices/settingsSlice.ts）。slice 自己的注释
 * 写着「只改 Redux state，落盘走 dispatchSaveSettings」—— 每个 reducer
 * 只改内存里的 state，**单独 dispatch 不会落盘**。
 *
 * 于是名单取 `settings/saveSettings/fulfilled`：
 *   · fulfilled = 写盘已经成功（storage.setSettings 是 await 到真落盘的）
 *     ⇒ 这才是「设置真的变了」的时刻；
 *   · pending = 写盘**还没**发生（此刻排上传 = 上传一份还没落盘的设置；
 *     写失败时那次上传传的还是旧值）；
 *   · rejected = 写盘失败 ⇒ 什么都没变，不该排上传。
 *
 * reducer（setThemeMode / setSessionSort / …）不在名单里：它们表达的是
 * 「用户改了」的**意图**，落盘由随后的 dispatchSaveSettings 完成。UI 上
 * 每一个 reducer dispatch 后面都跟着一次 dispatchSaveSettings（改设置 =
 * reducer + 保存；写失败时还有一次回滚 dispatch），所以**一次用户改动仍然
 * 只排一次上传**——不多（回滚不排），不少（保存成功排）。
 *
 * ── 判据与守卫 ─────────────────────────────────────────────────────────
 *
 * 本文件是判据的唯一出处，中间件只转发。守卫（tests/guards/settingsUploadTrigger.test.ts）
 * 不钉这份名单的字面量：它解析 settingsSlice.ts，自己推出「哪些 action
 * 真的写了盘」，再断言本判据**覆盖全部写类、排除全部读类**。所以：
 *   · 新增一个**写类** thunk ⇒ 守卫要求这里跟着改（漏了就红）；
 *   · 新增一个**读类** thunk ⇒ 这里不用动，守卫也不会误伤它。
 */
export const SETTINGS_UPLOAD_TRIGGER_ACTION_TYPES: readonly string[] = [
  // 写盘成功的唯一信号（settingsSlice.saveSettings 的 fulfilled）。
  'settings/saveSettings/fulfilled',
];

/**
 * 这个 action 该不该排一次上传。
 *
 * @param actionType action 的 type（可能是任意值：中间件拿到的 action 未必是 plain object）
 */
export function isSettingsUploadTrigger(actionType: unknown): boolean {
  return (
    typeof actionType === 'string' &&
    SETTINGS_UPLOAD_TRIGGER_ACTION_TYPES.includes(actionType)
  );
}
