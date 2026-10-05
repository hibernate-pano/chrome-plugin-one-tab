# TapStack 深度体检报告（第二轮）

> 日期：2026-10-05 ｜ 对象：HEAD `3587668`（**v1.22.11**，工作区干净）
> 方法：本机全量门禁实测 + 三路并行只读审计（数据同步 / 安全 / 性能与门禁）+ 关键项**量化实测**（真实 yjs 复现单次写入体积）
> 性质：只读体检，未修改任何代码。上一轮报告见 `docs/health-check-2026-10-05.md`（基线 v1.22.9）。

---

## 一、结论（TL;DR）

**先给最重要的一句：静态门禁是绿的，但绿不等于健康。**

本机实测：单测 **903/903 通过**、`pnpm validate` **通过**、生产依赖审计 **0 漏洞**。也就是说，当前项目"严重的问题"**不在现有门禁能覆盖的范围内**——这本身就是本轮最重要的结论。

**总体健康度：主链路健康、边界有洞。发现 2 条 P0、4 条 P1、约 20 条 P2。**

1. **【P0·新增】云端 `profiles` 表对匿名开放全表读**：库里每一行的邮箱 + Stripe 客户/订阅字段，任何拿到公开 anon key 的人都能批量拖走。而 anon key 随扩展与网页版产物公开。**这是一条数据泄漏级问题，与上一轮体检无关，属本轮新发现。**
2. **【P0·遗留】y-indexeddb 更新日志无界增长 + 每次写入全量回放**：上一轮列为 P0 时还标注"量化待实测"，**本轮已完成量化**：单次 mutation 增量 6.1 KB（对照最小增量 0.22 KB，**放大 27.9 倍**），IDB 只增不减、每次打开回放全部历史。这是全仓唯一随使用时间恶化的资源项。
3. **【P1·新增】线上日志证实：部分会话"存得下、回不来"**（第七节）。保存侧与还原侧各有一张 URL 协议白名单且互不相同，导致 `file://` / `blob:` 等标签**可保存可上传、但永远无法还原**；还原率判据按整组生效，会把同组正常标签一起隐藏。**该组在这些设备上永久不可见、且跨设备同步事实上冻结。**
4. **【P1·新增】超过 45 个标签的会话被 CSS 裁掉且不可滚动**：`max-h-[2000px]` / 行距 44px。对"一次收纳整窗标签"的产品定位，这是常见路径。
5. **上一轮的三条 P1 已确认全部修复**（本轮逐条给出代码证据，见第六节），且**新引入的队列分车道经逐条验证无正确性风险**。
6. **未发现已成立的"丢用户数据"P0/P1 路径**（数据路审计独立确认；第七节的两组卡死会话也核实过云端行与本地副本都不会被删）。

---

## 二、自动化验证实测（本机，2026-10-05）

| 项目 | 结果 |
|------|------|
| `pnpm test` | **903/903 通过**（83 个测试文件，21s；测试代码 20.1k 行 vs 源码 26.1k 行） |
| `pnpm validate`（元数据 + 双 tsc + 双 eslint + vite build） | **通过** |
| `pnpm audit --prod` | **0 已知漏洞** |
| popup 首屏急加载体积 | **747 KB raw / ≈213 KB gzip**（含 `supabase-vendor` 111 KB raw，未登录也加载） |
| CI（`Verify`） | main 最新绿；含**真实 Postgres** 拉起 `opStampGuard.pg.test.ts`，且探测缺 bin 即红（设计扎实） |

---

## 三、P0（需尽快处理）

### P0-1 `profiles` 表 `FOR SELECT USING (true)` —— 全站邮箱 + Stripe 字段对匿名开放

**证据链**

1. 建表即埋（`supabase/migrations/20260303044037_create_profiles.sql:7-35`）：
   - 列包含 `email`、`plan`、`stripe_customer_id`、`subscription_id`、`subscription_status`、`ai_usage_count`；
   - `:28` `"Users can view own profile"`（`auth.uid() = id`）；
   - `:34-35` `CREATE POLICY "Anyone can view public profile fields" ON profiles FOR SELECT USING (true);`
2. 后续迁移**主动删掉了"仅自己可见"那条，却保留了全开那条**（`supabase/migrations/20260923160000_fix_rls_initplan.sql:72-82`）：
   ```sql
   DROP POLICY "Users can view own profile" ON public.profiles;
   ```
   文件头注释的理由是「`USING (true)` 已经放行所有行，删掉它消除 `multiple_permissive_policies` WARN，**语义零变化**」。
   ——这个推理对**被删那条策略的效果**是正确的，但它把 `USING (true)` 当成了「本来就该有的公开字段策略」。实际上 RLS 策略是**或集**关系：只要有一条 `USING (true)`，`email` / `stripe_*` 就全部对匿名可见。
3. 攻击面是公开的：生产项目 ref `reccclnaxadbuccsrwmg` 已内嵌在**已上架扩展**的产物里（`dist/utils-BcnH0696.js`、`dist/confirm-Bav2sq_4.js`）与**公网网页版**产物里（`dist-web/assets/index-*.js`）。anon key 按 Supabase 设计就是公开的。
4. 全仓**没有任何 `REVOKE`**，也没有其它迁移收紧过这张表——即最终态就是这条宽策略。

**影响**：任何人不需登录，用公开 anon key 打 PostgREST `/rest/v1/profiles` 即可拖走全站用户邮箱与订阅信息。

**必须先做的一步核实**：Supabase 对 `public` schema 的表默认给 `anon` 授了 SELECT（本仓迁移里看不到 GRANT，属平台默认）。请到 Supabase Dashboard 用一次 `select * from profiles limit 1;`（以 anon 身份）或查 `Database → Policies` 确认。**我没有、也不会去实际请求生产库——那等于未授权访问他人数据。**

**附带（同表，P1）**：`"Users can update own profile"` 只有 `USING ((select auth.uid()) = id)`，**没有 `WITH CHECK`、也没有列级限制**。任何登录用户可自助执行 `update profiles set plan='pro'` / 重置 `ai_daily_count`。`plan` 的 CHECK 只约束取值域是 `free|pro`，不拦人。

**好消息**：`profiles` / `ai_usage_logs` / Stripe 相关字段在当前代码中**零引用**（`src/` 全局搜不到），是 Dashboard 时代留下的遗留表。修法因此很干净：

- 首选：`DROP POLICY "Anyone can view public profile fields" ON public.profiles;`（若表确实无人用，直接 `DROP TABLE`）；
- 若确有"公开档案"需求：改用只暴露非敏感列的视图，不要用表级 `USING (true)`；同时给 UPDATE 补 `WITH CHECK` 并限制可更新列。

### P0-2 y-indexeddb 更新日志无界增长 + 每次 mutation 全量回放（已量化）

**机制**

- 每次影子写都新建短命 Y.Doc 并挂 `y-indexeddb`（`src/core/ydoc.ts:101-110`），`finally` 里立刻 `destroy()`（`:122-130`）。
- y-indexeddb 的压缩是**防抖 1000ms 后**执行（`y-indexeddb/src/y-indexeddb.js:111-120`，`PREFERRED_TRIM_SIZE = 500`），而 `destroy()` 第一件事就是 `clearTimeout(this._storeTimeoutId)`（`:128-131`）。**定时器永远等不到触发**——每次 open 写入的那条 update 之后，压缩就被取消了。因此 IDB 里的 update 行**只增不减**。
- 另外 `:87` 每次 open 都会写一条 `Y.encodeStateAsUpdate(空 doc)`，即**光是打开就 +1 行**。
- 打开时 `fetchUpdates` 从 `_dbref = 0` 起 `getAll`（`:18`）→ **每次打开都回放全部历史**。
- 每次写入体积被放大：`src/core/yTranslate.ts:147` 无条件产出 `setOrder` 计划，`src/core/ydoc.ts:62-63` 执行 `order.delete(0, order.length)` + `push(整份顺序)` —— 即使顺序没变，也把整个 order 数组重写一遍。
- `needsSnapshot` 被算出来（`src/core/yShadow.ts:146`）但**只被诊断导出读取**（`src/utils/diagnostics.ts:672-679`），没有任何东西据此执行压缩。
- 开关是**全量开启**：`src/core/yShadowConfig.ts:19,22` → `SHADOW_WRITE_ENABLED = true`、`SHADOW_ROLLOUT_PERCENT = 100`。

**量化实测**（用项目真实 yjs，复现 `plansToDoc` 语义；规模 400 组 × 20 标签）

| 指标 | 值 |
|------|-----|
| 初始整库状态 `encodeStateAsUpdate` | 2.2 MB |
| **单次 mutation 增量（含 order 全量重写）** | **6.1 KB** |
| 对照：只改一个组、不重写 order | 0.22 KB |
| **放大倍数** | **27.9×** |
| 累计 1,000 次 mutation → IDB 常驻 | ≈ 6 MB |
| 累计 20,000 次 | ≈ 118 MB |
| 累计 50,000 次 | ≈ 296 MB |

关键不是"IDB 占多少兆"，而是**回放成本随使用时长线性上涨**：第 N 次 mutation 要回放 N 条历史 update，累积成本是 O(N²)。这条链路跑在 **SW 唯一线程的单写者队列里**，最终表现为"越用越卡"。

**影响**：存储膨胀 + 点击延迟随使用时间恶化，且发生在被"1.22.9 点击跟手性"专项优化过的同一条队列上。

---

## 四、P1（正确性 / 用户可见）

### P1-1 单次 mutation 的固定 I/O 链——1.22.9 只修了"上传段"，队列前半段仍是"全量 × 多份"

一次用户点击（如删除一个会话）在队列里要依次付：

| 步骤 | 证据 | 成本形状 |
|------|------|----------|
| journal 全量读 + 全量写 | `src/utils/journal.ts:62-65` | 最多 1000 条数组，每次读改写 |
| 取号全扫 | `src/utils/seqRegistry.ts:43-53` | O(G×T) 遍历全部组与标签 |
| Y 影子：open + 全量回放 + 写增量 | `src/core/ydoc.ts:82-130` | 见 P0-2（6.1 KB/次） |
| Y update 日志全量读 + 全量写 | `src/core/yShadow.ts:139-150` | 最多 500 条数组，每次读改写 |
| **Dexie 物化视图全表重写** | `src/core/yMaterialize.ts:109-138` | 400×20 场景 = **8400 行 `bulkPut` + 全量主键读** |
| groups blob 全量写 | `src/utils/storage.ts:248-254` | 与数据量成正比 |

叠加：后台轮询每 60s **先全量读本地 groups 再探活**（`src/background/backgroundSync.ts:98` → `syncEngine.ts:316-317` 的 `getGroupsFresh()` 在 `:330` 的 digest 探活**之前**），命中与否都要付一次全量本地读。

### P1-2 标签数 > 45 的会话被 CSS 裁掉且不可滚动

- `src/components/tabs/TabGroup.tsx:555-558`：展开态容器为 `overflow-hidden max-h-[2000px]`。
- `src/components/tabs/lazyTabRows.ts:29`：`TAB_ROW_STRIDE_PX = 44` → **2000 / 44 ≈ 45.5 行**。
- `src/components/tabs/` 内**没有任何 `overflow-y-auto`/`overflow-auto`**（已全目录 grep），即被裁掉的部分既不显示也不可滚动到达。
- 讽刺的是，`tests/lazyTabRows.test.ts:34` 明确断言 `resolveRowWindow(150, false).placeholderHeight === 6600`（150 行 = 6600px），而 DOM 实际被夹在 2000px——**纯函数承诺"逐像素一致"的契约，在 N > 45 时被 CSS 单方面破坏**，且没有任何测试看着这个常量。

**影响**：保存了 > 45 个标签的会话，尾部的标签在界面上**静默消失、点不到**。该产品核心场景就是"一次收纳整窗标签"，50–100 标签的窗口很常见。不是数据丢失（"恢复整个会话"仍会打开全部），但用户会以为标签丢了。

> 建议在真实浏览器里对一条 60 标签的会话做一次目视确认后定性；代码层面结论已足够明确。

### P1-3 云端"加密"是服务端可见的混淆——需要一次定位拍板

- 密钥材料就是公开的 `userId`：`src/utils/encryptionUtils.ts:18-26`（`keyString = userId`，`useDeviceId` 时拼 `deviceId`），迭代 100k 的 PBKDF2 无法弥补输入熵为零。
- 密文与密钥材料**同一张表同一行**（`src/utils/supabase/upload.ts` 写 `user_id` 与 `tabs_data`）。
- 设备派生实际退化：`encryptionUtils.ts:24` 读的是 `secureStorage.get('deviceId')`，而真实键名是 `tabvaultpro_device_id`（`src/utils/deviceUtils.ts`），取不到 → 返回 `''` → `V2_DEVICE` 实际等价于 `V2_STANDARD`。
- `README.md` 已自我声明"不是严格 E2E"，所以**不是文案失实**；`docs/rebuild-plan.md:56` 也已写明正解（Argon2id + 每用户 DEK + 恢复码），只是未实现。

**这是一条"定位"问题而非"修 bug"问题**：要么做真 E2EE，要么在商店文案与 README 里把"服务端可见混淆"说透。继续拖下去，用户预期与服务端现实之间的落差只会更大。

### P1-4 会话"存得下、回不来"——保存与还原用两套 URL 协议白名单（**线上已证实正在发生**）

保存侧 `isInternalUrl` 与还原侧 `sanitizeTabUrl` 是两张互不相同的协议表，于是 `file://` / `blob:` 等标签可保存可上传、却永远无法还原；还原率判据按**整组**生效，会把同组的正常标签一并隐藏。该组在没有本地副本的设备上永久不可见，在有副本的设备上跨设备同步事实上冻结。

**完整证据链、为什么"只是这一次看不见"的说法与实际不符、以及修复方向，见 [第七节 7.2](#72-还原率-000-低于阈值-05整组跳过--2-组--p1本轮最该先修的正确性问题)。**

---

## 五、P2（技术债 / 边界，按主题归并）

**数据与同步**
- `normalizeTabsData` 只归一化**外层**形状、不归一化**元素**形状 → camelCase 载荷会静默丢 `created_at` / `last_accessed` / `last_op_*`（详见 7.1）。
- 上传侧对"非数组 `tabs_data`"的处置是**置为空数组后上传**（`upload.ts:463-468`）——当前不可达，但与"下载侧容忍 wrapper"并存，是一处地雷（详见 7.1 末段）。
- `scheduleUpload` 吞掉 `setPendingUpload(true)` 的写失败（`syncEngine.ts:168-170` 只 `logWarn`）——与本文件其它地方的 fail-closed 纪律方向相反；写失败 = 静默"不上传"（本轮新发现）。
- 删除意图登记失败被 handler 吞掉、mutation 仍回 `ok:true`（`src/background/mutationHandlers.ts:72-84`）→ UI 谎报成功（上一轮同）。
- `getPendingUpload` 读失败静默返回 `false`（`src/utils/storage.ts:628-635`），与同文件 fail-closed 纪律相反。
- journal 是**纯 write-only**：承诺的 WAL 重放从未实现，`read()` / `markConfirmedUpTo()` 在 `src/` 内**零调用点**（已 grep）→ 每次 mutation 全量读写数组、毫无收益。
- 覆盖下载（forceRemote）预广播失败后继续执行，复活只留一行日志（`syncEngine.ts:259-262`）。
- 云端墓碑 TTL 清理在"安静账号"永不触发（客户端 purge 只挂在 upload，`syncEngine.ts:574`）；服务端 cron 整段被注释、未启用（`supabase/manual/tombstone_expiry_cron.sql:35-43`）→ `is_deleted` 行对休眠账号无限堆积。
- 删除广播逐行 UPDATE + 逐行重新取号（`upload.ts` 约 776-825）：1000 条约 50–150s 串行网络调用，全程占住单写者队列。
- Web 端（`src/web/webApi.ts`）是同步语义的**第二套手工实现**：解密串行、写操作无读回校验 → 长期漂移风险。

**安全与隐私**
- Supabase JWT / refresh token **明文**存 `chrome.storage.local`（`src/utils/supabase/client.ts:99-107`），未走自家加密通道。
- 会话名 `name` 与 `is_locked` 明文上云（`upload.ts:393-396`）——会话名常含工作语境，与项目自己的脱敏标准不一致。
- `SENSITIVE_KEYS` 的键名与真实存储键不匹配（`src/utils/secureStorage.ts:17`）→ 那条加密规则**从未生效**；`auth_cache` 明文。
- `deviceId` 用 `Math.random` 生成（`src/utils/deviceUtils.ts:14-17`）。
- `src/auth/confirm.js`：邮箱验证 token 被取出拼进 URL 字符串但从未使用 + 硬编码真实项目 ref（未来"补全"这一行就会把 token 送进无 redirect 校验的端点）。
- 本地 IndexedDB 明文；网页版无安全响应头。
- 已核实**为误报/无问题**：消息面无外部暴露（无 `externally_connectable`、无 content script）、CSP `script-src 'self'`、权限最小化、无 `eval`/远程代码、URL 消毒链无存活注入路径、Web 端无 IDOR、`handle_new_user` 的 SECURITY DEFINER 非漏洞。

**性能与工程门禁**
- **体积门是"纸面门"**：`scripts/report-y-bundle.mjs` 未出现在 `package.json` / `validate` / CI 任何一环，超预算只打印后 `exit 0`；而 `docs/v2-plan.md` 承诺"超预算阻断发布"。
- **单测 glob 只覆盖顶层**（`package.json:13` `tests/*.test.ts`）：往 `tests/` 子目录放测试文件会**静默不跑**且无任何报警（`tests/_helpers/` 已存在，风险是活的）。
- CI 只在 `main` push 与 PR 触发：**feature 分支直推零门禁**；本地无 pre-commit / pre-push。
- `cws-publish.mjs` 的 `publish` 分支**不校验 HTTP 状态**（upload 分支是校验的）→ 发版最关键的"提交审核"这一步可能"以为发了其实没发"。
- e2e 种子规模过小（最大 20 会话 / 15 标签），历史上翻车的"大数据量 + 多设备"结构上覆盖不到。
- Redux 一致性：`saveSettings` 无 `rejected` 分支（`src/store/slices/settingsSlice.ts:18-24`）且**所有调用方都不 catch**（`ThemeContext.tsx:113,131`、`HeaderDropdown.tsx:120,127,134`、`Header.tsx:154`）→ 设置 UI/存储漂移 + unhandled rejection；`moveTabAndSync.rejected` 是空 no-op（`tabSlice.ts:784-786`）→ 拖拽失败不回滚。
- 死代码：`src/hooks/useDebounce.ts`（零外部引用）、`escapeHtml`（零调用）、`getDeletedGroups`（零调用）——`deadCodeGuards` 是黑名单式，管不住新增死代码。

---

## 六、与上一轮体检的对照

**已修复（本轮逐条给出证据）**

| 上一轮条目 | 现状 | 证据 |
|---|---|---|
| P1-1 上传快路径绕过单写者队列 | **已修复** | `src/services/syncEngine.ts:180,193` → `enqueue('sync:upload', () => this.upload())` |
| P1-3 plain 降级分支读回校验误判导致设备卡死 | **已修复** | `src/utils/supabase/readback.ts:216` 新增 `missingAsAchieved`；`upload.ts:763` 显式传入（stamp 分支 `:833` 保持严格） |
| P1-4 迁移移除墓碑却没登记删除意图 | **已修复** | `src/utils/migrationUtils.ts:129-131` 先 `addPendingDeleteIds` 再物理移除 |
| 队列分车道是否引入重排风险 | **无风险（已逐条验证）** | mutation 一律走 `getGroupsForWrite`（真值读 + flush 防抖）；清队只按名字消费本轮确认的 id（`storage.clearPendingDeleteIds`）→ 与执行顺序无关 |

**仍存在**：P0-1（加密定位）、P0-2（y-indexeddb）、P1-5（导入/导出解析器零测试）、P1-6（体积门未接线）、以及第五节大部分 P2。

**本轮新发现**：P0-1（profiles 全表可读）、P1-2（2000px 裁剪）、`scheduleUpload` 吞写失败。

---

## 七、线上真实日志补录（2026-10-05 用户提供）

用户从**已构建的扩展**（`dist/utils-BcnH0696.js`，即 `src/utils/**` 那个 chunk）贴出的控制台日志，两类信号。生产构建只 drop 了 `console.log/info/debug`（`vite.config.ts:25-28`），所以 `console.warn/error` 在用户机器上长期可见——这两类日志会随每次同步反复出现。

### 7.1 `[normalizeTabsData] tabs_data 非数组，已从 wrapper 对象的字段 "tabs" 恢复` × 3 组

**这条本身是"正常在工作"，不是故障。** `normalizeTabsData`（`src/core/normalizeTabsData.ts:24-49`）是历史坏行的兼容恢复：云端 `tab_groups.tabs_data` 历史上被写成过 wrapper 对象（`{tabs: [...]}`），不恢复就会在生产压缩代码里抛 `c.map is not a function`、整次下载失败。命中的 3 个组（`wf-7bt4Igiu4CFBnrq0Wa` / `m2LIohtRSP-eIcj6x0Pka` / `3AitBYoO-S0JO4n50rF76`）是被成功救回来的。

但它暴露两个真问题：

**（P2·数据保真）只归一化了外层形状，没有归一化"元素形状"。**
`webTombstone.ts:10-12` 明确记载生产里存在三种载荷形状：「扩展写入的 `TabData[]`（snake_case）、Web/旧客户端写入的 `Tab[]`（**camelCase**）或 wrapper 对象」。而 `deserializeTab`（`src/core/tabDataCodec.ts:27-46`）只读 snake_case：`data.created_at`、`data.last_accessed`、`data.is_deleted`、`data.last_op_*`。因此若 wrapper 内层是 camelCase `Tab[]`，恢复出来的元素会**静默丢字段**：

- `createdAt` / `lastAccessed` → `undefined`：`cleanDuplicates` 按 `new Date(b.tab.lastAccessed).getTime()` 排序（`src/core/mutationOps.ts:311`）会得到 `NaN`，"同 URL 留最新"的判定退化（仍保留一个，不会清零，但可能留下错的那个）；
- tab 级 `lastOp` → `undefined`：tab 级操作印记静默丢失（当前是组级整组覆盖，影响有限，但会与 `yAudit` 的对账口径产生噪声）。

**测试盲区**：`tests/normalizeTabsData.test.ts:39-54` 只断言外层形状（`assert.strictEqual(result, inner)`），**从不检查元素字段**，所以这条路径的保真度没有任何防线。

**（P3·永不收敛的噪声）** wrapper 行永远不会被改写成数组：下载路径只是旁路恢复，上传路径又只会写数组（`upload.ts:388` 的 `serializeTab` 映射）。于是这两三个组会让 `downloadTabGroups` **每次执行都重复告警**——而后台 alarm 每 60s 一次（`backgroundSync.ts:24,28-30`）、每次开 popup 还会再来一次。

> 另外发现一处**潜伏的矛盾**（暂不可达，列为 P3 地雷）：上传侧对"非数组 `tabs_data`"的处置是 **置为空数组后上传**（`upload.ts:463-468`）。当前扩展的上传载荷永远是数组（`upload.ts:376-414` 现造），所以这条分支实际不可达；但**下载侧容忍 wrapper、上传侧销毁 wrapper** 这两条并存，一旦将来有人把下载结果直接接回上传，就会把 wrapper 行静默清成 `[]`（且无墓碑、无回收站）。建议要么删掉这条死分支，要么让它抛错。

### 7.2 还原率 0.00 低于阈值 0.5，整组跳过 × 2 组 —— **P1，本轮最该先修的正确性问题**

```
标签组 mji8xap0kh82cnj8e0k 的 1 个标签有 1 个无法还原（URL 未通过安全校验），还原率 0.00 低于阈值 0.5，已跳过该组…
标签组 1744560850772      的 1 个标签有 1 个无法还原（URL 未通过安全校验），还原率 0.00 低于阈值 0.5，已跳过该组…
```

**根因：保存侧与还原侧各有一张 URL 协议白名单，且两张表互不相同（单一真相源缺失）。**

| | 位置 | 策略 | 结果 |
|---|---|---|---|
| 保存侧 | `isInternalUrl`（`src/domain/tabGroup/filters.ts:27-34`） | 只拒 `chrome://`、`chrome-extension://`、`edge://`、`about:` | `file:` / `blob:` / `data:` / `devtools:` / `chrome-untrusted:` / `view-source:` / `ws:` **一律放行、照存、照传** |
| 还原侧 | `sanitizeTabUrl`（`src/utils/inputValidation.ts:224-243`） | 只放行 `http:` / `https:` / `ftp:` / `about:` / `loading:` | 上面那一族全部返回 `null`，被 `deserializeTab` 过滤掉 |

即：**产品会保存它自己永远还原不了的标签**。对目标用户（开发者、研究者）来说，一个窗口里混着本地 PDF（`file://`）和站点 blob URL 是常态，所以这不是历史个案，而是**活的产线路径**。

**粒度问题让影响被放大**：判据按**整组**生效（`download.ts:286-294`，`MIN_RESTORABLE_TAB_RATIO = 0.5`，`download.ts:50`）。一个 3 标签的组里若 2 个是 `file:`/`blob:` → 0.33 < 0.5 → **连同那个完全正常的 https 标签一起被隐藏**。判据本身只该按标签生效，不该把同组的正常标签连坐。

**"只是这一次同步窗口看不见"的说法与实际不符。**
`download.ts:43-47` 的注释写：「低于阈值 → 整组跳过…云端行原封保留，等问题修好（或对端重写）后自然重新出现。代价是"这一次同步窗口里看不见这一组"」。但：

- 不可还原是**云端那一行数据的不可变属性**，没有任何代码会去"修好"它；
- "对端重写"也救不了——`serializeTab`（`tabDataCodec.ts:10-24`）**不做任何消毒**，对端重新上传时写回去的还是同一个 URL。

所以真实语义是**永久**，不是"这一次"：

- **已有本地副本的设备**：`mergeOpStamped` 的「仅本地有 → 保留本地」分支（`src/core/opStampMerge.ts:42`）会让本地副本原地胜出，云端行**永远不参与合并** → 这一组的**跨设备同步事实上冻结**（对端的任何修改都到不了这台设备）；
- **没有本地副本的设备**（换机、重装、新设备登录）：**这一组永远不出现**，而且界面上没有任何提示。

**是好消息的部分（我核实过，不是数据丢失）**：云端行原封保留、本地副本不会被删（`opStampMerge.ts:42` 的保留分支）、也不会登记 `pendingDeleteIds`。所以定级 P1 而非 P0。

**修复方向（架构层，不是打补丁）**
核心是**把"该不该存储"与"该不该渲染/导航"分开**——目前 `sanitizeTabUrl` 把两件事混成了一件：

1. **入库门**只拒真正危险的 schema（`javascript:` / `vbscript:` / `data:`）；`file:` / `blob:` / `devtools:` 这类是**数据**，应当存得下；
2. **渲染/点击门**单独判定"当前设备能不能打开"，不能打开的行**降级显示**（"此标签在当前设备无法打开"），而不是把它从数据里丢掉；
3. **取消"整组跳过"这一档**，改为「整组进结果、但标记为**不可回写**」（read-only 恢复）：既保证可见，又不触发注释里担心的"截断回写 → 全设备永久丢失"；
4. **保存侧与还原侧共用同一张协议表**（现在 `isInternalUrl` 与 `sanitizeTabUrl` 各写一份，`inputValidation.ts:216-220` 的注释甚至承认两张表对 `about:` 的答案相反），并加一条 meta-test 钉住"不存在可保存但不可还原的协议"；
5. **给已经卡住的历史行一条出路**：一次性修复（放宽策略后重新拉取），或在 UI 里给出可见入口（"有 N 个会话因 URL 不受支持未同步"），不要让它只躺在控制台里。

---

## 八、做得好的（值得保持，别在重构里丢掉）

1. **单写者 + 语义命令 + 纯函数复用**：popup 乐观 UI 与 SW 落盘共用 `core/mutationOps` 纯函数，把竞态类 bug 从"逐个打补丁"变成结构性消灭。
2. **读回校验三件套 + 写前认输预检**：把服务端守卫的静默吞写变成显式失败。
3. **fail-closed 读路径纪律**：groups/settings 读失败抛错而非降级；下载前快照读失败直接中止（`syncEngine.ts:316-322`），堵死"一次读错误把本地换云端"。
4. **门禁本身被测试钉住（meta-test）**：`gateScripts` / `ciWorkflow`（CI 装 Postgres 且探测缺失即红）/ `deadCodeGuards` / `docsAlignment` 把文档与防线漂移都纳入变红范围。
5. **诊断导出白名单式脱敏**；**URL 三道正交白名单 + 消息路径双层消毒**，全链路无 `javascript:` 存活路径。

---

## 九、建议的动作顺序

1. **今天**：核实并收口 `profiles` RLS（P0-1）。这是一条数据泄漏，优先级高于一切工程债。
2. **下一个发版必须带**：修掉"存得下、回不来"（7.2）——这是**线上日志已经证实正在发生**的用户可见缺陷，且会持续产生新的受害会话。最小可交付：保存侧与还原侧共用同一张协议表 + 取消"整组跳过"档位（改 read-only 恢复）+ 给历史卡住的行一条恢复路径。
3. **下一版**：`max-h-[2000px]` 裁剪（P1-2，一处常量 + 一条回归测试，收益/成本比最高）。
4. **下一版**：决定 y-indexeddb 的去向（P0-2）——最省事的止血是把影子写灰度降到 0（`SHADOW_ROLLOUT_PERCENT = 0`）直到 V3 决策；要保留则必须补真正的压缩（写完主动 `storeState`，或定期整库重建），并先停掉无条件 order 重写（`ydoc.ts:62-63`）。
5. **拍板**：加密定位（P1-3）——真 E2EE 还是把"服务端可见混淆"写进商店文案。不建议再拖。
6. **打包一个"防线版"**：体积门接进 CI（超预算 `exit 1`）、单测 glob 改递归（或显式列目录）、`cws-publish` publish 分支校验结果、`settingsSlice` 补 rejected + 调用方 catch、`normalizeTabsData` 补元素级保真断言（7.1）、删除 `upload.ts:463-468` 的死分支或改为抛错、（可选）pre-push 跑 `validate`。
7. **性能专线**：固定 I/O 链（P1-1）——先做"轮询先探活再决定是否全量读"这一处零风险改动，再评估 Y 影子写路径与 Dexie 全表重写的替代方案。

---

*三路只读审计的完整明细（含全部 file:line 证据）保留在本轮会话记录中；本报告为归并去重后的结论版。*
*量化实测方法：以项目真实 yjs 复现 `plansToDoc` 的 order 重写语义，规模 400 组 × 20 标签，取 50 次 mutation 的平均增量；脚本为一次性使用，未入库。*
