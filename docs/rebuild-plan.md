# TapStack 重构方案：Local-First + CRDT（指导文档）

> ⛔ **作废声明（2026-10-09，专家团体检 P1-1）**
>
> **本文不是「唯一指导源」，不得按本文实现任何东西。**
> 文首原句「影子双写上线，灰度 100% 开发全量」是**对已删除架构的虚假陈述**——
> 实测 `yjs` / `dexie` / `y-indexeddb` 在 `package.json` 与 `src/` 全量零残留
> （python 全仓扫描，两处命中均为说明「那三个包已删除」的历史注释）；
> `diagnostics.ts:41` 明确记录「2026-10-05 瘦身：移除 gate / shadow / audit 三段」。
> 自称「唯一指导源」却陈述一个不存在的状态，比没有文档更危险：
> 下一个人（或下一个 AI）会照它去实现一遍 CRDT 影子双写。
>
> 一份**说谎的文档是主动误导**。要么删、要么横幅作废，二者必须选一——
> 本文件选择横幅作废：保留决策痕迹供回顾，但把「照此实施」这条路封死。
>
> | 章节/对象 | 状态 | 说明 |
> |---|---|---|
> | 「影子双写上线，灰度 100%」 | ❌ 已被推翻 | 影子双写相关包与代码于 2026-10-05 全部删除（净删 5678 行，`db09f10`） |
> | 「本文档是重构唯一指导源」 | ❌ 作废 | 现有唯一有效指导见 `docs/v2-plan.md`（其文首有逐条状态表） |
> | Yjs / Dexie / y-indexeddb 架构章节 | ❌ 作废 | 依赖已从 `package.json` 移除，`src/` 零引用 |
> | `y_audit_log` / `y_shadow_log` / `gate` / `shadow` / `audit` 段 | ❌ 已删除 | 诊断三段已于 2026-10-05 移除；`UnavailableSource` 的 `shadowAudit` 取值是待清的死残留 |
> | Web 仪表盘章节 | ⛔ 待决 | `src/web/` 已删，但线上 `tapstack-two.vercel.app` 仍部署着旧版（见本轮体检报告）——去留由负责人决定 |
> | 各阶段的历史决策与被推翻的理由 | ✅ 仍有价值 | 仅作为决策痕迹回顾，不作为实施依据 |
>
> 为什么本文件不直接删除：它是判断过程的记录，删除会丢掉「当时为什么这么选、
> 后来为什么推翻」的知识。但**知识资产必须标明自己的时效**，否则就是误导。

> 状态：S1–S5、V2 已完成（影子双写上线，灰度 100% 开发全量，体积门通过），V3 待决策。本文档是重构唯一指导源，阶段状态在此更新。
>
> ⚠️ **上面这行状态已作废** —— 原文保留在此仅供对照，以文首 ⛔ 作废声明为准。
>
> 门禁可观测性（2026-10-04 补）：V3 的进门条件（P1 验收：对账差异率 < 0.1% 持续 7 天，见
> `v2-plan.md`）此前**没有任何读取方**——`y_audit_log` / `y_shadow_log` 只写不读，
> 于是门禁从未被执行、V3 无法拍板。现已补上读路径：`y_audit_daily` 按天滚动聚合
> （逐条日志 FIFO 50 条比 7 天窗口短，靠它无法证明「持续」）、诊断导出新增 `gate`/`shadow`/`audit`
> 三段、以及菜单「影子对账（开发者）」面板。判定是四态（达成/未达成/覆盖不足/无数据），
> **「无数据」与「覆盖不足」不得被读成通过**。
> 原则：Spec-First —— 先定接口与验收标准，再写实现；绞杀式演进，不搞大爆炸重写。

## 0. 诉求边界

- **不变的核心**：all tabs（一键收纳全部标签）+ 多端同步 + 会话管理。这是产品的命，其他都可以推倒。
- **允许重来**：数据模型、同步协议、存储分层、安全模型、Web/扩展双端实现。UI/交互维持现状（此前已修复点击跟手性，不借机改交互）。

## 1. 现状枷锁（为什么必须重构）

| # | 枷锁 | 代价（已付/在付） |
|---|------|------------------|
| 1 | 整组 JSONB 快照 blob：改 1 个 tab 重写整组 | egress 爆炸、组级合并必丢并发、digest 探活等一整套代偿 |
| 2 | 在 MV3 里假装有常驻 daemon | 30s 缓存/防抖落盘/pending 标志/双驱动调度，F1/F9 类 bug 是结构必然 |
| 3 | 冲突仲裁塞进 DB 触发器（RETURN NULL 静默吞写） | “感觉没同步但无错误”的根源，难测试难观测 |
| 4 | 半吊子安全：密钥派生自 userId + 墓碑长期留云 | 有加密之形无 E2EE 之实，与删除直觉冲突 |
| 5 | Web 与扩展各写一套同步语义 | 漂移是注定的（统计含已删标签 bug 即例证） |

## 2. 目标架构

```
┌─────────────┐  ┌─────────────┐
│ 扩展 popup   │  │ Web 仪表盘   │   UI 永远只读本地，瞬间响应
└──────┬──────┘  └──────┬──────┘
       │  @tapstack/sync-core（共享包：唯一真相的语义）  │
       ▼                ▼
┌─────────────────────────────────────┐
│ 本地真相源：Y.Doc（CRDT）+ Dexie 物化视图（查询/排序/搜索）│
└──────────────┬──────────────────────┘
               │ op log（加密 Y-Update，增量）
               ▼
┌─────────────────────────────────────┐
│ Supabase：sync_updates（append-only log）+ sync_snapshots（compact 快照）│
│ Auth/RLS 复用；实时用 Broadcast 只发“有新 seq”通知，拉取走 HTTPS      │
└─────────────────────────────────────┘
```

- 同步从“传快照”变“传操作”，流量降 1~2 数量级；并发在数学上可合并，**不再有输家**。
- SW 只做无状态搬运（推拉 op log），可随时被杀；MV3 对抗复杂度归零。
- 合并/过滤/加解密只有一份实现，双端漂移结构性消失。

## 3. 技术选型决策（已定，不再讨论）

- **CRDT：Yjs 13.x**。纯 JS 跑在 module SW（无 WASM/CSP 问题），~50–70KB gzip；Automerge 因 WASM 体积（~1MB+）与 MV3 `wasm-unsafe-eval` 审核面出局。Yjs 删除=DeleteSet 天然防复活；move 建模为 delete+insert（应用层 id 幂等）。
- **查询层：Dexie**。Y.Doc 是真相源不是数据库，排序/搜索/过滤/分页走 Dexie 物化视图（`tab_groups`/`tabs`，索引 groupId/updatedAt/is_deleted）。现有 `mutationProtocol` 语义 op 保留为 UI→core 命令层，core 内翻译成 Yjs 事务并双写视图。
- **同步管道：自建 Y-Update log over Supabase（方案 A）**。零新运维，复用 Auth/RLS/Postgres，与现有迁移路径最短。y-websocket 自建（运维）、Workers DO（新增厂商+鉴权桥接）、托管同步（费用+数据主权）均否决；DO 仅在“实时 presence/共编成刚需”时重议（`sync.ts` 预留传输抽象）。
- **E2EE：应用层 AES-GCM-256（WebCrypto，MV3 可用）**。每用户随机 DEK，KEK=Argon2id(passphrase)；多设备经恢复码/二维码递送 DEK。Y-update 先加密再入库，服务端只见密文，RLS 仍按 user_id 隔离。**密钥丢失=不可恢复**，恢复码 UX 是 P0（否则客服压力）。旧“userId 派生密钥”做法废除。
- **体积门**：引入后扩展 build gzip 增量 >120KB 即告警。

## 4. 数据模型

Y-Schema（`packages/core/ydoc.ts`）：`groups: Y.Map`、`tabs: Y.Map`、`order: Y.Array`。
同步表：
`sync_updates(doc_id, user_id, seq, base_vector, update密文, created_at)`，RLS 按 user_id；
`sync_snapshots(doc_id, snapshot, up_to_seq)`。compact 阈值：log>500 条或 >256KB（DeleteSet 膨胀必须截断）。
传输只做 `encodeStateAsUpdate` / state-vector diff；Broadcast 只发通知不传大包。

## 5. 绞杀路线（分期，每期独立可发版）

- **S1 抽共享纯函数（执行中）**：建 `packages/core`（或先 `src/core` 过渡），搬运 P0（`opStamp/normalizeTabsData/tabDataCodec/oneTabFormatParser/tabGroupUtils/versionHelper/authGuard/hydrationDecision/syncUtils` 纯决策四函数，零依赖）+ P1（`opStampMerge/mutationOps/mutationProtocol`）；`tabSlice`/`webApi` 改 import；单测锁定。验收：tsc+全量单测绿，行为零变化。
- **S2 存储 KV 收敛**：`storageAdapter+drivers+键常量` 进共享包；`storage.ts` 与 `supabaseSharedStorage` 同源。保留防抖/直写双路径语义（MV3 被杀窗口，不可合并）。
- **S3 拆上帝模块**：`supabase.ts`(1637行) 拆 `client/probe/upload/download/readback`，先抽 `SupabasePort` 接口再搬实现（禁硬抽，登录态/RLS 会话易碎）；`tabGroupSyncService` 依赖接口。
- **S4 单写者收口**：`tabSlice` 旧直写路径全代理为 `sendMutation`；废弃 `mergeTabGroups/mergeTabs` 删除或隔离 legacy（禁接回生产，否则回退 version-LWW）。
- **S5 统一删除语义**：Web deleteTab 改发墓碑命令（或带 stamp 的重加密回写），消灭 R2 口径差；单测锁定两种形状往返。
- **V2 影子双写**：Y.Doc 落地，双写 blob+op log，读仍走 blob；灰度按用户切。
- **V3 切读路径**：读走 Dexie 视图 + Y 合并；compact/快照回填旧列；下线 blob 列与触发器守卫。

## 6. 测试与可观测（地基，不是点缀）

每期必备：tsc 干净、全量单测绿、ESLint 零警告；双端往返单测（墓碑/印记两种形状）；同步状态面（pending/lastUpload/冲突数/digest 命中率）进设置调试页；后台失败转用户可见提示。V2 起要求真机双端并发 + 弱网 + 密钥丢失恢复实测。

## 7. 风险与回滚

- S1–S5 均为纯搬运/收敛，行为零变化，回滚= revert。
- V2/V3 按用户灰度，快照回填旧列保留逃生通道；E2EE 切换期双轨解密（旧 userId 派生仅用于迁移 DEK 加密）。
- 最大风险：Yjs compact 运维债与 E2EE 恢复码 UX，前者定阈值+单测，后者发版前必须可用。

## 8. 执行清单

- [x] S1 共享纯函数抽取（已完成：src/core + re-export，tsc/单测/eslint/vite 全绿）
- [x] S2 存储 KV 收敛（已完成：src/storage-kv + re-export，tsc/单测/eslint/vite 全绿，行为零变化）
- [x] S3 supabase.ts 拆分（已完成：SupabasePort 接口+8 模块+16 行门面，251 单测全绿）
- [x] S4 单写者收口 + 废弃合并隔离
- [x] S5 删除语义统一（已完成：webTombstone+墓碑命令+门禁，259 单测全绿）
- [x] V2 影子双写 + 灰度（已完成；开发阶段灰度已拉满 100% 加速验证，277 单测全绿）
- [x] V3 门禁可见化（`y_audit_daily` 按天聚合 + 诊断导出 `gate` 段 + 影子对账面板：门禁在此之前**无读取方**，信号被采集却无人能看见，V3 因此无法拍板）
- [ ] V3 切读 + 下线 blob/触发器（前置：门禁判 pass，或 Jasper 明确接受未验证风险）
- [ ] E2EE 恢复码 UX + 发版说明（含 removeTab stamp 语义变化）
