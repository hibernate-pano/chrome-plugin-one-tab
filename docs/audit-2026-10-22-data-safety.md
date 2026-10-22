# 数据安全专项审计：2026-10-22（基线 v1.25.1）

<!-- doc-status:进行中（专家团汇入） -->
>
> **文档状态：进行中** —— 本文件是「数据安全」一路的只读审计结论，未改任何代码。
> 修完后改成「已闭环」。

## 0. 范围、纪律与前提

- **只读审计**：`src/` 全量 + `tests/` 全量 + 隐私政策/商店文案/README 的承诺一致性。**未修改任何源码或测试**。
- **本产品的前提**（决定了所有定级）：自 v1.22.0 起**删除即物理清除、无回收站、无撤销**。
  ⇒ **任何数据丢失路径都是 P0**；**读失败必须 fail-closed**（不得返回 `null`/`[]` 冒充「键不存在」）。
- **验证纪律**：
  - 所有「grep 零命中 ⇒ 不存在」的结论都用**第二种方法**复核（`grep -F` + 独立 python 扫描），复核方式写在条目里。
  - 守门测试的检测力结论来自**变异测试**（在仓库副本 `/tmp/tsaudit` 上做，工作树未动）；我自己跑的门禁只作「当时是绿的」佐证，**不**用「本地全绿」单独判定守卫可靠（陷阱 3）。
  - 「已确认缺陷」与「风险推测」严格分开，推测一律标注。

---

## 1. 破坏性操作的披露核对（结论先行）

**披露这一层做得比同类产品好**：11 个不可逆操作里，有确认框的全部都带**数量**和**「不可恢复/不可撤销」**说明，
覆盖上传/下载还做了**两段式确认**（第一次点击只写风险文案，第二次才执行）。

**真正的窟窿在三个地方**：① 兜底缺失（DS-2）② 账号边界（DS-1）③ 并发语义（DS-3）。

| 操作 | 位置 | 数量 | 「不可恢复」 |
|---|---|---|---|
| 删除整个会话 | `src/components/tabs/TabGroup.tsx:183`（`handleDelete`） | ✅ N | ✅ |
| 删除所有会话 | `src/components/layout/HeaderDropdown.tsx:469`（`handleDeleteAllGroups`，确认框在 `:562-573`） | ✅ N+M(锁定数) | ✅ |
| 删除单条标签（非最后一条） | `TabGroup.tsx:470`（`handleDeleteTab`） | ✕ | ✕（✕ 按钮自带 tooltip） |
| 删除单条标签（最后一条⇒整组消失） | `TabGroup.tsx:500` / `SearchResultList.tsx:485` | ✕ | ✅ |
| **拖走最后一条标签** | `TabGroup.tsx:451-467` | ✕ | ✕ **且零反馈**（DS-12） |
| 覆盖上传 | `SyncButton.tsx:145-193` + `syncPreviewView.tsx:48-59` | ✅ N/M/K | ✅「操作不可撤销」 |
| 覆盖下载 | `SyncButton.tsx:194-223` | ✅ N/M，**✕ K**（DS-6） | ✅ |
| 导入 | `HeaderDropdown.tsx:989-1081` | ✅ | 不需要（纯追加、零删除） |
| 清空本地数据 | `storage.ts:1775-1810` | — | **无 UI 入口**（见 §6 撤回 #4） |
| 切换后端（WebDAV 换库） | `WebDavSettings.tsx:600-760` | ✅ | — |
| **退出登录** | `HeaderDropdown.tsx:445` | ✕ | ✕ **且不清本地数据**（DS-8） |

---

## 2. P0 结论（真丢数据 / 真泄露）

### DS-1 · 换账号后旧账号的会话流进新账号的云端，且用新账号的密钥加密

**位置**
- `src/storage-kv/keys.ts:14` — `GROUPS: 'tab_groups'`：**单键，不按账号分**。
- `src/store/slices/authSlice.ts:149`（thunk） / `:283-290`（reducer，`:289` 才 `authCache.clearAuthState()`）。
- `src/utils/authCache.ts:77-84` — `clearAuthState()` 只删 `chrome.storage.local` 的 `auth_cache` 一个键。
- `src/components/auth/restoreAfterLogin.ts:70` — `sendSyncCommand('download', {forceRemote:false})`。
- `src/components/auth/LoginForm.tsx:72-75` — toast「已从云端恢复 N 个会话」（N = **云端**组数）。
- `src/utils/supabase/upload.ts:645`（`requireSessionUserId()`）/ `:779`（`user_id: userId`）/ `:839`（`encryptData(group.tabs_data, userId)`）。
- `src/legal/privacy.html:34` — 「该加密密钥由**账户 ID** 派生」。

**失效路径（可复现）**
1. 用户以账号 A 登录，本机有 30 个会话（落在 IndexedDB 的 `tab_groups` 单键里）。
2. 退出登录 → `authSlice.ts:289` 只清 `auth_cache`；**30 个会话原地不动**。
3. 以账号 B 登录 → `restoreAfterLogin.ts:70` 发**合并**下载（`forceRemote:false`）
   ⇒ B 的云端会话并进来，A 的 30 个**原样留在列表里**；
   `LoginForm.tsx:72` 的 toast 只说「已从云端恢复 N 个会话」，**不提本机还残留着 A 的 30 个**。
4. 发生一次上传（开自动同步，或按上传键）：
   `syncEngine.ts:1112-1124` 对 supabase **永不做归属抑制**（`decideSuppressFullUpload` 的
   `configuredBackendId !== 'supabase'` 一项恒 false ⇒ 抑制恒关）⇒ `groupsForUpload = activeGroups`（**全量**本机会话）
   ⇒ `upload.ts:645/779` 用 **B 的 userId** 作 `user_id` ⇒ `upload.ts:839` 用 **B 的 userId 派生密钥**加密 A 的会话标题与网址
   ⇒ **A 的私有数据进了 B 的账号行里，且用 B 的密钥加密**。
5. 无任何账号切换检测：`authSlice.signIn.fulfilled`（`:260-268`）不比对上次账号 id；
   `signOut` 侧 `authCache.clearAuthState()` 已把旧用户 id 一并抹掉 ⇒ 事后也无法比对。
   （复核方式：`grep -rn "lastUserId|previousUser|switchAccount" src/` 零命中 **＋** 逐行读 `authSlice.ts:115-175 / 240-300` 全文，两法一致。）

**用户看到什么**：登录 B 之后列表里混着 A 的会话，没有任何提示；点上传后 A 的数据进了 B 的云端。

**数据是否丢**：A 的数据**没丢**，但**泄露**了（在 B 的账号下可见、可被持有 B 凭据的一方解密）。
本产品隐私政策把「账户 ID 派生密钥」写成了明确的安全边界，这条路径直接越过了它。

**最小改法**
`GROUPS` 改为按账号分键（`tab_groups:<userId>`，登录时按账号切视图）—— 这是根治；
退一步：`signIn.fulfilled` 比对 `authCache` 里的旧账号 id，不一致时弹「本机有 N 个属于上一个账号的会话，要上传到新账号吗」，
且上传前按账号过滤。

---

### DS-2 · 覆盖下载的删除熔断在结构上看不见这次覆盖 ⇒ 一次操作可物理清空本机任意多会话

**位置**
- `src/services/syncEngine.ts:798-800` — 覆盖模式下 `localGroups` 被过滤成
  `snapshot.filter(g => !g.isDeleted && skippedIds.has(g.id))`
  ⇒ **被云端替换掉的本机会话在进合并之前就已经不在了**。
- `src/services/syncEngine.ts:878` — `const mergeDropped = removedGroupIds(mergedGroups, finalGroups);`
  ⇒ `mergeDropped` **只统计「空壳剔除」**，覆盖场景下**恒为 0**。
- `src/services/syncEngine.ts:880-882` — `checkDeleteFailsafe(mergedGroups.filter(g=>!g.isDeleted).length, mergeDropped.length)`。
- `src/sync-backend/failsafe.ts:51-58` — `if (deleteCount <= 0) return { allowed: true }`。
- `src/core/syncDecision.ts:220-232` — 空云端闸门只在 `cloudTotalCount === 0` 时拒绝（调用点 `syncEngine.ts:712`）。
- `src/services/syncEngine.ts:866-869` — **熔断自己的注释说它防的就是这件事**：
  「服务端分页/限流导致只读到一部分（坚果云单次 750 条上限…）⇒ 在『下载覆盖本地』的语义下会直接清空用户本机会话」。

**失效路径（可复现）**
1. 本机 50 个活跃会话；云端这轮只**读到 1 个**（分页截断 / 清单不全 / 服务端返回合法但不完整的 207）。
2. 用户点「从云端下载（覆盖）」⇒ 预览显示「预计删除 49 个会话…操作不可撤销」⇒ 用户点两下确认。
3. 执行：`syncEngine.ts:798-800` 把本机 50 个换成云端 1 个 ⇒ **49 个会话物理清除，无回收站**。
4. 空云端闸门：`cloudTotalCount = 1 + 0 = 1 ≠ 0` ⇒ **放行**（`syncDecision.ts:223`）。
5. 熔断：`mergeDropped = 0` ⇒ `checkDeleteFailsafe(1, 0)` ⇒ `deleteCount <= 0` ⇒ **ALLOWED**。
   （用仓库里的真 `checkDeleteFailsafe` 实跑：ALLOWED，无 reason。）
6. **没有任何一层拦下它。**

**用户看到什么**：「覆盖成功，已恢复 1 个会话」。本机 49 个会话消失，无提示、无回滚、无撤销。

**数据是否丢**：**丢**。49 个会话永久消失（无回收站）。

**最小改法**
熔断的实参改用「**覆盖前的本机活跃数**」与「**覆盖后本机活跃数**」的差值，而不是 `mergeDropped.length`。
（⚠️ 这会被现有守卫判红 —— 见 **DS-11**，必须先松守卫。）

---

### DS-3 · 另一台设备的一次并发编辑可以静默撤销「删除」

**位置**
- `src/core/opStampMerge.ts:50-56` — 云端墓碑 vs 本地活跃 ⇒ stamp 决胜；本地新则保留本地，
  注释原文（`:53`）：「**删除被本地更新撤销**，与旧模型语义一致」。
- `src/utils/supabase/upload.ts:926`（所在块 `:908-928`） — 合并模式也会写 `is_deleted`：
  注释「本地认为活跃 → is_deleted=false：把 Web 端已软删、本地仍活跃（恢复/取消删除）的组复位为活跃」，
  `:926` `(group as any).is_deleted = isTombstone;`。
- `src/core/opStamp.ts:22-30` — `compareStamps` 跨设备**裸比 seq 数值**。
- `src/utils/seqRegistry.ts:8-9` — 自己的注释：「序号只在同一设备内单调，**跨设备裸比数值毫无意义**」。
- `src/utils/supabase/upload.ts:1285-1290` — 墓碑取号 `max(本机 lamport, 云端旧 seq + 1)`。

**失效路径（可复现）**
1. 设备 A 删除会话 X ⇒ A 本地物理清除；`markCloudGroupsAsDeleted` 给云端行盖墓碑（seq = A 的计数器）。
2. 设备 B 离线，期间**编辑了同一个会话 X** ⇒ B 的本地 stamp 存在且未上传。
3. B 上线下载合并 ⇒ `opStampMerge.ts:50-56` 判「本地新」⇒ **X 留在 B 的列表里**（墓碑没生效）。
4. B 上传 ⇒ `upload.ts:926`（所在块 `:908-928`） 把 `is_deleted` 复位为 **false** ⇒ **云端墓碑被翻回活跃**。
5. A 下轮下载 ⇒ 合并把 X 收进来 ⇒ **A 的列表里 X 重新出现**。

**用户看到什么**：A 刚删掉的会话，**又回来了**；且没有任何提示。A 看到的还是 B 的版本（A 那份内容已丢）。

**数据是否丢**：A 看到的那份内容**丢**（被 B 的版本覆盖）；删除意图**丢**。

**为什么胜负是任意的**：墓碑的 seq 是**删除那台设备自己的计数器**，B 的离线编辑的 seq 是**另一台设备自己的计数器**，
两个无关计数器的数值大小决定胜负，**与事件先后无关**。`seqRegistry.ts:8-9` 明说跨设备裸比数值毫无意义，
而 Lamport 不变式（「本机发出的号必须大于它观察到的任何印记」）恰恰在**离线**场景下不成立。

**未披露**：`README.md:8` / `README.md:71` / `CHROMEWEBSTORE.md:429` 只说「两台设备**同时编辑**同一会话，后保存方整组赢」，
**没有**覆盖「删除 vs 并发编辑」。而删除确认框写着「删除后无法恢复」（`src/components/tabs/lockedDeleteCopy.ts`）、
「其他登录设备将同步删除」（`src/components/layout/deleteAllMessages.ts`）。
前科：`CHROMEWEBSTORE.md:387` 的 v1.24.2 变更记录里就写着「删除会被静默撤销、会话复活」。

**数据是否丢**：见上（A 的那份内容丢 + 删除意图丢）。**P0**。

**最小改法**（二选一）
① 给删除一个**语义优先级**：墓碑 seq 额外带一个「删除世代」位，合并时墓碑恒赢；
② 最低成本：删除确认框 + 三处文档补一句「另一台设备若在此期间改过这个会话，本次删除可能被它的改动覆盖」。

---

## 3. P1 结论（可能丢 / 承诺与行为不符）

### DS-4 · `getFirstSyncPending` 读失败被当成「没有待决」⇒ 切库时把历史会话全量推上云

**位置**：`src/utils/storage.ts:1047-1050`
```ts
} catch {
  // 读不到就当「没有待决」：挡住的代价（数据传不上去）比放过的代价大。
  return false;
}
```

**失效路径**
1. 用户在设置页改 WebDAV 库地址 ⇒ `WebDavSettings.tsx:679` 写入 `setFirstSyncPending(true, targetScope)`。
2. 下一轮上传前，`syncEngine.ts:1112` 读这个标志 —— **读失败**（IndexedDB 瞬时读错 / SW 冷启动 KV 未就绪）。
3. `storage.ts:1049` 返回 `false` ⇒ `syncEngine.ts:1113` `explicitFirstSync = true`
   ⇒ `decideSuppressFullUpload`（`syncEngine.ts:167-179`）返回 **false**（抑制关）
   ⇒ `changedGroupIds = null` ⇒ `groupsForUpload = activeGroups`（**全量本机会话**）。
4. **本机全部历史会话被推上新云盘**，用户从未被问过「这些归谁」。

**用户看到什么**：同步正常完成，界面无异常。

**数据是否丢**：不丢，但**归属被单方面决定**（本机历史进了可能不属于你的库）—— 不可回滚。

**方向反了**：这与 `src/storage-kv/firstSyncPendingRecord.ts` 自己的不变量（「宁可少传，不可多传」「『多传』不可回滚」）**直接矛盾**。
挡住 = 少传（可再传）；放过 = 多传（不可回滚）。

**零测试覆盖**：`grep -rn "getFirstSyncPending" tests/` 只命中正常读写与接线断言，**没有一条测读失败分支**
（复核方式：另跑 `grep -rn "getPendingUploadRegistryState" tests/` 同法核对，同样零覆盖）。

**最小改法**：`catch { return true; }`（读不到 = 待决），或直接抛；补一条「读失败 ⇒ 抑制仍开着」的测试。

---

### DS-5 · `getPendingUploadRegistryState` 读失败被当成「干净」⇒ 漏登记的改动永远补不上云

**位置**：`src/utils/storage.ts:1181-1184`
```ts
} catch {
  // 读失败 ⇒ false（既有纪律：读不到不等于失败过）。
  return clean;      // clean = { unreliable:false, gapOpen:false, gen:0 }
}
```

**失效路径**
1. 某次变更登记（`pendingUploadGroupIds`）失败 ⇒ 状态被写成 `unreliable:true, gapOpen:true`。
2. 下一轮上传前读这个状态 —— **读失败** ⇒ `storage.ts:1183` 返回 `clean` ⇒ **「漏登记未覆盖」这个事实被抹掉**。
3. `src/core/uploadCoverage.ts` 的 `canClearPending = !registryBlocksThisRound && !registryGapOpen && unsyncedIds.length === 0`
   ⇒ 本轮可以宣称「全部已同步」⇒ `setPendingUpload(false)` + `clearPendingUploadGroupIds()`。
4. 那批漏登记的改动**既没上云，也不再重试**。

**用户看到什么**：同步显示「已全部同步」，但那批会话在云端**从来没出现过**，且之后再也不会上传。

**数据是否丢**：**丢**（云端副本永久缺失；本机还在，但一旦本机清数据/换机就没了）。

**方向反了**：同文件里 `getGroups` / `getSettings` / `getPendingUpload` 全是 fail-closed，唯独这里 fail-open。

**最小改法**：`catch { return { unreliable: true, gapOpen: true, gen: 0 }; }`（读不到 = 不可信；
方向同 `getPendingUploadGroupIds`（`storage.ts:1098`）的 `return []`）。

---

### DS-6 · 覆盖下载的预览看不到「读不出来」的云端组 ⇒ 预览数与实际不符

**位置**
- `src/components/sync/SyncButton.tsx:209` — 下载方向用**普通** `downloadTabGroups()`；
  上传方向 `:168` 用**原子包装** `downloadTabGroupsWithSkips()`。
- `src/utils/syncPreview.ts:246-262` — `buildDownloadPreviewSummary` 只看到「读得到的」云端组。
- `src/services/syncEngine.ts:798-800` + `:855-862`（`finalGroups` 把 `skippedIds` 放回）——
  执行时**被跳过的组对应的本机副本会活下来**。

**失效路径**
1. 云端有 50 组，其中 1 组「读不出来」；本机有 50 组（含那 1 组的副本）。
2. 预览：`downloadTabGroups()` 只拿到 49 组 ⇒ 「预计删除 50 个会话」（50 本机 − 0 可读…实际是 50−49=1 才对，
   但因为可读组与本机组按 id 配对，预览数会**偏大**）。
3. 执行：`skippedIds` 的那 1 组本机副本被放回 ⇒ 实际只删 N−1 个。

**用户看到什么**：风险文案说「预计删除 N 个会话」，实际删 N−1 个，**且没有任何一句解释那 1 个为什么留下**。

**数据是否丢**：**不丢**（方向是「比实际更严重」）。但违反仓库自己的「预览与实际同源」纪律
（对照 `tests/overwritePreviewConsistency.test.ts:78` 上传方向的做法：真调同一函数）。

**最小改法**：下载方向也改用 `downloadTabGroupsWithSkips()`，把 `skippedRemoteIds` 传进 `buildDownloadPreviewSummary`。

---

### DS-7 · 「清理重复标签」的确认数字来自可能陈旧的 Redux 快照，实际删除用真值读

**位置**
- `src/components/layout/Header.tsx:129-135`
  ```ts
  let localGroups = groups;
  try { localGroups = await storage.getGroupsForWrite(); }
  catch (error) { logWarn('[Header] 清理前读取真实会话失败，改用界面当前快照计算清理范围:', error); }
  const plan = planCleanDuplicates(localGroups);
  ```
- 执行侧是**真值读**：`src/background/mutationService.ts:37` `getGroups: () => storage.getGroupsForWrite()`
  → `src/background/mutationHandlers.ts:321-323` 用权威 groups 重算 `planCleanDuplicates`。

**失效路径**
1. 本机 storage 里有 200 个会话，Redux 快照还是 150 个（跨设备同步刚写完、通知未到）。
2. 读 `getGroupsForWrite()` **失败** ⇒ 退回 150 个的快照 ⇒ 确认框写「本次预计清除 12 个重复标签页」。
3. 执行侧读真值（200 个）⇒ **实际清除的数量与确认框里的数字不一致**。
4. 变体：读失败 **且** Redux 快照为空 ⇒ `Header.tsx:139-142` 在**根本没有确认框**的情况下直接返回
   「没有发现重复标签或空会话，无需清理」—— 用户以为无事发生。

**用户看到什么**：确认框的数字与真实删除量对不上；或点了清理却什么都没发生、也没有任何解释。

**数据是否丢**：不额外丢（删除的是真重复），但**披露失真**；且属破坏性路径上的读路径 fail-open。

**最小改法**：读失败时**中止**并提示「暂时读不到真实会话，已取消清理」，不要退回快照。

---

### DS-8 · 退出登录不清本地数据、且零提示

**位置**
- `src/components/layout/HeaderDropdown.tsx:445` — `handleSignOut` 只 `dispatch(signOut())` + toast「已退出登录」。
- `src/store/slices/authSlice.ts:149`（thunk，只调 `supabaseAuth.signOut()`）/ `:283-290`（reducer，`:289` 只 `authCache.clearAuthState()`）。
- `src/utils/authCache.ts:77-84` — 只删 `chrome.storage.local` 的 `auth_cache`。

**失效路径**
1. 账号 A 登录，本机 30 个会话。
2. 点「退出登录」⇒ **无确认、零提示**；本地 30 个会话原地不动（`tab_groups` 单键）。
3. 账号 B 登录 ⇒ 见 **DS-1**：A 的 30 个会话混进 B 的列表，上传时进 B 的云端。

**用户看到什么**：只有一句「已退出登录」。用户合理地以为「退出 = 这个账号的数据不在本机了」。

**数据是否丢**：本机不丢；泄露风险见 DS-1。

**最小改法**：退出登录时加一句「本机 **N** 个会话仍保留，不会上传到新账号」；
或按 DS-1 改成按账号分键，这句话就自动成立。

---

### DS-9 · 锁定会话「✕ 逐条删除」被拒时的那句提示，全仓零测试覆盖

**位置**
- `tests/guards/lockedTabDeleteGuard.test.ts:88` —
  `assert.match(body.slice(lockAt, dispatchAt), /showDeleteError\(/, '拦住之后必须出声，不能静默返回')`
  ⇒ **只断言「有一个 `showDeleteError(` 调用」，从不检查它说了什么**。
- 被守的文案：`src/components/search/SearchResultList.tsx:459` `showDeleteError('该会话已锁定，解锁后才能删除其中的标签')`。

**失效路径（变异验证）**
把 `SearchResultList.tsx:459` 的文案改成 `showDeleteError('随便改点什么')`
⇒ **0 红**（三个相关文件 43 个用例全绿）。改成 `showDeleteError('')` 同样全绿 ⇒ 界面弹一个空白 toast。

**用户看到什么**：点锁定会话的「✕」，弹一句无意义的话（或空白），**用户不知道要去解锁**。

**数据是否丢**：不丢。但这是「无回收站」产品里**唯一一条防误删承诺**的用户可见反馈环节，而它零覆盖。

**零覆盖的复核方式（双法一致）**
- 方法 1：`grep -rnF "解锁后才能删除其中的标签" tests/` ⇒ 零命中。
- 方法 2：独立 python 扫描 `tests/**/*.ts(x)` 的同一精确串 ⇒ 零命中；
  同族对照：`"会话已锁定，解锁后才能移动其中的标签"` ⇒ `tests/guards/audit20261019DataSafety.test.ts`（**有**覆盖）；
  `"其中包含 N 个已锁定的会话"` / `"该会话已锁定"` ⇒ `tests/lockedDelete.test.ts`（**有**覆盖）。
  ⇒ **缺的正是「逐条删除」这一条**。

**最小改法**：照抄 `tests/guards/deleteAllDisclosure.test.ts:53` 的逐字中文断言范式，一行改动。

---

### DS-10 · `p0DataSafetyGuards` 里三条纯字面量守卫：改日志措辞就红，防不了任何回归

**位置**
- `tests/p0DataSafetyGuards.test.ts:114` — 断言 `backgroundSync.ts` 里一句**中文日志**
  `读不到 pending_upload 判据，中止本轮同步` ⇒ 改这句 `logWarn` 的措辞 ⇒ **1 红，行为零变化**。
- `tests/p0DataSafetyGuards.test.ts:78` — `src.indexOf('const [lastUpload, pending] = await Promise.all([')`
  ⇒ 钉死一整行源码的变量名与解构形状 ⇒ 任何**行为等价**的重构都会误红。
- `tests/p0DataSafetyGuards.test.ts:102` — `reason: 'precheck_unknown'` 字符串（勉强算契约守卫：
  `backgroundSync.ts:750` 按 reason 路由退避）。
- 同类：`tests/syncOverwriteGuard.test.ts:205` 钉死 JSX 字面量 `disabled={uploadOverwriteState.type === 'blocked'}`。

**失效路径**：任何人整理日志措辞或重命名局部变量 ⇒ 门禁变红 ⇒ 维护者要么改回、要么把断言改松 ⇒
**断言越改越松，最后什么都拦不住**。

**用户看到什么**：无用户可见影响（这是工程纪律问题，不是运行时缺陷）。

**数据是否丢**：不直接丢；但它让「fail-closed」这条最关键的纪律**看起来有守卫、其实没有**。

**最小改法**：把「钉字符串」换成「钉控制流」—— 例如断言 catch 块**之后没有落到下载语句**，
或断言该分支返回了带 `success:false` 的结果对象。

---

### DS-11 · 熔断守卫把实参钉死成 `mergeDropped.length` ⇒ **正确的修法会被判红**

**位置**
- `tests/syncFailsafeGuard.test.ts:99-105` —
  ```ts
  // 现在断言的是**实参本身**：必须传 mergeDropped.length。
  assert.ok(callText.includes('mergeDropped.length'), ...);
  assert.ok(callText.includes('mergedGroups') && callText.includes('isDeleted'), ...);
  ```
- 该文件自己的注释记着上一轮的近失：「把实参换成 `snapshot.length, droppedIds.length` 后依然全绿」。

**失效路径**
1. 要修 **DS-2**，必须把 `syncEngine.ts:880-882` 的实参换成「覆盖前本机活跃数 − 覆盖后活跃数」的差值。
2. 这条守卫会**红**，而且是以「你把删除数算错了」的名义把正确修法挡回去。
3. ⇒ **DS-2 修不动，除非先松这条守卫**。

**用户看到什么**：无直接用户可见影响；但它让本产品**唯一一道「远端看起来不对时不要盲从」的防线**
（`src/sync-backend/failsafe.ts` 文件头原话）**既测不准、又挡修**。

**数据是否丢**：本身不丢；但它是 DS-2 得以长期存在的原因。

**最小改法**
把断言从「必须传 `mergeDropped.length`」改成「**实参必须能反映本机会话的净减少**」；
并**同时**加一条行为级测试：真引擎 + 假后端（云端只回 1 组、本机 10 组）⇒ 覆盖下载必须被熔断拦下。

---

## 4. P2 结论（体验 / 纪律）

### DS-12 · 拖走最后一条标签：零成功反馈
- **位置**：`src/components/tabs/TabGroup.tsx:451-467` — `handleMoveTab` 的 `.then` 里**只有**失败分支
  （`deleteBroadcastWarn`），成功时一句话都没有；会话卡直接消失。
- **对照**：删单个会话有确认框、恢复有 toast（`src/components/tabs/restoreFeedbackCopy.ts`）、
  清理重复有 toast（`src/components/layout/cleanDuplicatesMessage.ts`）。
  **唯独「一次手势毁掉整个会话」这条路径完全静默。**
- **注**：这条路径无确认是**产品钦定**（`TabGroup.tsx:771-795` 注释原文「产品负责人 2026-10-19 明确要求恢复：**直接删除，不加确认**」），
  且被 `tests/dragLastTabRefused.test.ts` 钉成守卫 ⇒ **不是缺陷，是被守护的决定**。缺的只是反馈。
- **最小改法**：加一条「已移出「X」」的 toast（有动作按钮更好 —— 见 §5）。

### DS-13 · 「删除全部搜索结果」不说「整组消失」；关掉确认开关后一次点击删 N 条
- **位置**：`src/components/search/SearchResultList.tsx:606-620` —
  文案「将从所属会话中永久移除这 **N** 条标签记录（锁定会话除外），删除后无法恢复。」
  但 `deleteTabAndSync` 内部「删到组空 → 自动整组删除」⇒ 某会话标签全被命中时**整个会话消失**，文案没说。
- `:607-610` — `if (!confirmBeforeDelete) { void handleDeleteAllSearchResults(); return; }`
  ⇒ 关掉开关后**一次点击、零提示**删掉 N 条。
- **最小改法**：文案补一句「某会话若因此被清空，会一并从列表消失」。

### DS-14 · 搜索页「全部恢复」时打不开的标签也被永久删除，但文案不说「永久」
- 列表页 `src/components/tabs/TabGroup.tsx:343`：「另有 N 个在当前设备无法打开…**这几个地址不再保存在列表中。**」✅ 诚实。
- 搜索页 `src/components/search/SearchResultList.tsx:565-572`：「另有 N 个在当前设备无法打开…**命中的标签已从所属会话移除**」
  ⇒ 技术上不假，但 `consumeMatchedTabs`（`:531-545`）**把它们全删了**。
- **最小改法**：搜索页复用列表页那半句。

### DS-15 · 导入不做「覆盖」：内容有差异的同名会话并存成两份，无提示
- **位置**：`src/core/mutationOps.ts:290-352` `applyImportGroups` — 指纹去重（name + URL 集 + 计数），
  **新 id**（`deps.genId()`，`:334`）。
- **后果**：把备份导到一台**已有这些会话但内容改过**的机器 ⇒ 指纹不同 ⇒ 全部作为新会话落盘 ⇒ 一份备份变两份列表，零提示。
- **要一起说清的好处**：导入是全仓**唯一一条纯增量、零删除**的路径（不会覆盖、不会删除任何已有会话）。
- **最小改法**：导入结果补一句「同名但内容不同的会话会作为新会话并存」。

### DS-16 · 墓碑双写守卫的 fixture 与阈值自指 ⇒ 恒真
- **位置**：`tests/overwriteTombstoneDoubleWrite.test.ts:34`（`import { ID_BATCH_SIZE }` 自被测模块）
  / `:170`（假网关阈值 `count > ID_BATCH_SIZE`）/ `:476`（fixture 长度 `ID_BATCH_SIZE + 1`）
  ⇒ 变异把 `ID_BATCH_SIZE` 150 → 10000 ⇒ **0 红，恒真**。
- **缓解**：真正的「必须分批」不变量由 `tests/idBatches.test.ts` 独立守着（变异 ⇒ 4 红），数据安全没裸奔；
  但**「恰好 150 这个数值」无人守**（真实网关上限约 600 UUID，改成 3000 会静默越过）。
- **最小改法**：fixture 长度与阈值都改硬编码；或加一条不变量断言 `ID_BATCH_SIZE * 36 <= 20000`。

### DS-17 · 两个后端「读不出来」的语义不同，同一句话含义不同
- Supabase：**逐组跳过 + 报出清单**（`src/utils/supabase/download.ts:436-566` + `lastDownloadSkipped` 同轮保证）。
- WebDAV：**整轮抛错**（`src/sync-backend/webdav/adapter.ts:1193-1229`，文件头明写「D-6 对本后端结构上不适用」）。
- **后果**：同一个「云端有 3 组读不出来」的事实，Supabase 用户看到「保留 3 组」，WebDAV 用户看到「同步失败」。
  方向都对（都偏少传/中止），但**不能共用一套解释文案**。
- **最小改法**：「读不出来」的原因文案按后端分流（现有 `REASON_COPY` 已是这个形状，扩两条即可）。

### DS-18 · `storageFailClosed` 的 blocked 用例依赖「必须是本文件第一个 it」
- **位置**：`tests/storageFailClosed.test.ts:146-147` 自己的注释：
  「模块级 cachedDb 已持有句柄，blocked 场景就再也触发不到」⇒ 往文件顶部插一个用例，它会**静默失效**而不是变红。
- **最小改法**：把该用例移到独立文件，或让装置在 `before` 里重建 DB 句柄。

---

## 5. 读路径 fail-closed 审计（item 4）

`src/utils/storage.ts` 全部 catch 点逐条分类（**写路径的静默失败按分工不算本轮重点**）：

| 方向 | 函数 | 位置 | 说明 |
|---|---|---|---|
| ✅ fail-closed | `getGroups` | `:427-459` | 键值非数组 ⇒ 抛错（2026-10-09 P1-10） |
| ✅ | `getSettings` | `:~665-690` | 读失败抛错，绝不返回 DEFAULT_SETTINGS |
| ✅ | `getPendingUpload` / `getLastUploadTime` / `getLastSyncTime` | `:~960` / `:1395` | 2026-10-05 / 10-07 已修 |
| ✅ | `getPendingDeleteIds` / `clearPendingDeleteIds` | `:833-955` | 清失败抛错且**先于**动内存兜底 |
| ❌ **fail-open** | **`getFirstSyncPending`** | **`:1047-1050`** | ⇒ **DS-4** |
| ❌ **fail-open** | **`getPendingUploadRegistryState`** | **`:1181-1184`** | ⇒ **DS-5** |
| ⚪ fail-closed 但无害 | `getPendingUploadGroupIds` | `:1098` | 返回 `[]` ⇒ 少传，方向安全 |
| ⚪ 低危 | `getDeletedGroups` / `getDeviceSeq` / `getJournal` / `getLastSyncedSeq` / `getOpStampMigrated` | `:789` / `:1421` / `:1430` / `:1440` / `:1458` | 真正的 Lamport 路径在 `src/utils/seqRegistry.ts`（**不吞读错**），这几个是旁路 |
| ❌ **破坏性路径上的 fail-open** | 清理重复的确认计数 | `Header.tsx:129-135` | ⇒ **DS-7** |

**判据**：fail-open 只在**方向上更危险**时才算缺陷。读失败 ⇒「少传/中止」是安全的（可重试）；
读失败 ⇒「多传/宣告已同步」是危险的（不可回滚）。DS-4 与 DS-5 都属于后者。

---

## 6. 我撤回的判断（怀疑过、复核后不成立）

| # | 怀疑过 | 复核结果 | 复核方式 |
|---|---|---|---|
| 1 | 「覆盖上传会删掉读不出来的云端行」 | **撤回**。Supabase 侧已彻底修好：`src/utils/supabase/upload.ts:338-350` `probeOverwriteDeletePlan`（fail-closed）+ `src/core/overwriteUploadGuard.ts` `planOverwriteUpload` + `upload.ts:363-388`/`:1138` `verifyProtectedRowsStillExist`；预览与执行共用同一判据函数。WebDAV 侧**结构上不适用**（覆盖是清单并集，从不删云端独有分片；下载是 fail-closed，D-6 不可能发生） | 读调用链 + `grep -rn "probeOverwriteDeletePlan" src`（2 处命中都在 supabase 路径）+ 跑 `tests/overwriteUploadKeepsUnreadableCloud.test.ts`（9 pass / 0 fail） |
| 2 | 「换云盘会把历史会话推上去」 | **WebDAV 侧撤回**（待决位已按库作用域化：`src/sync-backend/webdav/libraryIdentity.ts` + `firstSyncDecision.ts:242` + `src/storage-kv/firstSyncPendingRecord.ts`，有 `tests/guards/librarySwitchOwnershipGate.test.ts` 守着）。**但同类问题在 Supabase 账号切换上完全没有对应物** ⇒ 转为 **DS-1** | 读三个文件全文 + 跑该守卫 |
| 3 | 「`probeOverwriteDeletePlan` 会在错误的后端（WebDAV）上被调用」 | **撤回**。它只在 `src/utils/supabase/upload.ts:960` 被调用，那条路只能经 `supabaseAdapter.uploadGroups` 到达 | 读调用链 + `grep -rn` |
| 4 | 「存在『清除本地数据』的用户入口」 | **撤回**。`storage.clear()`（`src/utils/storage.ts:1775-1810`）在生产代码里**没有任何调用方** | `grep -rn "storage.clear("`（命中全是注释）**＋** 独立 python 扫描全部 `src/**/*.ts(x)`（同样只有注释）**＋** 扫 `tests/`（只有一行注释） |
| 5 | 「合并算法会在并发下复活已删内容」 | **部分撤回**。旧「规则 2」已于 2026-10-21 删除（`src/core/syncDecision.ts:257-280` 有完整推导与实测记录），删除的跨端收敛是合法行为、**必须**传播。**但**「删除被另一台设备的并发编辑撤销」这条**成立** ⇒ **DS-3**。两者不是一回事 | 读 `syncDecision.ts:245-294` 全文 + `tests/syncNoResurrectConvergence.test.ts` |
| 6 | 「`getFirstSyncPending` 的 catch 是 fail-closed」 | **撤回**。文件里那句注释的代价评估在**跨设备**场景是反的 ⇒ **DS-4** | 读 `storage.ts:1025-1050` + `src/storage-kv/firstSyncPendingRecord.ts` 文件头的不变量 |
| 7 | 「拖拽删会话是未被守护的行为」 | **撤回**。`tests/dragLastTabRefused.test.ts` 明确把「不拦」钉成产品决定（断言 `onDragBlocked=` 不出现在 JSX、断言 `refuseDragDeleteGroup` 已移除、断言注释里写明「不拦」）。它是**被守护的决定**，不是遗漏 | 读该测试全文 + `TabGroup.tsx:771-795` |
| 8 | 「`storage.getDeviceSeq` 的 `catch { return 0 }` 是丢数据隐患」 | **撤回**。真正的 Lamport 取号走 `src/utils/seqRegistry.ts`，它**不吞读错**；`storage.ts` 里的那几个是旁路 | 读 `seqRegistry.ts` 全文 + `grep -rn "getDeviceSeq\|seqRegistry" src` |

---

## 7. 未能验证项（受环境限制，非遗漏）

1. **没有真机 / 没有真实 Supabase 账号** ⇒ **DS-1** 与 **DS-3** 是**代码路径确认**，未在真机复现。
   DS-1 的最后一环（上传真的把 A 的会话写进 B 的行）依赖真实 RLS 与 `requireSessionUserId()`，**没有**连生产库验证。
2. **没有本地 Postgres** ⇒ 服务端 `guard_tab_group_op_stamp` 触发器在 DS-1 / DS-3 场景下的实际行为未验证
   （`tests/versionGuardOpStamp.pg.test.ts` / `opStampGuard.pg.test.ts` 是真库测试，本机没跑）。
3. **坚果云 750 条上限未实测** ⇒ **DS-2** 的**触发条件**（服务端返回合法但不完整的 207 清单）未在真机复现；
   我只验证了「熔断在数学上看不见这次覆盖」这一半。
4. **熔断的算术演示不是端到端** ⇒ 我用仓库里的真 `checkDeleteFailsafe` 跑了「本机 50 / 云端 1 ⇒ ALLOWED」，
   但**没有**端到端跑通一条 forceRemote 覆盖下载（`tests/forceRemoteSkippedGroups.test.ts` 存在，未逐条读覆盖面）。
   DS-2 的「执行路径」结论来自读 `syncEngine.ts:712-882`，不是来自跑通。
5. **守卫检测力的变异测试在仓库副本上做**（不是我本人做的）。
   我**亲自复核**了其中 3 条：(a) DS-9 的文案盲区（双法独立复核）、(b) DS-10 的字面量守卫形态（读源码确认）、
   (c) DS-16 的自比常量（读 `:34/:170/:476` 确认）。其余结论采信但**未逐条复现**。
6. **没有审计 `src/utils/supabase/download.ts` 的分页稳定性**（`created_at` 并列、offset 漂移）与 **RLS 策略** —— 不在本轮分工内。
7. **没有读 `docs/audit-2026-10-22-round41.md` 的专家团章节**（当时尚未写入）—— 与本轮其它专家（UI/产品/架构/文案）的结论**没有**交叉比对，可能重叠。

---

## 8. 最便宜的兜底（产品级建议）

**推荐：删除后 5 秒 toast 里的「撤销」—— 撤销数据只在本机内存，不落盘、不进同步语义。**

- **为什么是它**：本产品对「无回收站」的承诺是**硬约束**（隐私政策 / 商店 listing / README /
  `assert.match(en, /no undo/i)` 四处一起钉着），所以任何兜底只要**引入「事后还能救回来」**这层新语义，
  就等于动地基。5 秒窗口的性质是「**删除即时生效，5 秒内可取消这次删除**」，而不是「删除被推迟」；
  窗口一关就是物理清除、不可恢复、不可撤销 —— **原承诺逐字仍成立**，只多一个 5 秒例外。
  这比 round2 §4.1 记的 V2 方案（本地墓碑 + 30 天 TTL + 云端反向戳）便宜一个数量级。
- **代价**：
  1. 一个内存 ring buffer（最近一次删除的载荷 + delete token），刷新即失效 —— 这正是我们要的。
  2. **toast 要支持动作按钮**：现在的 `src/contexts/ToastContext.tsx:9`
     `showToast(message, type?, duration?)` **没有** action 参数 ⇒ 这是本方案唯一真正的工程成本
     （toast 组件 + context 各改一处）。
  3. 恢复路径：载荷写回本地 + **取一个全新的 stamp**（不能复用旧 stamp，否则云端墓碑可能仍赢）
     + 从 `pendingDeleteIds` 摘掉那个 id（若墓碑尚未广播）。
  4. **若墓碑已广播**（30s alarm 到了，或「删除所有会话」会立刻推一次覆盖上传）：
     恢复的组必须用**严格大于墓碑 seq 的新 stamp** 重新上传，把云端 `is_deleted` 翻回 false。
     这一步是现成的 —— `src/utils/supabase/upload.ts:926`（所在块 `:908-928`） 的合并模式已经在写 `is_deleted=false`，
     而 `markCloudGroupsAsDeleted`（`upload.ts:1285-1290`）写墓碑时已把本机时钟抬到 `max(lamport, cloud+1)`
     ⇒ 恢复时取的新号必然更大 ⇒ 覆盖成立。**同步语义影响 = 零新增概念**，只复用既有路径。
- **它会怎么动现有承诺（4 处，缺一不可）**：
  - `src/legal/privacy.html` —— 现在被 `tests/docsAlignment.test.ts:356-357` 钉着 `/不可恢复/` 与 `/没有撤销入口|无撤销/`
  - `CHROMEWEBSTORE.md` —— 被 `tests/docsAlignment.test.ts:254` 与 `:834` 钉着 `/no undo/i`
  - `README.md` —— 被 `tests/docsAlignment.test.ts:428` 钉着 `/删除即物理清除|不进回收站/`
  - 以及那两条 `assert.match(en, /no undo/i)` **断言本身**（它们是承诺的一部分，不改就是让测试撒谎）
  - 外加 6 处删除文案要改成条件句（组删除 / 单条最后一条 / 删全部 / 清理重复 / 搜索批删 / 拖拽），
    其中**拖拽那条最该改**（唯一零反馈路径，DS-12）。
- **明确不建议的两条**：
  - ❌「给拖拽加一次确认」—— 代码量最小，但产品负责人 2026-10-19 已明确否决（`TabGroup.tsx:771-795`），
    且 `tests/dragLastTabRefused.test.ts` 会在加回拦截时变红。**这是产品决定，不是缺陷**。
  - ❌「本地墓碑 + 30 天 TTL」—— round2 §4.1 已论证：那是又一层新语义 + 四个承诺点 + 云端反向戳的印记严格性风险。
- **零承诺层的最低成本止血**：DS-12 的一条 toast（「已移出「X」」）—— 不救数据，但让用户知道发生了什么，
  从而还有机会手动恢复。

---

## 9. 汇总表

| 编号 | 级别 | 一句话标题 | 位置 | 最小改法 |
|---|---|---|---|---|
| DS-1 | **P0** | 换账号后旧账号会话流进新账号云端（用新账号密钥加密） | `keys.ts:14` / `authSlice.ts:149,283-290` / `restoreAfterLogin.ts:70` / `upload.ts:645,779,839` | `GROUPS` 按 `userId` 分键；或 signIn 时比对旧账号并询问是否上传 |
| DS-2 | **P0** | 覆盖下载的删除熔断在结构上看不见这次覆盖 | `syncEngine.ts:798-800,878,880-882` / `syncDecision.ts:220-232` / `failsafe.ts:51-58` | 熔断实参改用「覆盖前本机活跃数 − 覆盖后活跃数」 |
| DS-3 | **P0** | 并发编辑可静默撤销删除，「删除后无法恢复」跨设备不成立 | `opStampMerge.ts:50-56` / `opStamp.ts:22-30` / `upload.ts:920-928,1285-1290` | 墓碑加删除优先级位；或删除确认框与三处文档写明此边界 |
| DS-4 | P1 | `getFirstSyncPending` 读失败 ⇒ 归属待决期失效 ⇒ 切库全量推历史 | `storage.ts:1047-1050` | `catch { return true }`；补读失败分支测试 |
| DS-5 | P1 | `getPendingUploadRegistryState` 读失败 ⇒ gapOpen 被抹 ⇒ 漏登记永不补传 | `storage.ts:1181-1184` | `catch { return {unreliable:true, gapOpen:true, gen:0} }` |
| DS-6 | P1 | 覆盖下载预览看不到「读不出来」的云端组 ⇒ 预览数与实际不符 | `SyncButton.tsx:209` / `syncPreview.ts:246-262` | 改用 `downloadTabGroupsWithSkips()` 并传 `skippedRemoteIds` |
| DS-7 | P1 | 清理重复的确认数字来自陈旧快照，实际删除用真值读 | `Header.tsx:129-135` vs `mutationService.ts:37` | 读失败时中止清理，不要退回快照 |
| DS-8 | P1 | 退出登录不清本地数据且零提示 | `HeaderDropdown.tsx:445` / `authSlice.ts:283-290` / `authCache.ts:77-84` | toast 说清「本机 N 个会话仍保留」 |
| DS-9 | P1 | 锁定逐条删除的拒绝文案零覆盖（守卫只匹配 `showDeleteError\(`） | `guards/lockedTabDeleteGuard.test.ts:88` / `SearchResultList.tsx:459` | 照抄 `deleteAllDisclosure.test.ts:53` 的逐字中文断言 |
| DS-10 | P1 | `p0DataSafetyGuards` 三条纯字面量守卫：改日志就红 | `p0DataSafetyGuards.test.ts:78,102,114` | 改成钉控制流/语义，不钉字符串 |
| DS-11 | P1 | 熔断守卫把实参钉死成 `mergeDropped.length` ⇒ 正确的修法被判红 | `tests/syncFailsafeGuard.test.ts:99-105` | 改成「实参必须能反映本机会话净减少」+ 加行为级测试 |
| DS-12 | P2 | 拖走最后一条标签零成功反馈 | `TabGroup.tsx:451-467` | 加一条「已移出「X」」toast |
| DS-13 | P2 | 「删除全部搜索结果」不说整组消失；关开关后一次点击删 N 条 | `SearchResultList.tsx:606-620` | 文案补「某会话若因此被清空会一并消失」 |
| DS-14 | P2 | 搜索页「全部恢复」不说明打不开的标签被永久删除（列表页说了） | `SearchResultList.tsx:565-572` vs `TabGroup.tsx:343` | 搜索页复用列表页那半句 |
| DS-15 | P2 | 导入不做覆盖：内容不同的同名会话并存成两份且无提示 | `mutationOps.ts:290-352` | 导入结果补一句说明 |
| DS-16 | P2 | 墓碑双写守卫的 fixture 与阈值自指 ⇒ 恒真 | `overwriteTombstoneDoubleWrite.test.ts:34,170,476` | 阈值与 fixture 改硬编码 |
| DS-17 | P2 | 两后端「读不出来」语义不同，同一句话含义不同 | `supabase/download.ts:436-566` vs `webdav/adapter.ts:1193-1229` | 原因文案按后端分流 |
| DS-18 | P2 | `storageFailClosed` 的 blocked 用例依赖「必须是第一个 it」 | `storageFailClosed.test.ts:146-147` | 拆独立文件或重建句柄 |
