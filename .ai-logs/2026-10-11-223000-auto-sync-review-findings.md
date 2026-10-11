# 2026-10-11 22:30 — 自动同步默认关闭功能的全面审查（安全性/稳定性/可靠性）

## 对话出发点

Jasper：「请从头到尾全面审查该功能，确保其安全性、稳定性与可靠性。」

对象 = 刚落地的 1.23.0 自动同步默认关闭 + 四档间隔（见
`.ai-logs/2026-10-11-210000-auto-sync-default-off.md`）。
**按代码审查标准做**：找 bug、风险、回归，不是复述「测试全绿」。

## 审查结论

**发现 2 个真缺陷（均 P1，无 P0），已修 + 加守卫 + 变异验证。**
另有 1 处「设计正确但依赖了未验证的前提」，验证后确认成立（见「验证过的假设」）。

审查覆盖：SW 配置读取路径 / alarm 生命周期 / popup-SW 跨进程一致性 /
删除广播链路 / 上传链路 / UI 保存失败路径 / 云端设置同步 / 旧守卫契约更新。

---

## 缺陷 1 [P1] 60s 设置缓存导致「关掉自动同步」关不掉

### 现象（用户视角）

用户点「关闭自动同步」→ UI 显示已关闭 → **后台 alarm 仍在按开启状态跑**，
最长持续 60 秒。这段时间里用户的显式意图完全无效，后台继续出站流量 ——
而这正是本功能想解决的那笔流量。

### 根因

修复前 `readAutoSyncConfig` 走 `store.dispatch(loadSettings())`，而 `getSettings`
走 `cachedAsyncFn('storage', 'settings')` —— **60 秒进程内缓存**。
popup 与 SW 是两个执行上下文、各有独立的 `cacheManager`（模块级单例，每进程一份），
所以 popup 落盘后 SW 进程的缓存毫不知情：

```
用户点关闭 → popup 落盘（自己缓存已更新）
          → 发 resyncAlarm 叫 SW 重建 alarm
          → SW 的 readAutoSyncConfig 读到【自己那份 60s 旧缓存】= enabled:true
          → 判定「还开着」→ 按旧档位把 alarm 重建出来
```

两层后果，第二层才致命：
1. 关态下 popup 的自动下载门禁也读同一缓存 → 关了仍自动拉一次；
2. **真正致命**：`handleAlarm` 的「关则自杀」每轮都读到旧值 true ⇒ 用户显式
   关掉的意图在最长 60 秒内**完全无效**。

### 证据（探针实证）

```
SW 第1次读 = {"enabled":true,...}
popup 改盘后 SW 第2次读 = {"enabled":true,...}
=> 结论: SW 读到【旧值】(进程内 60s 缓存)
```

### 整改（`src/background/backgroundSync.ts`）

`readAutoSyncConfig` 改为**直接读盘**（`kvGet(STORAGE_KEYS.SETTINGS)` + `{...DEFAULT_SETTINGS, ...stored}`），
绕过 `cachedAsyncFn`。语义从「本进程 60s 前见过什么」变成「当前真实配置」。

**为什么不「让 SW 清一下缓存」**：清 cacheManager 也可以，但那是「从外面捅穿
别人模块的私有缓存」，会建立一条新的跨模块耦合，且下一个有缓存的设置字段会再犯
一次。直接读盘语义更准，代价是每次读多一次几 KB 的 KV 读 —— 相对它后面要跑的
整库管线可以忽略。

**顺带修正的 fail 方向**：原实现读失败时 fail-open（按「开」处理）。改为
fail-closed（按「关」处理）+ `logError`。理由：撤销用户显式关掉的意图，比多跑一轮
更糟；且读失败会让自动同步静默停摆，必须出声（「我开了却不动」无从排查）。
这条方向与 `performBackgroundSync` §2.5 的 fail-closed 是**同向**的（那里也是
「读不到就中止，不赌破坏性更强的那边」）。

### 守卫（`tests/autoSyncDefaultOff.test.ts` F 段，3 条）

- 行为：popup 落盘后立即再读必须是新值（开关 + 档位都验）；
- 结构：`readAutoSyncConfig` 不得经由 `loadSettings`，必须含 `kvGet`；
- 结构：catch 分支必须 `enabled:false` + `logError`。

变异验证：`readAutoSyncConfig` 改回 `store.dispatch(loadSettings())` → **变红 2 条**
（行为 + 结构都抓到）；catch 改回 fail-open → 变红。

### 一个测试层面的教训

结构断言第一次写时被**自己的注释**误判为红（注释里正解释着「为什么不能走
loadSettings」，`doesNotMatch(/loadSettings/)` 命中了说明文字）。修法：切片时先
滤掉注释行再断言。这个坑在 P0 的 `getData` 守卫那里已经踩过一次，这次是第二次 ——
已固化为本文件的固定写法（`filter(l => !t.startsWith('*') && …)`）。

---

## 缺陷 2 [P1] 保存失败时 UI 谎报开关状态

### 现象

用户点「关闭自动同步」→ `storage.setSettings` 抛错（IndexedDB 瞬时错误 /
写失败）→ reducer 已改 Redux、磁盘还是旧值 → 界面显示「已关闭」而后台仍按
「开启」跑，**且提示语只说「保存失败」，没说「现在到底是什么状态」**。

### 根因

`dispatchSaveSettings` 已把失败原因交回来（2026-09-09 P2-1 的成果），但
`handleToggleAutoSync` / `handleSetSyncInterval` 只 `showToast(saveError)` 就 return，
没有把 Redux 收回磁盘真值。

既有开关（通知 / 删除确认）有同款问题，但它们不控制任何后台行为，代价只是
「刷新后回退」；**本开关直接决定「是否出流量」**，当场不回滚 = 用户以为省了流量、
实际还在花，且没有任何提示说「其实没关掉」。

### 整改（`src/components/layout/HeaderDropdown.tsx`）

两个 handler 的失败分支都改成：回滚 reducer + 一条说清全部的 toast：

```
dispatch(setSyncEnabled(settings.syncEnabled));
showToast(`${saveError}（自动同步开关已恢复为${settings.syncEnabled ? '开启' : '关闭'}）`, 'error');
```

档位同理（否则「显示 30 分钟、实际 5 分钟」）。
顺手把原来「先 `showToast(saveError)` 再 return」的双 toast 收敛成一条 ——
原写法只有「保存失败」没有「现在是什么状态」，用户仍需自己猜开关生效没有。

### 守卫（G 段，1 条结构断言）

两个 handler 的 `if (saveError)` 分支必须含：回滚 dispatch + 「已恢复为」文案。
变异验证：删掉回滚那一行 → 变红。

---

## 验证过的假设（不是缺陷，但差点被我当成缺陷）

按「不假设、追根因」的纪律，这几条我都实际查了代码/链路，结论是**实现正确**：

1. **上传链路不受开关影响** ✓ —— `scheduleUpload` 走独立的 `SYNC_UPLOAD_ALARM`
   + `setTimeout` 双驱动，事件驱动（每次本地改动触发），与后台轮询的
   `SYNC_ALARM` 完全无关。关态下本地改动照常上云。
2. **删除广播在关态下不会卡住** ✓ —— 同样走 `scheduleUpload`（`DELETE_PRIORITY_MS`
   更快），`upload()` 里 `markCloudGroupsAsDeleted` 无条件执行。关态下删除意图
   照样广播，对端不会复活。
3. **UI 的竞态** ✓ —— `handleToggleAutoSync` 里 `settings.syncEnabled` 是渲染时
   快照（用于算 `nextEnabled` 与回滚目标），`dispatchSaveSettings` 内部用
   `getState()` 拿最新值落盘，两者不冲突。
4. **关态不会漏掉 pending_upload** ✓ —— `runScheduledUpload` 与 `upload()` 都清
   `pending_upload`，不依赖后台轮询。

---

## 遇到的问题

- **工具数字参数序列化故障**（`yield_time_ms` / `session_id` 被序列化成浮点导致参数
  校验失败），`write_stdin` 轮询不可用。workaround：长命令前台起 + 重定向落盘 +
  短命令轮询文件。环境噪音，与代码无关。
- **需云端的 E2E 仍因 Supabase `exceed_egress_quota` 失败**（既有环境问题）。

## 最终结果

**审查通过（2 个 P1 已修）。**

- 单测 **1117 passed / 0 failed**（审查前 1113 → +4：F 段 3 条 + G 段 1 条）
- `pnpm type-check` / `type-check:tests` / `lint` / `lint:tests` → 全 exit 0
- `pnpm build` exit 0
- 纯本地 E2E `e2e-tab-reorder.mjs` **8/8 通过**
- 本轮新增 3 个守卫**全部做过变异验证**（缓存回归 / fail-open 方向 / UI 不回滚），
  确认改坏实现会红

### 状态汇总（承前）

| 项 | 状态 |
|---|---|
| 代码实现 | 完成，审查 2 个 P1 已修 |
| 单测 / 门禁 / E2E | 全绿 |
| 版本号 | **仍是 1.22.17**，按发版纪律应 bump 到 1.23.0 后再 commit/tag/push —— 等 Jasper 确认 |
| 云端列迁移 | SQL 已写好未执行（客户端 42703 降级，发版先行安全） |
| 诊断字段 | `autoSyncEnabled` 已有真实行为支撑，但档位未上报（可选增强） |
