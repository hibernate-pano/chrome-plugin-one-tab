# 数据安全审计 · round 43（2026-10-23）

**审计对象**：`chrome-plugin-one-tab`（TapStack）　**HEAD**：`23d2aab`（与 `cb6ac46` 的 `src/` 零差异）　**审计范围**：数据安全（跨账号泄露 / 数据丢失 / 误删 / 不可逆动作）
**性质**：只读审计。本轮**没有改动** `src/` 与 `tests/` 的任何一行；本文件是唯一的产出。
> **注**：审计期间仓库里有**别的 agent 在并发改 `src/`**（`src/store/middleware/autoSyncMiddleware.ts`、`src/sync-backend/webdav/client.ts`）。这两个文件**不在本报告的引用范围里**，本报告所有行号仍对应 `23d2aab` / `cb6ac46`。`docs/audit-2026-10-22-round42.md` 期间被**追加**了第 43 轮的内容（追加在文末）⇒ 对它的引用（`:112` / `:294` / `:330-336`）仍成立。

**铁律（本报告全程按它判定严重度）**

1. 读失败必须 fail-closed（读不到真值 ⇒ 不动数据）。fail-open（读失败 ⇒ 当成「没数据」⇒ 继续执行破坏性动作）= P0。
2. 删除即物理清除，无回收站（v1.22.0 起）⇒ 任何「误删」都不可恢复。
3. 恢复 = 消费（会话被恢复就没了）。撤销是**附加**退路，不许把消费语义改回去。
4. `writtenIds`（WebDAV = 本轮写入的全部 id）vs `writtenTombstoneIds`（Supabase = 仅墓碑 id）⇒ `pendingDeleteIds` 队列那一支**绝不**能套 `writtenTombstoneIds` 过滤器。
5. 两个后端「读不出来」的语义不同（Supabase 静默跳过 / WebDAV 整轮抛错）⇒ 统一基准是 fail-closed。

---

## 0. 结论先行

| 编号 | 严重度 | 结论 | 位置 |
|---|---|---|---|
| **DS-3** | **P0** | 仍然成立，**且上轮主审把它「撤回」成「不成立」是错的**（见 §1）。删除 vs 另一台设备的并发编辑，胜负由**两台无关计数器的数值大小**决定 ⇒ 删除被静默撤销、A 的内容丢。**修法①要改协议，本轮不能碰**；修法②（披露）✅ **已修**（`1f7bb14`：确认框与菜单行那句「其他登录设备将同步删除」补上「**删除可能不生效**」这一档 ⇒ 用户按确认键的那一刻不再被许一个实现不保证的结果） | `src/core/opStampMerge.ts:50-56`、`src/core/opStamp.ts:22-30` |
| **DS-43-1** | **P1（本轮新）** | **删除广播没有账号闸门** ⇒ 删掉「属于别的账号」的会话时，删除意图被发给当前账号的云端并被当成「已达成」清队 ⇒ 该会话在它真正所属的账号下**复活** —— ✅ **已修**（`00a2ad0`：广播前按归属分批，别账号的**留在队列里**、等主人登录回来再广播；第 47 轮补上**端到端往返守卫** + 变异自证，见 §3.1） | `src/utils/supabase/upload.ts:1269`、`src/services/syncEngine.ts:1396-1416` |
| **DS-43-2** | **P1（本轮新）** | **OneTab 往返抹掉锁定态** ⇒ 用户自己设的「防误删锁」消失 ⇒ 恢复即消费（不可逆） —— ✅ **已修**（`00783c7`：格式承载不了锁定态 ⇒ 走**披露**（导出 / 导入各说清丢了什么）；第 47 轮补上变异自证） | `src/sync-backend/oneTabFormatParser.ts:240` |
| **DS-43-3** | **P1（本轮新）** | 导入文件可注入 `isDeleted` ⇒ 该会话**列表里看不见**，且一轮同步后被**物理删除** —— ✅ **已修**（`00783c7` 组级；`5b33048` **标签级** —— 一条标签在所有设备上永久隐形） | `src/core/normalizeTabsData.ts:179` → `src/services/syncEngine.ts:1180,1421` |
| **DS-43-10** | **P1（本轮新）** | 搜索页「恢复整个会话」的**部分成功分支不挂撤销** ⇒ 会话已被物理消费，用户手里**一条退路都没有**（列表页同一分支挂了） —— ✅ **已修**（`bad5aae`：两处同口径） | `src/components/search/SearchResultList.tsx:403-413` vs `src/components/tabs/TabGroup.tsx:442-450` |
| **DS-43-11** | **P1（本轮新）** | **上轮说「DS-12 已修」，实际没修**：拖走最后一条标签仍然**零成功反馈**、全程无「会话会消失」文案。HEAD 的 `.then` 里只有失败分支；上轮发布提交对这段函数的 diff 也没加过 toast —— ✅ **已修**（`e169764`） | `src/components/tabs/TabGroup.tsx:583-601`；`docs/audit-2026-10-22-round42.md:112` |
| **DS-4** | **P1** | 第 43 轮时**仍然 fail-open**：读失败 ⇒ 当成「没有待决」⇒ 切库时历史会话被全量推上云 —— ✅ **已修**（`3c73504`：**抛错**，本轮上传中止、界面报失败、下一轮重试 —— **不是**返回 `true`，那会变成「静默的假成功」，见 §1.1） | `src/utils/storage.ts:1138-1141` |
| **DS-5** | **P1** | 第 43 轮时**仍然 fail-open**：读失败 ⇒ 当成「干净」⇒ 漏登记的改动永远补不上云 —— ✅ **已修**（`3c73504`：同样**抛错**） | `src/utils/storage.ts:1272-1275` |
| **DS-43-4** | P2 | 导入时**一个**越界时间戳炸掉整批导入，且失败理由甩锅「存储空间 / 写入权限」 —— ✅ **已修**（`35b363f`：根因修掉 + 逐组隔离 + 失败理由分家） | `src/utils/storage.ts:1707` + `src/core/normalizeTabsData.ts:80` |
| **DS-43-5** | P2 | 导入的**设置**合并失败被吞，仍弹「已导入 N 个会话」⇒ 主题 / 布局 / 排序没恢复，零提示 —— ✅ **已修**（`35b363f`：失败如实上报，界面说「设置没恢复」） | `src/utils/storage.ts:1758-1760` |
| **DS-43-6** | P2 | 导出**成功零反馈**，且扩展没有 `downloads` 权限 ⇒ 下载被拦 / 写盘失败时用户什么都看不到 —— ⚠️ **部分修**（`35b363f`：回执有了（文件名 + 会话数）、blob 撤销改成延后）；**`downloads` 权限仍未加** ⇒ 「文件真的落到磁盘上了」这件事我们仍然看不到，如实记为残余 | `src/components/layout/HeaderDropdown.tsx:644` |
| **DS-43-7** | P2 | 上传闸门的兜底是 **fail-open**：归属记录缺失 ⇒ 全机会话认给当前账号。它的注释写着「读失败 ⇒ 中止上传」，代码没这么做 —— ✅ **已修**（`00783c7`） | `src/utils/supabase/upload.ts:514-533` + `src/utils/authCache.ts:44-54` |
| **DS-43-8** | P2 | 商店文案「导入的会话也按内容命名（和保存时同一套规则）」**两档都不成立** —— ✅ **已修**（`639f8ff` 改文案；`35b363f` 复核：**行为不能改** —— 会话名是幂等指纹的一部分） | `CHROMEWEBSTORE.md:54` |
| **DS-43-9** | P2 | 导入没有体积 / 条数上限，整个文件在 popup 主线程解析 —— ✅ **已修**（`35b363f`：导入**分块**（大文件能真的导进去）+ 文件上限 64MB，超了说清「文件没问题」并给出路） | `src/components/layout/HeaderDropdown.tsx:1100-1292` |
| **DS-9** | P2 | 第 43 轮时**仍然零覆盖**：守卫只断言「有一个 `showDeleteError(` 调用」，改文案 0 红 —— ✅ **已修**（`bad5aae`：列表页与搜索页的拒删措辞抽成同源纯函数 `lockedTabDeleteMessage()`；守卫断言的是「两处同源」而不是「有一处调用」） | `tests/guards/lockedTabDeleteGuard.test.ts:80-91` |
| **DS-15** | P2 | 第 43 轮时**仍然成立**：导入不做覆盖 ⇒ 同名不同内容的会话并存成两份，零提示 —— ✅ **已修**（`35b363f`：导入结果一律带上这句披露；**行为不动** —— 改成覆盖式会吞掉用户的真实数据） | `src/core/mutationOps.ts:330-346` |
| **DS-43-12** | P2 | toast 队列只留最近 3 条 ⇒ 连续消费 4 次时，最早那条**带撤销的** toast 被**静默挤出** ⇒ 那次消费变成不可逆，用户不知道 —— ✅ **已修**（`00783c7`：队列准入策略 `toastQueuePolicy.admitToast` —— 挤掉的是**可挤掉**的那条；带动作的退路与错误提示**不可被自动挤掉**，挤不掉时允许超限） | `src/contexts/ToastContext.tsx:86` |
| **DS-43-13** | P2 | 搜索页「删除全部搜索结果」的确认计数**含锁定组** ⇒ 标题与正文说的 N 恒 ≥ 实际删除数 —— ✅ **已修**（`bad5aae`：确认框与执行同源 `planBulkDelete`） | `src/components/search/SearchResultList.tsx:742-743` vs `:724` |
| **DS-43-14** | P2 | 批量删除**第 k 条失败 ⇒ 第 k+1…n 条根本不执行**，但只有一句通用「删除操作失败，请重试」⇒ 静默的部分执行 —— ✅ **已修**（`bad5aae`：在第一条失败处停下，并如实回报「第几条失败、前面删了几个、还剩几个没动」） | `src/components/search/SearchResultList.tsx:721-733` |
| **DS-43-15** | P2 | 「删除所有会话」的确认数字取自 **Redux 快照**，SW 按磁盘真值删并回传 `{count}` —— **这个 count 从未展示过**，且删完零成功提示 —— ✅ **已修**（第 46 轮，`34c2b33`：确认前读**磁盘真值**（读不到就**中止**）+ 删完报**实际条数**） | `src/components/layout/HeaderDropdown.tsx:170/602` vs `src/core/mutationOps.ts:211` |
| **DS-43-16** | P2 | 「删除前确认」开关**关闭**时，✕ 的提示只说「移除这条记录」，**没说整个会话卡会一起消失** —— ✅ **已修**（`e169764`） | `src/components/dnd/DraggableTab.tsx:431` |
| **DS-43-17** | P3 | 删除按钮的 `aria-label` 不含「不可恢复」，且 Tooltip **没有 `aria-describedby` 接线** ⇒ 读屏用户听不到「删除后无法恢复」 —— ✅ **已修**（`b0ca1f9`：「删除后无法恢复」进**可访问名**本身 —— Tooltip 的 `aria-describedby` 只在可见时才挂，多数读屏不会重念 ⇒ 后果必须写在名字里） | `src/components/tabs/TabGroup.tsx:1227-1236`、`src/components/common/Tooltip.tsx:171` |
| **DS-43-20** | **P0（条件性）** | **`chrome.storage.local` 被清 ⇒ 用户被登出 ⇒ 重新登录时 `first-bind` 把本机全部会话**静默认领**给新账号，零提示** —— DS-1 的原始后果被完整重开。触发条件需真实浏览器验证（见 §6.3） | `src/utils/supabase/client.ts:59` + `src/storage-kv/stringStore.ts:27-37` → `src/store/slices/authSlice.ts:110-125` → `src/core/accountScope.ts:257-270` |
| **DS-43-18** | P1 | 「冲突」在代码里**不存在**：`syncStatus: 'conflict'` 从未被赋值 ⇒ `stats.conflicts` **恒为 0**；且三处文档说「以**最后保存**的一方为准」，而胜负其实由 `(seq, deviceId 字典序)` 决定 ⇒ 文档教了一个不成立的预期 —— ✅ **已修**（文档半：`00783c7` / `639f8ff` / `ec759a9`；代码半：本轮 —— 删掉恒为 0 的 `stats.conflicts` 与永不出现的 `'conflict'` 取值，见 §7.5 之五） | `src/services/syncEngine.ts:70/733/1161`、`src/types/tab.ts:16/119`、`README.md:8/73`、`CHROMEWEBSTORE.md:430` |
| **DS-43-19** | P1 | 归属待决期（WebDAV 首次同步）有一条**登记竞态**：`scheduleUpload` 在保存/重命名/加锁分支**没有 await** ⇒ 登记还在飞行中，本轮白名单快照看不到它 ⇒ `clearPendingUploadGroupIds`（kvRemove）与在途的 kvSet 竞争 ⇒ **登记被抹掉、`pending_upload` 被置 false** ⇒ 该改动留在本机不上云，界面却报「同步成功」 —— ✅ **已修**（`3c73504`：`scheduleUpload` 补 await + 白名单改成**按确认逐条消费**（读-改-写，不再 `kvRemove`）⇒ 在途的登记不会被抹掉） | `src/background/mutationHandlers.ts:224/306/319` vs `:246/254/262`；`src/services/syncEngine.ts:1285,1558-1564` |
| **DS-7 / DS-8 / DS-11 / DS-17** | — | **上轮清单已过期：这四条在 HEAD 上其实已经修好了**（详见 §1） | — |
| **P0-1**（第 47 轮新） | **P0** | **后台算不出「本机当前指向哪个云端库」** ⇒ 归属待决位（**按库寻址**）在 service worker 侧恒为保守分支 ⇒ **SW 永远以为归属决策没做完** ⇒ 自动上传被永久降级成「只传本次改动过的那几个」⇒ **本机的历史会话再也传不上用户自己的云盘，而回包还报「成功」** —— ✅ **已修**（第 47 轮：同一份模块、两种取法 —— 页面动态 import / SW 由入口静态注册；**已在真 Chrome 上验过**，见 §8） | `src/storage-kv/firstSyncPendingRecord.ts:145`（旧写法 `await import(...)`）→ `src/sync-backend/webdav/libraryIdentityRuntime.ts` |
| **P0-48-1**（第 48 轮新） | **P0** | **弹窗每开一次都把整条 Supabase SDK 拉下来**（≈**267KB** 未压缩 / **75.3KB** gzip）—— 只为核一次「你登录着吗」，而用户点开弹窗只想看**本机会话列表**。⚠️ 这个缺陷**编译期合法、类型全绿、界面照常能看**，只有网络面板里多出的两个 chunk 才看得出来 ⇒ 单测**完全隐形** —— ✅ **已修**（第 48 轮：核登录态整件事搬到 **service worker**（SW 侧 SDK 是**静态依赖** ⇒ 零下载），弹窗只发一条消息问「核完了吗」；**真机 A/B 实测**：首帧之前被请求的字节 **884.4KB → 617.2KB**，且弹窗**一次也没请求过** SDK 块，见 §11） | `src/components/app/AuthProvider.tsx`（挂载时 `getCurrentUser()`）→ `src/store/slices/authSlice.ts:307` |

**本轮真正能立刻动手、且不需要改协议的**：DS-4、DS-5、DS-9、DS-15、DS-43-1、DS-43-2、DS-43-3、DS-43-7、DS-43-10 ~ DS-43-16、DS-43-18、DS-43-19。合计 17 条。
**需要改协议 / 需要真实浏览器或真实后端才能验的**：DS-3（①）、DS-43-20（触发条件）。

> **第 47 轮的结账（2026-10-23）**：上面这 17 条**全部已修并各自带 commit**（见 §0 表与 §3 / §4 / §5 的逐条处置）。
> 另有第 47 轮**新发现并当场修掉**的：P0-1（后台算不出库作用域，见上）、P0-2 / P1-3 / P1-4 / P1-5（搜索页那一批，`bad5aae`）。
> **仍然开放**：DS-3 的**修法①**（要改印记格式 = 协议级）、DS-43-6 残余（`downloads` 权限 —— **要 Jasper 拍板**）、DS-43-20（触发条件要真机）。

> **第 48 轮（2026-10-23）**：新发现并修掉 **P0-48-1**（弹窗每开一次都下载整条 Supabase SDK ≈75KB —— 见 §11）。
> ⚠️ 它的根子跟第 47 轮的 P0-1 是**同一个形状**：「同一份模块，两种取法」
> （页面动态 import / SW 由入口静态注册）—— 只是这次搬的是「核登录态」，
> 上次搬的是「算库作用域」。**判据的形状也跟着同一种**：
> 纯函数判据 + IO 留在 IO 层 + **变异自证**（改坏 ⇒ 红；等价改写 ⇒ 绿）。

---

## 1. 上轮推迟项的逐条裁定

上轮推迟清单（`docs/audit-2026-10-22-round42.md` §6.2）：`DS-3 / DS-4 / DS-5 / DS-7 / DS-8 / DS-9 / DS-11 / DS-15 / DS-17`。

| 编号 | 上轮说「推迟」的理由 | 本轮裁定（HEAD `23d2aab`） | 现在能修吗 |
|---|---|---|---|
| **DS-3** | 需要改协议 | **仍然成立，确认为 P0**。但上轮给的**修法②（披露）不需要改协议** —— 删除确认框与三处文档补一句即可，**现在就能做** —— ✅ **已修**（`1f7bb14`）。修法①（给删除一个语义优先级位）确实要改印记格式 ⇒ 本轮不碰 | ②✅已修，①不能 |
| **DS-4** | 读失败 fail-open | 第 43 轮时**仍然 fail-open**（`src/utils/storage.ts:1138-1141` 一字未改）—— ✅ **已修**（`3c73504`，按 §1.1 的结论**抛错**） | **能**，但**别照抄上轮的改法**（见下） |
| **DS-5** | 读失败 fail-open | 第 43 轮时**仍然 fail-open**（`src/utils/storage.ts:1272-1275` 一字未改）—— ✅ **已修**（`3c73504`，**抛错**） | **能**（1 行，见下） |
| **DS-7** | 清理重复的确认数来自陈旧快照 | **已经修好了**（上轮清单过期）。`src/components/layout/Header.tsx:135-140` 现在读真值失败就**中止清理并提示**，不再退回快照 | 不用修 |
| **DS-8** | 退出登录不清本地数据、零提示 | **已经修好了**（上轮清单过期）。`src/components/layout/HeaderDropdown.tsx:459-512` 现在先数本机会话数，退出后明说「本机 N 个会话仍保留，不会上传到其它账号」 | 不用修 |
| **DS-9** | 锁定会话逐条删除的提示零覆盖 | 第 43 轮时**仍然零覆盖**：守卫的标题写着「且给出可执行的解释」，断言却只到 `/showDeleteError\(/` 为止 —— ✅ **已修**（`bad5aae`：两处措辞抽成同源纯函数，守卫改钉「两处同源」） | **能**（1 行断言） |
| **DS-11** | 熔断守卫把实参钉死 | **已经修好了**（上轮清单过期）。`tests/syncFailsafeGuard.test.ts:92-120` 现在断言的是不变量（两道闸门都要在），不再是字面量 | 不用修 |
| **DS-15** | 导入不覆盖，同名会话并存无提示 | 第 43 轮时**仍然成立**：导入仍是纯追加（`src/core/mutationOps.ts:346`），导入结果文案仍不说这件事 —— ✅ **已修**（`35b363f`：导入结果一律带上这句披露；**行为不动**） | **能**（文案层） |
| **DS-17** | 两后端「读不出来」共用一句话 | **已经解决了**（上轮清单过期）。现在 Supabase 侧有专属文案模块 `src/components/sync/skippedRemoteGroupsCopy.ts`（只挂在 `SyncButton.tsx:10`），而 WebDAV 的「读不出来」是整轮抛错 ⇒ **两边不再共用同一句话**。`src/utils/serviceWorkerErrorCopy.ts` 的 `REASON_COPY` 与本条无关（那是 SW 的 URL 打开失败） | 不用修 |

> **上轮清单本身的四个错**（留给下一轮，别再照抄）：
> ① §6.2 把 DS-7 / DS-8 / DS-11 列成「推迟」，但它们在上一轮**收尾阶段**其实已经修好了 —— §2.2 的处置行与 §6.2 的清单自相矛盾。
> ② §6.2 那段「DS-1 修完之后的已知边界」的**推理是错的**（见 §6.3）。
> ③ §2.2 写「**DS-12** 已修」（拖走最后一条标签：零成功反馈），但**代码里没有这次修复** —— HEAD 的 `handleMoveTab` 的 `.then` 里只有失败分支，上轮发布提交（`bac6ec1`）对这段函数的 diff 也没加过任何 toast ⇒ 上轮之后这条路径一次都没被改过。见 §3.3 的 DS-43-11。**这一条最值得记住**：上轮自己的元教训第 5 条写的是「『判据层全绿』≠『功能被用上了』」，而这一条是它的加强版 —— **连「已修」这句话本身都没有被任何东西钉住**。建议：凡是写进审计处置表的「已修」，都要有一条**指向具体代码改动**的引用（commit 或行号），否则下一轮只能靠重新读代码来发现它其实没修。
> ④ **§5「主审的撤回记录」把 DS-3 撤成了「不成立」，这个撤回是错的。** 撤回理由写的是「墓碑取号走的是**同一个持久化号位**，新号必然大于墓碑」—— 这只保证**同一台设备内部**的单调。跨设备时：墓碑号 = `max(A 的本机号位, 云端那行当时的 seq + 1)`（`src/utils/supabase/upload.ts:1374-1377`），而**对方那台设备离线编辑的号来自它自己的计数器**（`src/utils/seqRegistry.ts:78-104`）⇒ 两个无关计数器的裸数值比较决定胜负（`src/core/opStampMerge.ts:50-56` → `src/core/opStamp.ts:22-26`）。
> 　 用仓库真实的 `mergeOpStamped` + `shouldConcedeGroup` 跑出来的实测：
> ```
> 墓碑seq(A)=100 离线编辑seq(B)=99   -> 本地存活=false | B认输=true  | ✅ 删除生效
> 墓碑seq(A)=100 离线编辑seq(B)=101  -> 本地存活=true  | B认输=false | ❌ 删除被撤销
> 墓碑seq(A)=3   离线编辑seq(B)=100  -> 本地存活=true  | B认输=false | ❌ 删除被撤销
> ```
> 　 三个条件同时成立时，上轮的撤回是对的：**同设备**（A 删完再编辑）、**对方的编辑已经上云**（墓碑号 = `max(A 号位, 对方 seq+1) > 对方 seq`）、**对方的编辑还在本地且删除广播先到**（← 这一档就是 DS-3，仍然活着）。
> 　 ⇒ **教训**：撤回一条发现时，必须把「它在什么条件下成立」写出来；只写一句「已由 X 解决」而没有边界条件，下一轮就会拿着那句总结当结论用。

### 1.1 DS-4 / DS-5 的改法要改上轮那一版（上轮给的方向有一个坑）

上轮给的最小改法是 `catch { return true; }`（DS-4）/ `catch { return { unreliable: true, gapOpen: true, gen: 0 }; }`（DS-5）。**方向是对的，但照抄会引入一个新的静默失败**：

- **DS-4 改成 `return true`** ⇒ 读失败被当成「归属待决」⇒ WebDAV 路径进入**白名单模式**。而白名单 `getPendingUploadGroupIds` 在同一个读失败下也返回 `[]`（fail-closed）⇒ **本轮一个会话都不传**；接着对账看到「登记集合 = 空集」⇒ `unsyncedIds` 也是空 ⇒ `canClearPending = true` ⇒ **清掉 `pending_upload` 并报「全部已同步」**。
  ⇒ 也就是说：**读失败会变成一次「静默的假成功」** —— 比原来的 fail-open 更隐蔽（原来是「多传」，改完变成「少传且谎报成功」）。
  ⇒ **正确改法：抛错**（`getFirstSyncPending` 的读失败直接冒出去 ⇒ 本轮上传中止 ⇒ 界面报失败 ⇒ 下一轮重试）。这与 `storage.getGroups` / `getSettings` 的既有纪律一致。
- **DS-5 改成返回 `{unreliable:true, gapOpen:true, gen:0}`** ⇒ 方向安全且**能自愈**：那一轮 `decideRegistryAfterUpload` 会尝试用 `expectedGen = 0` 写回，被 `setPendingUploadRegistryStateIfUnchanged` 的并发保护挡下（`storage.ts:1347`）⇒ 状态保持「不可信」⇒ 本轮如实报「无法确认全部已同步」⇒ 下一轮读到真实 `gen` ⇒ 正常路径是全量 ⇒ 标志复位、缺口关闭。**代价是多一轮「不能确认已同步」的提示**，可以接受。
  ⇒ 若不想留这个多轮提示，**同样可以抛错**（读不到 ⇒ 本轮中止 ⇒ 下一轮重来），语义更直白。

⇒ 两条都建议**抛错**，与 `getGroups` / `getSettings` 同口径；这比「返回一个假装正常的值」更符合仓库自己的铁律 1。

> **已按此修**（`3c73504`）：两条都改成**抛错**。
> · `storage.getFirstSyncPending()` 读失败 ⇒ 抛「读不到归属决策状态，已中止本轮上传以免历史会话被误传」
>   ⇒ 本轮上传中止、界面报失败、下一轮重试。**不是** `return true`（那会进白名单模式 ⇒ 本轮一个都不传 ⇒ 对账看到空集 ⇒ 报「全部已同步」⇒ 静默的假成功）。
> · `storage.getPendingUploadRegistryState()` 读失败 ⇒ 抛「读不到『本次改动的会话 id』登记状态，已中止本轮上传」。
> · 界面（`WebDavSettings.tsx`）的「归属待决」从布尔改成**三态**（`boolean | null`）：
>   `null` = **读不到** ⇒ 显示「读不到『这些会话归不归这个云盘』的状态，已暂停自动上传以免误传。请刷新页面重试……」
>   ⇒ **不许**落回「没有待决」（那等于把「不知道」说成「没有」）。
>
> **守卫**：`tests/guards/readFailureFailClosed.test.ts`（行为层：注入读失败 ⇒ 必须 reject）
+ `tests/guards/readFailureFailClosedMutation.test.ts`（变异自证：**六条**——改回 `return false` ⇒ 红；
> 改成 `return true`（上一轮那版）⇒ **也必须红**；改回 `return clean` ⇒ 红；界面落回 `setOwnershipPending(false)` ⇒ 红；
> 界面退回布尔 ⇒ 红；**等价改写**（错误消息换个说法）⇒ **仍然绿**）。

---

## 2. 本轮三个新模块的深审

### 2.1 `src/core/accountScope.ts` —— 归属判定

**归属记录写在哪**：`chrome.storage.local` 的独立键 `local_account_scope`（`src/utils/authCache.ts:33`），会话本体在 IndexedDB（`src/storage-kv/`）。写入点只有三处：`authCache.ts:124`（退出登录前记一笔）、`authSlice.ts:121`（登录认账）、`upload.ts:525`（上传时兜底播种）。

**「记录不存在」与「记录损坏」处理得确实不同 —— 这一条上轮修对了：**

| 情况 | 走到哪 | 结果 |
|---|---|---|
| 记录**不存在**（键缺失） | `accountScopeStore.read()` 返回 `null`（`authCache.ts:80-83`） | `loadAccountScopeForUpload` 走兜底（`upload.ts:518-525`） |
| 记录**形状损坏** | `normalizeAccountScope` **抛错**（`accountScope.ts:118-166`） | 异常一路冒到 `uploadTabGroups` 之外 ⇒ **上传整体中止**（fail-closed）✔ |
| 记录**读失败**（`chrome.storage.local.get` 抛） | `accountScopeStore.read()` **不 catch** ⇒ 同样冒出去 | 上传中止 ✔ |

**但兜底本身是 fail-open（DS-43-7）**：`upload.ts:518-525` 在记录缺失时用 `lastUserId ?? currentUserId` 播种并**落盘**。

- `readLastAuthCacheUserId()` 的注释写「读失败返回 null（**调用方据此中止上传，fail-closed**）」（`authCache.ts:50-53`）—— **调用方没有中止**，`null` 被当成「这台机器从没登录过」⇒ 全机会话认给当前账号。
- 真实后果：`auth_cache` 与 `local_account_scope` **同在 `chrome.storage.local`**（`authCache.ts:47` vs `:80`）⇒ 两者一起丢时，`lastUserId` 必然是 `null` ⇒ **兜底永远退化成「归当前账号」**。
- 今天还没被触发（两个读共用同一个失败域，chrome.storage.local.get 抛错时 `accountScopeStore.read()` 也会抛 ⇒ 上传中止），但**注释与实现的承诺不一致**，且 DS-43-1 那种「换账号后误删」的组合会踩到它。

**修法（1 行，闭合 §6.2 那个窗口）**：`loadAccountScopeForUpload` 在记录缺失时**抛错**而不是播种。理由：登录必然走过 `bindLocalSessionsToAccount`（`authSlice.ts:110-137`）⇒ 真正要上传时记录一定存在；记录不存在本身就是异常状态，不该由上传层替用户认账。

**其它审查结论：**

- `resolveGroupOwner`（`accountScope.ts:178-187`）的判定顺序（显式例外 > 归属账号 > 兜底）正确。
- `decideAccountBind`（`:248-325`）的 first-bind / same-account / account-switch 三分支正确：换账号时给**本机现有且无明确归属**的会话补认账给上一个账号，新账号之后新建的会话自然落在新账号名下。
- `pruneForeignOwners` 只在 `decideAccountBind` 里被调，而 `bindLocalSessionsToAccount` 在**同账号时提前 return**（`authSlice.ts:112-113`）⇒ **同账号登录时归属表从不清剪**。`foreignOwners` 只增不减（每条约 90 字节，`chrome.storage.local` 配额 10MB）⇒ 需要删掉 10 万个会话才会顶到配额。**低危，记录**。
- `bindLocalSessionsToAccount` 整体包在 try/catch 里并**吞掉异常**（`authSlice.ts:129-137`）⇒ 归属记录写失败时登录照样成功，闸门随后会把**全部**会话判成「不是当前账号的」⇒ 当前账号一个会话都传不上去。方向是安全的（不会泄露），但**用户看到的只是「同步没动静」**。建议：写失败时至少留一条可见提示。
- `filterGroupsByAccount`（`:195-213`）是纯函数、无 IO、判据单一 ⇒ 这部分设计是干净的。

### 2.2 `src/core/overwriteGuard.ts` —— 覆盖删除计划

- 判据是**集合差**而不是数量差（`deletedIds = local − surviving − tombstones`）⇒ 云端新增的会话不会掩盖本机的删除。这一点比上轮的做法更正确，**保留**。
- 调用点有两处（合并前估计 `src/services/syncEngine.ts:739` 附近、合并后精确值 `:963` 附近），两处**在写入之前**（`setGroupsImmediate` 在熔断之后）⇒ 「熔断在写入之前」这句注释是真的，**不是假话**。
- **部分失败的口径是对的**：云端「读不出来」的组走 `skippedIds` ⇒ 被算进 `survivingActiveIds` ⇒ 不会被算成「这次覆盖删掉的」；云端墓碑（别的设备显式删的）走 `cloudTombstoneIds` ⇒ 也不算 ⇒ **「远端说它被删了」不被熔断拦下**（拦下就成了「用户删不掉」），口径正确。
- **一个必须知道的边界**：`src/sync-backend/failsafe.ts:34` 的 `minTotal: 5` ⇒ **本机活跃会话 ≤ 5 个时，比例判据整条不生效**（`totalBefore > minTotal` 才算比例），只有 `maxChanged: 1000` 那条兜底。⇒ 「本机 5 个、云端 1 个」的一次覆盖不会被熔断拦。这是 Floccus 原式口径（避免 3 条的库删 1 条就熔断），**不是缺陷**，但它是「覆盖」这条路上唯一的一道闸门，记在这里备查。
- **覆盖删除计划的剩余风险不在判据里，在「上传失败」上**：判据只问「这次覆盖会删掉本机会话多少」，**不问「云端那一侧写得进去吗」**。合并已经把本机那份覆盖掉了（本地物理清除），随后上传若整轮失败 ⇒ 云端没有这些行、本地也没有 ⇒ **净删除**。这条不在本轮修改范围内（属于「合并与上传不是一个事务」的结构性问题），但**它是覆盖路径上最后一条不可逆的口子**，下一轮应专门看。

### 2.3 `src/core/uploadCoverage.ts` —— 上传覆盖对账

- `reconcileUploadCoverage`（`:170-199`）的判据正确：登记集合 ⊆ 上行 ∪ 已删除结案 ∪ 不属于本账号；两个标志位（`unreliable` / `gapOpen`）**分开**、各自有**与对账无关**的复位路径（`decideRegistryAfterRegistryWrite` / `decideRegistryAfterUpload`）⇒ **没有自指**。这条是上轮 D-10 的正解，**保留**。
- `notThisAccountIds` 那一支（`:96-109` / `:175-179`）的推理是对的：属于别的账号的会话**永远**不会进上行集合，把它算成「未同步」会让 `pending_upload` 永远清不掉 ⇒ 无限重试。**与 DS-43-1 同源**：这个设计只处理了「上传侧」，**删除广播侧没有对应的处理**。
- **「登记了但传不上去」会不会永远重试？** 分三种：
  1. **正常路径**（非归属待决期）：`groupsForUpload = activeGroups`（全量）⇒ `submittedCoversAllActive` 恒为真 ⇒ 标志每轮复位 ⇒ **不会卡**。
  2. **归属待决期**（WebDAV 首次同步）：清单由白名单决定 ⇒ `scopeDerivedFromRegistry = true` ⇒ 登记不可信就**阻断**本轮，`pending_upload` 保留 ⇒ **会一直重试，直到用户完成归属决策那一次全量上传**。这是设计内的（`decideRegistryAfterUpload` 的 `needsFullScope` 注释里明写「不许为了关 gap 而绕过归属决策」）。
  3. **DS-5 的读失败**：读失败被当成「干净」⇒ 标志复位 ⇒ 缺口被当成已补上 ⇒ **漏登记的那批永远不重试**。这是本条真正的问题，见 §1。
- **一个结构性观察**：`registeredGroupIds` 只在 `suppressFullUpload` 时非空（`src/services/syncEngine.ts:1285`）⇒ **正常路径下这个对账是空对空**（`unsyncedIds` 恒为空），真正兜住「漏登记」的是 `submittedCoversAllActive` 那条「本轮是不是全量」的事实判据。两条判据的职责不同、但**文档里都叫「对账」**，容易让人误以为白名单对账在正常路径上兜底。**不是缺陷，是命名/文档问题。**

---

## 3. 删除 / 消费全链路

> 每个动作三问：① 用户预期 ② 实际行为 ③ 用户还能拿回什么。

| 动作 | ① 用户预期 | ② 实际行为 | ③ 还能拿回什么 | 判定 |
|---|---|---|---|---|
| **删除整个会话** | 永久删除，其它设备同步删除 | 确认框 → 本地物理移除 → 登记 `pendingDeleteIds` → 上传时 `markCloudGroupsAsDeleted` 打云端墓碑并读回确认 → **只清被点名确认的那些 id**（`storage.ts:1018` `clearPendingDeleteIds`） | **什么都拿不回**（无回收站、无撤销）。跨设备删除靠队列 + 单调印记，不靠重读 | ✔ 与文案一致 |
| **删除单个标签** | 立刻生效，不弹确认 | `shouldAutoDeleteAfterTabRemoval`（`src/core/tabGroupUtils.ts:9-23`）：**锁定的组豁免**；否则删到组空 ⇒ **整组跟着消失**（会先确认，商店文案已披露） | 同上 | ✔ |
| **拖走最后一条标签** | 直接生效，不多问（产品钦定，`tests/dragLastTabRefused.test.ts` 钉住） | 组被搬空 ⇒ 整个会话消失；锁定组豁免（`tabGroupUtils.ts:11-13`） | 同上 | ⚠️ **DS-43-11：成功时零反馈**（见 §3.3） |
| **清理重复标签** | 给出真实数量再确认 | 上轮已修：读真值失败 ⇒ **中止清理并提示**（`Header.tsx:135-140`） | — | ✔ |
| **恢复整个会话（消费）** | 标签打开，会话从列表消失 | 1.24.1 定案：恢复即消费。**锁定的会话从不被消费** | **有退路**：屏幕上的「撤销」把**记录**放回列表（不去关已开的窗口），并撤回跨设备删除意图（`storage.ts:1018-1043` `retractPendingDeleteIds`） | ⚠️ **DS-43-10：搜索页的部分成功分支没有退路**（见 §3.3） |
| **恢复锁定会话** | 标签打开，会话**仍在** | 锁定 ⇒ 不消费 ⇒ **不给撤销按钮**（挂了就是骗人） | 会话本来就没被删 | ✔ |
| **撤销** | 把记录放回去 | 单写者队列（上传与语义命令串行）+ 单调 Lamport ⇒ 撤销要么整块排在上传前（意图已撤），要么排在上传后（取更新的印记复位云端行）。**两种顺序都不分叉** | — | ✔ 语义正确 |

### 3.1 DS-43-1（本轮新）：删除广播没有账号闸门 ⇒ 删除被静默丢弃 ⇒ 会话在原账号下复活

**位置**

- `src/utils/supabase/upload.ts:1269` `markCloudGroupsAsDeleted(deletedIds)` —— 用**当前登录账号**的 `userId` 写云端（`.eq('user_id', userId)`），**没有任何账号归属判断**。
- `src/services/syncEngine.ts:1396-1416` —— `pendingDeleteIds` 那一支**故意不过滤**（这是对的：不能套 `writtenTombstoneIds`），但**也没有账号闸门**。
- `src/utils/supabase/upload.ts:1327` —— `verifyTombstoneReadback(deletedIds, userId, { missingAsAchieved: true })`：**云端没有这行 ⇒ 视为「意图已达成」**。
- 闸门只在一个地方：`src/utils/supabase/upload.ts:700-701`（`filterGroupsByAccount`）—— **只管上行，不管删除广播**。

**可复现的失效路径**

1. 机器 M 登录**账号 A**，保存会话 X，同步 ⇒ X 是 A 云端里的一行（`user_id = A`）。
2. 退出 A，登录**账号 B**。账号闸门把 X 认账给 A（`foreignOwners[X] = A`）⇒ X **不会**上传到 B。本地列表仍显示 X，提示「本机还有 1 个会话属于上一个账号」。
3. 用户**删除 X**（整个会话）。删除 UI 不看归属 ⇒ X 被物理移除，id 进 `pendingDeleteIds`。
4. B 下的下一轮上传：`markCloudGroupsAsDeleted([X], B)` ⇒ `UPDATE tab_groups SET is_deleted=true WHERE user_id = B AND id = X` ⇒ **0 行**；读回校验按 `missingAsAchieved` **判成功** ⇒ `storage.clearPendingDeleteIds([X])` ⇒ **删除意图被当作「已达成」清掉**。
5. 用户再登录 **A** ⇒ `restoreAfterLogin` 下载 A 的云端 ⇒ X 在 A 云端仍是 `is_deleted = false` ⇒ `mergeOpStamped`（`src/core/opStampMerge.ts:43-48`）判「云端有、本机没有」⇒ **把 X 整组加回本地列表**。

**用户看到什么**：删掉的会话**又回来了**，零提示、零报错。而且它会继续留在 A 的云端里（本地副本被重新上传覆盖）。

**数据是否丢**：不丢（内容还在）。**丢的是用户的删除意图**，且违反仓库自己的铁律——`src/utils/storage.ts:845-855` 的注释白纸黑字写着这条失效模式：「删除意图永久丢失 → 对端下次合并（`mergeOpStamped` 的 `cg && !lg`）把已删的组整组加回来」。**本条就是那条注释所描述的失效，只是触发原因换成了「广播发给了错误的账号」。**

**严重度**：P1。**不是 P0**：跨账号泄露那条底线**没有被突破**（闸门挡住了 X 被传进 B 的云端），坏的是「删了又回来」。

**修法（不改协议）**：在广播前用同一套归属判据把 `pendingDeleteIds` 分成「属于当前账号」与「属于别的账号」两批：

- 属于当前账号的 ⇒ 照常广播 + 读回确认 + 清队；
- 属于别的账号的 ⇒ **留在队列里**（`clearPendingDeleteIds` 已经只清被点名确认的那些 ⇒ 天然支持），等用户登录到那个账号时再广播。

这样「换账号 ⇒ 删了 A 的会话 ⇒ 切回 A ⇒ 它还在」变成「切回 A ⇒ 它真的被删了」，语义闭合。**注意这条与铁律 4 是两回事**：铁律 4 禁的是套 `writtenTombstoneIds` 过滤器，这里加的是**归属**过滤，两者不冲突。

> **已修**（`00a2ad0`）：广播前用同一套归属判据把 `pendingDeleteIds` 分成「属于当前账号」与「属于别的账号」两批；
> 后者**留在队列里**（清队是**按确认逐条消费**的 ⇒ 天然支持），等用户登录到那个账号时再广播。
> **第 47 轮补上端到端守卫**（`e006eaa`）：`tests/guards/deleteBroadcastAccountRoundTrip.test.ts`
> 钉的是**用户可见的终点**（A 的云端那行还是活跃的 → 切回 A 后它**必须**变成墓碑 → 真广播过之后队列**必须**被清掉），
> 而不只是「没被清掉」（后者挡不住「永远留在队列里、永远不广播」）。
> 假后端**转手给真的 Supabase 写入层**（闸门住在那里）⇒ 证明的是「闸门真的挡住了别的账号的会话」，
> 不是「引擎按点名清队」。

### 3.2 导入路径顺带发现的删除相关问题
- **DS-43-3**（详见 §4.1）：导入可以注入 `isDeleted` ⇒ 造出一个「看不见的会话」，它随后被当成老版本墓碑**物理删除**。
- `applyImportGroups` 是全仓**唯一一条纯增量、零删除**的路径（`src/core/mutationOps.ts:346`：`[...processed, ...groups]`）⇒ 这条性质值得保留，**不要**为了修 DS-15 把它改成覆盖式。

### 3.3 消费 / 删除链路的披露缺口（DS-43-10 ~ DS-43-17）

这一组不是「数据丢了」，是**用户被误导了**或**退路在某个分支上凭空消失**。其中两条值得单独说。

#### DS-43-10（P1）· 搜索页「恢复整个会话」的部分成功分支没有撤销

- **位置**：`src/components/search/SearchResultList.tsx:403-413`。
- **事实**：`consumeSession()` 在 `:403` 已经执行（会话被物理移除）⇒ 若 `skippedUnopenable > 0`，走的是 `showDeleteError(...)` + `return` ⇒ **没有 `showConsumeToast` ⇒ 没有撤销凭据**。
- **对照（同一个产品动作、另一个界面）**：`src/components/tabs/TabGroup.tsx:442-450` 的同一分支挂了 `showConsumeToast(..., { group }, { type: 'error' })`，而且它的注释原文写着：
  > 「部分成功**也是一次消费** —— `consumeSession()` 已经在上面跑过了 ⇒ 未锁定时整条会话已被移除。那是不可逆的删除，所以这条提示上同样要挂『撤销』—— 否则用户手里就有一条**没有退路**的消费。」

  ⇒ **搜索页违反的正是它隔壁那条注释写下的原则。**
- **用户看到什么**：标签开了（部分），会话从列表消失，屏幕上弹一句错误通道的说明，**没有任何撤销按钮** ⇒ 用户以为自己还能找回，其实找不回。
- **数据是否丢**：会丢（会话已被消费；无回收站、无撤销）。
- **为什么这一条特别值得修**：部分成功**恰恰是最需要退路**的场景（有的标签开了、有的打不开，用户会想「那打不开的那几个还在吧」⇒ 实际上整条会话都没了）。
- **修法**：把搜索页这一分支改成与列表页同口径（`showConsumeToast(..., group.isLocked ? undefined : { group }, { type: 'error' })`）。**两条分支应该共用同一个函数**（`useConsumeUndo.ts` 的 `showConsumeToast` 已经是共用的，缺的是调用方对齐 —— 这正是仓库自己的元教训「同一语义两处实现，迟早漂移」）。
- ✅ **已修**（`bad5aae`）：两处同口径。**守卫钉的是「数据流」不是「字面量」**（断言那条分支真的调用了带撤销凭据的 toast）。

#### DS-43-11（P1）· 上轮说「DS-12 已修」，实际没修

- **上轮的说法**：`docs/audit-2026-10-22-round42.md:112` ⇒「**DS-12** | 拖走最后一条标签：零成功反馈 | **已修**」。
- **HEAD 的事实**：`src/components/tabs/TabGroup.tsx:583-601` 的 `handleMoveTab` 的 `.then` 里**只有**失败分支（`deleteBroadcastWarn`），**成功时一句话都没有**；整条拖拽链路里也没有任何别的地方发 toast（`grep -rn "moveTabAndSync" src/` 只有这一个 dispatch 点；`src/components/dnd/` 里零 toast）。
- **反证**：`git log --oneline -S "handleMoveTab" -- src/components/tabs/TabGroup.tsx` 的最后一条是 `da51184`（一次样式重构）⇒ **上轮审计之后这条路径一次都没被改过**。
- **顺带的不一致**：round 42 给「恢复即消费」配了撤销（旗舰退路），但**拖走最后一条标签同样是「整条会话不可逆消失」**，却连一句反馈都没有 ⇒ 两条同后果的路径，一条有退路一条没有。
- **用户看到什么**：卡片凭空消失，零解释。**用户能不能拿回**：不能。
- **注**：`tests/dragLastTabRefused.test.ts` 把「不加确认」钉成了产品决定（那是对的，不建议改语义）—— **缺的只是反馈**。这正是上轮 DS-12 的原话（「产品钦定，不建议改语义，缺的只是反馈」），说明上轮**知道自己要修什么、但没修**。
- **修法**：成功时补一句「已从「X」移出「Y」，「X」因最后一条被移出而消失」（或按仓库既有风格给一条带撤销的 toast —— 但拖拽路径要接撤销，需要把「源组快照」一起带上，工作量比 toast 大 ⇒ **本轮建议先补文案，别动语义**）。
- ✅ **已修**（`e169764`）：按建议只补文案、**不动语义**（拖拽路径仍然不加确认）。

#### 其余披露缺口（DS-43-12 ~ DS-43-17）

| 编号 | 事实 | 位置 |
|---|---|---|
| **DS-43-12** | toast 队列只保留最近 3 条（`setQueue(prev => [...prev.slice(-2), ...])`）⇒ **连续消费 4 个会话**时，最早那条带撤销的 toast 被**静默挤出队列** ⇒ 那次消费变成不可逆，而用户从头到尾不知道有过退路 —— ✅ **已修**（`00783c7`：`slice(-2)` 换成 `toastQueuePolicy.admitToast` —— 挤掉的是**可挤掉**的那条（既没有动作、又不是错误）；带动作的退路与错误提示**不可被自动挤掉**，一条都挤不掉时**允许队列变长**） | `src/contexts/ToastContext.tsx:86` |
| **DS-43-13** | 搜索页「删除全部搜索结果」的确认计数用 `matchingTabs.length`（**不排除锁定组**），而执行时 `if (group.isLocked) continue` 跳过 ⇒ 标题「删除 N 个标签？」与正文「永久移除这 N 条标签记录」用的都是**含锁定的总数**，恒 ≥ 实际删除数 —— ✅ **已修**（`bad5aae`：确认框与执行**同源** `planBulkDelete`） | `SearchResultList.tsx:742-743` vs `:724` |
| **DS-43-14** | 批量删除的所有条目在**同一个 try 里**串行执行 ⇒ 第 k 条失败后**第 k+1…n 条根本不执行**，但提示只有一句「删除操作失败，请重试」⇒ 用户既不知道前 k−1 条已删、也不知道后面没删 ⇒ **静默的部分执行** —— ✅ **已修**（`bad5aae`：在第一条失败处停下，并如实回报「第几条失败、前面删了几个、还剩几个没动」） | `SearchResultList.tsx:721-733` |
| **DS-43-15** | 「删除所有会话」的确认数字 N 取自 **Redux 快照**，SW 按**磁盘真值**删并回传 `{count}` —— **这个 count 从头到尾没有被展示过**（payload 只用来取 `broadcastWarn`）⇒ 确认框数字可能 ≠ 实际删除条数；且删完**零成功提示** —— ✅ **已修**（第 46 轮，`34c2b33`）：确认前读**磁盘真值**（`planDeleteAll`，总数与锁定数出自**同一次读**），读失败**中止**（fail closed，不退回快照）；执行后按 SW 回执报**实际条数**，与确认时的数不等时说明差在哪 | `HeaderDropdown.tsx:170/602`、`:517`；`src/core/mutationOps.ts:211` |
| **DS-43-16** | 「删除前确认」开关**打开**时，删最后一条会弹「这是该会话的最后一条标签记录，删除后整个会话会从列表消失」✓；开关**关闭**时零确认，而 ✕ 的提示只有「从会话中移除这条记录（无法恢复）」—— **没说整张会话卡会一起消失** —— ✅ **已修**（`e169764`） | `TabGroup.tsx:625` vs `src/components/dnd/DraggableTab.tsx:431` |
| **DS-43-17** | 删除按钮的 `aria-label` 只有「删除会话」，「（删除后无法恢复）」只存在于 Tooltip 的 `content`；而 Tooltip 只渲染 `role="tooltip"`、**没有 `aria-describedby` 接线** ⇒ 读屏用户听不到「不可恢复」 —— ✅ **已修**（`b0ca1f9`）：「删除后无法恢复」进**可访问名**本身。⚠️ 关键理由：Tooltip 的 `aria-describedby` **只在它可见时才挂** ⇒ 多数读屏**不会重念** ⇒ 后果必须写在名字里（WCAG 2.5.3 要求可访问名包含可见文字 ⇒ 名字与提示必须一起改） | `TabGroup.tsx:1227-1236`、`src/components/common/Tooltip.tsx:171` |

#### 这条链路上**确认没问题**的部分（省得下一轮重新查）

- **SW 回 `success:false` / `ok:false` 被界面当成成功**：不存在。`unwrapDeleteResult`（`src/store/slices/tabSlice.ts:169-175`）对 `!res.ok` 一律 `throw`；所有消费点都判 `r.success !== true` 才消费。
- **读失败被当成空集后继续破坏**：不存在。`storage.getGroups` 形状不对就抛（`storage.ts:459-491`）；破坏性路径 `Header.tsx:132-138` fail-closed 中止。
- **本地已删、云端墓碑广播静默失败**：不存在。`noteDeletedGroups` 把失败转成 `broadcastWarn`（`src/background/mutationHandlers.ts:104-119`），五个删除入口全部 surface；上传侧 `markCloudGroupsAsDeleted` 失败会抛、队列保留到下轮。
- **打不开的标签被消费**：不会。前置拦截后明说「已保留在会话中」。
- **撤销的印记链**：墓碑取号与恢复取号同源同一个 `DEVICE_SEQ` 单调计数器 ⇒ 恢复印记必然新于墓碑；上传与语义命令同在 SW 单写者队列 ⇒ 不会分叉。**删除意图的撤回排在写记录之前**（`mutationHandlers.ts:391-399` → `:401-421`）⇒ fail-closed。

---

## 4. 导入 / 导出 / 往返

### 4.1 DS-43-3（本轮新，P1）：导入可注入墓碑 ⇒ 隐形会话 + 一轮同步后被物理删除

**位置**

- `src/core/normalizeTabsData.ts:178-186` —— 归一化用 `...(g as object)` 把文件里的**每一个未知字段**原样带进本地行，只覆盖 `id / name / tabs / createdAt / updatedAt / isLocked`。**`isDeleted` 不在覆盖名单里 ⇒ 文件里写了 `isDeleted: true` 就原样保留。**
- `src/core/mutationOps.ts:330-340` —— `applyImportGroups` 同样 `...group` 展开 ⇒ `isDeleted` 一路带到落盘。
- `src/core/mutationOps.ts:344` —— `.filter(group => !isEmptyGroup(group))`：`isEmptyGroup`（`src/core/mutationOps.ts:39-40`）只看**标签**、不看组级 `isDeleted` ⇒ 带墓碑的组照样算「已导入」。
- `src/store/slices/tabSliceHelpers.ts:171-179` `toActiveGroupsView` —— `if (!g.isDeleted) byId.set(g.id, g)` ⇒ **列表里看不见它**。
- `src/services/syncEngine.ts:1180` —— `legacyTombstoneIds = allGroups.filter(g => g.isDeleted).map(g => g.id)` ⇒ 它进了删除广播集合；云端没有这行 ⇒ 广播是空操作（`missingAsAchieved`）⇒ `:1421` `setGroupsImmediate(activeGroups)` **把它从本地物理删除**。

**失效路径**

1. 用户导入一份带 `isDeleted: true` 的备份（v1.21 时代带回收站的备份、或被手改过的文件）。
2. 导入提示说「已导入 N 个会话」⇒ **列表一个都没多**。
3. 下一轮同步 ⇒ 那行被当成老版本残留墓碑 ⇒ 广播空操作 ⇒ **本地这行被物理抹掉**。

**用户看到什么**：「导入了，但什么都没多」，然后那行数据也不见了，零解释。
**数据是否丢**：**是**（用户以为恢复出来的会话不存在）。
**可达性**：需要文件里带 `isDeleted` 字段。旧版备份的可达性我**没有**做到端到端验证（旧模型的删除组是存在独立键里还是同键带 `isDeleted`，需要查 v1.21 的导出实现）⇒ **标 P1 但可达性待验**。用手改过的 JSON 一定可复现。

**修法**：`normalizeImportedGroup` 的覆盖名单里加上 `isDeleted: false`（导入的永远是「活着的会话」），并在 `applyImportGroups` 里对组级 `isDeleted` 显式归零。一行。

> **已修**（`00783c7` 组级 / `5b33048` **标签级**）：
> · **组级**：`isDeleted` 在导入归一化时显式归零 ⇒ 导入文件带不进来。
> · **标签级**（第 47 轮补）：导入文件**不许注入标签级墓碑** —— 一条标签在**所有设备**上会永久隐形
>   （组还在，但那条标签谁都看不见、也删不掉）。这是组级墓碑的「缩小版」，同一个洞的另一个入口。

### 4.2 DS-43-2（本轮新，P1）：OneTab 往返抹掉锁定态 ⇒ 锁的保护失效

**位置**：`src/sync-backend/oneTabFormatParser.ts:222-241` —— 解析 OneTab 时新建的会话是 `isLocked: false`、`favicon: ''`、`pinned: false`、时间戳全为导入时刻、**会话名由内容派生**（`deriveImportedGroupName`，只实现了保存规则的第一档「主导域名」，`oneTabFormatParser.ts:33-36`）。导出侧 `formatToOneTabFormat`（`oneTabFormatParser.ts:253-274`）只写 `url | title` ⇒ **格式本身承载不了锁定态**。

**失效路径**

1. 用户把一个**锁定**会话导出成 OneTab（拿去别的浏览器用）。
2. 在另一台机器导入 ⇒ 该会话变成**未锁定**。
3. 用户点「快速恢复」⇒ 标签开了，**会话从列表消失**（未锁定会话恢复即消费）—— 而锁定态本该让它留在列表里。
4. 不可逆（v1.22.0 起无回收站；这条路径**没有撤销**，因为锁定会话从不被消费 ⇒ 也从来没有过消费 ⇒ 也就没有撤销按钮）。

**用户看到什么**：他明明锁过这个会话，恢复后它却没了。
**数据是否丢**：**是**（会话被消费掉了）。
**与承诺的冲突**：`CHROMEWEBSTORE.md:50` 承诺「**锁定的会话恢复后仍保留**，可以反复使用」。往返之后这个承诺对导出的那份不成立。
**修法**：OneTab 格式承载不了锁定态 ⇒ **不能靠格式补**（那是协议级改动）。可做的是**披露**：导入 OneTab 后的提示里写明「OneTab 格式不含锁定信息，导入的会话都是未锁定的」；并在**导出**时提示「OneTab 格式不保存锁定状态 / 会话名 / favicon，导出后重新导入会丢失这些」。JSON 路径无此问题（`isLocked` 保真）。

> **已修**（`00783c7` 披露；第 47 轮补 `002e666` 变异自证）：披露落在**导出侧 + 导入侧**两处。
> 守卫不钉字面量 ⇒ **等价改写必须仍然绿**（钉死字面量会让正确修复反而红 —— 本仓反复踩的坑）。

### 4.3 DS-15（仍开放）：导入不覆盖 ⇒ 同名不同内容的会话并存成两份

`applyImportGroups` 的指纹是「组名 + 组内 URL 集合 + 计数」（`src/core/mutationOps.ts:299` `groupContentFingerprint`）⇒ 同名但内容改过的会话指纹不同 ⇒ **两份并存，零提示**。这与导入「纯增量、零删除」的性质是一致的（不覆盖是**对的**），缺的只是**一句说明**。

**修法（文案层，1 处）**：`src/components/layout/importResultCopy.ts` 的部分成功文案补一句「同名但内容不同的会话会作为新会话并存」。

### 4.4 DS-43-4 / DS-43-5 / DS-43-6 / DS-43-8 / DS-43-9（本轮新，P2）

| 编号 | 事实 | 位置 |
|---|---|---|
| **DS-43-4** | 导入用 `data.data.groups.map(normalizeImportedGroup)`，**没有逐组 try/catch**；而 `asIso` 对「有限但越界」的数字（`new Date(1e20).toISOString()` 抛 `RangeError`）会炸 ⇒ **一个坏时间戳让整批导入归零**，失败理由却写着「可能是浏览器存储空间不足或扩展无写入权限」⇒ 用户永远查不出真因 | `src/utils/storage.ts:1707` + `src/core/normalizeTabsData.ts:80` + `src/utils/storage.ts:1784-1787` |
| **DS-43-5** | 组落盘与设置合并**不原子**：设置合并的 try/catch 只 `logWarn`，函数仍返回 `ok: true` ⇒ 界面弹「已导入 N 个会话」，而**主题 / 布局 / 排序键其实没恢复**，零提示 | `src/utils/storage.ts:1736` vs `:1758-1760` |
| **DS-43-6** | 导出**成功零反馈**（只有 `onClose()`，没有 toast）；扩展的 `manifest.json` **没有 `downloads` 权限** ⇒ 下载被浏览器策略拦 / 多文件下载提示拦 / 磁盘写失败时，**扩展收不到任何信号**，用户什么都看不到 | `src/components/layout/HeaderDropdown.tsx:644`（OneTab 同款在 `:679`）+ `manifest.json:10-16` |
| **DS-43-8** | 商店文案「导入的会话也**按内容命名**（和保存时同一套规则）」**两档都不成立**：JSON 导入保**文件里的名字**（`normalizeTabsData.ts:181`），OneTab 导入只实现保存规则的第一档「主导域名」，取不到域名时是「导入的会话 N」而不是保存路径的第 ② ③ 档 | `CHROMEWEBSTORE.md:54` vs `normalizeTabsData.ts:181` / `oneTabFormatParser.ts:33-36` |
| **DS-43-9** | 导入**没有任何体积 / 条数上限**，整个文件在 popup 主线程解析，再整个塞进 `chrome.runtime.sendMessage` ⇒ 超大文件会先冻住界面、再撞消息体积上限 | `src/components/layout/HeaderDropdown.tsx:1100-1292` |

### 4.5 导入 / 导出里**确认没问题**的部分（省得下一轮重新查）

- 导入**纯追加**，不覆盖、不删除任何已有会话（`mutationOps.ts:346`）。
- 文件里的 id **永远不落盘**（`mutationOps.ts:334` / `:339` 用 `genId()` 重新生成）⇒ 恶意文件无法指定 id 去覆盖已有会话；碰撞概率 ~6×10⁻³¹。
- JSON 往返**保真**：会话名 / 锁定态 / 全部时间戳 / favicon / pinned / 标签标题全部活下来（只有组 id、标签 id、组 `lastOp`、数组顺序会变）。
- 导出的内容是**全量原始行**，不看锁定 / 搜索 / 筛选 ⇒ 导出不会漏东西。
- 空会话在导出与导入两侧都被丢弃，但**已披露**（`importResultCopy.ts:68-72`），且 OneTab 路径的计数包含空块 ⇒ 不会显示成「成功但列表没变」。

---

## 5. 同步竞态

| 场景 | 实际行为 | 判定 |
|---|---|---|
| **两台设备编辑同一个会话** | 整组 LWW，印记决胜（`src/core/opStamp.ts:22-30`）。**跨设备裸比 `s` 数值**——`seqRegistry.ts` 自己的注释就说「序号只在同一设备内单调，跨设备裸比数值毫无意义」。败方那一组的**全部标签被物理替换**（无 tab 级并集） | ⚠️ **DS-43-18**：败方新增的标签**人间蒸发**，零提示；而且「冲突」这个概念在代码里**根本不存在**（`syncStatus: 'conflict'` 从未被赋值 ⇒ `stats.conflicts` 恒为 0）。三处文档说「以**最后保存**的一方为准」，而胜负其实由 `(seq, deviceId 字典序)` 决定 ⇒ **文档教了一个不成立的预期**（先保存的 A 可能赢过后保存的 B）。**文档半已修**（`00783c7` / `639f8ff` / `ec759a9`），**代码半见 §5.3** |
| **一台设备删除，另一台同时编辑** | **DS-3**：胜负由两个无关计数器的数值决定 ⇒ 删除被静默撤销、A 的内容被 B 的版本覆盖 | **P0，见 §1**。**披露也缺**：`README.md:8` / `README.md:73` / `CHROMEWEBSTORE.md:480` 三处都写了「同时编辑 ⇒ 后保存方整组赢」，但**没有一处**覆盖「删除 vs 并发编辑」—— 而删除确认框写的是「其他登录设备将同步删除」（`src/components/layout/deleteAllMessages.ts:43`） |
| **一台设备删除，另一台只读不动** | 云端墓碑 vs 本地活跃 ⇒ 印记决胜；墓碑的 seq 走**本机 Lamport 时钟**（`src/utils/supabase/upload.ts:1374-1375`：`max(tombstoneSeq.nextSeq(), 云端旧 seq + 1)`，并 `bumpSeqIfLower` 抬本机时钟）⇒ 正常情况下墓碑更新，删除**会**传播 | ✔ |
| **用户在同步进行中编辑会话** | 写方一路登记受影响 id ⇒ 下一轮补传；水位只取本轮真正落盘的行，且新号严格大于本机曾发出的每一个号（`seqRegistry.ts:78-104`）⇒ 不会跳过 | ✔ 一般路径不丢；**归属待决期有一个窄缝** ⇒ 见 **DS-43-19** |
| **同步中删除一个会话** | 删除意图走**独立的持久化队列**（`pendingDeleteIds`），与上传清单无关 ⇒ 不会被「这轮不传它」吃掉 | ✔（但见 DS-43-1） |
| **上传失败** | `pending_upload` 保留 + 队列保留 ⇒ 下轮 alarm / 60s 轮询重试 | ✔ |
| **上传部分成功** | 端口层按「后端认输 = 已裁决」处理（远端版本更新 ⇒ 本地不上行，等下次下载合并物理替换）⇒ **不会**把「认输」算成「没传上去」⇒ 不会无限重试 | ✔（设计正确，注释在 `uploadCoverage.ts:19-22`） |
| **删除广播失败后，用户手动「云端覆盖本地」** | 覆盖下载会先把云端那行（仍是活跃行）合回本机 ⇒ **已删会话在本机复活**（下一轮广播成功后会被再次物理移除、自愈，但用户看见它回来了） | ⚠️ 披露缺口，见 §3.3 后的「复活向量」说明 |

### 5.1 DS-43-19：归属待决期的「登记竞态」⇒ 静默不同步

- **位置**：`src/background/mutationHandlers.ts` 的保存 / 重命名 / 加锁分支 `scheduleUpload(...)` **没有 `await`**（`:224` / `:306` / `:319`），而删除分支 await（`:246` / `:254` / `:262`）。
- **失效路径**：待决期只传白名单里的会话（`src/services/syncEngine.ts:1263-1267`）⇒ 本轮的白名单快照（`:1285`）若看不到还在飞行中的登记 ⇒ 本轮不传 ⇒ `coverage.canClearPending` 为真 ⇒ `src/services/syncEngine.ts:1558-1564` **整键清空**白名单（`clearPendingUploadGroupIds` 是 `kvRemove`，与在途的 `kvSet` 竞争）⇒ **登记被抹掉、`pending_upload` 被置 false**。
- **用户看到什么**：上传报 `success: true`，界面报「同步成功」，**而那个改动根本没上云**。数据没丢（用户完成归属决策时那次全量会带上），但**用户以为同步了**。
- **适用范围**：只在**自带存储的归属待决期**成立（正常模式传全量，白名单不参与筛选）。
- **最小修法**：把保存 / 重命名 / 加锁分支改成 `await scheduleUpload(...)`（与删除分支一致）；或者把 `clearPendingUploadGroupIds` 改成**按确认集合逐条消费**（`storage.clearPendingDeleteIds` 已经是这个形状）。
- **同一根因的另一处**：导入路径 `src/background/mutationHandlers.ts:294` 也没 `await scheduleUpload(...)`（登记的是**新 id**，D-3 的修法本身是对的，但少一个 await）。

> **已修**（`3c73504`）：**两头都堵**——
> · 保存 / 重命名 / 加锁 / 导入分支的 `scheduleUpload(...)` **补上 `await`**（与删除分支一致）⇒ 登记不会还在飞行中就被快照。
> · `clearPendingUploadGroupIds`（`kvRemove`，整键抹）改成 **`consumePendingUploadGroupIds(settledIds)`**：
>   **读-改-写**（取出 → 只去掉已确认的那些 → 写回）⇒ **在途的登记不会被抹掉**（原来整键抹掉 ⇒ 与在途的 `kvSet` 竞争 ⇒ 谁后写谁赢）。
> · ⚠️ 守卫 `tests/backendParityDefects.test.ts` 原本**钉死了字面量** `setPendingUpload(false)` ⇒
>   改对了实现反而红 ⇒ 守卫已改成用**括号配对**算出 `canClearPending` 守卫块的**真实范围**，
>   再断言「标志的写入**在**守卫块之内」，但**不**钉那个字面量（并断言它**全仓不出现**）。

### 5.2 两条「删除复活」向量（补记，`pendingDeleteIds` 队列本身是对的）

删除意图在云端写失败时**会保留并重试**（`markCloudGroupsAsDeleted` 抛错 ⇒ 冒到 `syncEngine.ts:1621` 的 catch ⇒ `success:false`；`pending_upload` 不清、队列不消费）✔ 已核实。

但有两条路会让**墓碑没写下去**：

1. **手动「云端覆盖本地」**：若此刻删除广播仍在失败，用户点覆盖下载 ⇒ 云端那行（仍是活跃行）被合回本机 ⇒ **已删会话在本机复活**（之后广播成功会再被移除，但用户已经看见了）。
2. **SW 被回收 + KV 写失败**：`addPendingDeleteIds` 写 KV 失败时会塞进进程内存兜底（`src/utils/storage.ts:930-934`），但**内存兜底活不过 SW 生命周期** ⇒ 删除意图**永久消失** ⇒ 云端行永远停在活跃态 ⇒ 下一次下载在所有设备上把它带回来。用户当时**会被告知**（「N 个会话已从本机删除，但未能登记云端删除广播…」），但**这条告警不跨 SW 生命周期**。

> **明确的「查了没事」**（免得下一轮重复排查）：`pendingDeleteIds` 那一支**没有**被 `writtenTombstoneIds` 过滤（`src/services/syncEngine.ts:1396-1400`）—— 铁律 4 那个陷阱在 HEAD **不存在**。清队是**按确认逐条消费**（`src/utils/storage.ts:959-994`），不会连坐抹掉本轮新增的意图。

### 5.3 DS-43-18 的代码半：删掉那个**恒为 0** 的「冲突」统计量

- **位置**：`src/services/syncEngine.ts` 的 `MergeResult.stats`（曾有 `conflicts: number`）、`src/types/tab.ts` 的 `syncStatus` 联合类型（曾含 `'conflict'`）。
- **失效路径**：`syncStatus === 'conflict'` **全仓没有任何一处会赋出来**（合并是整组 LWW，见 `src/core/opStampMerge.ts`）⇒ `stats.conflicts` **恒为 0** ⇒ 而它**零消费**（全仓只有 `backgroundSync.ts` 拼日志字符串时提到它）。
- **为什么这比「有个没用的字段」更糟**：统计量的语义是「这里发生过几次」。一个**恒为 0** 的统计量说的是「一次都没发生过」—— 而它明明发生过（败方新增的标签被丢）。⇒ **它让人以为这件事不存在**。
- **本轮改法**：**删掉**这两处承诺，不补「读取方」也不补「实现」（本仓对 `displayOrder` 死字段也是同样的处理）。真相**留在文档里**：README「整组覆盖」与商店页「Known Issues」都写着「败方新增的标签会丢，且**没有任何提示** / 界面上看不到冲突提示」。
- **为什么不做「冲突提示」**：那需要**共同祖先**（三方合并的基线）才能区分「云端只是更新了」与「两边同时改了、有一边被覆盖」。没有基线的任何实现都只能靠猜，**猜错就是误报**，而误报的冲突提示会教用户不信任同步 ⇒ 协议级改动，不在本轮范围。
- **守卫**：`tests/guards/phantomConflictState.test.ts` —— ① 类型里不许再出现 `'conflict'`；② `syncEngine` 里不许再出现 `conflicts`；③ **README / 商店页必须仍然写着那两句真话**（代码不再承诺之后，文档是唯一的真相所在）；④ 台账不许把这条债抹掉。变异自证见 `phantomConflictStateMutation.test.ts`（三条「改坏 ⇒ 必须红」+ 一条「等价改写 ⇒ 必须仍绿」）。

---

## 6. 本地存储边界：§6.2 那个「极窄窗口」到底有多宽

### 6.1 事实

| 数据 | 位置 | 生命周期 |
|---|---|---|
| 会话本体 | IndexedDB（`src/storage-kv/`；IndexedDB 不可用时退到 localStorage） | 跟「清除本地数据」一起没 |
| **归属记录** `local_account_scope` | **`chrome.storage.local`** | **只被 `storage.clear()` 排除在外**（`authCache.ts:20-22` 明写这是有意的） |
| 登录缓存 `auth_cache` | **同一个 `chrome.storage.local`** | 退出登录时被 `remove`（`authCache.ts:209`） |

### 6.2 窗口的实际宽度

上轮 §6.2 写的是：「若 `chrome.storage.local` 被单独清掉（会话还在、归属记录没了），**且这台机器从没有过登录缓存**（= 从没登录过），则本机会话会被归到当前账号」。

**这个前置条件是自相矛盾的**：`auth_cache` 与 `local_account_scope` 在**同一个存储区**（`authCache.ts:47` vs `:80`）。`chrome.storage.local` 被清掉 ⇒ 登录缓存**必然**一起没 ⇒ `readLastAuthCacheUserId()` 必然返回 `null` ⇒ 兜底必然退化成 `ownerUserId = currentUserId`。**「从没登录过」这个条件在「chrome.storage.local 被清掉」的前提下不可能成立**（除非这台机器从来没登录过、也从来没保存过会话——那就没有泄露可言）。

⇒ **正确的表述是**：窗口 = 「`local_account_scope` 缺失，而 IndexedDB 里的会话还在」。这个状态下**本机的全部会话被认给当前账号**，并以当前账号的密钥上传进当前账号的云端 —— **DS-1 的原始后果原样复现**。

### 6.3 这个窗口今天走得到吗？—— 走不到，但**不是**因为 §6.2 给的理由

| 可能路径 | 结论 |
|---|---|
| `storage.clear()`（产品内的「清除本地数据」） | **不是触发源**：它只清 KV 键（`authCache.ts:20-22` 明写归属记录**不**在 `STORAGE_KEYS` 里）⇒ 记录还在，会话没了 ⇒ 方向相反，无害。另外**它在生产代码里没有任何调用方**（上轮已核过） |
| `secureStorage.clear()` → `chrome.storage.local.clear()`（`src/utils/secureStorage.ts:201`） | **是触发源**（两个键一起没，IndexedDB 不受影响）。但**全仓只有 `secureStorage.get` / `secureStorage.set` 在用，`clear()` 没有任何调用方** ⇒ 今天走不到，但它是一个**导出的公开 API**，离调用只差一行 |
| Chrome 的「清除浏览数据」 | 不清扩展存储 ⇒ 不触发 |
| 扩展被卸载 / 重装 | 两个存储区一起没 ⇒ 不触发 |
| 配额打满（`chrome.storage.local` 10MB） | **不是触发源**：写失败 ⇒ 归属记录**保持旧值**（`authCache.ts:124` 与 `authSlice.ts:121` 的异常都被吞）⇒ 不会变成「缺失」，但会变成「过期」（方向见 §2.1 末条） |

⇒ **结论：窗口真实存在、产品路径今天走不到、但被一段错误的推理掩盖着。** 它值得关掉的理由不是「它会被触发」，而是**它一旦被触发就是 P0 级的跨账号泄露**，而且触发它只需要一行 `chrome.storage.local.clear()`。

### 6.3bis DS-43-20：清掉 `chrome.storage.local` 的真实后果比「上传闸门放行」更严重

上一节只说了**上传侧**的兜底（`loadAccountScopeForUpload` 播种 `ownerUserId = currentUserId`）。但**登录侧更早、更彻底**：

- Supabase 的登录会话**也在 `chrome.storage.local`** —— `src/utils/supabase/client.ts:59` 用 `sharedStringStorage`，而 `src/storage-kv/stringStore.ts:27-37` 的实现就是 `chrome.storage.local.get/set/remove`。
- ⇒ **清掉 `chrome.storage.local` = 用户被真的登出** ⇒ 必须重新登录 ⇒ 走 `signIn` → `bindLocalSessionsToAccount`（`src/store/slices/authSlice.ts:182`）。
- 此时 `accountScopeStore.read()` 返回 `null` ⇒ `scope = createAccountScopeRecord()`（`ownerUserId: null`）⇒ `decideAccountBind`（`src/core/accountScope.ts:257-270`）判 **`first-bind`** ⇒ **把本机全部会话认给这个刚登录的账号，`notice: null`（零提示）**。
- ⇒ **下一个登录的账号静默认领本机全部会话**，随后这些会话以它的 `user_id` 与它派生的密钥上云。
- ⇒ 这就是 **DS-1 的原始后果被完整重开**，而且比上传侧那条更早发生、更彻底（上传侧的兜底只是「认给当前账号」，登录侧那条是「没有任何会话属于任何账号，于是第一个登录的人全拿」）。

⇒ **修法要落在两处，不是一处**：
- **登录侧**：`decideAccountBind` 的 `first-bind` 分支不该在「本机明明有会话、但归属记录不存在」时静默认领 —— 那正是「记录丢了」的形态，不是「这台机器第一次有账号」。两者必须区分（判据：本机会话非空 且 归属记录缺失 ⇒ 归账可疑 ⇒ **提示用户**或**拒绝认账**）。
- **上传侧**：§6.4 的第 1 条（记录缺失就抛错）。

⇒ 另外，**「还有没有别的归属副本能活下来」—— 没有，已穷举**：归属记录**只**在 `chrome.storage.local`；`local_account_scope` **不在** `STORAGE_KEYS` ⇒ 不在 `MIGRATION_SCAN_KEYS`（由 `Object.values(STORAGE_KEYS)` 派生）⇒ **一次 chrome.storage→IndexedDB 迁移也不会把它抄进 IndexedDB**；水位键 `supabase_sync_watermark_seq:<userId>` 是**按账号寻址的推导量，不含逐会话归属信息**。

### 6.4 能不能关掉？—— 能，而且**不用改协议**（四条，按推荐顺序）

1. **推荐（1 行）**：把 `loadAccountScopeForUpload` 的兜底从「播种 `ownerUserId = currentUserId`」改成**抛错**。理由：登录必然走过 `bindLocalSessionsToAccount` ⇒ 真正要上传时归属记录一定存在；记录不存在本身是异常状态，上传层不该替用户认账。这条同时修掉 **DS-43-7**（fail-open）和 §6.2 那个窗口。
2. **必须一起做（否则 1 不够）**：`decideAccountBind` 的 `first-bind` 分支要区分「本机真的从没绑过账号」与「归属记录丢了」。判据：本机会话非空 **且** 归属记录缺失 ⇒ 不是 first-bind ⇒ 走「认账可疑」路径（提示用户 / 拒绝认账）。**这是 DS-43-20 的直接修法。**
3. **可选（更彻底）**：把归属记录从 `chrome.storage.local` 搬进 KV（IndexedDB），让「会话还在 ⇒ 归属记录还在」成为**结构事实**。代价：归属记录会跟着 `storage.clear()` 一起没 —— 但那时会话也没了，无可归属，**不亏**。需要一次性迁移（读旧键 → 写 KV → 删旧键）。**注意**：`src/utils/authCache.ts:20-22` 的设计意图原文是「独立键也让『清除本地数据』不会顺手把它带走 —— **归属记录与本机会话同生共死**」—— 而它现在与本机会话**分处两地** ⇒ **那句注释描述的正是它做不到的事**。
4. **不推荐**：给 `secureStorage.clear()` 加一道「会连带清掉归属记录 ⇒ 先把归属记录备份到 KV」的护栏。能防住那一条路径，但防不住未来新增的其它清空路径 ⇒ 治标不治本。

### 6.5 触发条件需要真实浏览器验证

「Chrome 会不会单独清 `chrome.storage.local` 而保留扩展的 IndexedDB」**从代码里推不出来**。要测的是三件事，分别看 IndexedDB 的 `tab_groups` 与 `chrome.storage.local` 的 `local_account_scope` / `auth_cache` 是否还在：

1. `chrome://extensions` → 扩展详情 → 「清除存储」/ 重装；
2. `chrome://settings` → 清站点数据（含扩展自己的源）；
3. Chrome 的「清除浏览数据」。

⇒ **需要真机 + 真实浏览器**。三条里只要有一条能单独清掉 `chrome.storage.local`，DS-43-20 就是**产品内可达的 P0**；三条都一起清，则它只在应用层可达（`secureStorage.clear()` 那个死代码）。

---

## 7. 需要真机 + 真实后端才能验的部分

以下几条的代码路径我读完了、逻辑推理也成立，但**判据依赖真实后端的行为或真实浏览器的多设备状态**，单测与静态阅读证不到。给出可直接执行的验证脚本设计。

### 7.1 DS-3（删除 vs 并发编辑）—— 需要真机 + 真实后端

**脚本设计（两台真机 + 真实 Supabase 账号）**

- 机器 A、B 登录**同一个**账号。
- A 上保存会话 X（内容 v1）⇒ 等同步完成（云端有 X，`last_op_seq = sA`）。
- **断开 B 的网络**（Chrome 开发者工具 → Network → Offline，或关 Wi-Fi）。
- B 上编辑 X（内容 v2）⇒ B 本地印记 `sB`（B 自己的计数器，**不观测过云端**）。
- A 上删除 X ⇒ A 本地物理移除；A 上传 ⇒ 云端 X 被盖墓碑，`last_op_seq = sA'`。
- **恢复 B 的网络** ⇒ B 下载合并。
- **断言**（脚本要钉的是**目标状态**，不是「跑完了」）：
  - 若 `sB > sA'` ⇒ **B 的本地赢** ⇒ X 在 B 的列表里活着；B 上传后云端墓碑被翻回活跃 ⇒ **A 下轮下载后 X 复活** ⇒ **复现成立**。
  - 若 `sB < sA'` ⇒ 墓碑赢 ⇒ X 在 B 上消失 ⇒ 这一轮没复现（但结论仍然是「胜负由两台无关计数器的数值决定」⇒ **换个 seq 就能复现**）。
- ⇒ 判据应当是**「把 A 的删除序号人为调大 / 调小，X 的存活结果随之翻转」**，而不是「X 复活了一次」。这一条同时把「任意性」钉成可测事实。

### 7.2 DS-43-1（删除广播发错账号）—— 需要真机 + 真实后端

> ✅ **仓内已能验**（第 47 轮，`e006eaa`）：`tests/guards/deleteBroadcastAccountRoundTrip.test.ts`
> 用**真的**写入层（`utils/supabase/upload.ts` 的 `markCloudGroupsAsDeleted`）对着假云端跑完整往返 ⇒
> 「挡下 → 留在队列 → 主人登录回来 → 墓碑真的落地 → 队列被清掉」这条链**在仓内钉住了**。
> 下面这套真机脚本仍然是**最终确认**（要连真的 Supabase、真的多账号）。

- 机器 M 登录账号 A ⇒ 保存会话 X ⇒ 同步（云端 A 有 X）。
- 退出 A ⇒ 登录账号 B（此时界面应出现「本机还有 1 个会话属于上一个账号」提示）。
- 删除 X ⇒ 等一轮同步完成（此时 B 的云端**没有** X，广播是空操作）。
- 退出 B ⇒ 登录回 A ⇒ 触发恢复下载。
- **断言**：A 的列表里**出现了 X** ⇒ 复现成立（用户删掉的会话回来了）。
- 修完之后同一个脚本的**反向断言**：A 的列表里**没有** X，且 B 下的队列里那条删除意图**仍在**（`chrome.storage.local` 之外的 KV 键 `pending_delete_ids`）⇒ 证明「删除意图没被丢弃、只是等到了对的账号」。

### 7.3 OneTab 往返（DS-43-2）—— 需要真机（后端不需要）

> ✅ **仓内已能验**（`00783c7` 的行为守卫 + 第 47 轮 `002e666` 的变异自证）：
> 往返后的 `isLocked === false` 与两处**披露文案**都已被钉住。

- 锁定一个会话 ⇒ 导出 OneTab ⇒ 导入回本机。
- **断言**：导入后的会话 `isLocked === false`；再点「快速恢复」⇒ 断言该会话**从列表消失**（= 被消费了）⇒ 复现成立。

### 7.4 导入注入墓碑（DS-43-3）—— 需要真机（后端不需要，但需要一个真实的旧备份）

> ✅ **仓内已能验**（`00783c7` 组级 / `5b33048` 标签级）：带 `isDeleted` 的导入文件**归一化时就被抹掉**，
> 不再进落盘 ⇒ 下面那两步（列表里看不见 → 一轮同步后被物理删除）都**不再可达**。

- 造一份 JSON：`{ data: { groups: [ { name: "X", tabs: [{url:"https://a.com", title:"a"}], isDeleted: true } ] } }`。
- 导入 ⇒ **断言**：提示说「已导入 1 个会话」但列表**没有** X ⇒ 复现第一半。
- 触发一轮同步（开自动同步或手动点同步）⇒ **断言**：本地存储里那行**消失了**（KV 键 `tab_groups` 里不再有该 id）⇒ 复现第二半。

### 7.5 导出反馈（DS-43-6）—— 需要真机

- 装扩展 ⇒ 触发一次导出 ⇒ **断言**浏览器下载目录里出现文件（这需要探针去看文件系统，**不能**靠扩展自己的 toast 判断，因为扩展没有 `downloads` 权限）。
- 反向：在 Chrome 设置里禁掉下载 ⇒ 再点导出 ⇒ **断言**用户侧**看不到任何提示**（现状）⇒ 确认这是真的静默失败。

**2026-10-23 第 44 轮之后，这条的一半变了**（`35b363f`）：

- ✅ **回执有了**：导出后会弹一条提示，带**文件名 + 会话数**（我们真正知道的）。
  ⇒ 「点了导出，什么都没发生」这个形态消失了。
- ✅ **blob URL 改成延后释放**（原先「点完立刻 `revokeObjectURL`」与浏览器侧取数撞上时，
  下载会拿到失效的 URL ⇒ 文件没下来且毫无提示）。
- ⚠️ **仍然看不见的那一半**：扩展**没有 `downloads` 权限** ⇒ 「文件真的落到磁盘上了」
  我们收不到任何信号。⇒ 弹窗里那句话说的是「**已生成**备份文件」，
  **不是**「已保存到磁盘」—— 这是刻意的措辞，不是漏写。
  ⇒ 真机那条探针仍然要跑：**它验的是「生成」与「落盘」之间那道缝**。
- 💡 **要不要加 `downloads` 权限**（那样能真的知道下载成没成功）是一个**产品决定**，
  不是技术决定：它会多一条权限（商店页要写明、用户会看到权限提示），
  换来的只是「文件有没有落盘」这一个信号。**本轮不擅自加。**


### 7.6 DS-43-20（清掉 `chrome.storage.local`）—— 需要真机 + 真实浏览器

**脚本设计（在 §6.5 的三种清法上各跑一遍）**

1. 机器 M 登录**账号 A** ⇒ 保存会话 X ⇒ 同步（云端 A 有 X）。
2. 退出 A（或直接清）⇒ 执行清空操作 ⇒ **断言**：`chrome.storage.local` 的 `local_account_scope` 与 `auth_cache` 都没了，而 IndexedDB 的 `tab_groups` 里 X 还在。
3. 登录**账号 B** ⇒ **断言**：界面上**出现**「本机还有 1 个会话属于上一个账号」这类提示（修好之后应当出现；现状是**零提示**）。
4. 同步 ⇒ **断言**：B 的云端**没有** X（修好之后）；现状是 X 以 B 的 `user_id` 上去了 ⇒ **复现成立**。
5. 反向断言（修好之后）：B 退出、登录回 A ⇒ X 仍在 A 的云端、**没有**被 B 领走。

### 7.7 两条已经能离线复现的（不必等真机）

- **DS-3**：`mergeOpStamped` + `shouldConcedeGroup` 是**纯函数**，可以用仓库自己的 loader 直接跑真实生产代码（不 mock 被审逻辑）：
  ```
  node --import ./tests/_register-loader.mjs --experimental-strip-types <探针>.mjs
  ```
  探针要打印的是**四组 (墓碑 seq, 离线编辑 seq) 组合下的胜负**，判据钉「把 A 的删除序号调大/调小，X 的存活结果随之**翻转**」—— 这才把「胜负是任意的」钉成可测事实（只跑一次看到「复活了」证明不了任意性）。
- **DS-43-10**：`SearchResultList` 与 `TabGroup` 的两个分支是**同源漂移** ⇒ 适合做一条**接线守卫**：断言两个界面在 `skippedUnopenable > 0` 时都调用了带撤销凭据的 toast（比钉字面量好）。

---

## 8. 我这轮**撤回**的怀疑（避免下一轮重复劳动）

| # | 怀疑过 | 复核结果 | 复核方式 |
|---|---|---|---|
| 1 | 「账号归属记录**不存在**与**损坏**处理成了一回事」 | **撤回**。损坏 ⇒ `normalizeAccountScope` 抛错 ⇒ 上传整体中止（fail-closed）；不存在 ⇒ 才走兜底 | 读 `accountScope.ts:118-166` + `authCache.ts:77-84` + `upload.ts:514-525` |
| 2 | 「覆盖删除计划用数量差 ⇒ 云端新增会话会掩盖本机删除」 | **撤回**。`planOverwriteDeletion` 用的是**集合差** | 读 `src/core/overwriteGuard.ts` 全文 |
| 3 | 「上传覆盖对账会自锁（标志清不掉 ⇒ 无限重试）」 | **撤回**。两个标志各有**与对账无关**的复位路径（登记成功 / 本轮是全量） | 读 `src/core/uploadCoverage.ts:237-319` 全文 |
| 4 | 「删除广播的 `pendingDeleteIds` 支路套了 `writtenTombstoneIds` 过滤器」 | **撤回**。那一支保持不筛选，注释与实现一致（这是铁律 4 要防的坑） | 读 `src/services/syncEngine.ts:1396-1416` |
| 5 | 「登录成功会触发覆盖下载，把上一个账号的会话清空」 | **撤回**。`restoreAfterLogin` 发的是 `forceRemote: false`（合并模式），合并**保留**云端没有的本机会话（`opStampMerge.ts:42` `lg && !cg ⇒ merged.push(lg)`） | 读 `src/components/auth/restoreAfterLogin.ts` + `src/core/opStampMerge.ts:40-48` |
| 6 | 「两个后端的『读不出来』共用一句文案（DS-17 仍成立）」 | **撤回**。Supabase 走专属文案模块，WebDAV 是整轮抛错 ⇒ 两边不再共用同一句话 | 读 `src/components/sync/skippedRemoteGroupsCopy.ts` + `src/sync-backend/webdav/adapter.ts` |
| 7 | 「`chrome.storage.local` 与 IndexedDB 能被产品路径单独清掉一个」 | **基本撤回**，但留一条尾巴：`secureStorage.clear()`（`src/utils/secureStorage.ts:201`）能清前者，但**全仓无调用方**；`storage.clear()` 只清 KV | `grep -rn "secureStorage" src/` + 读 `src/utils/storage.ts:1866` 的键清单来源 |
| 8 | 「撤销按钮会随 popup 失焦而销毁 ⇒ 旗舰动作『恢复整个会话』的退路实际上点不到」 | **撤回**。HEAD 的 `manifest.json` **没有 `default_popup`**，管理器是 `chrome.tabs.create` 开的**独立标签页**（`src/background/TabManager.ts:82`）⇒ 失焦不会销毁它 ⇒ 撤销 toast 活下来了。**残留的真问题**是另外两条：8 秒时限（`consumeUndoCopy.ts:20`）在「恢复整组会开新窗口并聚焦」之后对用户很紧，以及队列只留 3 条（DS-43-12） | 读 `manifest.json:26-29` + `src/background/TabManager.ts:82` + `src/contexts/ToastContext.tsx:86` |
| 9 | 「合并会在并发下复活已删内容 ⇒ 删除不可靠」 | **撤回**。删除的跨端收敛是合法行为、必须传播；`opStampMerge.ts:43-48` 的「云端有、本机没有 ⇒ 收进来」只在**云端墓碑**时才被跳过（`if (cg.isDeleted) continue`）。**但**「删除被另一台设备的并发编辑撤销」这条**成立** ⇒ 那是 DS-3，不是这一条 | 读 `src/core/opStampMerge.ts:40-48` |

---

## 9. 附：本轮复核过的守卫覆盖情况

| 主题 | 守卫 | 状态 |
|---|---|---|
| 账号闸门 | `tests/guards/accountScopeGuard.test.ts`、`accountScopeReconcile.test.ts` | ✔ 有，且带「闸门退化成不过滤时守卫必须看得见」的自证检测力 |
| 覆盖删除熔断 | `tests/guards/overwriteDeleteGuard.test.ts` | ✔ 有 |
| 锁定会话逐条删除 | `tests/guards/lockedTabDeleteGuard.test.ts:80-91` | ✅ **已补**（`bad5aae`，DS-9）：断言改成「两处**同源**」（都调共享纯函数 `lockedTabDeleteMessage()`，且那个名字是从 `lockedDeleteCopy` 引入的）⇒ 换个写法不误报，只有「各写一份」才红 |
| 熔断实参不变量 | `tests/syncFailsafeGuard.test.ts:92-120` | ✔ 已改成钉不变量（DS-11 已修） |
| 导入登记新 id | `tests/backendParityDefects.test.ts:124-136` | ✔ 有（D-3 修复已锁） |
| 消费撤销的**接线**（两个界面都挂上撤销） | `tests/guards/searchPageCopyHonestyMutation.test.ts` | ✅ **已补**（`bad5aae`，DS-43-10）：断言那条分支真的调用了**带撤销凭据**的 toast（钉数据流，不钉字面量） |
| **页面与后台的库作用域一致**（P0-1） | `tests/guards/libraryScopeResolution.test.ts` + `libraryScopeResolutionMutation.test.ts` | ✅ **有**（`29bdb91`）：三态断言（页面真值 / SW 必须走注册表 / 两边相同）+ 三条变异自证。⚠️ 这一类缺陷在 Node 里**天然隐形**（Node 的 `import()` 合法）⇒ 另有真机探针 `scripts/lead-verify-sw-library-scope.mjs` |
| 删除广播的**整条往返**（DS-43-1） | `tests/guards/deleteBroadcastAccountRoundTrip.test.ts` + `…RoundTripMutation.test.ts` | ✅ **有**（`e006eaa`）：钉的是**用户可见的终点**（切回主人 ⇒ 墓碑真的落地 ⇒ 队列真的被清掉） |

---

---

## 10. 第 47 轮新发现并修掉的：P0-1 —— 后台算不出「本机在哪个库」

> 这一条**不在**第 43 轮的清单里 —— 它是第 47 轮顺着「同步路径为什么静默不同步」往下挖时挖出来的，
> 而且它是**第 43 轮 §5.1 那条（DS-43-19）之外的另一个静默失败**。

### 10.1 缺陷形状

归属待决位（「这些会话归不归这个库」）是**按库寻址**的（`storage-kv/firstSyncPendingRecord.ts`）
⇒ 要判断「当前这个库待不待决」，**必须先知道「当前是哪个库」**。

而「当前是哪个库」要在**两个 realm** 里各算一次：页面（弹窗 / 设置页）与
**Service Worker**（真正执行上传的那一侧）。过去那条边是 `await import(...)`
⇒ **service worker 里 `import()` 被 Chrome 禁止**（HTML 规范）⇒ **SW 侧永远算不出**。

⇒ 于是判据整个换了一档：

```
SW 算不出库 ⇒ scope = null
             ⇒ 落进「不知道是哪个库 ⇒ 只要有 ANY 一格待决就算待决」的保守分支
             ⇒ SW 永远以为归属决策没做完
             ⇒ 自动上传被永久降级成「只传本次改动过的那几个」
             ⇒ 本机的历史会话再也传不上用户自己的云盘，而回包还报「成功」
```

而页面侧算得出真值 ⇒ 界面显示「决策已完成」⇒ **两边对不上，且用户毫无提示**。

⚠️ 注意这条**不是**「多传」（那才是不可逆的灾难）。它是「**少传**」——
方向是保守的，但**结果是永久的**：用户的历史会话再也传不上自己的云盘，
而界面一直显示「同步成功」。

### 10.2 为什么单测完全看不见

**Node 的 `import()` 是合法的** ⇒ 单测里 SW 侧照样算得出真值 ⇒ 这条缺陷在
整个单测套件里**隐形**（既不报类型错也不报 lint）。
（同仓教训：memory「SW 启动即崩这一类缺陷」—— Chrome 上不存在的行为，
在 Node 里合法、在真机里非法。）

### 10.3 修法

**同一份模块，两种取法**（与既有的 `supabaseRuntime` / `webdavRuntime` 同一个形状）：

- 新增 `src/sync-backend/webdav/libraryIdentityRuntime.ts`（**加载器注册表**）：
  页面走默认的动态 import（首屏不下载）；SW 由入口 `src/service-worker.ts`
  **静态** import 并注册。没注册就**明确报错**，而不是让 Chrome 抛一句规范条款。
- 注册表对 `libraryIdentity` 只有**类型位置**的引用
  （`typeof import('./libraryIdentity')` ⇒ 编译后消失）⇒ 运行时不成环。
- `src/storage-kv/firstSyncPendingRecord.ts` 拆出**不吞异常**的
  `resolveCurrentLibraryScopeStrict()`（给诊断通道用），
  `resolveCurrentLibraryScope()` 仍然是兜底成 `no-library` 的那一个
  （**判据上仍然 fail-closed**）。

### 10.4 判据

- `tests/guards/libraryScopeResolution.test.ts`：① 页面 realm 算出来的作用域
  = 磁盘上那个库的真值（**不是**兜底的 no-library）；② SW realm 里算作用域
  **必须经由注册进来的加载器**（用**哨兵加载器**把「走没走注册表」变成可观测的事实 ——
  不钉这条的话，把实现改回旧写法守卫仍然全绿 ⇒ 零检测力）；③ 两边算出的作用域**必须相同**。
- `tests/guards/libraryScopeResolutionMutation.test.ts`：三条变异自证
  （改回直接动态 import ⇒ 红；注册表在 SW realm 里忽略注册的加载器 ⇒ 红；
  **等价改写 ⇒ 仍然绿**）。

### 10.5 真机验证（**已在真 Chrome 上跑通**）

`scripts/lead-verify-sw-library-scope.mjs`（产出 `outputs/lead-verify-sw-library-scope/report.json`）：

| 步骤 | 结果 |
|---|---|
| 事实 1：SW realm 里的动态 `import()` | **失败** —— Chrome 原话：`import() is disallowed on ServiceWorkerGlobalScope by the HTML specification` ⇒ **根因坐实** |
| 事实 2：页面 realm 里的动态 `import()` | **成功**（对照组） |
| 事实 3：页面 realm 算出来的库 | `["https://dav.probe.invalid/","probe-user","TapStack"]`（= 磁盘上配的那个库） |
| 事实 3bis：**SW realm 算出来的库（走注册表）** | **与页面完全相同** ← **这才是 P0-1 的直接判据** |
| 两轮上传（自动 vs 显式） | **同形**（都走到后端那一层，如实报 `locked:true`） |

⚠️ **为什么「同形」本身不够**：修好之后两轮都死在「云服务还没解锁」那一道闸门上
（探针没有应用密码）⇒ 「同形」也可能是「两边都死在同一个无关的地方」⇒ **弱绿**。
⇒ 所以才加了**事实 3bis**（SW 必须**正面算出**那个库）+ 一个**阳性对照**。

**检测力自证**（关键）：把入口的注册调用去掉并重新构建 ⇒ 探针立刻报**两条**问题：

- SW 侧算不出库作用域（注册表抛「Service Worker 里必须注册静态的『库身份』加载器」）；
- **自动上传回包变成 `{ok:true, payload:{success:true}}`**（**什么都没传，却报成功**），
  而同一次显式上传如实报 `locked:true` ⇒ 两轮**不同形**。

⇒ 判据真的看得见这个缺陷，**不是弱绿**。

---

## 11. 第 48 轮新发现并修掉的：P0-48-1 —— 弹窗每开一次都下载整条 Supabase SDK

### 11.1 症状

第 47 轮把首屏**渲染阻塞集**从 263.4KB 压到 176.0KB（gzip）⇒ 但那只是把 SDK
**移出首屏**，**没有移出弹窗**：挂载时那次「核登录态」仍然会
`await import('@/utils/supabaseFacade')` ⇒ **每次开弹窗都下载一次整条 SDK**。

真机实测（`scripts/lead-verify-first-screen.mjs`，CDP 请求时间线）：

| 口径 | 第 47 轮（HEAD） | 第 48 轮（修后） |
|---|---|---|
| 首帧之前被请求的字节 | **884.4KB** | **617.2KB** |
| 其中 Supabase SDK | **267.0KB**（`supabaseFacade` 46.5KB + `supabase-vendor` 226.9KB） | **0** |
| gzip 口径 | **75.3KB** | **0** |
| SDK 块被请求的时刻 | **首帧前 18ms**（正好压在首帧上） | **一次也没被请求** |

### 11.2 为什么单测完全看不见（连「首屏体积门」都看不见）

首屏体积门量的是 **HTML 里的渲染阻塞清单** ⇒ 动态 import 的 SDK **不在那个清单里**
⇒ 门一直是绿的。**「不在首屏」≠「不用下」** —— 动态 import 只是把下载**推迟**，
不是取消。这正是第 47 轮那版「首屏瘦身」留下的尾巴。

而这个缺陷的形态是：**编译期合法、类型全绿、界面照常能看**，
只有「打开弹窗时网络面板里多出两个 chunk」才看得出来 ⇒
仓库里没有 DOM 测试环境（组件测试是 `react-dom/server` 的 SSR，`useEffect` 不跑）
⇒ **「挂载时到底加载了什么」测不出来**。

### 11.3 根因（一行）

「核登录态」这件事被放在了**页面侧** ⇒ 页面侧要核 ⇒ 必须有 Supabase 客户端
⇒ 必须加载门面 ⇒ 必须加载整条 SDK ⇒ **75KB 与用户要干的事毫无关系，却每次都付**。

### 11.4 修法：核登录态搬到 service worker

与第 47 轮的 P0-1 **同一个形状**（同一份模块，两种取法）：

- 新增 `src/core/authStatus.ts` —— **纯判据**（四档，见 §11.5），不碰网络、不碰存储；
- 新增 `src/background/authStatus.ts` —— **后台侧 IO**（读缓存 + 核服务端 + 交给判据）；
- 新增 `src/utils/authStatusChannel.ts` —— **页面侧通道**（只发一条消息，不 import 任何后端模块）；
- `src/service-worker.ts` 新增 `AUTH_STATUS` 分支（只读：只回答「登录态是什么」）。

⇒ **SW 侧的 SDK 是静态依赖**（入口静态 import 门面并注册给 `utils/supabaseRuntime.ts`）
⇒ **零下载**（已经在扩展包里）⇒ 弹窗只发一条消息问「核完了吗」。

⚠️ **少掉的东西，一件都不少**：挂载时那次核的**另一个作用**是
「登录着就顺手把云端拉回来」（跨设备找回）—— 这条**保留**：
核到登录着时仍然发 `sendSyncCommand('download', {auto: true})`，
而**下载本来就是在后台做的** ⇒ 弹窗不碰 SDK，功能不丢。

### 11.5 四档而不是一个布尔（诚实度）

「登录 / 没登录」看着是两个事实，真实世界有**第三、第四种**：

| 档 | 含义 | 界面怎么说 |
|---|---|---|
| `authenticated` | 核到了：确实登录着 | 正常 |
| `not_authenticated` | 核到了：确实没登录 | 「去登录」 |
| `backend_unavailable` | **核不到**：服务端整体不可用（生产实测 402）⇒ **用户多半登录着**，只是确认不了 | 「云端暂时不可用，本地没丢」（**不许**说「没登录」） |
| `unknown` | **核不到**：断网等 ⇒ **不知道** | 同上，方向一致 |

⚠️ 把后两档读成「没登录」是**一句更重的谎**：用户会去重新登录、重新输密码，
甚至以为账号被删了，而真正的原因是「我们的云端项目被限制」。

⇒ 归零（`isAuthenticated: false`）**只许有一处**，且必须落在「明确核到没有会话」那一支里。
这条由 `tests/guards/backendUnavailableHonesty.test.ts` 用 **AST 结构**判
（不是正则、不是字面量：局部变量改名仍绿，把归零挪到别的分支 / 再加一处归零 ⇒ 红）。

⚠️ **诚实度复核**（怕「搬走了 ⇒ 少说了什么」）：旧实现里 402 的那句人话
（「TapStack 云端暂时不可用…你的本地会话一个都没有丢…」）落在 `state.auth.error`
⇒ 只有登录弹窗读它 ⇒ 而**没有会话时压根不会联网**（`getSession()` 直接返回 null）
⇒ 那句话在旧实现里**本来就够不着用户**；**有会话时用户已登录** ⇒ 登录弹窗不显示。
⇒ 搬走之后**没有任何用户可见的信号变少**；而登录动作本身被 402 拦下时，
`signIn` 仍然给出同一句人话（**动作发生的那一刻仍然说人话**）。

### 11.6 判据（守卫 + 变异自证）

`tests/guards/popupDoesNotLoadSupabaseSdk.test.ts` —— 判的是**行为**，
不是「文件里出现某字符串就红」：

- ① 「会加载 Supabase 门面的符号」是**算出来的**（`tests/_helpers/facadeLoading.ts`：
  从「函数体里真的 `import('@/utils/supabaseFacade')`」的根出发，沿调用往外推 ——
  同文件的局部函数**哪怕没被导出**、跨文件的 import 绑定、类的方法）；
  ⚠️ 只看**导出**符号会推不到 `authSlice.ts` 里那个**没导出的** `loadSupabaseAuth`
  ⇒ 守卫会变成空壳（缺陷放回去也不红）⇒ 守卫里有一条专门盯这件事；
- ② 弹窗的**静态 import 闭包**（`tests/_helpers/moduleGraph.ts`，AST 判定，不是正则）里没有门面模块；
- ③ 弹窗的**挂载路径**上不许出现「会加载门面的调用」
  （`tests/_helpers/mountPath.ts`：模块顶层 + `useEffect`/`useLayoutEffect`/`useMemo`
  的回调，再沿本文件的局部调用跟进去；⚠️ **JSX 事件处理器不算** ——
  「用户点了『去登录』才加载 SDK」是设计要的，判据要是把它也禁了，
  就等于逼着实现把登录功能删掉）；
- ④ 弹窗必须经由 `requestAuthStatus` 那条通道核登录态；SW 必须处理 `AUTH_STATUS`
  且**真的去核**（不许回一个常量）；
- ⑤ 通道本身：**失败必须抛**（`{ok:false}` / 没回包 / `ok` 但没给判定 ⇒ 全部抛）
  —— 静默当成「没登录」是一句谎。

`tests/guards/popupDoesNotLoadSupabaseSdkMutation.test.ts` —— **四个方向**证明它有检测力：
① 把旧行为放回去 ⇒ 红；② 换个写法（不写 `getCurrentUser`，直接调门面）⇒ 红；
③ **改判据自己的算法**（让危险集算不出 `getCurrentUser`）⇒ 红
（这一条最要紧：它证明守卫抓的确实是「算出来的危险集」，而不是碰巧撞上了某个字面量）；
④ **等价改写**（改变量名 / 改 hook 顺序）⇒ 仍然绿（证明它判行为，不判长相）。

⚠️ **这条守卫的算法自己也踩过两个坑**，都是**变异自证**逼出来的：
「IIFE」（`void (async () => {…})()`）与「动态 import 绑定的局部名」
都被漏判过 —— 漏判时守卫是**绿的**，而缺陷已经回来了。

### 11.7 真机验证（**已在真 Chrome 上跑通，A/B 同机对照**）

`scripts/lead-verify-first-screen.mjs`（产出 `outputs/lead-verify-first-screen/report.json`）：

- 判据④从「同步栈**最终**被下载了（延后 ≠ 删掉）」**改成**
  「弹窗页面**一次也不该**下载云端栈」——
  ⚠️ 旧口径在这次修法下**本身就是错的**：页面侧连延后都不该有。
  「功能没被删掉」改由 **⑤'（`AUTH_STATUS` 回合真的答得出四档之一）** 与 ⑥a（登录路径）承担。
- A/B 口径：**同一台机器、同一份脚本**，只把 `AuthProvider.tsx` 换回 HEAD 那版
  （`git show HEAD:…`）重新构建再跑一遍 ⇒ 两次的数字可直接相减
  （⚠️ 仓库规矩：**忘了 rebuild ⇒ 前后对比是假的** ⇒ 每次换实现都重新 `pnpm build`）。

---

*本报告原本是只读审计（对应 HEAD `23d2aab`）。**第 47 轮**在其中列出的条目上动了 `src/` 与 `tests/`，
处置与 commit 见 §0 表与各条末尾的「已修」标注。第 43 轮原始的行号仍对应 `23d2aab`。
**第 48 轮**新增 §11（P0-48-1：弹窗每开一次都下载整条 Supabase SDK）。*
