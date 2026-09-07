# 同步层重构设计：单写者 + 操作印记

日期：2026-09-07
状态：已与需求方逐节确认，待实施
范围：tab_groups / tabs 数据的本地写入、云端同步与合并；用户设置同步不在本期范围

## 1. 背景与根因

### 1.1 事故

用户在单机上"保存当前窗口"后，标签管理器中未出现刚保存的会话；重开 popup 或重新保存后恢复。经代码走查确认了如下竞态时间线：

```
t=0    打开 popup → AuthProvider 自动触发 downloadAndMerge()
       ├─ 拍本地快照（不含将要保存的组）
       └─ await 下载云端（网络往返 1~3s）
t≈1s   用户点击"保存当前窗口" → popup 发消息给 SW
       └─ SW 把新组写入 chrome.storage（数据已落盘）
       └─ 保存流程关闭已保存标签 → popup 随之关闭
t≈2-3s popup 的下载合并跑完
       └─ 把「t=0 快照 + 云端」的合并结果整体写回 chrome.storage
       └─ 刚保存的组被抹掉
```

### 1.2 根因清单

| # | 根因 | 位置 |
|---|------|------|
| R1 | popup 与 SW 是独立执行环境，各自读写 chrome.storage 做"读-改-写"，`isSyncing` 锁是进程内单例，跨进程无效；谁后写谁赢 | syncEngine.ts（popup 与 SW 各持一个实例）、TabManager.saveAllTabs、autoSyncMiddleware |
| R2 | 下载流水线只在入口做一次前置守卫，写回前不重读最新本地数据，拿旧快照整体覆盖 | syncEngine.downloadAndMerge |
| R3 | `updateGroup` 用"UI 传入的 tabs"diff 出墓碑，UI 状态过旧时会误杀刚合并/刚保存进来的标签（意图问题，与并发无关） | tabSlice.updateGroup |
| R4 | 合并结果把 `updatedAt` 改写为合并时刻，第二次合并比较的是"上次合并时间"而非用户操作时间，"谁新谁赢"启发式退化 | syncUtils.mergeGroup |
| R5 | 跨设备同 URL 不同 ID 的重加标签被 URL 墓碑误杀（自认取舍） | syncUtils.mergeTabs |
| R6 | 所有上传防抖（1.5~3s）实际被 chrome.alarms 最小间隔拖成 ≥30s，扩大了未上传窗口 | syncEngine.scheduleUpload |

### 1.3 设计哲学

病根是"用快照对比去猜操作意图"。本设计把需求方提出的"binlog 记录单"蒸馏后落地：**操作是持久化的一等记录，但日志的信息被"折叠"进每条数据的操作印记**——合并时逐实体比印记，不需要重放引擎、不需要日志压缩方案（journal 仅作 write-ahead 崩溃恢复）。

## 2. 目标与非目标

**目标**

1. 一台设备内任何本地操作（保存/删除/点开/改名/拖动/导入/清理）与任何同步动作并发时，不丢失任何一方意图。
2. 多设备合并结果确定：与合并顺序、合并次数无关（交换律、幂等、收敛）。
3. 删除意图跨设备可靠传播；误删可恢复（保留软删 + 恢复语义）。
4. 存量数据与云端行平滑迁移，迁移后新旧语义不混用。
5. MV3 约束下可靠：SW 随时被杀不丢已确认的操作。

**非目标**

- 用户设置（settings）的冲突合并维持现状。
- Web 端仪表盘的交互重构（仅收编其写入语义，见 §7）。
- 实时推送（websocket/轮询推送），保持 alarm 轮询模型。

## 3. 总体架构：单写者 + 语义命令

### 3.1 写入权收敛

**SW 是唯一**有权修改 chrome.storage 中 groups、唯一有权读写云端 `tab_groups` 的进程（Web 仪表盘例外，见 §6.2）。

popup / Web 端不再自己执行任何 downloadAndMerge / upload / storage 写。UI 层职责收敛为：

1. **发语义命令**：`chrome.runtime.sendMessage({ type: 'MUTATE', op: ... })`；
2. **乐观更新** Redux（保持 UI 即时响应）；
3. **订阅对账**：`chrome.storage.onChanged` 监听 groups 变化，回填 Redux（替代现有 REFRESH_TAB_LIST 手动广播 + 30s 缓存 TTL 机制）。

### 3.2 语义命令替代全量补丁

今天 UI 通过"传入过滤后的 tabs"表达删除（R3 根因）。新设计中 UI 只发**语义命令**：

```
OPEN_TAB(groupId, tabId)        // 点开=移出该标签
DELETE_TAB(groupId, tabId)
DELETE_GROUP(groupId)
RESTORE_GROUP(groupId)
SAVE_GROUP(groupPayload)        // 新建会话
IMPORT_GROUPS(payload)
RENAME_GROUP(groupId, name)
TOGGLE_LOCK(groupId)
MOVE_GROUP(fromId, toIndex) / MOVE_TAB(...)
CLEAN_DUPLICATES()
```

SW 的 `mutationService` 收到命令后基于**队列时刻的最新状态**执行操作——`OPEN_TAB` 就是"墓碑化这一个 tabId"，不存在 diff，R3 从结构上消失。

### 3.3 mutation 队列

SW 内一个 FIFO promise 队列，成员包括所有语义命令、`upload`、`downloadMerge`。串行执行保证：

- 任何写路径执行期间没有并发写；
- 下载合并的"快照→合并→写回"窗口内不可能插入用户操作（R2 从结构上消失；快照仍保留，仅作失败回滚）；
- 上传读到的状态总是已提交状态。

### 3.4 Redux 层改造方式

tabSlice 现有 thunk **签名不变**（组件零改动），内部改为：乐观 reducer + 发命令 + 回执/onChanged 对账。加载类 thunk（loadGroups 等）保留在本地（读 storage 是无害并发）。

## 4. 数据结构

### 4.1 OpStamp

```ts
interface OpStamp { d: string; s: number }  // d=设备ID, s=单调递增序号
```

- `TabGroup.lastOp?: OpStamp`；`Tab.lastOp?: OpStamp`；墓碑即 `isDeleted: true` 且带删除操作的 `lastOp`。
- 设备 ID 复用现有 `getDeviceId()`（deviceUtils.ts，chrome.storage 持久化 UUID）。Web 端用独立命名空间（§7）。
- 每台设备持久化 `seq`；SW 启动时修复：`seq = max(持久化seq, 全部实体印记中本设备最大s) + 100`，保证序号永不回退、跳号无害。

### 4.2 印记比较（全序，收敛的数学前提）

```
compare(a, b)：
  a.s ≠ b.s        → 数值比较
  a.d ≠ b.d        → 字符串字典序
  都相等           → 比较 updatedAt，再比实体 id
```

任何两台设备对同一对候选项必须算出同一个赢家。

### 4.3 本地 journal（write-ahead log）

- chrome.storage 独立 key，有界数组（上限 1000 条，FIFO 裁剪）。
- 条目：`{ d, s, ts, type: 语义命令类型, groupId?, tabId?, payload? }`。
- 写序：`seq++` → **journal + seq 一次 `storage.local.set` 落盘**（先于状态）→ 应用状态 → 落盘状态。
- SW 被杀中断时，重启后重放 journal 中"印记高于当前状态对应实体"的条目——重放规则与合并规则同一条，天然幂等。
- 云端确认判定：upload 成功后，journal 中 `s ≤ 本次上传快照内最大 seq` 的条目标记已确认；journal 条目保留至被裁剪，仅用于崩溃恢复与调试视图。

## 5. 合并规则

### 5.1 组级

本地组集合 G_l 与云端组集合 G_c 按 id 求并集；同一 id 比印记，赢家整组胜出。`isDeleted: true` 的组是墓碑，同样参与比印记：

- 赢家是活跃组 → 组存活；
- 赢家是墓碑 → 组不进活跃视图，墓碑保留在 storage/云端用于传播（直到 GC，§8）；
- 恢复 = 对实体盖更新印记并置 `isDeleted: false`，天然赢过旧墓碑（现有 restoreGroup 语义平移）。

### 5.2 组字段

- `name` / `isFavorite` / `displayOrder`：跟随组印记赢家（整字段 LWW）。拖动排序 = 盖组印记的语义命令，跨设备并发排序整组决出单赢家（接受此粒度）。
- `isLocked`：保持现有逻辑或（任一锁定即锁定）。
- `notes`：保持现有本地优先（设备本地元数据，不参与争抢）。
- `version` 字段冻结，不再参与任何判定（云端列保留兼容）。

### 5.3 标签级

组内标签按 tab id 求并集，逐个比印记；墓碑同理。标签操作只盖 **tab 自己的印记**，不动组印记——A 设备加标签不会导致 B 设备的组名修改被回滚。

### 5.4 URL 去重（确定性化）

同 URL 存在多个活跃标签时：印记最高者胜，败者盖墓碑。合并产生的墓碑属于合并设备的一次变更操作：盖 `{ d: 本设备, s: ++seq }` 印记并照常入 journal，与用户操作走同一写路径。两台设备独立合并必选出同一个败者（印记全序保证），结果收敛。**【已拍板】**跨设备"同 URL 重加"从"被误杀"（R5）变为**存活**：重加是独立实体、印记更新，符合用户意图。

### 5.5 保留的安全网

`validateMergeResult`（合并结果低于预期最小值则回滚）保留；`decideDownloadPrecheck` / `UPLOAD_GUARD_MS` 保留（减少无谓网络与竞态面，不再是正确性的承重墙）。

## 6. 云端 Schema 与第三方写入方

### 6.1 Supabase `tab_groups` 变更

新增两列（可空）：

```sql
last_op_device text;
last_op_seq    bigint;
```

- 空印记视为全序最小值：存量云端行首次合并必输给任何带印记的本地实体。
- 标签印记内嵌在 `tabs_data` JSON 中，无需改列。
- 上传仍为行级 upsert；`markCloudGroupsAsDeleted` 简化为"直接写删除印记"（省去现有"读旧 version 再写回"的一次往返）。

### 6.2 Web 仪表盘（第三个写入方）

现状：webApi.ts 直接对 `tab_groups` 行级写入（改名、恢复、彻底删除）。收编规则：

- Web 端维护自己的设备标识（`web-` 前缀 + localStorage UUID）与本地 seq；
- 其行级写入（update）必须带上自身印记 `{ d: webDeviceId, s: ++seq }`；
- 扩展端下载时按全序比较，Web 改名与本地操作确定性决出胜负；
- 行级 delete（彻底删除）不参与印记，维持现状（属 GC 类操作）；
- Web 端读取时忽略空印记行的冲突判定（视为最小值），与扩展端口径一致。

## 7. 迁移

1. 云端 ALTER TABLE 加列（可空，无需回填）。
2. 本地存量数据一次性迁移：所有实体盖 `{ d: 'legacy', s: 老 version || 1 }`；本设备 seq 初始化为 `max(实体印记s) + 1000`，避免与 legacy 段撞号。
3. 现有墓碑原样保留（isDeleted + version → 迁移为 isDeleted + legacy 印记）。
4. 迁移幂等：已带印记（d ≠ 'legacy' 或含非空 lastOp）的实体跳过。
5. 迁移在 SW 启动与 popup 启动两处入口各做一次检查（storage 版本号守卫）。

## 8. 墓碑压缩（GC）

- 条件：墓碑印记已被云端确认（upload 成功）且墓碑年龄 > 30 天 → 物理清除（本地移除、云端行删除）。
- 已知代价（文档写明）：离线超过 30 天的设备重新上线时，若其对端已 GC，可能出现被删项复活。个人工具场景可接受。
- GC 由后台 alarm 低频执行（每日一次）。

## 9. 触发策略与发布顺序

**【已拍板】不做半自动过渡态**，发布顺序本身是安全边界：

1. **阶段一（单写者）**：§3 全部落地。阶段一合入即恢复全自动同步（触发器不变：popup 打开下载、60s 后台轮询、操作后防抖上传；R6 的 30s 下限属体验问题，顺带用 setTimeout + SW keepalive 优化，不阻塞）。
2. **阶段二（操作印记）**：§4/§5/§6/§7 落地，合并语义切换。
3. **阶段三（加固）**：§8 GC、调试视图（journal/印记/最近合并决策）、性质测试补全。

## 10. 测试策略

- **合并性质测试**（验收"确定性"）：交换律 `merge(A,B) ≡ merge(B,A)`、幂等 `merge(A,A) ≡ A`、收敛 `merge(merge(A,B),C) ≡ merge(A,merge(B,C))`，覆盖组/标签/墓碑/URL 去重/恢复全分支。
- **崩溃重放**：journal 写入后进程死亡模拟，重放结果与正常路径一致。
- **队列串行化**：交错命令+上传+下载合并，断言无交错写。
- **迁移**：存量数据回填幂等、云端空印记行首合并必输。
- **既有测试保留并适配**：tabTombstone、syncMergeSafety、normalizeTabsData、hydrationDecision、autoDeleteEmptyGroup 等全部迁移到新语义（它们是历年踩坑的沉淀）。

## 11. 既有机制去留

| 机制 | 去留 | 说明 |
|------|------|------|
| 组级软删墓碑 | 保留 | 盖印记 |
| 标签级墓碑 | 保留 | 盖印记；UI 侧不再需要"过滤 tabs 表达删除" |
| `pending_upload` 标志 | 保留 | 语义升级：journal 有未确认条目 |
| `version` 字段 | 冻结 | 云端列保留，不参与判定 |
| `decideDownloadPrecheck` / `UPLOAD_GUARD_MS` | 保留 | 降级为优化项 |
| `validateMergeResult` | 保留 | 安全网 |
| REFRESH_TAB_LIST 广播 | 废弃 | 被 `storage.onChanged` 替代 |
| 30s groups 缓存 TTL | 保留 | onChanged 主动失效后仅兜底 |
| 误删保护 / 回收站视图 | 保留 | 语义不变 |

## 12. 已决策事项记录

1. 需求方"binlog 记录单"方案：采纳其思想（操作一等公民、持久化、按时间线），修正为"印记折叠进实体"，不做独立重放引擎。—— 2026-09-07
2. 手动/半自动同步方案：否决为过渡态；全自动为最终形态，阶段一合入即恢复。—— 2026-09-07
3. 跨设备同 URL 重加：由"误杀"改为"存活"（§5.4）。—— 2026-09-07
4. 发布顺序：阶段一 → 恢复全自动 → 阶段二 → 阶段三，无半自动窗口。—— 2026-09-07
