# TapStack 深度体检报告

> 日期：2026-10-05 ｜ 对象：HEAD `5450b82`（v1.22.9，工作区干净）
> 方法：五路并行只读审计（架构 / 数据与同步 / 安全 / 性能 / 测试与门禁）+ Mimosa deep 静态扫描 + 本机全量门禁实测
> 性质：只读体检，未改任何代码。

---

## 一、结论（TL;DR）

**总体健康度：良好，可继续发版，但有 9 个该排期的问题。**

- 数据安全主链路（单写者队列、fail-closed 读、删除广播按确认消费、读回校验三件套、meta-test 门禁）是同类项目里罕见的扎实，**当前 HEAD 无已成立的"丢用户数据"P0 路径**。
- 最重的两个问题都在"边界与降级路径"上：① 云端加密的密钥材料熵为零（用户 ID 与密文同行落库），本质是混淆而非加密；② y-indexeddb 更新日志无界增长，是全仓唯一随使用时间恶化的资源项。
- 三条 P1 正确性风险都与"删了又回来 / 永久卡死"直接相关（上传快路径绕队列、plain 降级模式读回误判、迁移升级边界复活），建议下一版优先处理。
- 工程防线的"最后 10%"有缺口：导入/导出解析器零测试、体积门未接线、发版脚本 publish 分支不校验结果。
- Mimosa 扫描报的 4 条 HIGH（SSRF）经核实**全部误报**（dist-web 是纯静态 SPA，无服务端运行时）。

---

## 二、最近版本改动（1.22.0 → 1.22.9）

主线：9-29 推翻墓碑模型 → 9-29~10-4 一轮同步可靠性加固 → 10-3~10-4 转向体验与性能打磨。商店现状：**线上 1.22.7，1.22.9 已于 10-4 提交审核**。

| 版本 | 日期 | 核心改动 | 上架状态 |
|------|------|----------|----------|
| 1.22.0 | 09-29 | **无墓碑模型**：删除即物理移除（废除回收站/墓碑），删除广播 = pendingDeleteIds + 云端 is_deleted 行 + TTL 30 天；合并 = 组级 LWW 整组覆盖 | 已提审 |
| 1.22.1 | 09-29 | 同步可靠性加固补丁：修掉一批会丢用户数据的同步缺陷（防误删云端数据、防探活烧额度、防设备卡死），建立真正的发版门禁 | 已发布 |
| 1.22.2 | 09-30 | 双栏视图空标签组重复渲染修复（按 id 去重 + 零标签组熄掉） | 已提审（被后续覆盖） |
| 1.22.3 | 10-01 | 列表刷新、乐观写回滚、覆盖上传防护三处修复；顺带修掉一批假绿门禁 | 未上架（并入 1.22.4） |
| 1.22.4 | 10-03 | 新增三套主题（Apple / Chrome / Claude 质感，主题收敛 7→6）；登录弹窗矮视口裁切修复 | 已发布 |
| 1.22.5 | 10-04 | 删除广播分批（修复清理大量重复标签时 URL 超网关上限→上传无限重试）；拖拽不再整页刷新；登录弹窗独立浮层 | 已发布 |
| 1.22.6 | 10-04 | 清理重复不再卡顿且给出结果反馈（批量登记，2000 条 9s→批处理）；同步弹窗信息对齐 + 矮视口修复 | 已发布 |
| 1.22.7 | 10-04 | 修复同步弹窗两张模式卡标题栏错位 | 已发布 |
| 1.22.8 | 10-04 | 迁移台账对齐（补齐 13 个直连数据库打的迁移，`db push` 恢复可对账）；清理脚本保留期文案 7 天→30 天更正 | 未上架（并入 1.22.9） |
| 1.22.9 | 10-04 | **点击跟手性**：上传/下载加解密改有界并发（数百会话 3s→1s 内）、tabSlice 乐观更新、修掉两处平方级计算、删除类竞态（在途删除被刷新/清理复活）统一剥离 + 失败放回列表提示；**视口懒渲染**（400 会话 DOM 从 10.2 万元素降到 1.5 万，点击→反馈 1.9s→0.23s）；**V3 门禁可见化**（yGate 按天聚合 + 四态判定 + 诊断导出/开发者面板同源）；CI 依赖审计收口 --prod 解除六连红 | 已提交审核 |

---

## 三、自动化验证实测（本机，2026-10-05）

| 项目 | 结果 |
|------|------|
| `pnpm test` | **884/884 通过**（79 个测试文件，21s） |
| `pnpm validate`（extension 校验 + 双 tsc + 双 eslint + vite build） | **通过** |
| `pnpm security:audit`（--prod） | **0 已知漏洞**（另有 18 条 pnpm overrides 钉版） |
| CI（GitHub Actions `Verify`） | main 最新 **绿**；1.22.4–1.22.8 曾六连红（dev 依赖审计常红），`fix(ci)` 收口到 --prod 后解除 |
| 构建产物 | 主包 169.8KB raw / 46.7KB gzip；yjs+dexie 异步 chunk 约 58KB gzip（低于 120KB 预算）；SW 静态图约 95KB gzip |

---

## 四、发现的问题

严重度：P0 = 数据丢失/安全，需尽快处理；P1 = 正确性风险；P2 = 技术债/边界；P3 = 小问题。

### P0

**P0-1 云端"加密"的密钥材料熵为零，本质是混淆而非加密**
`src/utils/encryptionUtils.ts:18-43`（keyString = userId，V2_DEVICE 再拼 deviceId）；密钥的两个组成部分与密文**存在同一张表同一行**（`src/utils/supabase/upload.ts:397-398`）。任何拿到数据库读权限的人（拖库、备份泄露、误开 service_role）可零成本解密全部用户浏览记录。AES-GCM + PBKDF2-100k 都救不了输入熵为零。
`README.md:65-68` 已自我声明"不是严格 E2E"，所以不是文案失实，而是**最值得修的安全债**。真正修法是用户口令/恢复短语派生密钥，或本地随机密钥+口令托管导出——换迭代次数没有用。
（两路审计独立确认：数据路定 P0，安全路定 P1。）

**P0-2 y-indexeddb 更新日志无界增长 + 每次 mutation 全量回放（量化待实测）**
`src/core/ydoc.ts:101-130`：每次影子写新建短命 Y.Doc 挂 `tapstack-y-v2`，`destroy()` 只断连不清库；压缩定时器（防抖 1s）永远活不到触发（会话只活几毫秒）。结果是每次 mutation：读全量历史逐条回放 + 净增 2 条 entry，单条 update 又因 `yTranslate.ts:147` 恒附加全量 order 序列而是 O(全体会话) 的。
估计重度用户一年积累 200-500MB，且回放成本线性上涨、发生在 SW 主线程单写者队列内，最终转成点击延迟。KV 侧的 Y 日志有 500 条/256KB 上限，唯独这条腿没有。**这是全仓唯一随使用时间无界的资源项**，同时打击存储、CPU、延迟。

### P1

**P1-1 `scheduleUpload` 的 setTimeout 快路径绕过单写者队列**
`src/services/syncEngine.ts:161-177` 直接调 `upload()` 不经 `enqueue()`，与 `service-worker.ts:156-160`"所有数据写动作经 mutationQueue 串行化"的设计承诺直接矛盾。`upload()` 内部有两组非原子读-改-写（广播删除、登记删除意图），与队列内 mutation 交错理论上可丢删除广播 → 对端复活。窗口窄，但这是全仓最核心不变量的破口。

**P1-2 消息协议三层都没有超时：云请求挂起可挂死整条队列和 UI**
`src/core/mutationProtocol.ts:33-50`（只处理 reject）、`src/utils/supabase/client.ts:99-107`（未配 AbortSignal，全目录无超时）、`mutationQueue.ts`（FIFO 无任务级超时）。`sync:upload` 排队首时若网络只是慢不报错，其后所有用户操作全部阻塞，唯一出路是重开 popup。

**P1-3 plain 降级模式下读回校验含"云端根本不存在的 id"→ 设备上传永久卡死**
`src/utils/supabase/upload.ts:743-756`：plain 分支用**全量**队列做墓碑读回校验；stamp 分支（`:824-825`）和 hard-delete 分支（`:850-864`）都刻意只校验 touchedIds（注释明说云端不存在的 id 视为达成）。于是"离线保存又离线删除、从未上过云"的组会让 plain 分支读回报错 → 上传整体失败、pending_upload 永不清 → 该设备既传不上也下不来，且同队列其他删除广播被连坐。

**P1-4 `purgeTombstones` 迁移删掉本地墓碑组却没把 id 转入 pendingDeleteIds → 升级边界复活路径**
`src/utils/migrationUtils.ts:107-131`：把 `isDeleted` 组从 storage 物理移除但不登记删除意图；它假设的"下一次 upload 兜底"（`syncEngine.ts:495` 读 storage）永远读不到已被删掉的组。凡"离线删除 + 墓碑从未上过云 + 升级到 1.22.x"，云端仍是活跃行，下次下载合并整组复活。修法一行：移除前把墓碑 id 批量登记进 pendingDeleteIds。

**P1-5 导入/导出解析器零行为测试——用户数据进出口裸奔**
`src/core/oneTabFormatParser.ts`（82 行，OneTab 格式双向解析）全 tests/ 目录零引用。解析器吞行、字段错位、往返不一致都不会让任何测试变红——正是仓库自己总结的"库函数全绿但没接线"的镜像形态（这次是"接了线但没人测"）。

**P1-6 体积门是"纸面门"**
`scripts/report-y-bundle.mjs:8-9` 自述不阻断构建、`:80-83` 超预算仅打印后 exit 0；未出现在 package.json、validate、CI 任何一环。而 `docs/v2-plan.md:214` 承诺"超预算告警阻断发布"——一条带过期安全感的假防线。

**P1-7（设计提示）无墓碑模型下删除链路没有任何 second copy**
本地删除即物理移除 + 云端 purge/TTL 后永久消失。这是拍板过的模型，不算缺陷；但它把全部完整性压力压在删除广播链路上——上面每一条 P1/P2 的低概率丢失都会变成"永久丢失、无找回"。值得考虑在云侧保留一条对业务不可见的延长软删窗口。

### P2（按主题归并）

**数据/同步：**
- 删除意图登记失败被 handler 吞掉，mutation 返回 ok:true → UI 谎报成功（`mutationHandlers.ts:72-84`，对照 storage 层精心设计的 fail-closed）。journal 本可兜底，但承诺的 WAL 重放从未实现（`journal.ts:3-4`），目前是 write-only 纯开销。
- 覆盖下载（forceRemote）预广播失败后继续执行，复活只有一行日志（`syncEngine.ts:230-245`）。
- 云端墓碑 TTL 清理在"安静账号"永不触发：客户端 purge 只挂在 upload（`syncEngine.ts:555-559`），无变更不再上传；服务端 cron 整段注释、未启用（`supabase/manual/tombstone_expiry_cron.sql:33-45`）→ is_deleted 行无限堆积。
- 墓碑广播逐行 UPDATE + 每行重新取号（`upload.ts:776-825`）：1000 条 ≈ 50-150s 串行网络调用，占住单写者队列。
- 迁移 verify 覆盖面与迁移集漂移：`scripts/supabase-migrate.mjs:83-126` 不核对 tiebreak（20260913）与 deleted_at（20260926），缺 tiebreak 的库也得 "✓ VERIFY OK"，与 1.22.8"零漂移"口径不完全一致。
- `getPendingUpload` 读失败静默返回 false（`storage.ts:628-635`），与同文件 fail-closed 纪律方向相反——读失败会让下载静默跳过"先上传后下载"保护。

**Redux/UI 一致性：**
- `moveTabAndSync.rejected` 是空 reducer，拖拽移动失败不回滚（`tabSlice.ts:784-786`，同类 thunk 都有快照回滚）。
- `saveSettings` 无 rejected 处理且调用方无 catch：设置开关 UI/存储漂移 + unhandled rejection（`settingsSlice.ts:18-24`）。

**安全（P2 级）：**
- 会话名 `name` / `is_locked` 明文上云（`upload.ts:393-396`）——会话名常含工作语境，与项目自己的脱敏标准不一致。
- Supabase JWT（refresh token）明文存 chrome.storage.local（`client.ts:74,99-107`），未走自家 SENSITIVE_KEYS 加密通道。
- `confirm.js:11` 死代码：邮箱验证 token 被取出拼进 URL 字符串但从未使用 + 硬编码真实项目 ref；未来"补全"这行就会把 token 送进无 redirect 校验的端点。
- deviceId 用 `Math.random` 生成（`deviceUtils.ts:14-17`）且参与旧版密钥派生；`secureStorage.ts:17` 的 SENSITIVE_KEYS 写的键名与真实存储键不匹配，那条加密规则从未生效。

**性能：**
- 每次 mutation 的固定 I/O 链仍是"全量 × 多份"：journal 全量读写 + groups 2.3MB 全量读写 + 取号 O(G×T) 全扫 + 影子链再跑一遍全量（Dexie 物化视图整表重写 ≈ 8400 行/次）——1.22.9 修的是上传段，队列里排在用户下一次点击前面的还有这整条。
- 60s 轮询先全量读本地 2.3MB 再探活（`syncEngine.ts:297-304`）：云端命中时读放大 ≈ 3.3GB/天。可先探活、命中复用缓存。
- popup 冷启动静态图约 637KB raw / 187KB gzip：`react-dnd` 的 lazy() 被 manualChunks 的 `id.includes('node_modules/react')` 规则击穿，约 30KB gzip 每次开 popup 都急加载（`vite.config.ts` + `MainApp.tsx:11-13`）。
- Web 端（dist-web）三处欠账：`fetchGroups` 逐行串行解密（400 会话 ≈ 3.6s，扩展端已并发 8 做 0.5s）；写操作无读回校验（服务端守卫静默吞写零感知）；Lamport 下限采样封顶 500 行且无 order by（`webApi.ts:231-247,371-399,304-316`）。加上 web 端是 SW 语义的第二套手工实现，长期漂移风险。

**工程：**
- 本地零强制门禁：无 pre-commit/pre-push（`.git/hooks` 只有 IDE 钩子），质量兜底全在 push 后的 CI；CI 又只在 main/PR 触发，feature 分支直推零门禁。
- e2e 数据规模过小：最大种子 20 会话/15 标签、全部 A/B 双设备——历史上翻车的"大数据量 + 多设备"场景结构性覆盖不到。
- `cws-publish.mjs` publish 分支不校验 HTTP 状态、失败 exit 0（`:113-116`；upload 分支是检查的）——发版链路最关键一步可能"以为发了其实没发"。
- 单测 glob 只在顶层（`tests/*.test.ts`），往子目录放测试文件会静默不跑且无报警——仓库在 e2e 运行器上已有"登记表即门禁"的解法，单测没享受同款。

### P3（略举）

- 新死代码：`useDebounce.ts` 零引用；`storage.clear()` / `getDeletedGroups()` 生产零调用——deadCodeGuards 是黑名单式，管不住新增死代码（未引入 knip 类工具）。
- `JOURNAL_KEY = 'journal'` 硬编码（`journal.ts:37`），与 `storage-kv/keys.ts:40` 同值不同源，恰是 keys.ts 头注释要杜绝的键名分叉。
- `dropEmptyGroups` 注释声称"锁定组豁免"但实现不看锁定态，与 cleanDuplicates 路径判据不一致（`syncEngine.ts:372-378` vs `mutationOps.ts:38-39,343`）。
- `escapeHtml` 不转义引号且当前零调用（`inputValidation.ts:248-252`）——建议删除或补引号转义。
- SW 每次唤醒固定多付 `contextMenus.removeAll()+create×3+alarms.create` 4 次 IPC；`ensureVersion()` 无进程内记忆，每次读写多一次 IDB 往返。
- 设置同步是整对象 LWW 云端全赢，两台设备并发改设置静默丢失（已接受设计，建议文档标注）。
- 版本号五处同步纯手工（有事后校验器兜底，无 bump 脚本）。

---

## 五、Mimosa 深度扫描结果与误报核实

- 扫描：`scan-2026-10-05T03-39-46.356Z-16c48de2a145`，深度 deep，静态分析（无运行时执行），封印 `sha256:19b966e1…`。依赖扫描 35 个包、0 命中漏洞；业务逻辑候选 0 条。
- 报告 4 条 HIGH，全部为 SSRF（CWE-918），定位在 `dist-web/assets/index-*.js`（构建产物）。
- **核实结论：全部误报。** SSRF 需要"服务端按用户提供 URL 发起请求"的服务端运行时；`vercel.json` 是纯静态托管（无 `api/`、无 serverless functions），dist-web 代码跑在用户浏览器里，fetch 目标是固定 Supabase 域名 + anon key。静态分析器把"浏览器端 fetch 带 URL 参数"误判成了 SSRF 污点链。无需处理。

---

## 六、做得好的（值得保持）

1. **单写者 + 语义命令 + 纯函数复用**：popup 乐观 UI 与 SW 落盘共用 `core/mutationOps` 纯函数，cleanDuplicates 双端用同一 plan 重推出逐字段一致的结果——把竞态类 bug 从逐个打补丁变成结构性消灭。
2. **读回校验三件套 + 写前认输预检**（`readback.ts` + `findConcededGroupIds`）：把服务端守卫的静默吞写变成显式失败，根治过"pending_upload 永久卡死"一类故障。
3. **fail-closed 读路径纪律**：groups/settings 读失败抛错而非降级，`clearPendingDeleteIds` 逐条点名语义堵死删除意图静默蒸发。
4. **门禁本身被测试钉住（meta-test）**：`gateScripts.test.ts` 钉 validate 覆盖面、`ciWorkflow.test.ts` 钉 CI 装 Postgres 且探测缺失即失败、`deadCodeGuards`/`docsAlignment` 把文档漂移纳入变红范围；e2e 运行器"存在但未登记 = 硬失败"。
5. **诊断导出的白名单式脱敏**（`diagnostics.ts`）：新字段默认不外泄，1.22.9 的门禁面板用真机 Playwright 实测过 url/title/userId/设备号零泄露。
6. **URL 三道正交白名单 + 消息路径双层消毒**：保存→入库→消息→渲染全链路无 `javascript:` 存活路径；manifest 权限 6 项均有实际调用点、无外部消息面、CSP `script-src 'self'` 全程无远程代码。

---

## 七、建议的修复顺序

1. **下一版修数据面三条 P1**（都是"删了又回来/永久卡死"类，直接打用户）：
   - P1-4 迁移复活边界：一行修复，收益/成本比最高；
   - P1-3 plain 读回校验对齐 stamp 分支口径（只校验 touchedIds）；
   - P1-1 上传快路径收口进队列。
2. **加密定位拍板**：要么真 E2E（口令派生/本地密钥托管，中大工程），要么在 README/商店文案明确"服务端可见混淆级"，并顺手评估 name/is_locked 是否入密文。不建议再拖——这是用户预期与服务端现实之间最大的落差。
3. **队列超时**：mutationProtocol 加超时 + supabase client 配 AbortSignal，小改动消除"挂死"类故障。
4. **y-indexeddb 无界增长**：最低成本方案是影子写完成后主动 `storeState` 压缩（或定期整库重建），先量化现网 `tapstack-y-v2` 实际体积再定。
5. **工程补线（可打包成一个"防线版"）**：导入/导出解析器单测、体积门接进 CI（超预算 exit 1）、cws-publish publish 分支校验结果、（可选）pre-push 跑 `pnpm validate`。

---

*审计明细（五路完整报告，含全部 file:line 证据）保留在会话记录中；本报告为归并去重后的结论版。*
