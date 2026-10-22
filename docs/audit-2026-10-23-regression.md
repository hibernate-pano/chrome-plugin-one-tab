# 第 43 轮审计：回归审查（对抗式复核第 42 轮自己的改动）

<!-- doc-status:进行中 -->
>
> **审查范围**：`bac6ec1`（v1.26.0 第 42 轮收口）→ `23d2aab`（审计时的 HEAD）
> 及其后的 `cb6ac46`（商店文案守卫；只碰 `CHROMEWEBSTORE.md` / `RELEASE-NOTES.md` /
> 一个新守卫，**未触及本报告引用的任何源码**）。
>
> **审查对象**：第 42 轮新加的判据 / 开关 / 守卫 / 接线，
> 找「新引入的回归」与「声称已修但实际没修好」。
>
> **纪律**：只读审计（`src/` `tests/` 一个字没改）；每条结论都有 **HEAD 上的
> `file:line`** 证据；假阳性比漏报更贵 ⇒ §5 逐条写清「查了但不成立」的理由。
>
> **方法**：读 diff → 读全文件 → **把仓库复制一份做变异测试**（改一行源码，
> 看守卫会不会红）→ **用假后端写探针跑真实代码路径**。
> §6 的「守卫检测力表」与 §1 的 R-1 全部是**实测**出来的，不是推演出来的。
>
> **行号基准**：`cb6ac46`（= 本轮开始时的 HEAD）。审计期间另一个 agent 在工作树
> 上改了 `upload.ts` / `syncEngine.ts` 等文件，**行号会漂**（例如
> `upload.ts` 的 `uploadGroups` 从 702 漂到 707）。本报告全部用**纯净 HEAD** 的行号。
> 复核时请以 `git stash` 后的 HEAD 为准，或按符号名定位。

---

## 0. 结论先行

| 编号 | 级别 | 一句话结论 | 归属 |
|---|---|---|---|
| **R-1** | **P0** | 换账号后点「覆盖上传」⇒ **账号闸门把上行集清空** ⇒ 覆盖分支照样 `DELETE` 掉当前账号的**全部云端行**，然后 upsert 空集 ⇒ **云端被清空，引擎报 `success: true`** | 第 42 轮引入的回归（DS-1 收口制造的新失效模式） |
| **R-2** | **P1** | `accountScopeReconcile` 守卫**零检测力**：它盯的是「文件里出现过这个字面量」，而真过滤器所在的语句被摘掉后它照样绿 | 第 42 轮引入的回归（守卫层） |
| **R-3** | **P1** | 同一条守卫**会把正确的等价改写判红**（本仓反复踩的「守卫钉字面量」坑，第 42 轮自己写进去的） | 第 42 轮引入的回归（守卫层） |
| **R-4** | **P1** | 换账号提示**只有一个消费者**（400ms 兜底 setTimeout）⇒ 页面在 400ms 内被关掉 ⇒ 提示永远不被告知（「不许静默」的承诺不成立） | 第 42 轮引入的回归（DS-1 收口） |
| **R-5** | **P1** | `loadAccountScopeForUpload` 的兜底把「读失败」与「没有记录」混为一谈 ⇒ chrome.storage.local 读失败会**静默放行全部会话** | 第 42 轮引入的回归（DS-1 收口） |
| **R-6** | **P2** | 排序下拉在**筛选浏览 / 搜索**视图里也在，但那个视图**根本不排序** ⇒ 控件说谎 —— ✅ **已修**（第 45 轮，`87a91f5`：`SearchFilterSection` 加 `showSortControl`，结果视图不摆这个控件） | 第 42 轮引入的回归（L-10 收口） |
| **R-7** | **P2** | `uploadPerformed` 是**死字段**（判据函数里从不读它）⇒ 传什么都不影响结果，是接口噪声 | 早于第 42 轮（v1.25.1 就在），本轮顺手记 |
| **R-8** | **P1** | **仓库→线上**的接缝只给隐私政策接上了，**商店页没接** ⇒ 线上仍在宣传产品已拍板不做的「分组管理 / 自动折叠空分组」，且漏掉「自带存储」「保存即关闭」「没有数量上限」⇒ 审核员看到的是 v1.25.1 的旧文案 | 早于第 42 轮的接缝缺口（第 43 轮新守卫**只钉仓库那一侧**） |
| **R-9** | **P2** | `autoSyncDisclosure` 守卫把「读设置真值」钉成**属性访问的字面形状**（`settings.syncEnabled`）⇒ 一次语义等价的改写就让它变红 | 第 42 轮引入的回归（守卫层） |
| **R-11** | **P1** | **双栏布局下排序是假的**：分栏按「标签数均衡」贪心重排 ⇒ 屏幕上的顺序与键盘 Tab 序都**不等于**用户选的排序（**穷举 4096 种组合：DOM/键盘序 100% 不一致，逐行视觉序 ~65% 不一致**）⇒ L-10 的「排序接上了」只对单栏成立 | 第 42 轮引入的回归（L-10 收口；分栏逻辑本身早于本轮，但第 42 轮把它**升格成用户可选的四键排序**）—— ✅ **已修**（第 45 轮，`87a91f5`：不再拆列容器，排好的顺序**逐行铺**，DOM 序 = 视觉序 = 排序序） |
| **R-12** | **P1** | 第 42 轮的**空态出口（L-11）零守卫、零单测**（`grep` 全仓 0 命中）；**而且首帧必给错的那个出口** —— `AuthProvider` 读到了缓存登录态却**不 dispatch**（`AuthProvider.tsx:30-35`）⇒ 冷启动那一两秒，已登录老用户看到的是「登录 TapStack 云端」而不是「从云端恢复会话」 | 第 42 轮引入的回归（接线层无守卫 + 缓存登录态未接线）—— ✅ **已修**（第 45 轮，`87a91f5`：出口搬进纯函数 `src/core/emptyStateExits.ts` + 五层守卫；缓存登录态**立刻** dispatch 进 store） |
| **R-13** | **P2** | `round42StoreHonesty` 守卫**钉死中文/英文字面量**（「· 外观：」「保存即关闭」）⇒ 一次等价改写就红；而第 43 轮新加的 `storeListingClaimGuard`（钉不变量）没被它取代 ⇒ 两套口径并存 | 第 42 轮引入的回归（守卫层） |
| **R-10** | **P2｜非缺陷** | 第 43 轮新加的 `settingsUploadTrigger` 守卫**形状是对的**（行为层+推导层+自证层，钉不变量）；但判据的**事实来源**仍是硬编码的 action-type 白名单 ⇒ 将来改 thunk 名字会静默失效 | 第 43 轮新引入（**不是**第 42 轮的回归；记在这里以免被当成漏报） |

**撤回一条自己写错的结论**（重要，留在 §5 第一条）：审计中途我曾把 R-1 写成
「别的账号的会话 id 会在当前账号的云端凭空造出一行墓碑」。
**这是错的** —— `markCloudGroupsAsDeleted` 只对**已存在**的行做 `UPDATE`，
`upload.ts:1378-1388` 的 `.eq('user_id', userId)` 把写入范围锁死在当前账号，
它**没有 INSERT/UPSERT 路径**（`upload.ts` 里对 `tab_groups` 的写只有
`upsert`（`:306`）、`update`（`:637`/`:661`/`:1314`/`:1380`）、`delete`
（`:1065`/`:1084`/`:1416`/`:1462`/`:1525`）——**墓碑路径里没有 upsert**）。
⇒ 不可能凭空造行。真实失效路径是 R-1 现在的版本。

---

## 1. 真成立的发现

### R-1 | P0 | 换账号后点「覆盖上传」：闸门清空上行集 ⇒ 覆盖分支把当前账号的云端**整个删空**，并且报「成功」

**归属**：第 42 轮引入的回归（DS-1 的账号闸门是第 42 轮新增的
`src/core/accountScope.ts` + `upload.ts:700-702` 的闸门调用；
闸门引入前的行为见本条末尾的对照实验）

**证据链**：

1. **闸门把上行集换成「放行的那一批」**：`src/utils/supabase/upload.ts:701-702`

   ```ts
   const scoped = filterGroupsByAccount(groups, accountScope, userId);
   const uploadGroups = scoped.allowed;   // ← 被闸门挡下的会话从上行集里消失
   ```

2. **上行集一路传到 upsert**：`upload.ts:728`（`selectDirtyGroupsForUpload(uploadGroups, watermark)`）
   → `:787`（`selectRowsForUpload(candidateGroups, …)`）→ `:818`（`uploadRows`）
   → `:826`（`groupsWithUser`）→ `:868`（`uniqueGroups`）→ `:1116`（`upsertRowsInBatches(uniqueGroups)`）。

3. **但覆盖分支的 DELETE 不看上行集**：`upload.ts:1047-1066`

   ```ts
   if (overwriteCloud) {
     if (protectedCloudIds.length === 0) {
       const { error: deleteError } = await supabase
         .from('tab_groups')
         .delete()
         .eq('user_id', userId);        // ← 删掉当前账号的**全部**行
     }
   ```

   这个 DELETE 的条件只有「`user_id` 等于当前账号」，
   **与「这一轮实际上行了什么」毫无关系**。

4. **「上行集为空 ⇒ 不覆盖」的保护不存在**：`upload.ts` 全文里，
   覆盖分支之前**没有**任何「这一轮什么都不会传 ⇒ 别删」的前置检查。
   唯一近似的保护是 `syncEngine.ts:1343` 的 `skippedOverwrite = 'no-active-groups'`，
   但它的判据是 **`activeGroups.length === 0`**（`syncEngine.ts:1176`：
   `allGroups.filter(g => !g.isDeleted)`）—— **本机有任何活跃组**（哪怕全属于别的账号），
   这个保护就不触发。

**实测（假后端探针，跑的是真代码路径）**：

场景：A 登录存了 3 个会话 → 登出 → B 登录 → B 点「覆盖上传」，
B 的云端原本有 3 个 B 自己的会话（`b-1`/`b-2`/`b-3`）。

```
[探针] 认账后归属： {"g-a1":"user-probe-a","g-a2":"user-probe-a","g-a3":"user-probe-a"} owner= user-probe-b
[探针] B 云端初始行： [ 'b-1', 'b-2', 'b-3' ]
[探针] 上传结果： {"result":null,"writtenTombstoneIds":[],"blockedAccountIds":["g-a1","g-a2","g-a3"]}
[探针] B 云端剩余行： []
[探针] 云端操作序列： [ 'DELETE:b-1,b-2,b-3' ]
[探针] 本机 tab_groups 仍有： 3 个
```

**引擎那一层的回报**（第二次探针，直接调 `syncEngine.upload({overwriteCloud:true})`）：

```
[探针2] upload 结果： {"success":true}
[探针2] B 云端剩余行： []
[探针2] 云端操作： [ 'DELETE:b-1,b-2,b-3' ]
```

⇒ **云端 3 行全被删，一行都没补回来，而引擎报 `success: true`。**

**部分放行的变体**（B 自己也有 1 个会话）：

```
[探针3] upload 结果： {"success":true}
[探针3] B 云端剩余行： []
[探针3] 云端操作： [ 'DELETE:b-1,b-2' ]
```

⇒ 闸门放行的那 1 个也没写上去（`uploadRows` 为空 ⇒ `upsertRowsInBatches([])` 不发请求）。
**云端照样被清空。**

**对照实验（这是「第 42 轮引入」的证据）**：把闸门摘掉（`uploadGroups = groups`，
即模拟第 42 轮之前），同一场景：

```
[探针2] upload 结果： {"success":true}
[探针2] B 云端剩余行： [ 'g-a1', 'g-a2' ]
[探针2] 云端操作： [ 'DELETE:b-1,b-2,b-3', 'UPSERT:g-a1,g-a2' ]
```

⇒ **第 42 轮之前**：云端被**替换**成 A 的会话（这是 DS-1 本来要修的泄露），
数据还在，只是归属错了。
⇒ **第 42 轮之后**：云端被**清空**，一行不剩。
**闸门修好了「写进去」，却让「覆盖时先删」这一步的破坏性达到了最大。**
这是第 42 轮引入的**新失效模式**：修 A 制造了 B。

**失效路径（一步不漏）**：

1. 用户 A 在本机存了 3 个会话，用的是云端（Supabase）后端。
2. A 退出登录 ⇒ 归属记录记下「本机会话属于 A」（`authCache.ts:110-134`），
   **A 的 3 个会话留在本机**（数据不许丢，这是设计）。
3. 用户 B 在**同一台机器**登录 ⇒ `decideAccountBind` 判定 `account-switch`，
   把 3 个会话都认给 A，并生成一条「本机还有 3 个会话属于上一个账号」的提示
   （`accountScope.ts:303-312`）。
4. B 在设置里点「覆盖上传」（`SyncButton.tsx:42` 的 `upload.overwrite`；
   有两段式确认，用户会看到「本地 N / 云端 M」的风险文案并再点一次）。
5. `upload.ts:701-702` 的闸门把 3 个会话全挡下 ⇒ `uploadGroups = []`。
6. `upload.ts:1047-1066` 的覆盖分支执行 `DELETE tab_groups WHERE user_id = B`
   ⇒ **B 的云端全部行被删**（B 自己以前在云端存的会话也没了）。
7. `upload.ts:1116` 的 upsert 收到空集 ⇒ 什么也没写回去。
8. `syncEngine` 拿到的 `uploadRows` 为空 ⇒ `reconcileUploadCoverage` 算不出未同步
   ⇒ 返回 `success: true`（`syncEngine.ts:1595`）。

**用户看到什么**：

- 界面弹「上传成功」（`SyncButton.tsx` 的成功分支；`skippedOverwrite` 没被置位，
  所以那句「本地没有活跃会话，覆盖上传已跳过」**不会出现**）。
- 然后用户换台设备登录 B ⇒ **B 的云端是空的** ⇒ 所有会话都没了。
- 本机那 3 个 A 的会话还在（它们从来没上过 B 的云端），
  但**B 自己的云端会话**没了 —— 用户完全无从知道发生了什么。
- v1.22.0 起无回收站、删除即物理清除 ⇒ **不可逆**。

**数据是否丢**：**丢**。丢的是 **B 账号自己云端里的全部会话**（3 个）。
本机的 A 的会话没丢（本机一份），但它们也永远上不了 B 的云端（闸门挡着），
⇒ A 若想找回自己的云端副本，必须重新登录 A 并覆盖上传。

**为什么现有的守卫一个都没抓住**：

- `tests/guards/accountScopeGuard.test.ts:472-587` 的端到端守卫**只测了合并模式**
  （`uploadTabGroups([...], false)`，见 `:557-570` 的第二个参数），
  **完全没有覆盖 `overwriteCloud=true`**（实测 grep：该文件里 `overwriteCloud` 0 命中）。
- `tests/guards/accountScopeReconcile.test.ts` 全部 7 条都在管**对账口径**，
  碰不到「覆盖时先删」这一步。
- `syncEngine.ts:1343` 的 `no-active-groups` 保护**判据选错了对象**：
  它问「本机有没有活跃组」，而这里真正要问的是
  「**这一轮实际上行了几条**」—— 本机有 3 个（属于 A 的）活跃组，
  但实际上行 0 条。

**最小改法**（两处，缺一不可）：

```ts
// ① src/utils/supabase/upload.ts —— 覆盖分支的 DELETE 必须与「实际上行集」同源
if (overwriteCloud) {
  // 本轮**实际上行**的 id 集合（不是「本机有哪些」，也不是「本机活跃有几个」）。
  const willWriteIds = new Set(uploadRows.map(g => g.id));
  // 覆盖的语义是「云端镜像本机」；「本机」= 本轮真的写上去的那些。
  // 一条都写不上去 ⇒ 这次覆盖**什么都不能删**（否则 = 把云端清空）。
  if (willWriteIds.size === 0) {
    logWarn('[upload] 覆盖上传：本轮没有任何会话被放行上行，已跳过覆盖（云端保持不变）');
    return { result: null, writtenTombstoneIds: [], blockedAccountIds: scoped.blockedIds };
  }
  ...
  // DELETE 的条件从「.eq('user_id', userId)」改成「只删本轮不写的那几条」
}
```

⚠️ 注意：**只加这一处还不够**。`uploadRows` 还要受增量闸门
（`selectDirtyGroupsForUpload`，`upload.ts:733`）与认输预检
（`concededIds`，`upload.ts:823`）影响 ⇒ 「本轮实际上行集」可能是空的，
而「本机有活跃组」为真。⇒ 判据必须用**实际上行集**（`uploadRows`），
不能用「本机活跃组数」。

```ts
// ② src/services/syncEngine.ts —— 空本地保护要问对对象
//    现在问的是「本机有没有活跃组」，应该问「本轮实际上行了几条」。
//    最省事的做法：让 upload.ts 把「覆盖被跳过」如实回传，
//    syncEngine 据此置 skippedOverwrite（UI 已有这条文案，SyncButton.tsx:388）。
```

```ts
// ③ tests/guards/accountScopeGuard.test.ts —— 端到端守卫补一条覆盖模式的用例
//    断言：B 换账号后做覆盖上传 ⇒ B 的云端行一个都不能少，且
//          引擎不得报 success（要么 skippedOverwrite，要么报错）。
```

#### R-1 的**修法本身**也踩了一个坑（2026-10-23 主审复核时发现，已改口径）

修法 ① 最初写的是「让 `uploadTabGroups` 在清单为空时也返回 `blockedAccountIds`，
`pendingDeleteIds` 用它过滤」。**这一条在删除这一路上是空操作**，理由：

- `syncEngine.ts:1217`：`const activeGroups = allGroups.filter(g => !g.isDeleted)`
  ⇒ 被删的会话已经**物理移除**，压根不在上行清单里；
- `syncEngine.ts:1533` 的 `.filter(id => !blockedByAccountScope.has(id))`
  作用在 `activeIds` 上，而 `activeIds` 来自 `activeGroups`
  ⇒ **删除广播的那一批永远不会出现在 `blockedByAccountScope` 里**。

⇒ 拿上行侧的闸门去挡删除广播 ⇒ **看起来修好了、实际什么都没挡**。
⇒ **删除广播的归属判定必须直接对 `pendingDeleteIds` 做**（同一套 `resolveGroupOwner` 口径），
落点在 `src/utils/supabase/upload.ts` 的 `markCloudGroupsAsDeleted` ——
那是**全仓唯一真正写 `.eq('user_id', userId)` 的地方**（upload.ts:1342 / 1384 / 1415 / 1444 / 1458，
另有 `purgeCloudGroups` 在 1490 / 1503）。

⚠️ **两个必须钉死的细节**（否则闸门会把删除意图弄丢，而删除不可逆）：

1. **被挡下的 id 不能被清队**。`storage.clearPendingDeleteIds(confirmedBroadcastIds)`
   已是**逐条点名**语义（只移除被点名的），但 `syncEngine.ts:1456` 现在传的是整批
   `cloudDeleteIds` ⇒ 若在 upload.ts 里悄悄剔掉几条，清队会把它们**连坐抹掉**
   ⇒ 删除意图永久丢失（1.22.0 起无回收站，不可逆）。
   ⇒ 「哪几条被挡住了」必须**回传到 syncEngine**，让它只清「真的广播成功的」。
2. **归属判定必须 fail-closed**。`core/accountScope.ts:178` 的 `resolveGroupOwner`
   在「没有 `foreignOwners[id]` 且 `ownerUserId` 为 null」时**回落到 `fallbackUserId`
   （= 当前账号）** ⇒ 一台从没登录过 / 归属记录被清掉的机器，它的每一条删除意图
   都会被判成「当前账号的」⇒ 闸门放行 ⇒ **DS-43-1 复现**。
   ⇒ 删除这一路：归属记录读不出来 / 形状坏 / `ownerUserId` 为 null
   ⇒ **一律当成「不属于当前账号」挡住**。宁可不删（用户看得见「还有 N 条没同步」），
   不可删错账号（用户看不见）。

---

### R-2 | P1 | `accountScopeReconcile` 守卫零检测力：真过滤器被摘掉，它照样绿

**归属**：第 42 轮引入的回归（守卫层；第 42 轮刚写完的「接线守卫」）

**证据**：`tests/guards/accountScopeReconcile.test.ts:94-104`

```ts
test('接线：syncEngine 把被挡下的会话从「已提交」里剔出去', () => {
  const engine = read(ENGINE);
  assert.ok(/blockedAccountIds/.test(engine), ...);
  assert.ok(/blockedByAccountScope\.has\(/.test(engine), ...);
});
```

这两条断言只问「**文件里出现过这个串**」。而
`blockedByAccountScope.has(` 在 HEAD 上出现**两次**
（`src/services/syncEngine.ts:1319` 与 `:1492`）：

```
1319:          .filter(id => !blockedByAccountScope.has(id));   ← 真过滤器
1492:        .filter(id => !blockedByAccountScope.has(id))     ← 全量判定
```

⇒ 把 `:1319` 那处（**真过滤器**）摘掉，`:1492` 那处仍然命中 ⇒ 守卫照样绿。

**实测（变异测试，在仓库副本 `/tmp/r43b` 上跑的，原仓库一个字节没改）**：

| 变异 | 守卫结果 |
|---|---|
| **M1**：删掉 `:1319` 的 `.filter(id => !blockedByAccountScope.has(id))` | 主断言 3/4/5 **全绿**；只有测试 7 红 |
| **M2**：保留字面量但让过滤器失效（`.filter(id => !blockedByAccountScope.has(id) \|\| true)`） | 主断言 3/4/5 **全绿**；只有测试 7 红 |

M1/M2 的实测输出（HEAD 副本，7 条用例）：

```
ok 1 - 对账：属于别的账号的会话不计入「未同步」
ok 2 - 对账：不传 notThisAccountIds 时，被挡下的那批仍算未同步（不得偷偷放行）
ok 3 - 接线：syncEngine 把被挡下的会话从「已提交」里剔出去
ok 4 - 接线：syncEngine 把被挡下的会话告诉对账函数
ok 5 - 接线：被挡下的会话不参与「本轮是不是全量」的判断
ok 6 - 接线：被挡下的 id 一路透传到 syncEngine（适配器与门面不许吞）
not ok 7 - 自证检测力：把「从已提交里剔出去」这一步去掉，守卫必须看得见
```

⇒ **语义已经坏了（哪怕是 M2 这种「字面量还在、逻辑已死」的软性破坏），
主体断言 3/4/5 一声不响。**
唯一的报警来自测试 7（自证检测力），而它报的错是
「前提没成立：当前源码里找不到这一步（判据需要更强的信号）」——
这句话描述的是**它自己的探针失灵**，不是「接线被摘掉了」。
真实缺陷发生时，值班的人会去看别处。

**为什么这是「假绿」而不是「覆盖不全」**：第 42 轮的核心教训写在自己的
台账里（`docs/audit-2026-10-22-round42.md:358-365`）：

> 「**『判据层全绿』≠『功能被用上了』**……凡是『有个控件 + 背后有判据』的功能，
> 必须有一条**接线**守卫，而且接线守卫的判据要钉**数据流**（控件读的字段 ==
> 判据吃的那个变量），不是钉『两边都出现过这个字段』。」

**这条守卫自己就犯了这个错**：它钉的是「两边都出现过这个字段」。

**最小改法**（钉不变量，不钉字面量）：

守卫文件里**已经**有一个形状正确的纯函数（`detectsSubmittedFilter`，`:86-92`），
但它只被用在**测试 7**（自证检测力）里，**主体断言仍然用全文 grep** ⇒ 顺序反了。
把主体断言换成它，并把它从「这一段里出现过 `blockedByAccountScope`」
加强成「**这一段里有一个接在 map 之后的 filter，其谓词引用了 blocked 集合**」：

```ts
// 判据：读 `submittedGroupIds =` 到下一个 `;` 这一段，
// 断言它**真的把 blocked 的 id 排除掉了**（而不是「这一段里出现过 blockedByAccountScope」）。
function excludesBlockedFromSubmitted(source: string): boolean {
  const at = source.indexOf('submittedGroupIds =');
  if (at < 0) return false;
  const end = source.indexOf(';', at);
  const seg = source.slice(at, end < 0 ? undefined : end);
  // 「接在 map 之后的 filter」+「谓词引用了 blocked 集合」——两个都要
  return /\.map\([^)]*\)\s*\.filter\(/.test(seg) && /blocked/i.test(seg);
}
```

**更好**：做成**行为级**守卫——直接调 `syncEngine.upload()`（假后端），
断言「被挡下的 id 不在 `submittedGroupIds` 里」。
仓里已有这个形状的假后端（`tests/guards/accountScopeGuard.test.ts:381-470` 的
`installFakeCloud`），可以复用（正是 R-1 的探针用的那套）。

---

### R-3 | P1 | 同一条守卫会把**正确的等价改写**判红（本仓反复踩的坑，第 42 轮自己写进去的）

**归属**：第 42 轮引入的回归（守卫层）

**证据**：`tests/guards/accountScopeReconcile.test.ts:148-157`

```ts
const unwired = original.replace(
  /\.filter\(id => !blockedByAccountScope\.has\(id\)\)/,
  ''
);
```

这一条把「接线被摘掉」**定义成**「那个字面量表达式不见了」。
⇒ 一个**语义完全等价、只是换了写法**的实现，会被这条 replace 命中 ⇒
`detectsSubmittedFilter(unwired)` 变 false ⇒ **测试 7 变红**。

**实测（变异测试）**：把 `src/services/syncEngine.ts:1317-1319` 改成

```ts
const blockedSet = blockedByAccountScope;
submittedGroupIds = groupsForUpload
  .map(g => g.id)
  .filter(id => !blockedSet.has(id));
```

（**语义一字不差**，只是把集合取了个别名）⇒

```
not ok 7 - 自证检测力：把「从已提交里剔出去」这一步去掉，守卫必须看得见
  error: 前提没成立：当前源码里找不到这一步（判据需要更强的信号）
```

⇒ **一个正确的实现被判红。**

这条正是本仓 memory 里那条教训的第三次复发
（`stale-literal-guards-block-correct-fixes`）：守卫钉死字面量 ⇒
「守卫要钉**不变量**，不钉字面量」——而这条守卫自己的注释
（`tests/guards/sessionSortWiring.test.ts:22-26`）恰恰把这条纪律写得很清楚，
**同一次提交里两条守卫的做法互相矛盾**：

> 【为什么不钉行号 / 具体写法】接线可以换写法（换个变量名、换种 selector
> 写法），但「同一个字段、同一条数据流」不能变。判据钉在**数据流**上，
> 不钉在**长相**上。

`sessionSortWiring.test.ts` 做对了（它用 TS AST 抽出「读出来的变量」与
「喂进去的变量」，比较**标识符**而不是比较文本）⇒ **实测它能红**（见 §6）。
`accountScopeReconcile.test.ts` 用的是同一件事的**弱版本**（grep 字面量）⇒ 失守。

**最小改法**：与 R-2 同一个改法（换成行为级断言）。若坚持用文本分析，
判据必须是「**这一段里有一个接在 map 之后的 filter 且谓词引用 blocked 集合**」
——即 `detectsSubmittedFilter` 的加强版，而不是「这一段里出现过 blockedByAccountScope」。

---

### R-4 | P1 | 换账号提示只有一个消费者：页面在 400ms 内被关掉 ⇒ 提示永远不被告知

**归属**：第 42 轮引入的回归（DS-1 收口）

**证据**：

- 提示是**持久**的（存在归属记录里），设计意图明确写在
  `src/components/auth/restoreAfterLogin.ts:64-70`：

  > 【为什么提示是持久的】它存在归属记录里……而不是某个内存变量 ⇒ 用户在登录后
  > 立刻关掉弹窗、提示没来得及发出去，它也不会丢：下次还能取到（不许静默）。

- 唯一的消费者是 `deliverAccountSwitchNotice`（`:97-102`），它由
  `scheduleAccountSwitchNotice` 的 **400ms setTimeout** 驱动（`:111-115`），
  而那个 setTimeout 由 `restoreAfterLogin` 的 `finally` 安排（`:142-146`）。

- **实测（探针）**：`consumeAccountSwitchNotice` 在全仓只有 **2 处**引用，
  都在 `restoreAfterLogin.ts` 本身（`:77` 定义 + `:98` 兜底通道内部调用）。
  `LoginForm.tsx` / `RegisterForm.tsx` / `AuthProvider.tsx` / `authSlice.ts` /
  `MainApp.tsx` **一处都没有**。
  `pendingNotice` 的写入方只有 `authSlice.ts:124`（认账时），
  读取方只有 `restoreAfterLogin.ts:80-82`。
  ⇒ **写有、读只在 400ms 兜底里。**

**失效路径**：

1. 用户 B 登录（换账号）⇒ `bindLocalSessionsToAccount` 写入 `pendingNotice`
   （`authSlice.ts:122-125`）。
2. `restoreAfterLogin` 的 `finally` 安排 400ms 后的兜底发出（`:146`）。
3. **用户在这 400ms 内关掉了管理页标签**（或页面被回收）⇒ `setTimeout` 不跑
   ⇒ 提示**留在存储里**（这一半符合设计：持久、不丢）。
4. 用户下次打开页面 ⇒ **没有任何代码去取这条持久提示** ——
   `restoreAfterLogin` 只在「登录之后」才跑，而用户已经登录过了 ⇒
   **这条提示永远不会被告知。**

**用户看到什么**：**什么都没有**。用户不知道本机还留着上一个账号的会话
（会话却仍然在列表里，看得见、点得动、还能删——见 R-1）。
「不许静默」这条承诺在**最常见的路径**上不成立。

**数据是否丢**：不丢。但「零提示的跨账号残留」正是 DS-1 缺陷的核心形状之一
（台账原文：「把 A 的私有数据写进 B 的账号行 —— 整个过程零提示」）。

**最小改法**：

- **必要**：在**页面挂载时**也消费一次持久提示（`AuthProvider` 的初始化 effect 里
  调 `consumeAccountSwitchNotice()`，有就 `errorHandler.handle(notice.text, ...)`）。
  这是「持久提示」的完整闭环：**谁写谁读 + 每次启动兜底读一次**。
- **顺带**：`LoginForm` 那个「并进自己文案」的接口（`restoreAfterLogin.ts:72-74`
  的注释）至今**没有任何调用方**——要么接上（`LoginForm.tsx:72-78` 的 `.then` 里
  消费并并进「已从云端恢复 N 个会话」那句），要么把注释改成实情
  （现在是「给界面用的接口」但没人用）。

---

### R-5 | P1 | `loadAccountScopeForUpload` 把「读失败」与「没有记录」混为一谈 ⇒ 静默放行全部会话

**归属**：第 42 轮引入的回归（DS-1 收口，`3d4369f`）

**证据**：

`src/utils/supabase/upload.ts:514-533`

```ts
async function loadAccountScopeForUpload(currentUserId: string): Promise<AccountScopeRecord> {
  const record = await accountScopeStore.read();
  if (record) return record;

  const lastUserId = await readLastAuthCacheUserId();
  const ownerUserId = lastUserId ?? currentUserId;   // ← 兜底认账给当前账号
  ...
}
```

而 `readLastAuthCacheUserId`（`src/utils/authCache.ts:45-54`）**读失败返回 null**
（catch 里 `logError` 然后 `return null`），不抛。

**这个函数的文档注释自己写着相反的契约**（`src/utils/authCache.ts:43-44`）：

> 读失败返回 null（**调用方据此中止上传，fail-closed**）。

⇒ **调用方并没有「据此中止」，而是「据此放行全部会话」。**
契约与实现相反，且**这个契约是第 42 轮自己写的**（`bac6ec1` 引入该注释）。

⇒ 于是有**两条不同的路径**落到同一个 `ownerUserId = currentUserId`：

| 真实情况 | 期望 | 实际 |
|---|---|---|
| 这台机器**从没登录过**（真的无主） | 归当前账号（可接受） | 归当前账号 ✓ |
| `chrome.storage.local` **读失败**（存储坏了 / 配额 / 权限） | **中止上传**（fail-closed） | 归当前账号 ⇒ **放行全部会话** ✗ |

**这个文件自己写着相反的纪律**（`src/utils/supabase/upload.ts:510-512`）：

> 【读失败（抛错）不在兜底之列】形状损坏的记录读出来是「读不出来」，
> 不是「没有归属」—— 与 storage.getGroups 的 fail-closed 纪律一致：
> 读不出来就中止上传，绝不把它当成「没有归属」而放行全部会话。

**「形状损坏」这条被守住了**（`normalizeAccountScope` 抛错 ⇒ `accountScopeStore.read()`
抛 ⇒ `loadAccountScopeForUpload` 抛出 ⇒ 上传中止）。
**但「读不出来（I/O 失败）」这条没守住** —— `readLastAuthCacheUserId` 把它吞成了 null。

**失效路径**：`chrome.storage.local` 读失败（一次瞬时故障就够）⇒ 登录缓存读成 null ⇒
归属记录被判成「不存在」⇒ 认账给当前账号 ⇒ **本机全部会话（含上一个账号的）
被写进当前账号的云端** ⇒ **DS-1 原样复发**，而且日志里只有一行 warn。

**用户看到什么**：无提示（本仓的纪律是「跨账号泄露零提示」）；会话已经在 B 的云端里了。

**数据是否丢**：不丢，但**跨账号泄露**（比丢数据更严重）。

**最小改法**：把「读失败」与「没有记录」分成两条路。

```ts
// src/utils/authCache.ts —— 让读失败可辨（别再吞成 null）
export async function readLastAuthCacheUserId(): Promise<string | null> {
  try { ... } catch (error) {
    logError('读取登录缓存里的账号 id 失败:', error);
    throw new Error('读取登录缓存失败');   // ← 读失败必须抛（fail-closed）
  }
}
```

调用方 `loadAccountScopeForUpload` 里区分：
`accountScopeStore.read()` 返回 `null` = 「键不存在」（可兜底）；
抛错 = 「读不出来」（**中止上传**）。`readLastAuthCacheUserId` 同理。

⚠️ 注意：`captureLocalSessionOwner`（`src/utils/authCache.ts:110-134`）也调它。
那里 catch 住并只记日志是对的（退出登录不该被一个读取失败卡住）——
但**方向相反的后果要写清楚**：记不住归属 ⇒ 闸门更保守（挡住更多），**不是更宽松**。
这一条现在因为 `readLastAuthCacheUserId` 不抛而**不会发生**（它拿到 null ⇒ 直接 return，
归属记录根本没写）⇒ 反而是**更宽松**的一侧。⇒ 修 `readLastAuthCacheUserId` 时，
`captureLocalSessionOwner` 要显式区分「读失败 ⇒ 记不住归属（保守方向不对！）」与
「真的没有登录缓存」。

> **关于「记录不存在 ⇒ 认账给当前账号」这条本身**：台账
> （`docs/audit-2026-10-22-round42.md:330-336`）已经把它列为**已知边界**，
> 并说明「这个窗口极窄，但它**不是零**」。**本条不是新发现那个窗口**，
> 而是说：**R-5 把这个已知窗口的触发条件从「从没有登录缓存」扩大到了
> 「登录缓存读不出来」**——后者的发生概率高得多（存储故障比「从没用过这个产品」常见）。
> 所以它**属于本轮引入**，且方向是**放宽**。

---

### R-6 | P2 | 排序下拉在筛选浏览 / 搜索视图里也在，但那个视图根本不排序 ⇒ 控件说谎

**归属**：第 42 轮引入的回归（L-10 收口）

**证据**：

- 排序控件挂在 `SearchFilterSection` 上，而 `SearchFilterSection` 有**两个**渲染点：
  - `src/components/tabs/TabList.tsx:521`（主列表视图）
  - `src/components/search/SearchResultList.tsx:809`（搜索结果 / 筛选浏览视图）
- 排序**只**在主列表侧生效：`src/components/tabs/TabList.tsx:359`
  `const sortedGroups = sortSessions(groups, sessionSort);`
- `SearchResultList.tsx` 里**没有** `sortSessions`、没有 `sessionSort`
  （实测 grep：**0 命中**）。它的顺序由 `buildSessionSearchResults` 决定
  ——按**相关度**分、同分按 `updatedAt` 倒序（`src/utils/search.ts:327-333`）。
- 排序控件在 `SearchFilterSection` 里的两个位置：
  `src/components/search/SearchFilterPanel.tsx:594`（工具条）与 `:618-620`（面板内）。

**失效路径**：

1. 用户在搜索框里输入关键词（或只用了筛选条件）⇒ 进入结果视图。
2. 结果视图的筛选区里**也有**那个「排序」下拉。
3. 用户把排序改成「名称」⇒ **列表顺序一动不动**（结果视图按相关度排）。
4. 用户改回「最近保存」⇒ 还是不动。

**用户看到什么**：一个「能选、选了没反应」的控件 —— 与 L-10 修复前
「判据层全绿、列表侧没接线」**完全同型**，只是换了个视图。

**数据是否丢**：不丢。

**为什么台账没提**：台账（`docs/audit-2026-10-22-round42.md:351-353` 附近）
明确写了「**为什么不改搜索结果视图**：搜索的主序是**相关度**，那是搜索的承诺；
把排序套到搜索结果上会让『已按相关度排序』变成假话。」
⇒ **判据层做对了**（不把排序套到搜索结果上是对的）。
**错的是控件的可见范围**：既然那个视图不排序，就不该在那个视图里摆排序下拉。

⚠️ 注意「筛选浏览」视图（无搜索词、有筛选条件）与「搜索」视图是**两个不同的东西**：
浏览视图没有相关度可言（`src/components/search/searchBrowseMode.ts:120-121`：
「全部同分（0），随后由 `buildSessionSearchResults` 按会话更新时间倒序收敛」）
⇒ **浏览视图本来是可以接排序的**（它是个列表，不是相关度排序）。
⇒ 但它现在既没接排序、又摆了排序下拉 ⇒ 同一个控件在两个视图里都是死的。

**最小改法**（二选一）：

- **A（推荐，最小）**：`SearchFilterSection` 收一个 `showSortControl` prop，
  `SearchResultList` 那个渲染点传 `false` ⇒ 结果视图里不摆排序下拉。
  代价：用户在看结果时改不了排序（但那里排序本来就不生效）。
- **B**：把排序接进 `SearchResultList`（浏览视图接、搜索视图不接）——
  改动大，且要重新论证「浏览视图按什么排」。

---

### R-7 | P2 | `uploadPerformed` 是死字段

**归属**：早于第 42 轮（`078ce5e` v1.25.1 就在），本轮顺手记

**证据**：`src/core/uploadCoverage.ts:57` 声明了 `uploadPerformed: boolean`，
但 `reconcileUploadCoverage` 的函数体（`:170-199`）**从不读它**。
调用方 `src/services/syncEngine.ts:1524` 传的是
`uploadPerformed: submittedGroupIds.length > 0`。
另有 6 个测试在传它（`tests/registryUnreliableReset.test.ts`、
`tests/backendParityDefects.test.ts`、`tests/guards/accountScopeReconcile.test.ts`）。

⇒ 传 `true` 还是 `false`，结果**完全一样**。

**为什么值得记**：这是一个**看起来像判据、实际不是**的字段——
正是本仓 `noPhantomMechanisms` 守卫要防的那一类（「有设置、有参数、无读取方」）。
它现在的处境比 `computeVisibleChunks` 轻（没有注释在给它背书），
但**接口上它是一个诱人的假开关**：下一个人看到 `uploadPerformed: false`
会以为「这轮没上传」有特殊含义。

**最小改法**：删掉这个字段（连同调用点与 6 个测试的传参），或者真的用它
（例如：`uploadPerformed === false && registeredIds.length > 0` 时明确报「本轮没有提交任何东西」）。

---

### R-8 | P1 | 仓库→线上的接缝只给隐私政策接上了，**商店页没接** ⇒ 线上仍在宣传产品已拍板不做的功能

**归属**：早于第 42 轮的接缝缺口（第 43 轮新加的 `storeListingClaimGuard`
**只钉仓库那一侧**，没有把接缝接到线上）

**证据：同一个仓库里，两条「线上」资产，接缝待遇完全不同。**

| 线上资产 | 线上 URL | 有没有守卫/脚本核对线上？ |
|---|---|---|
| 隐私政策 | `https://tapstack-two.vercel.app/privacy.html` | **有** —— `tests/guards/privacyPolicyCoversManifest.test.ts:190-257`（三态：ok / notFound / offline；notFound ⇒ **判红**） |
| **商店页** | `https://chromewebstore.google.com/detail/tapstack/bbbpnccbclnnphchghpfmcjjfhigepbk` | **没有** —— 实测 `grep -rc "chromewebstore.google.com" tests/ scripts/` ⇒ **0 命中** |

**实测线上现状（2026-10-23，`curl` 公开页，HTTP 200）**：

```
线上版本: 1.25.1          仓库版本: 1.26.0（manifest.json:4）
线上更新日期: October 20, 2026

  分组管理         出现 2 次
  自动折叠         出现 2 次
  数据仅在         出现 2 次
  自带存储         出现 0 次   ← 漏
  WebDAV           出现 0 次   ← 漏
  保存即关闭         出现 0 次   ← 漏
  数量上限         出现 0 次   ← 漏
```

线上原文（抓到的片段）：

> - 分组管理：拖拽整理标签页，自动折叠空分组
> - 数据仅在你授权的云端存储（Supabase），支持随时删除，本地与云端双重保障。

而仓库 `CHROMEWEBSTORE.md` 里这几条**都已经改对了**：
`:38`「保存即关闭」、`:43`「把窗口腾空」、`:56`「**没有数量上限**」、
`:58`「**自带存储**…（不经过我们的服务器）」、`:60`「开启同步后，数据只会传输到你自己选择的云端」。

**失效路径**：

1. 仓库改对了文案 ⇒ `storeListingClaimGuard` 全绿（它只读 `CHROMEWEBSTORE.md`）。
2. 线上那一侧**没有任何自动核对** ⇒ 漂移不会变红。
3. 用户在商店页看到的是 **v1.25.1 的旧文案**：
   - 宣传**产品已拍板「暂缓、明确不做」**的「分组管理 / 自动折叠空分组」
     （第 43 轮的产品总监审计已把这一条列为减法项）；
   - 说「数据仅在你授权的云端存储（Supabase）」⇒ **漏掉了「自带存储（WebDAV）」这个后端**
     ⇒ 对只用自带存储的用户，这句话是**错的**（他们的数据根本不经过 Supabase）；
   - 完全没提「保存即关闭」—— 这是产品最核心的差异化，线上读起来像个普通标签备份器。
4. 审核员按线上文案核对产品 ⇒ 三处对不上。

**数据是否丢**：不丢。但这是**对外发布的失实陈述**，
且第 43 轮刚加的 `storeListingClaimGuard` 在文件头**自己承认**了这个边界
（`tests/guards/storeListingClaimGuard.test.ts:28-31`）：

> ❌ 不能做：验证**线上**那份。线上是 Google 商店的内容，本仓没有它的写权限，
> 抓取也不是可靠的判据（页面是动态渲染的，版本状态会自己变）。
> ⇒ 线上漂移只能靠**人**定期抓公开页核对

⇒ 这条边界**是诚实的**，但它意味着：**光有 `storeListingClaimGuard` 是不够的**，
线上那一侧仍然**完全裸奔**。而同一仓里隐私政策**已经证明这条路走得通**
（那个守卫的形状可以直接复用）。

**最小改法**（把隐私政策那条守卫的形状搬过来）：

```ts
// tests/guards/storeListingLiveMatchesRepo.test.ts（新文件）
const LIVE_STORE = 'https://chromewebstore.google.com/detail/tapstack/bbbpnccbclnnphchghpfmcjjfhigepbk';

// 与 privacyPolicyCoversManifest.test.ts 同一个三态判据：
//   ok       —— 拿到了，继续逐条核对
//   notFound —— 服务器明确回答「没有」⇒ 判红
//   offline  —— 真连不上 ⇒ t.skip（环境问题，不是事故）
//
// 核对项（每条都要有仓库那一侧作为事实来源，不能钉中文原句）：
//   ① 线上不得出现「分组管理 / 自动折叠」—— 除非 TabGroup 类型上真有分组字段
//      （判据来源可以复用 storeListingClaimGuard 的 productHasFolderConcept）；
//   ② 线上必须提到每一个后端（Supabase + WebDAV）—— 后端种类从代码里现场数；
//   ③ 线上必须提到「保存即关闭」—— 从仓库那份里取关键词，而不是钉一句中文；
//   ④ 线上版本号必须 >= manifest.json 的当前版本。
```

⚠️ **一条纪律**：这个守卫**不许钉具体的中文句子**（否则改措辞就红），
且**必须**先把「线上那份」按仓库那份**现场解析**出来的要点核对，
而不是把仓库的整段文案塞进线上（那是复制粘贴式的假接缝）。

⚠️ 另：这个守卫的「线上抓取」**不能**成为 CI 的阻塞项
（商店页是动态渲染 + 可能被风控限流）⇒ 用 `t.skip` 处理 offline，
并且把「线上版本落后」**判红**（那是真事故），把「抓不到」**跳过**（那是环境）。

---

### R-9 | P2 | `autoSyncDisclosure` 守卫把「读设置真值」钉成属性访问的字面形状

**归属**：第 42 轮引入的回归（守卫层；`bac6ec1` 新增该守卫）

**证据**：`tests/guards/autoSyncDisclosure.test.ts:67-74`

```ts
it('状态行读的是**设置里的真值**，不是写死的文案', () => {
  assert.match(
    DROPDOWN,
    /syncEnabled:\s*settings\.syncEnabled/,
    '状态行必须读真实设置，否则用户改了开关看到的还是旧文案'
  );
});
```

**实测（变异测试，仓库副本 `/tmp/r43c`）**：

| 变异 | 守卫结果 |
|---|---|
| **语义破坏**：`syncEnabled: settings.syncEnabled` → `syncEnabled: true`（写死） | **变红** ✓ 判据有效 |
| **等价改写**：`settings.syncEnabled` → `settings['syncEnabled']`（索引访问，语义一字不差） | **变红** ✗ 把正确实现判红 |
| **等价改写**：`settings.syncEnabled` → `settings.(syncEnabled)`（加括号） | **变红** ✗ 把正确实现判红 |

⇒ 这条守卫**能抓住真缺陷**，但**抓法是钉字面量**：它要求「读设置」这件事
必须写成 `settings.syncEnabled` **这个形状**。
下一次有人把状态行改成解构（`const { syncEnabled } = settings`）、
或用中间变量（`const s = settings; s.syncEnabled`）——
**语义完全正确，守卫却会红。**

这正是本仓反复踩的坑（memory：`stale-literal-guards-block-correct-fixes`），
也是第 42 轮元教训 2 的第四次复发。

**最小改法**（钉不变量，不钉字面量）：

判据要问的是「**这个 `syncEnabled` 的值是不是来自 `settings`**，而不是
「是不是写成 `settings.syncEnabled`」。

```ts
// 判据：状态行拿到的 syncEnabled 必须**来自 settings 对象**，
// 而不是常量 —— 但**不关心**它是怎么取的（属性访问 / 解构 / 中间变量）。
const fn = extractFunction(DROPDOWN, 'autoPullStatusView');
assert.ok(fn, '应能找到状态行构造');
assert.ok(
  /syncEnabled\s*:\s*[^,\n]*settings/.test(fn) ||
  /syncEnabled\s*:\s*\w+\.syncEnabled/.test(fn),
  '状态行必须读真实设置（settings 的 syncEnabled），不能写死'
);
```

⚠️ 更稳的做法（与 `sessionSortWiring` 同款）：**把「值」抽出来比对**，
而不是比对「取值的语法」——
即断言「喂给 `autoPullStatusView` 的那个 `syncEnabled`，
**恒等于** `settings.syncEnabled` 的值」，用 AST 抽标识符（像 `sessionSortWiring` 那样），
这样换任何写法都绿、换成常量就红。

---

### R-10 | P2 | 第 43 轮新加的 `settingsUploadTrigger` 守卫形状正确，但**判据的「事实来源」仍是硬编码的白名单**

**归属**：第 43 轮新引入（工作树，`src/core/settingsUploadTrigger.ts` + `tests/guards/settingsUploadTrigger.test.ts`）

**说明**：这一条**不是缺陷**，是**给下一轮的提醒**（记在此处以免被当成漏报）。

该守卫的形状是**对的**：
- L1 行为层：真 store + 真中间件 + 真 thunk ⇒ 变异敏感（把中间件改回前缀匹配就红）；
- L2 推导层：**解析 `settingsSlice.ts`**，自己推出「哪些 action 真的写了盘」，
  再断言判据覆盖写类、排除读类；
- L3 自证层：同一个检查器对「前缀匹配」判据必须报错 ⇒ 证明 L2 不是空转。

这比 `accountScopeReconcile`（R-2/R-3）高了一个层次 ——
它钉的是**不变量**（覆盖写类、排除读类），不是字面量。

⚠️ **但有一个残留缺口**：`SETTINGS_UPLOAD_TRIGGER_ACTION_TYPES`
（`src/core/settingsUploadTrigger.ts:57-60`）**本身仍然是一份硬编码的字符串白名单**：

```ts
export const SETTINGS_UPLOAD_TRIGGER_ACTION_TYPES: readonly string[] = [
  'settings/saveSettings/fulfilled',
];
```

L2 守卫会保证「**将来新增**写类 thunk 时这里要跟着改」，
但它**不能**保证「**现在**这一条就是对的」——
如果 `settingsSlice.saveSettings` 改了名字（比如改成 `persistSettings`），
白名单里的旧字符串会**静默失效**（`includes()` 匹配不到任何 action
⇒ 永远不排上传 ⇒ 设置改了**再也不上云**，且**零提示**）。

⇒ **建议**：白名单里的 action type 应当**从 `settingsSlice.ts` 现场推导**
（与 L2 守卫同一套解析器），而不是手写字符串。
这一条**现在还没坏**（名字对得上），属于「下一个改名的人会踩」的雷。

---

### R-11 | P1 | 双栏布局下「排序」是假的：屏幕顺序与键盘 Tab 序都不等于用户选的排序

**归属**：第 42 轮引入的回归（L-10 收口）。
**分栏逻辑本身早于本轮**（`git blame`：`TabList.tsx:534-542` 来自 `a31cb5f`，2026-10-14），
但**第 42 轮把它从「一个写死的顺序」升级成「用户可选的四键排序」**，
于是「用户能选排序」这个承诺第一次有了「可能选了不起作用」的形状。

**证据链**：

1. **排序在 `TabList.tsx:359` 真的接上了**（这一条第 42 轮做对了）：
   ```ts
   const sortedGroups = sortSessions(groups, sessionSort);
   const filteredGroups = sortedGroups;
   ```
2. **但双栏渲染把 `filteredGroups` 重新分了一次**（`src/components/tabs/TabList.tsx:531-542`）：
   ```ts
   ) : layoutMode === 'double' ? (
     <div className="session-grid">
       {(() => {
         // 按标签数均衡分栏：贪心把下一组放进当前标签总数更少的一栏，
         // 避免“前半进左栏”时高卡全堆一侧的高低脚。读序仍按保存时间倒序。   ← 这句话现在是假的
         const columns: typeof filteredGroups[] = [[], []];
         const counts = [0, 0];
         for (const group of filteredGroups) {
           const target = counts[0] <= counts[1] ? 0 : 1;
           columns[target].push(group);
           counts[target] += group.tabs.length;
         }
         return columns.map((column, columnIndex) => (
           <div key={columnIndex} className="session-grid-column ...">
   ```
   ⇒ **分栏的判据是「标签数」，与用户选的排序键完全无关。**
3. **DOM 顺序 = 左栏全部，再右栏全部**（`:543-548`：`columns.map` 渲染两个
   `.session-grid-column`，每个 column 内部竖排）。CSS `src/styles/global.css:1697-1721`
   证实：`.session-grid` 是 `grid-template-columns: repeat(2, ...)`，
   两个 column 各自 `display:flex; flex-direction:column`。
   ⇒ **键盘 Tab 序 = 左栏从上到下，然后右栏从上到下**（不是逐行）。

**实测（探针跑真 `sortSessions` + 从 `TabList.tsx` **逐字抽出**那段分列代码）**：

最小复现（6 个会话 A–F，标签数 3,1,3,1,3,1，选「名称」升序）：

```
排序结果      : A → B → C → D → E → F
左栏 / 右栏  : A(3) D(1) E(3)  |  B(1) C(3) F(1)
视觉逐行读序 : A → B → D → C → E → F   ✘ 与排序不符
DOM/键盘 Tab序: A → D → E → B → C → F   ✘ 与排序不符
```

随机样本先给出方向（400 组 × 4 个排序键，视觉逐行序不一致率 >70%、
DOM 序不一致率 >97%），但**随机样本不是结论** —— 下面换成**穷举**。

**穷举（这是结论）**：6 个会话 × 每个会话标签数取 {1,2,3,4}
⇒ **4096 种组合全部枚举**（`sortSessions` 用的是 HEAD 里的真函数，
分列代码是从 `TabList.tsx` **逐字抽出**的，不是重写的）：

| 排序键 | DOM/键盘序 ≠ 排序序 | 逐行视觉序 ≠ 排序序 |
|---|---|---|
| `saved` | **4096/4096 = 100%** | 2816/4096 = 68.8% |
| `accessed` | **4096/4096 = 100%** | 2816/4096 = 68.8% |
| `name` | **4096/4096 = 100%** | 2656/4096 = 64.8% |
| `size` | **4096/4096 = 100%** | 2816/4096 = 68.8% |

⇒ **键盘 Tab 序与用户选的排序：在 6 个会话的规模下，100% 不一致**
（因为分栏至少要把第 2 个会话挪到右栏，DOM 序必然变）。
视觉逐行序也有 **~2/3** 的组合不一致。
**会话更多时，逐行视觉序的不一致率还会更高**（分栏越不均衡，插入位置越乱）。

**失效路径**：

1. 用户在 ⋯ 菜单点「切换为双栏布局」（`HeaderDropdown.tsx:941`）。
2. 用户把排序改成「名称」⇒ 单栏下顺序立刻变（这一半是真的）。
3. **切到双栏 ⇒ 顺序变了，但不是按名称排的** —— 它按「标签数」重新分了两栏，
   而分栏键与排序键无关。
4. 用户以为「排序坏了」⇒ 或者回单栏（于是排序「时好时坏」，
   取决于布局模式这个**与排序毫无关系**的设置），或者不再信任这个功能。

**为什么第 42 轮的守卫与真机脚本都没抓到**：

- `tests/guards/sessionSortWiring.test.ts` 钉的是「列表喂给 `sortSessions` 的
  变量 == 从 store 读出来的那个变量」—— **接线是通的**，它没义务管渲染层怎么摆。
- `scripts/lead-verify-sort.mjs` 是**真机脚本**，但它**只跑单栏**：
  脚本里 `layoutMode` 一个字都没出现（实测 grep **0 命中**），
  它读的是 `document.querySelectorAll('h3[id^="tab-group-title-"]')` 的
  **DOM 顺序**（`:81-88`）。
  ⚠️ 而 DOM 顺序在双栏下**恰恰是 100% 出错的那一半**（见上面的穷举表）——
  所以这个脚本**只要开一次双栏就会立刻报红**；它没开 ⇒ 它测的是单栏，
  测的恰好是**唯一没坏**的那条路径。

**数据是否丢**：不丢。但这是**「控件说谎」的又一例**
（R-6：搜索/浏览视图里的排序下拉；第 42 轮自己修掉的那次：判据层全绿、列表侧没接线）。
第 42 轮的台账把它记成
「守卫也全绿（39 条），但列表侧根本没接线 ⇒ 现在补了接线守卫」
（`docs/audit-2026-10-22-round42.md:264`、`:359`），
**接线这一半确实补上了**（`sessionSortWiring` 是本仓最完整的一条接线守卫），
**但没有一条断言管「排序在双栏下是否兑现」**
⇒ 同一个功能，**接线守卫有，兑现守卫没有**。

**最小改法**（三选一，**推荐 A**）：

- **A（推荐，最小）**：分栏**必须尊重排序**。
  「按标签数均衡」这个诉求（避免高低脚）与「用户选的顺序」是冲突的，
  而**用户的显式选择优先级更高**。
  ⇒ 分栏改成「**按排序后的顺序轮转填栏**」（第 1、3、5…进左栏，第 2、4、6…进右栏），
  这样 DOM 序 = 逐行视觉序 = 排序序，三者一致；高低脚的问题另说
  （可以让**高度**去均衡，而不是让**顺序**去均衡）。
- **B**：双栏下**不摆排序控件**（与 R-6 同一个修法：`SearchFilterSection`
  收 `showSortControl` prop，双栏传 `false`）⇒ 控件不说谎，
  但用户在双栏下就没有排序能力。
- **C**：保留现状，但在排序键 ≠ `'saved'` 时**明确提示**「双栏布局下顺序按卡片高度排列」。
  —— 这是**最差**的一档：把缺陷写进文案，等于承认功能半残。

⚠️ **无论选哪个，都要补一条守卫**（钉不变量，不钉字面量）：
「**双栏渲染后的会话顺序 == `sortSessions` 的结果**」——
判据应当是「把排好序的数组喂给分列函数，得到的**逐行视觉序**与**DOM 序**
都必须等于输入顺序」，而不是「分列代码长什么样」。

---

### R-12 | P1 | 第 42 轮的空态出口（L-11）零守卫、零单测：四个按钮点了会发生什么，全靠人读源码

**归属**：第 42 轮引入的回归（接线层无守卫）

**证据**：

1. L-11 新增了四个空态次级出口（`src/components/tabs/emptyStateActions.ts:50-63`）：
   ```ts
   export function resolveEmptyStateActions(input: EmptyStateActionsInput): EmptyStateAction[] {
     if (input.syncBackend === 'webdav') {
       return ['options', 'import'];
     }
     return input.isAuthenticated ? ['download', 'import'] : ['login', 'import'];
   }
   ```
   渲染在 `src/components/tabs/TabList.tsx:430-446`，点击分发在 `:173-194`。
2. **全仓没有任何一条断言提到它**（实测）：
   ```
   grep -rn "resolveEmptyStateActions\|emptyStateActions\|requestImport\|onImportRequest\|EMPTY_STATE_ACTION" tests/ scripts/
   ⇒ 0 命中
   ```
   ⇒ `resolveEmptyStateActions` 这个**纯函数**（本仓最擅长测的东西）**零测试**。
3. 而它是**直接决定用户看到什么**的判据：
   - `syncBackend === 'webdav'` ⇒ 给「打开设置」+「导入数据」（不给「登录」——
     WebDAV 用户没有 TapStack 账号，给「登录」是骗人）；
   - 云端未登录 ⇒ 给「登录 TapStack 云端」+「导入数据」；
   - 云端已登录 ⇒ 给「从云端恢复会话」+「导入数据」。
   **这三条分支对应三种完全不同的用户处境**，而一条断言都没有。

**失效路径（真会发生的，不是理论上的）**：

`isAuthenticated` 来自 `state.auth.isAuthenticated`（`TabList.tsx:55`），
而 `authSlice` 的**初值就是 `false`**（`src/store/slices/authSlice.ts:82`），
**只有 `getCurrentUser.fulfilled`（`:361-364`）或 `setFromCache`（`:287-291`）
才会把它置真**。

`AuthProvider` 的注入路径是**纯网络**的：
`AuthProvider.tsx:57` `await supabaseAuth.getSession()`
→ 有会话才 `dispatch(getCurrentUser())`（`:62`）
→ thunk 内部**又**发一次 `getSession()` + `getCurrentUser()`（`authSlice.ts:238/248`）
→ `fulfilled` 才置 `isAuthenticated = true`（`:363`）。

⚠️ **关键点**：`AuthProvider.tsx:30-35` 确实读了 `authCache.getAuthState()`，
但那一段**只打了一行日志**（`:33`），注释写得很清楚
「**这里可以设置用户状态，但不直接 dispatch**」（`:34`）
⇒ **缓存里明明有登录态，Redux 却仍是 `false`**。

⇒ 于是这条时间线成立：

| 时刻 | 界面上 | 用户看到 |
|---|---|---|
| t0 首帧 | `isAuthenticated=false`、`groups=[]`、`isLoading=false` | **空态卡 + 「登录 TapStack 云端」** |
| t0+ε | `RUN_MIGRATIONS` 回包 → `dispatch(loadGroups())`（`TabList.tsx:223/226`）→ `isLoading=true` | 整页 spinner（`TabList.tsx:297`） |
| t1 网络回包 | `getCurrentUser.fulfilled` → `isAuthenticated=true` | **若云端确实没会话 ⇒ 回到空态**，这次是「从云端恢复会话」 |

⇒ **已登录的老用户打开管理页的那一两秒里，空态先显示「登录 TapStack 云端」**
（而不是「从云端恢复会话」）。而这正是 L-11 这条修复**最想服务的用户**
（换设备的老用户 —— 他的会话在云端，本机是空的）。

**实测**（真渲染一遍 `TabList`，服务端渲染 harness，同
`tests/guards/blankSearchQueryKeepsEmptyState.test.ts` 那一套）：

```
--- isAuthenticated=false ---        --- isAuthenticated=true ---
  登录 TapStack 云端 : true            登录 TapStack 云端 : false
  从云端恢复会话     : false           从云端恢复会话     : true
  导入数据           : true            导入数据           : true
```

⇒ 机制本身是对的（`isAuthenticated` 一变，出口就换）。
**但守卫是 0 条**（上面第 2 条）⇒ 这个"对"没有任何东西保护它。

更糟的一层：这一格**没有守卫** ⇒ 下一个人把 `resolveEmptyStateActions`
的参数从 `isAuthenticated` 换成别的（比如 `user != null`），**测试全绿**、
界面上「登录」按钮**对已登录用户也出现**（点了弹登录框）
或者**「从云端恢复会话」按钮消失**（换设备的老用户在空态里彻底没有出路），
**没有任何东西会变红**。

⚠️ 而且这不只是「守卫缺失」，它还暴露了一个**真实的时序缺陷**：
`AuthProvider` 手上有缓存登录态却不用 ⇒ 空态出口在冷启动期间**必然先显示错的那一个**。
这一条**即使补了守卫也还在**（守卫只会把它钉住，不会让它消失）——
⇒ **修法应当分两层**：
  - **行为层**：`AuthProvider` 读到的缓存登录态**应当直接 `dispatch(setFromCache(...))`**
    （`authSlice.ts:287-291` 已有这个 action，`backgroundSync.ts:641-643` /
    `syncEngine.ts:1665` 都在用它 ⇒ 现成的路径），这样首帧就是对的；
  - **判据层**：补守卫把「已登录 ⇒ 空态给「从云端恢复会话」」钉住。

⚠️ **与工作树上另一处改动不冲突**（避免重复劳动 / 误判已修）：
审计期间工作树上的 `src/components/app/AuthProvider.tsx` 已经有一处
`dispatch(setFromCache(...))`（在 `.catch()` 分支里），
但它的触发条件是 **`isBackendUnavailableError(err)`**（云端项目 402 被封禁）
⇒ **只覆盖「服务端不可用」这一条错误路径**。
**正常冷启动路径（服务端正常、会话有效）里，缓存登录态依然只被读、不被 dispatch**
（`AuthProvider.tsx:30-35` 的原样保留）
⇒ **R-12 的这条时序缺陷在工作树上仍然成立**，
而且**判据层（零守卫）那边完全没人碰**。

⇒ 这是第 42 轮元教训 1（「判据层全绿 ≠ 功能被用上了」）的**第四个实例**，
也是最严重的一个：这次连**判据层**都没有。

**最小改法**（照抄本仓已有的正确形状）：

```ts
// tests/guards/emptyStateExits.test.ts（新文件）
// ① 纯函数层（三种后端 × 登录态 ⇒ 四种出口组合）
//    —— 直接 import resolveEmptyStateActions，断言**集合**而不是文案：
//    webdav ⇒ 不含 'login'（WebDAV 用户没有 TapStack 账号，给「登录」是骗人）
//    supabase + 未登录 ⇒ 含 'login'、不含 'download'
//    supabase + 已登录 ⇒ 含 'download'、不含 'login'
// ② 渲染层（照抄 tests/guards/blankSearchQueryKeepsEmptyState.test.ts 的 harness）
//    —— 真的把 TabList 渲染一遍（空 store），断言四个按钮的
//    aria-label 与「点了会发生什么」对应得上。
// ③ 接线层（钉**数据流**，不钉字面量）
//    —— 「onOpenAuth」必须真的被调用（登录出口）、
//       「chrome.runtime.openOptionsPage」必须真的被调用（设置出口）、
//       「sendSyncCommand('download')」必须真的被调用（恢复出口）、
//       「requestImport()」返回 false 时必须**出声**（导入出口的兜底）
```

⚠️ 特别提醒：② 这一层**必须**用「store 里 `auth.isAuthenticated = true`」
再渲染一遍 —— 因为**「已登录用户看到「登录」按钮」正是这条缺陷的形状**，
只渲染默认 store（未登录）永远测不到它。

---

### R-13 | P2 | `round42StoreHonesty` 守卫钉死中英文字面量 ⇒ 等价改写就红；而钉不变量的新守卫没取代它

**归属**：第 42 轮引入的回归（守卫层）

**证据**：实测（变异测试，在纯净 HEAD 副本 `/tmp/r43d` 上跑，**原仓库一个字节没改**）：

| 变异（**语义完全等价**） | `round42StoreHonesty` | `storeListingClaimGuard`（第 43 轮新增） | `docsAlignment` |
|---|---|---|---|
| `· 外观：` → `· 界面外观：`（同一条 bullet，只是措辞） | **红**（用例 ③） | 绿 | 绿 |
| Short Description 的「保存即关闭」→「保存并关闭」（同一个意思） | **红**（用例 ①） | 绿 | 绿 |

⇒ `tests/guards/round42StoreHonesty.test.ts` 钉的是**字面量**：
- `:97` `assert.match(STORE, /· 外观：/, ...)`
- `:101` `assert.match(STORE, /· Look and feel:/, ...)`
- `:56-58` `lineStartingWith(STORE, '保存即关闭')` + `assert.match(line, /关闭/)`
- `:66` `lineStartingWith(STORE, 'TapStack 把你当前浏览器窗口')`
- `:73` `lineStartingWith(STORE, 'TapStack saves every tab')`
- `:86` `lineStartingWith(STORE, '· 登录同步：')` / `:96` `lineStartingWith(STORE, '· Cloud sync:')`

⇒ 一次**不改变任何事实**的措辞调整就会让它变红 ——
这正是本仓 memory 里 `stale-literal-guards-block-correct-fixes` 那条教训。

**为什么第 43 轮的新守卫没有解决它**：
`tests/guards/storeListingClaimGuard.test.ts` 的形状是**对的**
（判据从**代码**取事实：主题套数从 `ThemeStyleSelector` 现场数、
后端种类从 `src/sync-backend/*` 现场数），
**但它没有接管 `round42StoreHonesty` 的那几条断言** ——
两套守卫并存，一套钉不变量、一套钉字面量。

⇒ 也就是说：**仓库里现在有两套「商店文案必须说什么」的判据**，
其中一套会把正确的改法判红。改文案的人会同时被两套守卫夹住，
且**不知道哪一套才是权威**。

**数据是否丢**：不丢。这是**开发体验型**缺陷（守卫层）。

**最小改法**：

1. 把 `round42StoreHonesty` 里那几条**字面量定位**改成**结构定位**：
   `lineStartingWith(STORE, '保存即关闭')` ⇒
   「取 **Short Description 那一段**（段落边界由 `## Detailed Description` 之类
   的固定标题界定），断言它**含有「关闭」这个动作词**与英文的 `close`」；
   `lineStartingWith(STORE, '· 外观：')` ⇒
   「取**所有 bullet 行**，断言其中**有一行提到主题/外观**（判据来源：
   `ThemeStyleSelector` 实际渲染的选项数 > 0）」。
2. 或者更干脆：**让 `storeListingClaimGuard` 接管这几条**，
   `round42StoreHonesty` 只保留它独有的那几条（⑤ 版本表自相矛盾、⑦ README 死指针）。

⚠️ 判据必须继续**钉不变量**：主题套数从代码数、后端种类从代码数、
「保存会关掉标签」这个**事实**（而不是「保存即关闭」这四个字）。

---

## 2. 逐项判定（按 team-lead 指定的六个维度）

### 2.1 接线完整性（用户入口 → 状态 → 持久化 → 渲染）

| 新增物 | 判定 | 证据 |
|---|---|---|
| `settings.sessionSort`（设置项） | **成立** | 用户入口 `SearchFilterPanel.tsx:207-216` → Redux `setSessionSort` → `dispatchSaveSettings` 落盘 → `storage.setSettings`（`src/utils/storage.ts:809` 带 `validateSessionSort`）→ 读回 `getSettings`（`:663`）→ 渲染 `TabList.tsx:359`。**四环齐全**。 |
| `sortSessions` 接进列表 | **成立**（上一轮的假绿已修） | `src/components/tabs/TabList.tsx:359`。**实测**：`sessionSortWiring` 守卫对「喂的不是 store 读出来的那个变量」这一变异**会红**（§6）。 |
| 排序控件在**结果视图**的可见性 | **不成立** | 见 **R-6**。 |
| 排序在**双栏布局**下的兑现 | **不成立** | 见 **R-11**：`TabList.tsx:531-542` 的分列逻辑按「标签数」贪心重排 ⇒ 视觉序与 DOM/键盘序都不等于 `sortSessions` 的结果。**接线是通的，但接上之后被渲染层推翻**。 |
| L-11 空态四个出口的**接线** | **成立** | `emptyStateActions.ts:50-63` → `TabList.tsx:167` → `:173-194` → `importRequest.ts:37/50` → `Header.tsx:352-357` → `HeaderDropdown.tsx:183/189-192`。四环齐全 ⇒ **但没有任何一条守卫或单测断言「点了会发生什么」**（见 **R-12**）。 |
| `blockedAccountIds`（端口字段） | **成立**（上行侧） | `upload.ts:1263` → `supabaseAdapter.ts:103` → `tabGroupSyncService.ts:83` → `syncEngine.ts:1315-1316`。四环齐全，**且**被挡下的 id 在两处对账判据里被排除（`:1492`、`:1542`）。 |
| `blockedAccountIds`（**覆盖上传**侧） | **不成立** | 见 **R-1**（闸门只管「上行集」，覆盖分支的 DELETE 不看它）。 |
| `notThisAccountIds`（对账入参） | **成立** | `uploadCoverage.ts:109` → `:175-179`；`syncEngine.ts:1542` 传值。 |
| `pendingNotice`（换账号提示） | **不成立** | 见 **R-4**（写有、读只在 400ms 兜底里）。 |
| `showFavicons` 管到卡片头 | **成立** | `TabGroup.tsx:170`（读设置）、`:988`（渲染）；守卫 `tests/deadSettingsAndEntryPoints.test.ts:107` 钉「整块不渲染」。 |
| `writtenTombstoneIds` 过滤器在 pendingDeleteIds 那一支 | **成立（未被套错）** | `syncEngine.ts:1396-1400`：**队列那一支确实没有套** `writtenTombstoneIds`；`legacyTombstoneIds` 那一支套了（正确——那是「本轮 upsert 已写墓碑」的语义）。守卫 `tests/guards/consumeUndoWiring.test.ts:217-234` 钉住了这一点。 |
| `overwriteGuard.planOverwriteDeletion` 两处接上 | **成立** | 合并前 `syncEngine.ts:766`（喂 `decideForceRemoteOverwrite`，`:776`）、合并后 `:981`/`:996`（喂 `checkDeleteFailsafe`）。同源同阈值。 |
| `accountScopeStore`（独立键） | **成立** | `utils/authCache.ts:77-95`；`clearAuthState` 只删 `auth_cache`（`:206-214`），归属记录活过退出登录（守卫 `accountScopeGuard.test.ts:295-335` 实测通过）。 |

### 2.2 守卫的检测力

见 §6 的完整表（每个判定都是变异实测出来的）。

### 2.3 状态机与时序

| 链路 | 判定 | 说明 |
|---|---|---|
| 消费 → 撤销 | **成立** | 纯函数 `core/consumeUndo.ts` 幂等（`changed:false`）；协议 op `restoreConsumed` 已登记（守卫 `consumeUndoWiring.test.ts:139-161`）；SW 侧「先撤删除意图、再写记录，撤不掉 ⇒ 中止」。**失败路径**：撤不掉 ⇒ 中止，fail-closed。 |
| 跨端删除（墓碑 / 删除优先级 / 单写者队列 / Lamport） | **成立** | 队列那一支不套过滤器（实测确认，`syncEngine.ts:1396-1400`）；单写者队列 + 单调 Lamport 两条结构性保证写在 `core/consumeUndo.ts:50-72`。**失败路径**：上传期间发生的撤销 ⇒ 由「写墓碑前重读队列」封堵（`syncEngine.ts:1396`，守卫 `consumeUndoWiring.test.ts:191-215` 钉住了「读队列在 upsert 之后、在广播之前」）。 |
| 覆盖下载熔断 | **成立** | 合并前估计 + 合并后精确值，同源同阈值（`core/overwriteGuard.ts`）。**失败路径**：熔断在**写入之前** ⇒ 本地一个字节没动（`syncEngine.ts:972-985`）；设置同步排在**全部**闸门之后（`:997`）。 |
| 覆盖**上传**的空集保护 | **不成立** | 见 **R-1**（`syncEngine.ts:1343` 的 `no-active-groups` 问错了对象）。 |

### 2.4 两个后端的 `writtenIds` 口径差异

**判定：成立 —— 第 42 轮没有把它套错地方。**

- `src/sync-backend/supabaseAdapter.ts:96-99`：`writtenIds` 只含 Supabase 真实报告的墓碑 id（**不含活跃行**）。
- `src/sync-backend/webdav/adapter.ts:1352`：`writtenIds.push(g.id)` —— 推的是**本轮写上远端的全部 id（含活跃行）**。
- `src/services/syncEngine.ts:1397-1400`：`pendingDeleteIds` 那一支**没有**套 `writtenTombstoneIds`；
  `legacyTombstoneIds` 那一支套了。
  ⇒ 语义正确：前者是「用户显式删除意图」（必须独立广播），后者是「本轮 upsert 已写的墓碑」（别写第二遍）。
- 台账（`docs/audit-2026-10-22-round42.md:211`）的警告是对的，实现也是对的。**撤回。**

⚠️ 但**新增的** `blockedAccountIds` 是第三个后端口径差异点：
**只有按账号分行的后端（Supabase）会有这个字段；WebDAV 永远不填**
（`src/sync-backend/ports.ts:108-116` 的注释写明了）。
`supabaseAdapter.ts:103` 用 `...(up?.blockedAccountIds ? {...} : {})` 透传 ⇒ WebDAV 路径
`up?.blockedAccountIds` 为 undefined ⇒ `blockedByAccountScope` 恒为空 ⇒
`syncEngine.ts:1492` 与 `:1542` 的过滤**对 WebDAV 是空操作** ⇒ 行为不变 ✓。
**这一点是对的**（WebDAV 不按账号分行，用户的云盘只属于他一个人，不需要账号闸门）。

### 2.5 两个后端的 fail-closed 基准

**判定：部分成立。**

- Supabase 侧：**fail-closed**（`accountScopeStore.read()` 形状损坏 ⇒ 抛 ⇒ 中止上传 ✓；
  `probeOverwriteDeletePlan` 读失败 ⇒ 抛 ⇒ 中止覆盖 ✓）。
- WebDAV 侧：本次改动**没有触碰**它的 fail-closed 语义。
- ⚠️ **但第 42 轮在 Supabase 侧引入了一个新的 fail-open 方向** —— 见 **R-5**：
  `readLastAuthCacheUserId` 把「读失败」吞成 null ⇒ 闸门兜底认账给当前账号 ⇒ **放行全部会话**。
  这一处的基准**与同文件里 `normalizeAccountScope` 的 fail-closed 不一致**，
  也**与 `readLastAuthCacheUserId` 自己的文档契约（`authCache.ts:43-44`）相反**。
- ⚠️ **另一处不一致**：覆盖上传的「读不出来」是 fail-closed 的
  （`upload.ts:329-333`：探测失败 ⇒ 抛 ⇒ 中止覆盖），
  但「**上行集为空**」不是 —— 它会**照样删空云端**（**R-1**）。
  ⇒ 同一段覆盖逻辑里，「读不出来」fail-closed、「没东西可写」fail-open，
  **两个方向的纪律不在同一条线上**。

### 2.6 数据形状（`uploadCoverage` / `accountScope` / `overwriteGuard` 的入参出参）

| 模块 | 判定 | 说明 |
|---|---|---|
| `reconcileUploadCoverage` | **成立** | `unique()` 过滤非字符串与空串（`:148-151`）；`notThisAccountIds` 用 `Set` 去重（`:175`）；`deleted`/`notThisAccount` 两个集合与 `submitted` 一起构成「不计入未同步」的三个来源，**互不干扰** ✓。 |
| `filterGroupsByAccount` | **成立** | `blockedIds` 与 `blocked` 同步维护（`accountScope.ts:200-212`）；`resolveGroupOwner` 判定顺序：显式例外 > ownerUserId > 兜底当前账号（`:178-187`）✓。 |
| `normalizeAccountScope` | **成立** | 形状坏一律抛（fail-closed）；`pendingNotice` 缺 `text`/`residualCount` 也抛（`:154-156`）✓。⚠️ 一个小问题：`pendingNotice.at` 缺失回落成 `0`（`:162`）—— **不一致但无害**（`at` 只用于诊断）。 |
| `planOverwriteDeletion` | **成立** | `uniqueIds` 去重 + 剔空（`:104-114`）；集合差而非计数差（文件头已论证）✓。 |
| `UploadCoverageInput.uploadPerformed` | **不成立** | 死字段，见 **R-7**。 |
| **覆盖上传的「上行集 vs 待删集」形状** | **不成立** | 见 **R-1**：这两个集合之间**没有任何约束**（上行集可以为空、待删集是当前账号全部行）。 |

---

## 3. 「第 42 轮声称已修但实际没修好」清单

| 台账条目 | 声称 | 实际 | 依据 |
|---|---|---|---|
| **DS-1**（跨账号隔离） | 「闸门放在真正写云端的那一层 ⇒ 四条上传路径全都汇到它 ⇒ 漏一条路径就漏一次」 | **上行集合**这一半成立；**「先删后写」的覆盖路径**没被覆盖（**R-1**）。台账原话「漏一条路径就漏一次」——**漏的正是「写之前先删」这一步**。 | R-1 |
| **DS-1** 收尾接缝 | 「被挡下的 id 一路透传到对账，并在两处被判据排除」 | **成立**（`syncEngine.ts:1492`、`:1542`），但**守卫看不见**（R-2/R-3）。 | R-2 / R-3 |
| **DS-1**「不许静默」 | 「换账号时会给用户一条带残留数的提示（持久、可消费、消费即清空；没人消费时由 restoreAfterLogin 兜底发出，不许静默）」 | **提示是持久的、可消费的** ✓；**但「没人消费时由 restoreAfterLogin 兜底发出」只在登录后 400ms 内成立** ⇒ 页面提前关闭 ⇒ 提示**永远不被告知**（R-4）。 | R-4 |
| **DS-1**「记录形状损坏 ⇒ 中止上传（fail-closed）」 | 形状损坏 ⇒ 中止 ✓ | **成立**。但「**读不出来**（I/O 失败）⇒ 中止」这一半被 `readLastAuthCacheUserId` 吞掉了（R-5）。 | R-5 |
| **L-10**（会话排序） | 「现在可以排序」 | **主列表成立** ✓；**结果视图里那个下拉是死的**（R-6）；**双栏布局下排序本身被渲染层推翻**（R-11）。 | R-6 / R-11 |
| **L-11**（空态出口） | 「空态给出可操作的出路」 | **接线成立** ✓（四环齐全）；**零守卫、零单测** ⇒ 换个人改坏它，测试不会红（R-12）。 | R-12 |
| **元教训 5**（「判据层全绿 ≠ 功能被用上了 ⇒ 必须有钉数据流的接线守卫」） | 台账把这条写成元教训 | **本轮自己写的接线守卫 `accountScopeReconcile` 钉的正是「两边都出现过这个字段」** ⇒ 同一条教训在写下它的那个提交里被违反（R-2）。 | R-2 |
| **元教训 5**（续） | 同上 | **元教训 5 讲的是「判据层」，而 L-11 连判据层都没有** ⇒ 它的守卫缺位比 R-2 更彻底（R-12）。 | R-12 |
| **元教训 2**（「守卫钉死字面量会让正确的修法变红」） | 同上 | **本轮自己写的守卫就钉死了字面量** ⇒ 等价改写被判红（R-3）；**第 42 轮的 `round42StoreHonesty` 是同一形状的第二例**（R-13）。 | R-3 / R-13 |

---

## 4. 最小修法汇总（按优先级）

1. **R-1（P0）**：`upload.ts` 的覆盖分支加一条前置 ——
   「**本轮实际上行集（`uploadRows`）为空 ⇒ 不删、跳过覆盖**」，
   并把「覆盖被跳过」如实回传给 `syncEngine`
   （复用已有的 `skippedOverwrite` 通道，UI 已有对应文案：`SyncButton.tsx:388`）。
   补一条覆盖模式的端到端守卫。
2. **R-2 / R-3（P1）**：`tests/guards/accountScopeReconcile.test.ts` 的主体断言
   换成**行为级**（调 `syncEngine.upload()` + 假后端，断言被挡下的 id 不在
   `submittedGroupIds` 里）；或至少把「全文 grep」换成
   `detectsSubmittedFilter` 的加强版（「这一句里有一个接在 map 之后的 filter
   且谓词引用 blocked 集合」）。
3. **R-4（P1）**：`AuthProvider` 的初始化 effect 里消费一次持久提示；
   并把 `LoginForm` 里那个「并进自己文案」的接口接上，或把注释改成实情。
4. **R-5（P1）**：`readLastAuthCacheUserId` 读失败改为**抛**；
   `loadAccountScopeForUpload` 区分「键不存在」（兜底）与「读不出来」（中止）；
   `captureLocalSessionOwner` 显式区分两种失败方向。
5. **R-8（P1）**：给**商店页**补一条「仓库→线上」的接缝守卫
   （照抄 `privacyPolicyCoversManifest.test.ts:190-257` 的三态形状：
   抓不到 ⇒ skip；抓到但内容旧 ⇒ 判红）。核对项从**仓库那份现场解析**，
   不钉中文原句。
6. **R-11（P1）**：分栏必须尊重排序。
   **推荐**：把 `TabList.tsx:531-542` 的贪心分列改成「**按排序后的顺序轮转填栏**」
   （第 1、3、5…进左栏，第 2、4、6…进右栏）——
   这样 DOM 序 = 逐行视觉序 = 排序序三者一致；
   「避免高低脚」这个诉求改由**高度**均衡承担，不要由**顺序**承担。
   **次选**：双栏下隐藏排序控件（与 R-6 同一个修法）。
   **同时**补一条守卫：「分列后的逐行视觉序与 DOM 序都必须等于输入顺序」
   —— 判据钉**不变量**，不钉分列代码长什么样。
   顺带把 `scripts/lead-verify-sort.mjs` 补一个**双栏**用例
   （它现在只测单栏，且读的是 DOM 序 ⇒ 双栏下会假绿）。
7. **R-12（P1）**：**两层都要改**。
   **（a）行为层（真正的缺陷）**：`AuthProvider.tsx:30-35` 读到的
   `authCache.getAuthState()` 应当**直接 `dispatch(setFromCache(...))`**
   （`authSlice.ts:287-291` 的现成 action，`backgroundSync.ts:641-643` /
   `syncEngine.ts:1665` 已在用）⇒ 冷启动首帧的登录态就是对的，
   空态不会先给错的那个出口。
   ⚠️ 判据钉**不变量**：「首帧的 `isAuthenticated` 来自缓存，
   不必等网络」—— 不要钉「某一行必须长什么样」。
   **（b）判据层**：新增 `tests/guards/emptyStateExits.test.ts`（三层）：
   ① **纯函数层** —— 直接 import `resolveEmptyStateActions`，
   断言**集合**而不是文案：
   `webdav ⇒ 不含 'login'`（WebDAV 用户没有 TapStack 账号，给「登录」是骗人）、
   `supabase + 未登录 ⇒ 含 'login' 且不含 'download'`、
   `supabase + 已登录 ⇒ 含 'download' 且不含 'login'`；
   ② **渲染层** —— 照抄 `tests/guards/blankSearchQueryKeepsEmptyState.test.ts` 的
   harness，**分别用「未登录」和「已登录」两份 store 各渲染一遍**，
   断言四个按钮的 `aria-label` 与「点了会发生什么」对应得上
   （已登录时**不得**出现「登录 TapStack 云端」—— 这正是本缺陷的形状）；
   ③ **接线层** —— 断言 `onOpenAuth` / `chrome.runtime.openOptionsPage` /
   `sendSyncCommand('download')` / `requestImport()` 各自真的被调用，
   且 `requestImport()` 返回 false 时**必须出声**。
8. **R-13（P2）**：把 `round42StoreHonesty` 里那几条**字面量定位**改成
   **结构定位**（按段落标题切分 Short Description / Detailed Description，
   再断言**动作词**「关闭 / close」存在；bullet 行断言「提到主题/外观」，
   判据来源是 `ThemeStyleSelector` 实际渲染的选项数 > 0），
   或直接**让 `storeListingClaimGuard` 接管这几条**，
   `round42StoreHonesty` 只留它独有的那几条（版本表自相矛盾、README 死指针）。
   ⚠️ 判据必须继续钉**不变量**：主题套数从代码数、后端种类从代码数、
   「保存会关掉标签」这个**事实**（而不是「保存即关闭」这四个字）。
9. **R-6（P2）**：`SearchFilterSection` 加 `showSortControl` prop，
   `SearchResultList` 那个渲染点传 `false`。
10. **R-7（P2）**：删掉 `uploadPerformed` 或真的用它。
11. **R-9（P2）**：`autoSyncDisclosure` 的「读设置真值」判据改成
   **比对值**（AST 抽标识符）而不是比对**取值语法**。
12. **R-10（P2，非缺陷）**：`SETTINGS_UPLOAD_TRIGGER_ACTION_TYPES`
   的白名单字符串改成**从 `settingsSlice.ts` 现场推导**。

---

## 5. 已复核后撤回（查了但不成立）

审计的价值在于**该撤的撤得掉**。以下都是本轮**追查过**、最后**判定不成立**的：

| 追查项 | 为什么不成立 |
|---|---|
| **「删除广播会在别的账号的云端凭空造出一行墓碑」**（审计中途我自己写过这条） | `markCloudGroupsAsDeleted` 对 `tab_groups` 只有 `UPDATE`（`upload.ts:1314`、`:1380`）与 `DELETE`（`:1416`）**两条路径，没有 INSERT/UPSERT**（`upsert` 只在 `:306` 的 `upsertRowsInBatches` 里，墓碑不走它）⇒ 不可能造出新行。且 `.eq('user_id', userId)`（`:1388`）把写入范围锁死在当前账号。**实测**：探针里 B 的云端从头到尾只出现 `DELETE:` 与 `UPSERT:` 操作，没有任何墓碑行凭空出现。**撤回。**（真实失效路径是 R-1。） |
| **「`writtenTombstoneIds` 被套错到 `pendingDeleteIds` 那一支」** | 逐字读了 `src/services/syncEngine.ts:1396-1400`：队列那一支**确实没有**套过滤器（只有 `legacyTombstoneIds` 那一支套了，而那一支套得对）。台账（`:211`）的警告是对的，实现是对的。**撤回。** |
| **「WebDAV 后端也漏了账号闸门」** | WebDAV 不按账号分行（用户的云盘只属于他一个人），且 `supabaseAdapter.ts:103` 的条件透传让 `blockedByAccountScope` 在 WebDAV 路径恒为空 ⇒ 行为零变化。**撤回。** |
| **「排序默认键不是 `'saved'`，升级会换顺序」** | `core/sessionSort.ts:64` `DEFAULT_SESSION_SORT = 'saved'`，判据是 `createdAt` 倒序（`:197`）⇒ 与旧版写死的表达式逐元素等价。守卫 `tests/sessionSort.test.ts` 钉住了这条等价性。**撤回。** |
| **「`accessible` 标签口径骗人」** | 第 42 轮已把「最近访问」改成「最近活动」，口径是 `max(updatedAt, max(tab.lastAccessed))`（`core/sessionSort.ts:137-146`），文件头说清了「改名也算碰过」这个取舍。**撤回**（口径诚实，不是缺陷）。 |
| **「`src/core/sessionSort.ts:49` 有乱码」** | 确实有一个替换字符（`��近我在动哪些会话`），但**全仓 11 个文件**都有同类乱码（含 `src/core/orphanedGroupFields.ts`、`tests/consumeUndo.test.ts` 等），**早于第 42 轮**，不是本轮引入。**撤回**（另案处理）。 |
| **「`uploadCoverage.uploadPerformed` 是本轮新引入的死字段」** | `git log -S` 显示它在 `078ce5e`（v1.25.1）就已存在。**降级为 R-7（P2，非本轮回归）。** |
| **「`accountScopeGuard.test.ts` 的「自证检测力」是零检测力」** | 它的两条「自证」用例确实写得弱（比较两个**字面量**：`silent` vs `text`），但同一文件里有**真的端到端复验**（`:472-587`：假云端 + 真上传函数 ⇒ 断言 B 的云端行里没有 A 的会话）。⇒ 整条守卫**不是**零检测力。**撤回**（但那两条自证用例本身可以改成行为断言，属可选改进）。 |
| **「`normalizeAccountScope` 对 `pendingNotice.at` 的处理不一致」** | `at` 只用于诊断，缺失回落 0 无害；`text`/`residualCount` 缺失抛错是对的。**撤回。** |
| **「覆盖上传的 `probeOverwriteDeletePlan(groups.map(...))` 用了全量清单会误保护」** | 第 42 轮把 `groups`（全量）改成 `uploadGroups`（闸门放行的）**只改了 `tombstonesDropped` 那一处**（`upload.ts:789`），探测那处仍是全量并**有完整论证**（`:1027-1033`：「『本机有没有副本』是关于数据的事实，与它归谁无关」）。且「受保护集 ∩ 上行集 = ∅」成立（上行集 ⊆ 本机清单）。**撤回。** |
| **「`sessionSortWiring` 守卫也是钉字面量」** | 它用 **TS AST** 抽出「从 store 读出来的变量名」与「喂给 `sortSessions` 的变量名」，比较的是**标识符**。**实测**（变异 M4）：把 `TabList.tsx:359` 改成喂常量 ⇒ 守卫**测试 1 与测试 4 双红**。**撤回**（这条守卫做对了，且是 `accountScopeReconcile` 应该学的样板）。 |
| **「`iconClickIsNonDestructive` / `headerActionBudget` / `noPhantomMechanisms` 三条守卫是零检测力」** | 逐条读了：`iconClick` 用**括号配平**取出 `chrome.action.onClicked` 的**函数体**再判（不是全文 grep）⇒ 有效；`headerActionBudget` 钉的是**行为不变量**（顶栏不得有这两个入口 / 菜单必须提供 / 不得带 `sm:hidden`）⇒ 有效；`noPhantomMechanisms` 判的是「生产引用 ∨ 明说没接线」，并带两条**规则自测**（一个真接线的符号、一个只在测试里的符号）⇒ 判据本身不是空转。**撤回。** |
| **「全量测试有 2 条红，说明第 42 轮留下了坏测试」** | 那 2 条红（`tests/guards/openUrlGateConsistency.test.ts` 与 `tests/syncBackoff.test.ts`）来自**另一个 agent 正在工作树上的未提交改动**，在**纯净 HEAD 副本上两条全绿**（实测 23/23 pass）。**撤回。** |
| **「`webDavBannerCopy` 是死导出」** | 组件里用的是 `WEB_DAV_BANNER_COPY` 常量本身（`WebDavSettings.tsx:78/1554`），`webDavBannerCopy` 这个**函数**导出确实没有生产调用点，但它是**文案表的一层包装**（`syncPreviewView.tsx:402-403`），且被 `tests/guards/uiTruthfulnessC.test.ts:335-356` 直接测。**撤回。** |
| **「`isFeatureBearingUpdate` / `lastActivityAt` / `splitOneTabLine` / `toMutationErrorCopy` 是死导出」** | 逐个查了生产引用：`isFeatureBearingUpdate` 被 `src/core/onboardingTrigger.ts:150` 内部消费；`lastActivityAt` 被 `src/core/sessionSort.ts:172-173` 内部消费；`splitOneTabLine` 被 `src/core/oneTabFormatParser.ts:234` 内部消费；`toMutationErrorCopy` 被同文件 `:82` 的 `mutationErrorMessage` 消费。**撤回**（对外导出只是顺带，`noPhantomMechanisms` 守卫的判定也是这个口径）。 |
| **「`getGroupsToSync` / `orphanedGroupFields` 是死导出」** | `getGroupsToSync`（`src/core/syncDecision.ts:182`）确实**全仓无调用点**（`git log -S` 显示它自 `ee3d587` 引入后就没被用过），但它**不属于第 42 轮**（引入于 2026-09），且是纯函数、无副作用 ⇒ 只是死代码，不影响行为；`orphanedGroupFields` 的 `hasOrphanedGroupFields` / `migrateOrphanedGroupFields` 被 `src/utils/migrationUtils.ts:12-13` 消费 ✓。**撤回**（`getGroupsToSync` 若要清理由另一轮单独处理）。 |
| **「`SESSION_SORT_OPTIONS` / `DEFAULT_SESSION_SORT` 是死导出」** | `SESSION_SORT_OPTIONS` 被 `SearchFilterPanel.tsx:228` 用来渲染下拉选项；`DEFAULT_SESSION_SORT` 被 `storage.ts:312` 当落盘默认值。**撤回。** |
| **「promo 站上的『收藏夹』『拖拽排序』是过时宣传」** | 逐句读了 `outputs/tapstack-promo/index.html`：两处都在**正当语境**里（『收藏夹』指锁定会话；『拖拽排序』指会话内标签拖拽），不是第 42 轮撤掉的功能。**撤回**（假阳性）。 |
| **「线上站点有 404 ⇒ 仓库→线上接缝断了」** | 只有 `/privacy.html` 是接缝守卫覆盖的那一条；其余路径在当前线上无法复现 404（2026-10-21 那次 alias 劫持事故**当前不可复现**，不作为本轮结论）。**撤回。**（R-8 只保留商店页那一条，是**仓库侧文案**与**线上文案**的差异。） |
| **「R-11 是第 42 轮新引入的回归」** | `git blame` 显示分列逻辑（`TabList.tsx:534-542`）来自 `a31cb5f`（2026-10-14，**早于**第 42 轮的 `bac6ec1`）⇒ **分栏本身不是本轮引入**。**但**第 42 轮把顺序从「写死的创建时间倒序」升级成「用户可选的四键排序」，并对外承诺「四个排序键逐个换、顺序逐个变」（`docs/RELEASE-NOTES.md:133`）—— **承诺是新的，双栏下兑现不了** ⇒ 定为「第 42 轮引入的回归（承诺层），机制层早于本轮」。 |

---

## 6. 守卫检测力表（第 42 轮新增/修改的守卫）

> **判据口径**：每条都给了「怎么证明它坏了」的**具体变异**。
> 「能红」= 实测变异后守卫变红；「不能红」= 实测变异后守卫仍绿。
> **实测方式**：把仓库 `git archive HEAD` 复制到 `/tmp/r43b`（node_modules 软链），
> 在副本上改源码 → 跑该守卫 → 记录结果。**原仓库一个字节没改。**

| 守卫 | 判据钉的是 | 变异 | 实测结果 | 结论 |
|---|---|---|---|---|
| `tests/guards/sessionSortWiring.test.ts` | **数据流**（TS AST 抽标识符） | `TabList.tsx:359` 喂常量而非 store 读出的变量 | **会红**（测试 1、4） | ✅ **能红**，是本轮最好的接线守卫 |
| `tests/guards/sessionSortWiring.test.ts` | 同上 | 摘掉 `sortSessions(` 调用 | **会红**（测试 4） | ✅ 能红 |
| `tests/guards/accountScopeReconcile.test.ts` | 全文 grep `blockedAccountIds` / `blockedByAccountScope.has(` | **M1**：删掉**真过滤器**（`:1319`），只留全量判定那处（`:1492`） | **仍绿**（测试 3/4/5 全绿） | ❌ **不能红**（R-2） |
| `tests/guards/accountScopeReconcile.test.ts` | 同上 | **M2**：过滤器改成 `.filter(id => !blockedByAccountScope.has(id) \|\| true)`（语义坏、字面量留） | **仍绿** | ❌ 不能红（R-2） |
| `tests/guards/accountScopeReconcile.test.ts` | 正则钉**字面量** | **M3**：**等价正确改写**（`blockedSet` 别名） | **变红**（测试 7，报「前提没成立」） | ❌ **把正确实现判红**（R-3） |
| `tests/guards/accountScopeGuard.test.ts`（一） | 纯函数行为 | `filterGroupsByAccount` 退化成不过滤 | 会红（`:66-84`） | ✅ 能红 |
| `tests/guards/accountScopeGuard.test.ts`（二） | **结构**（四条路径的调用关系，非行号） | 新增一条直连 `supabaseSync.uploadTabGroups` 的路径 | 会红（`:182-194`，callers 列表会多一项） | ✅ 能红 |
| `tests/guards/accountScopeGuard.test.ts`（六） | **端到端**（假云端 + 真上传函数） | 闸门改成放行 | 会红（`:472-587`） | ✅ 能红（本轮最强的一条） |
| `tests/guards/accountScopeGuard.test.ts`（六） | 同上 | —— | —— | ⚠️ 缺口：**端到端用例只测合并模式**（`:557-570` 第二个参数写死 `false`）⇒ **覆盖上传整条路径无守卫**（R-1） |
| `tests/guards/overwriteDeleteGuard.test.ts` | 纯函数 + 结构 | —— | —— | ✅ 判据是「问后果」，钉的是不变量（`wouldDelete` 的集合差），未见字面量陷阱 |
| `tests/guards/consumeUndoWiring.test.ts` | 结构 + **顺序**（读队列在 upsert 之后、广播之前） | 把 `getPendingDeleteIds()` 提到 upsert 之前 | 会红（`:191-215` 的 `queueReadAt > upsertAt`） | ✅ 能红 |
| `tests/guards/consumeUndoWiring.test.ts` | 结构（队列那一支不许套过滤器） | 给队列那一支套上 `writtenTombstoneIds` | 会红（`:217-234`，正则扫那一行） | ✅ 能红（**但**它钉的是「那一行不许出现这个串」⇒ 换个写法重写也会红，R-3 同款风险） |
| `tests/guards/iconClickIsNonDestructive.test.ts` | **函数体**（括号配平取出 `onClicked` 的 body） | 在 `onClicked` 里加回 `tabManager.saveAllTabs(tabs)` | 会红（`:58-79`） | ✅ 能红（不是全文 grep） |
| `tests/guards/headerActionBudget.test.ts` | 行为不变量（顶栏不得有 / 菜单必须有 / 不得 `sm:hidden`） | 把「切换布局」放回顶栏 | 会红（`:54-65`） | ✅ 能红 |
| `tests/guards/noPhantomMechanisms.test.ts` | 生产引用 ∨ 明说没接线 | 让 `computeVisibleChunks` 变成真接线 | 会红（不再需要「明说」） | ✅ 能红 |
| `tests/guards/noPhantomMechanisms.test.ts` | 同上 | —— | —— | ✅ 带两条**规则自测**（`:132-148`），判据本身不是空转 |
| `tests/guards/sessionCardActions.test.ts`（改过） | 放宽后的正则 `dominantTab?.favicon && (<SafeFavicon` | 在 favicon 前面再加一个**别的**条件（`showFavicons &&`） | **仍绿**（这是它刻意的放宽） | ✅ 符合意图（只守「没有 favicon 就不画」） |
| `tests/deadSettingsAndEntryPoints.test.ts`（新增用例） | 文本正则 | 删掉 `showFavicons &&` 前置条件 | 会红（`:107` 的 `/\{showFavicons && dominantTab\?\.favicon && \(\s*<SafeFavicon/`） | ⚠️ 能红，但**钉字面量**（换个写法就红 ⇒ R-3 同款风险，低危） |
| `tests/guards/autoSyncDisclosure.test.ts` | 正则钉**属性访问的字面形状** | **语义破坏**：`syncEnabled: settings.syncEnabled` → `syncEnabled: true` | **变红** | ✅ 能红（判据有效） |
| `tests/guards/autoSyncDisclosure.test.ts` | 同上 | **等价改写**：`settings.syncEnabled` → `settings['syncEnabled']` | **变红** | ❌ **把正确实现判红**（R-9） |
| `tests/guards/autoSyncDisclosure.test.ts` | 同上 | **等价改写**：`settings.syncEnabled` → `settings.(syncEnabled)` | **变红** | ❌ 把正确实现判红（R-9） |
| `tests/guards/uiTruthfulnessC.test.ts` | 源码正则（读 `WEB_DAV_BANNER_COPY[...]`） | 把 `webDavBannerKindOf(` 变成恒等 | **变红**（测试 6） | ✅ 能红 |
| `tests/guards/uiTruthfulnessC.test.ts` | 同上 | 属性访问 → 索引访问（`.skippedRemoteGroups`） | **仍绿** | ✅ 判据稳 |
| `tests/guards/sessionCardActions.test.ts` | 源码正则 | 把 `pickDominantTab(` 变成恒等 | **变红**（测试 1） | ✅ 能红 |
| `tests/guards/onboardingSpotlightFallback.test.ts` | 源码正则 | 把 `splitSelectorChain(` 变成恒等 | **变红**（测试 2） | ✅ 能红 |
| `tests/guards/syncSkippedGroupsCopy.test.ts` | 源码正则 + **括号配平取实参** | 属性访问 → 索引访问（`.skippedRemoteGroups`） | **仍绿** | ✅ 判据稳 |
| `tests/guards/syncSkippedGroupsCopy.test.ts` | 同上 | 改 import 别名（等价） | **仍绿** | ✅ 判据稳（它比的是**实参内容**，不是 import 文本） |
| `tests/guards/privacyPolicyCoversManifest.test.ts`（线上半） | **真 fetch 线上** + 三态判据 | —— | —— | ✅ **本仓唯一一条真正接上「仓库→线上」的守卫**（商店页照抄它即可，见 R-8） |
| `tests/guards/storeListingClaimGuard.test.ts`（第 43 轮新增） | 仓库文案 + **现场解析产品事实** | —— | —— | ✅ 形状正确（判据来自代码，不是钉文案）；⚠️ 但**只钉仓库那一侧** ⇒ 线上裸奔（R-8） |
| `tests/guards/settingsUploadTrigger.test.ts`（第 43 轮新增） | **行为层 + 解析推导层 + 规则自测层** | 把中间件改回前缀匹配 | 会红（L1） | ✅ 本仓**最完整**的接线守卫（不变量式，是 `accountScopeReconcile` 该学的样板） |
| **（无守卫）双栏排序** | —— | 把 `TabList.tsx:534-542` 的分列判据从「标签数」改成「按输入顺序轮转」 | **不会红**（根本没有守卫） | ❌ **缺口**（R-11）：`sessionSortWiring` 只钉「喂进 `sortSessions` 的变量」，**不钉渲染层怎么摆** ⇒ 接线通了照样可以推翻 |
| `scripts/lead-verify-sort.mjs`（真机脚本） | 读 **DOM 顺序**（`:81-88`），且**从不切双栏**（`layoutMode` 全文 0 命中） | 开双栏再跑 | **仍绿**（脚本只跑单栏） | ❌ **假绿**（R-11）：它读的是 DOM 序，而 DOM 序在双栏下**100% 出错**（穷举 4096/4096）⇒ **脚本只要加一个双栏用例会立刻报红** |
| **（无守卫）L-11 空态出口** | —— | 把 `resolveEmptyStateActions` 的 `isAuthenticated` 判断改掉 / 把 `'login'` 从 webdav 分支里加进去 | **不会红**（`grep -rn "resolveEmptyStateActions\|emptyStateActions\|requestImport" tests/ scripts/` = **0 命中**） | ❌ **缺口**（R-12）：连判据层都没有 |
| `tests/guards/round42StoreHonesty.test.ts` | 钉**中英文字面量**（`:56-58`、`:66`、`:73`、`:86`、`:96`、`:97`、`:101`） | `· 外观：` → `· 界面外观：`（语义等价） | **变红**（用例 ③） | ❌ **把正确实现判红**（R-13） |
| `tests/guards/round42StoreHonesty.test.ts` | 同上 | Short Description 的「保存即关闭」→「保存并关闭」（语义等价） | **变红**（用例 ①） | ❌ 把正确实现判红（R-13） |
| `tests/guards/storeListingClaimGuard.test.ts`（第 43 轮新增） | 仓库文案 + **现场解析产品事实** | 同上两处等价改写 | **仍绿** | ✅ 判据稳（它比的是**事实**，不是文案）⇒ **它应该接管 `round42StoreHonesty` 的那几条**（R-13 的修法方向） |
| `tests/docsAlignment.test.ts` | 仓库↔仓库 | 同上两处等价改写 | **仍绿** | ✅ 判据稳 |

---

## 7. 给下一轮的一句话

第 42 轮最 valuable 的那条元教训（「判据层全绿 ≠ 功能被用上了」），
**在写下它的那个提交里被自己违反了一次**：
`accountScopeReconcile` 钉的是「两边都出现过这个字段」，
而同一批的 `sessionSortWiring` 用 TS AST 钉的才是「同一条数据流」。

⇒ **下一轮收口时，守卫审查的标准动作应该是：把每条新守卫的判据问一遍
「它坏了会不会红」，并且用「改一行源码」而不是「读代码」来回答。**
本报告 §6 的表就是照这个标准做的实测结果 ——
其中两行（R-2/R-3）证明：**光看守卫代码是看不出这个问题的。**

而 R-1 更进一步，它提醒另一件事：
**「把不该写的挡住」这件事本身会改变其它代码路径的前提。**
第 42 轮把 A 的会话从上行集里拿掉是对的，
但覆盖上传的「先删空云端」这一步**假设了上行集会跟着补回来** ——
上游一改，这个假设就破了。
⇒ **凡是有「先删后写」的地方，删除条件必须与写入条件同源。**
