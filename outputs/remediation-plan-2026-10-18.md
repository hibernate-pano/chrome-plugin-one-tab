# 整改方案 · 双模式适配与首次同步归属审查

- 编制日期：2026-10-18
- 审查来源：外部 AI 审查报告（基准 `c9b2b42`）
- 本次复核基准：当前 `main` @ `dffdf59`（含后续两个修复 `42b98f2`、`dffdf59`）
- 复核方式：**逐条打开源码验证**，不直接采信报告结论

---

## 0. 核实结论速览

| 编号 | 报告结论 | 复核结果 | 依据 |
|---|---|---|---|
| **P0#1** | 未保存 WebDAV 配置时首次推送会走错后端，删光云端数据 | ✅ **成立，最高危** | `upload.ts:793` 覆盖模式先 `delete().eq('user_id', userId)` 删光再插入 |
| **P0#2** | WebDAV 用户后台自动同步永不运行 | 🔧 **已修** | 报告基准 `c9b2b42`；`42b98f2` 已按 `backendId` 分流 |
| **P1#1** | 云端未登录也能开自动同步（假绿灯） | ✅ 成立 | `index.ts:341` supabase 分支无 `lockedReason` ⇒ 必判 `ready` |
| **P1#2** | 下载确认框只数活跃会话，会误导 | ✅ 成立 | `countActive` 过滤墓碑，但 `downloadAndMerge` 服从墓碑 |
| **P1#3** | 首次同步把「只有墓碑」当空 | ✅ 成立 | `firstSyncDecision.ts:96` `remoteCount===0 → upload-all` |
| **P1#4** | 「不会自动上传」在下次保存后失效 | ✅ 成立 | `TabManager:158` 无条件 `scheduleUpload`，`upload()` 无 gate |
| P2 × 8 | 见 §3 | ✅ 全部成立 | 逐条验证 |
| 后置 × 4 | 见 §4 | ✅ 成立 | — |

**报告总评成立**：风险不在代码粗糙，而在「从 slim（WebDAV-only）往双模式搬」时，UI 与测试搬过来了，**后台登录门禁、首推区块的后端 gate、墓碑语义没一起搬**。

### 需要澄清的一处偏差

报告 P0#2 指向的「测试把缺陷写成前提」这一点**同样属实**——测试曾伪造 Supabase session 并把绕过步骤写成注释。该问题已在 `42b98f2` 中连同伪造一并删除，当前该文件已在**零 session** 下运行真实路径。

---

## 1. P0#1：跨后端删数据（最高优先级，先修）

### 已验证的完整事实链

1. `WebDavSettings.tsx:748` 首次推送区块**无条件渲染**——不要求 `settings.syncBackend === 'webdav'`，也不要求配置已保存。
2. `WebDavSettings.tsx:387` 的 `runPush` 只传 `overwriteCloud`，**不携带表单里刚填的地址/账号**。
3. 执行链 `service-worker.ts:641 → syncEngine.upload` 使用**已持久化的后端**。
4. 默认后端是 `supabase` 时，`upload.ts:793` 覆盖模式先删光：
   ```ts
   if (overwriteCloud) {
     const { error } = await supabase.from('tab_groups').delete().eq('user_id', userId);
     // …之后才 insert 本机数据
   ```
5. 而 UI `WebDavSettings.tsx:807` 承诺「三种方式都不会删除另一方的会话」。

**触发路径**：填好 WebDAV 地址 → 忘记点「保存并启用」→ 点「以本机为准」→ 默认后端仍是 Supabase → **删光该账号云端数据** → 插入本机数据。无回收站，不可逆。

### 修法（双层防护，P0 必须双层）

**第一层 · UI 前提**：区块渲染条件改为「后端已是 webdav 且配置已保存」，未满足时不渲染并提示「请先点『保存并启用』，再推送已有会话」。

**第二层 · 执行侧校验（不可省）**：`runPush` 执行前调 `readConfiguredBackendId()`，若 `resolvedId !== 'webdav'` 立即中止并提示「当前生效的同步方式不是自带存储，请先保存并启用」。UI 条件会被未来重构绕过，执行侧才是最后一道闸。

**验收（行为级）**：`syncBackend='supabase'` + WebDAV 表单已填未保存 → 点「以本机为准」→ 断言未发出任何 upload 命令、Supabase 数据未变动。

---

## 2. P1 级整改（4 项，建议同批修完再发 WebDAV 版）

### P1#1 云端未登录却判 `ready`

**根因**：`classifyBackendResolution` 只看 `lockedReason`，而 `index.ts:341` 的 supabase 分支直接返回、**永远没有 `lockedReason`** ⇒ 恒判 `ready` ⇒ `OptionsPage.tsx:256` 放行 ⇒ toast 承诺「每 N 分钟同步一次」，实际 `not_logged_in`。这是 B8 自己新造的假绿灯。

**修法**：
- `BackendStatus` 增加 `backendId` 字段
- `canEnableAutoSync(status, isAuthenticated)`：`status.kind !== 'ready'` 直接 false；云端模式额外要求已登录，WebDAV 模式不要求
- 云端未登录给独立 kind（`not_signed_in`）与专属文案——**不是**「重新输入应用密码」（云端要的是登录，不是 WebDAV 口令）

### P1#2 下载确认框只数活跃会话

**根因**：`WebDavSettings.tsx:472` 用 `countActive`（过滤墓碑），文案说「不会删除本机或云端的会话」，但 `downloadAndMerge` 服从云端墓碑。云端只有墓碑时确认框显示「云端有 0 个会话」，点击后本地对应会话**会消失**。与 B3 刚定下的「只有墓碑 ≠ 云端为空」直接冲突。

**修法**：确认框同时显示「云端有 N 个会话（另有 M 条删除记录）」；文案改为「下载会与本地合并，并**服从云端的删除记录**（被其它设备删掉的会话本机也会移除）」。不删除的承诺只保留给「不删云端」这一半。

### P1#3 首次同步把「只有墓碑」当空（会话复活）

**根因**：`firstSyncDecision.ts:96` `remoteCount === 0 → upload-all`，而 `remoteCount` 来自 `countActive`。**B3 刚把「空」和「只有墓碑」分开，B7 立刻合了回去。**

**后果**：点「检查并推送」→ 本地旧会话被重新上传 → **跨设备删除被撤销、已删会话复活**。

**修法**：三态区分
- `no-rows` → `upload-all`（不打扰）
- `only-tombstones` → 提示「云端有 N 条删除记录，这些会话已被其它设备删除；继续推送会撤销那些删除」，要求显式确认
- `has-active` → `ask-user`（三选一，维持现状）

**必须同步改测试**：`webdavFirstSyncDecision.test.ts:42-46` 当前把「远端只有墓碑 ⇒ 视为空」钉死了，该断言**方向错误**，需一并反转。

### P1#4 「不会自动上传」承诺在下一次保存后失效

**根因**：`TabManager.ts:158` 保存会话后无条件 `scheduleUpload` → `setPendingUpload(true)`；`upload()` 无任何首次同步 gate。而 `adapter.ts:380` 的 `firstSync`（远端无 manifest）会**上传全部本地组**。

**后果**：配好 WebDAV、未点「检查并推送」，随后保存一个标签页 → 所有旧会话被自动推上去 → **三选一归属决策被完全绕过**。这正是 B7 的核心价值所在。

**修法（建议）**：持久化「首次同步决策未完成」标志；未完成前 `upload()` 拒绝走全量路径（只允许空转或只传本次新增）。

**保守替代方案（改动更小）**：把文案改成「在你点『检查并推送』之前，保存新会话不会自动上传已有数据」——但**这只是把谎言换成较轻的谎言**，不解决决策被绕过的问题，**不推荐**。

---

## 3. P2 级整改（8 项，可随后续版本处理）

| # | 问题 | 位置 | 修法要点 |
|---|---|---|---|
| P2-1 | WebDAV 用户被刷新按钮要求登录 | `HeaderDropdown.tsx:157` 前提 vs `:510` 给 webdav 显示状态卡与刷新按钮 | webdav 时放行，或对未登录用户隐藏该按钮 |
| P2-2 | `probeRemote` 存储读在 try 外，失败会把 UI 卡在 `probing` | `WebDavSettings.tsx:303` 的 `getGroupsForWrite()` 在 `:305` try 之外；`handleFirstPush`/`handlePullFromCloud` 无 catch | 把读取移入 try，并给两个 handler 加 catch + 复位 `firstPush` |
| P2-3 | 保存顺序导致「配置已落盘但提示保存失败」，且 Redux 无回滚 | `WebDavSettings.tsx:247` 先写 config、`:250` 才校验口令；`:252-256` 保存失败未回滚 | 对照 `OptionsPage.tsx:326-331` 的正确写法：记 `prevBackend` 并回滚 |
| P2-4 | 子组件 save/lock/forget 后父页面 `backendStatus` 不刷新 | `WebDavSettings.tsx:240-281, 542-587` 只调 `primeSyncBackend()`，未通知 OptionsPage | 复用 B8 已有的 `refreshBackendStatus` 通道；补测这三条路径（现有测试只钉了 `handleSelectBackend`） |
| P2-5 | B1 锁定通知绕过「显示通知提醒」开关 | `backgroundSync.ts:127-147` 直接 `notifications.create`；全仓唯一尊重 `showNotifications` 的在 `TabManager.ts:486` | 按 2026-10-17 新策略分流：info 受开关控制、error 必发。二选一，但必须显式决策 |
| P2-6 | 每次开菜单/窗口聚焦都 `invalidateActiveSyncBackend`，丢掉已派生 Vault | `HeaderDropdown.tsx:84-98`、`OptionsPage.tsx:200-223`；`adapter.unlock()` 会重跑 PBKDF2（`adapter.ts:165-193`） | 只在设置真变化时失效；或把「读状态」与「重置后端」拆成两个出口 |
| P2-7 | WebDAV 用户没有工具栏同步按钮 | `SyncButton.tsx:338-340` 在 `!isAuthenticated` 时 `return null`，但 README 承诺该按钮 | 按后端而非登录态决定；或改 README 口径 |
| P2-8 | 测试层两处「假防线」 | `backgroundSyncLockedBackendOutcome.test.ts:139-181` 重复的踩坑注释块；`syncStatusHonesty.test.ts:379-389` 把「应用密码」钉在共享 hint 上 | 前者已在 `42b98f2` 删除；后者改成按后端分支断言。仓库无 Playwright 用例 ⇒ 提交信息里的「浏览器实测」不是可重复门禁，建议固化为脚本 |

---

## 4. 可后置（4 项）

| # | 问题 | 位置 | 判断 |
|---|---|---|---|
| ~~后-1~~ | ~~`resolveConfiguredBackend()` 异常时仍静默回落 Supabase~~ | — | **已完成（2026-10-18）**：该函数已整体删除。它不是待修项，而是 `primeSyncBackend` 的零调用劣化副本（catch 静默、不写 `lastResolution`、缺 `lockedKind`），且 docblock 仍写着「存储异常 ⇒ 回落 Supabase」，与函数体方向相反。补它（4 处改动 + 1 个新测试）比删它代码更多、用户可见收益为 0。回归锁 `tests/syncBackendSingleResolver.test.ts`（T1–T5，四类变异均已验证变红）。 |
| 后-2 | `handleSwitchBack` 不清 WebDAV session secrets；`handleForget` 不关自动同步 | `WebDavSettings.tsx` | 清完配置后 alarm 仍按档位醒来打锁定后端——B1 修好后表现是「一直让路 + 一次提醒」，不致命但会持续消耗唤醒 |
| 后-3 | 首次推送成功文案用 probe 快照计数，非实际 `writtenIds` | `WebDavSettings.tsx:416` | 远端有更新版本被跳过时「已推送 N 个」偏大。文案准确性问题 |
| 后-4 | `outputs/realtime-whiteboard.html` 与本项目无关 | 未跟踪 | 别提交；`chrome-extension.zip` 已确认是 1.24.2，与 manifest 一致 |

---

## 5. 执行顺序建议

```
阶段一（阻断发布）
  1. P0#1  跨后端删数据 —— UI 前提 + 执行侧双层校验 + 行为级测试
  2. P1#3  墓碑当空导致会话复活 —— 三态区分 + 反转错误断言
  3. P1#4  自动上传绕过三选一 —— 持久化首次同步未完成标志
  4. P1#1  云端假绿灯 —— canEnableAutoSync 纳入登录态

阶段二（同批可发）
  5. P1#2  下载确认框文案与统计
  6. P2-2 / P2-3 / P2-4（存储失败卡 UI、保存回滚、状态刷新）
  7. 补齐 P0/P1 的行为级测试（不要用源码字符串断言代替真实路径）

阶段三（后续版本）
  8. P2 其余项 + 后置项
```

**理由**：阶段一的 4 项都涉及「用户以为做了 A、实际做了 B」的语义错位，其中 3 项可导致不可逆数据丢失（删云端、复活已删会话、绕过归属决策）。阶段二不影响数据安全但影响可用性。

---

## 6. 修复时的纪律（沿用本仓库既有约定）

1. **行为级测试**：P0/P1 必须有「真实前提下的端到端断言」，不得用 `assert.match(源码字符串)` 代替。报告 P2-8 已指出这个倾向。
2. **每项修复做变异验证**：改坏实现 ⇒ 对应测试必须变红；改绿了说明断言无区分力。
3. **禁止恒真断言**：任何「数量不增」的断言前必须先断言非 0（`dffdf59` 刚修过一处）。
4. **双后端分别覆盖**：每条涉及「是否可同步」的判断，都要对 supabase 与 webdav 各写一次用例——本次 6 个缺陷里有 4 个正是漏了「双模式之一」这一侧。
5. **注释不得断言环境**：注释里不要写「测试环境没有 session 所以…」，这类说明会合理化真实缺陷。

---

## 7. 我的独立判断（与报告的差异）

报告整体准确，我确认其中 **5 项 P0/P1 全部成立**，另有 2 点补充：

1. **P1#3 与 P1#4 应合并成一类看待**：两者都源于「首次同步」这个概念没有单一的权威状态。三选一 UI 存在，但它不被任何地方记录。修法上建议引入一个持久化的 `firstSyncPending` 标志，同时解决 P1#3 的墓碑判断与 P1#4 的上传 gate，避免两套各自打补丁。
2. **报告未提到 P2-6 的性能影响量级**：`invalidateActiveSyncBackend` 每次触发会让下一次同步多跑一次 PBKDF2（`adapter.ts:165-193`），这在 250k 轮密钥派生下是可测的延迟。若设置页每次聚焦都触发，用户会感知。建议与 P1#1 的 `refreshBackendStatus` 改造合并处理。
