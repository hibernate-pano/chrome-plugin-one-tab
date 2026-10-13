# AI Log：自带存储（BYOK）同步方案调研与起草

- 时间：2026-10-13 18:12 ~ 18:45
- 分支：`feature/webdav-selfhost-sync`（从 `main` @ `86c4c45` 开出）
- 执行者：Codex（主 agent）+ 2 个只读调研 agent
- 结论：**方案已写完，等 Jasper 拍板。零生产代码改动。**

---

## 1. 对话出发点

Jasper 的原始需求：

1. 「自动同步带来了很多麻烦，但又希望保留该功能」
2. 「借鉴其他数据同步方式，例如让用户自行提供 Web3 存储（如坚果云等）」
3. 「先开一个新分支，做一个试用版」
4. 「将原来 Superbase 的存储模式改为 Web3 存储模式，让用户自行配置云服务及云存储」
5. 三个预期收益：不占他的存储空间 / 优化访问权限和频率 / 用户数据私密性更强
6. 一项大工程：数据库表存储形式 → 适合 Web3 存储的形式，并提升实时体验
7. 「请先调研市面上其他产品的实现方式，进行分析总结后，提交一份完善的方案给我，
   由我决定下一步是否推进。记得一定要开一个新分支。」

---

## 2. 执行过程

### 2.1 开分支（用户明确要求）

`git checkout -b feature/webdav-selfhost-sync`（从 `main` @ `86c4c45`）。
**注意**：开分支时工作区已有 2 个未跟踪文件
（`docs/health-check-2026-10-12-expert-team.html`、
`docs/verification-report-2026-10-13.html`），**不是我创建的**，未动。

### 2.2 读码摸清现状（未跑测试，只读）

为估算工作量读了这些文件（全部实际打开，非 grep 猜测）：

| 文件 | 读到了什么 |
|---|---|
| `src/utils/supabase/ports.ts` | `SupabaseSyncPort` 8 个方法的签名，注释明写「透传层依赖接口而非具体实现……未来多实现可经 setSyncPort 注入替身」 |
| `src/services/tabGroupSyncService.ts` | 透传层，`setSyncPort` / `resetSyncPort` 已存在 |
| `src/core/opStampMerge.ts` | 合并 = 组级 LWW 整组覆盖，`lastOp = {d: deviceId, s: seq}` 全序决胜 |
| `src/utils/supabase/syncWatermark.ts` | 增量水位按 `userId` 寻址 + 绑定 `deviceSeq` 防 seq 时钟回退（曾有 P0：清数据后新组永不上云） |
| `src/utils/supabase/download.ts:227-229` | 分页用 `.order('created_at').order('id')` 双排序（因 `created_at` 并列曾丢 25%） |
| `src/utils/encryptionUtils.ts` | 上云前 PBKDF2(userId+deviceId, 100k) → AES-256-GCM 逐组加密 |
| `src/background/backgroundSync.ts` | alarm + 四档间隔 + 退避状态机（1/2/5 分钟，封顶 8 次），调度骨架可复用 |
| `src/utils/storage.ts:562-600` | `pendingDeleteIds` 是删除广播**唯一**载体，整段 fail-closed 论证 |
| `manifest.json:8,18` | CSP `connect-src` 只允许 `https://*.supabase.co`；host_permissions 同 |
| `src/types/tab.ts` | `UserSettings` 19 个字段，含 `syncEnabled` / `syncIntervalMinutes` / `syncStrategy` / `deleteStrategy` |
| `src/utils/storage.ts:1023-1046` | `exportData()` 已产出 `{version, timestamp, data:{groups, settings}}` —— 可直接作为文件格式的基底 |
| `supabase/migrations/` | 25 个迁移，最后一个是 `20261011190000_add_sync_interval_minutes_to_user_settings.sql` |

**关键发现（决定了方案的乐观程度）**：`SupabaseSyncPort` 端口抽象已经存在，
所以「接第二个后端」是接进已有接缝，不是从零重写。但这个接口的 8 个方法签名
是**按 Supabase 能力设计的**（`writtenTombstoneIds`、`purgeExpiredCloudTombstones`
依赖云端行），文件后端要重设计这层接口，不能硬塞。

### 2.3 并行派 2 个调研 agent

| agent | 任务 | 产出 | 耗时 |
|---|---|---|---|
| Maxwell (`01a134cc-...f498`) | Floccus / xBrowserSync / Firefox Sync / 密码管理器 / WebDAV 库选型 / MV3 坑 | `.ai-logs/research-sync-products.md`（620 行） | ~14 分钟 |
| Halley (`01a134cc-...06f4`) | 坚果云 WebDAV 可行性（含真机实测）/ 后端横向对比 / 凭证安全 / 冲突解决 / 退避参数 | `.ai-logs/research-webdav-backends.md` + 自己的 AI Log | ~19 分钟 |

Halley 额外做了一件超出「查文档」的事：**用 Playwright + Chrome for Testing
真机加载两个 MV3 扩展做 A/B 对照实验**，证明「坚果云不返 CORS 头，但扩展声明
`host_permissions` 后 Chrome 直接豁免 CORS；不声明则 `Failed to fetch`」。
这比查文档可靠得多。

### 2.4 起草方案

`docs/webdav-selfhost-sync-plan.md`（11 节 + 附录），含：
- 一页纸结论
- 术语纠正（「Web3 存储」→「自带存储 BYOK」）
- 现状盘点（接缝在哪、能复用什么、不能复用什么）
- 核心工程：分片布局 / 删除广播载体 / 乐观锁 / 熔断 / 三方合并取舍
- 后端选型对比表（6 个后端 × 6 个维度）
- 加密方案（含 WebCrypto 不支持 Argon2 的约束）
- V1/V2/V3 分期
- Supabase 老用户迁移路径（3 个选项）
- 10 条风险清单
- 3 个需要 Jasper 回答的问题

---

## 3. 遇到的问题

### 3.1 我自己写错了一处构建命令（已改）

方案初稿 §10 写了「`pnpm build` 必须跑完整三步（`tsc && vite build && node
scripts/copy-assets.js`）」。

**这是错的。** `scripts/copy-assets.js` **在本仓库不存在**
（`ls` 确认，`package.json` 的 `build` 只有 `tsc && vite build`）。
那条三步构建是 **chrome-plugin-video-manager** 项目的做法——
我在 memory 里读到过它，就顺手写进来了，属于「把另一个项目的知识当本项目的」。

发现方式：写完方案后习惯性核对每条断言，`ls scripts/copy-assets.js` 直接证伪。
**已改正**并顺手把「别混」写进文档。

### 3.2 「同步带来了很多麻烦」这句话的根因，方案里不能答错

Jasper 说「自动同步带来了很多麻烦」。我去查了根因，发现是**两件不同的事**：

1. **Supabase egress 配额见底** → 1.23.0 把自动同步默认关掉 + 加四档间隔
   （`docs/RELEASE-NOTES.md` v1.23.0 节有完整决策留痕）
2. **LWW 合并模型下的静默丢失** → 1.22.16 / 1.22.17 / 1.23.1 连续三个版本在修

**换存储后端只能解决第 1 条，不能解决第 2 条。** 方案 §1 和 §4 明确写了这一点，
否则方案会给人「换了后端麻烦就解决了」的错觉。

### 3.3 「Web3 存储」这个词会导致方向性错误（最重要的澄清）

Jasper 原话是「Web3 存储」。按这个词去找方案会找到 IPFS / Arweave / Filecoin，
而这些对 TapStack **全部不适用**：要么自建网关（= 还是自己运维），
要么用公共网关（**用户的标签页 URL 就是浏览历史，交给第三方网关比放在我的
Supabase 上更不私密**）。

方案 §2 用一张对比表把三条路（WebDAV / IPFS / 分布式存储矿网）摊开，
并明确问 Jasper：「你指的是 WebDAV 这类文件型云存储，还是 IPFS 这类去中心化协议？」
**没有替他假设。**

### 3.4 调研 agent 的未验证项（不能当事实用）

Halley 如实标注：**他没有坚果云真实账号**，所以以下都是推测而非事实：
- 认证通过后 PROPFIND 是否返回 207 + `getetag`
- `If-Match` 是否真返回 412
- MKCOL 的实际返回码

方案附录 §附录 原样转述了这个限制，并写明「若推进，必须由真实账号在真机上先验证这一步」。
**没有把推测写成结论。**

### 3.5 一个我差点漏掉的关键问题

初稿只写了「新旧后端并存」，没写「**老用户的数据已经在 Supabase 里，
直接改后端 = 直接看不到自己的数据**」。
TapStack 是**无回收站、删除即物理清除**的模型（README 明写），
这等于删用户数据。
补进 §8，给了 3 个选项（并存+迁移向导 / 新老分开 / 硬切换），推荐第一个。

---

## 4. 最终结果

**成功（方案交付），零生产代码改动。**

产出文件：
1. `docs/webdav-selfhost-sync-plan.md` —— 方案正文（新增）
2. `.ai-logs/research-sync-products.md` —— 产品调研（agent 产出，620 行）
3. `.ai-logs/research-webdav-backends.md` —— 后端可行性调研（agent 产出）
4. `.ai-logs/2026-10-13-183500-research-webdav-backends.md` —— agent 自己的 AI Log
5. 本文件

验证：
- `tests/docsAlignment.test.ts` → 22 pass / 0 fail（新增 docs 文件未破坏门禁）
- 未跑全量测试：本次**零 src/ 改动**，只有新增 md 文件，不需要跑 995 个测试

未做（有意）：
- 没写任何生产代码（用户明确说「先调研 + 提交方案，由我决定是否推进」）
- 没提交 commit（用户没要求；等方案拍板后一并提交更干净）
- 没删 Supabase 代码（§8 的迁移路径需要它）

---

## 5. 待 Jasper 回答（阻塞项）

1. 「Web3 存储」= WebDAV/云盘文件，还是 IPFS/去中心化协议？
2. Supabase 老用户：并存+迁移向导，还是新老用户分开？
3. 「试用版」是否接受「只做单向备份 + 首次导入，不做双向实时同步」？

