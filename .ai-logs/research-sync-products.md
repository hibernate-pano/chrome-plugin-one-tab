# BYOK 同步产品调研：浏览器扩展 / 书签同步如何让用户自带存储

调研时间：2026-10-13
调研范围：Floccus、xBrowserSync、Firefox Sync、密码管理器、WebDAV 客户端选型、Chrome MV3 WebDAV 已知坑
方法：克隆 floccusaddon/floccus、xBrowserSync/api、xBrowserSync/core 三个仓库读源码为主，官方文档与 issue 为辅

---

## 0. 核心结论（先看这段）

1. **Floccus 在「文件型 BYOK 后端」上根本没有增量同步，也几乎没有并发控制协议。** 它每次同步都是「全量 GET 一个文件 → 内存里算 diff → 全量 PUT 回去」。WebDAV / Google Drive / Dropbox / Git 四个适配器都是单文件（`bookmarks.xbel`）。分片和增量是 Nextcloud Bookmarks 这类「有服务端 API」的适配器才有的能力。
2. **它唯一的并发保护是一个 `.lock` 伴随文件**：PUT 一个 `<file>.lock`，靠 `Last-Modified` 判断 15 分钟超时，靠每 2 分钟续写保活。这是一个**没有服务端原子性保证的软锁** —— 两个客户端同时 PUT 都能成功，静默互相覆盖。
3. **真正救命的不是协议，是三件本地工程**：① 上次成功同步的服务端快照（cache）作为「共同祖先」；② 两侧扫描结果做 5 阶段 plan/reconcile/execute；③ **删除熔断（failsafe）** —— 一次要删超过 20%（且至少 5 条、上限 1000 条）就直接中止同步并报错。
4. **加密是客户端对称的**：PBKDF2(passphrase, salt, 250000, SHA-256) → AES-256-GCM，密文 + salt 以 JSON 存进同一个文件。**不是 OpenPGP。**（网上大量文章说 Floccus 用 OpenPGP，那是 v4 时代的旧信息；v5 源码 `src/lib/Crypto.ts` 已经是纯 WebCrypto 对称加密，`DefunctCrypto.js` 是遗留的 AES-CBC 旧实现。）
5. **MV3 做 WebDAV 的真正风险不是 CORS，是「长事务被 service worker 掐死」**。`host_permissions` 让扩展上下文的 fetch 豁免 CORS（Chrome 侧成立），但 30 秒空闲 / 5 分钟单事件上限意味着一次 4000 条书签的同步随时可能被终止 —— Floccus 为此写了整个 continuation 持久化子系统。
6. **xBrowserSync 的冲突处理值得抄**：它缓存「上次共同状态」，用乐观并发（`lastUpdated` 不匹配 → 409）+ 结构化三方合并，比 Floccus 的方案小两个数量级（203 行 vs 2584 行）。

---

## 1. Floccus（最重要参考对象）

仓库：https://github.com/floccusaddon/floccus 　官网：https://floccus.org/
本次分析版本：master（`manifest.chrome.json` v5.11.1 / `manifest.json` v5.4.4）

### 1.1 后端可选项

源码注册在 `src/lib/Account.ts` 的 `AdapterFactory.register(...)`（动态 import），`src/lib/adapters/` 下共 8 个适配器 + 1 个 Caching 基类：

| 适配器 | 文件 | 存储形态 | `isAtomic()` |
|---|---|---|---|
| Nextcloud Bookmarks | `NextcloudBookmarks.ts`（1363 行，最复杂） | 服务端 App API，DB 分条 | `false` |
| Linkwarden | `Linkwarden.ts` | 服务端 REST API | `false` |
| KaraKeep | `Karakeep.ts` | 服务端 REST API | `false` |
| **WebDAV** | `WebDav.ts`（901 行） | **单文件** `bookmarks.xbel` | `true`（继承 Caching 默认） |
| Git over HTTPS | `Git.ts` | **单文件** + git commit 历史 | `true` |
| Google Drive | `GoogleDrive.ts` | **单文件**（Drive v3 `uploadType=media`） | `true` |
| Dropbox | `Dropbox.ts`（1188 行） | **单文件** + file id 强一致元数据 | `true` |
| Fake | `Fake.js` / `FakeNcBookmarks.ts` | 测试用 | `true` / `false` |

**关键分界线**：`isAtomic() === false` 的适配器（Nextcloud / Linkwarden / KaraKeep）会持久化 continuation（可中断续传），`true` 的文件型后端靠 cache + mappings 就够了。

协议面（`manifest.json` / `manifest.chrome.json`）：

```json
"permissions": ["alarms", "bookmarks", "storage", "unlimitedStorage", "tabs", "identity"],
"optional_permissions": ["history"],
"host_permissions": ["*://*/*"]
```

`host_permissions` 是 `*://*/*` 而不是可选授权 —— 因为自托管用户服务器地址千变万化，没法预置。安装时会给「读取和更改您在所有网站上的数据」警告，README 里明确承认了这点。

### 1.2 文件布局：单文件，且**没有分片**

WebDAV / Google Drive / Dropbox / Git 四个都是**整个书签树一个文件**。`WebDavAdapter` 的三个 URL 构造：

```js
getBookmarkURL()      { return normalizeServerURL(this.server.url) + this.server.bookmark_file }
getBookmarkLockURL()  { return this.getBookmarkURL() + '.lock' }
getBookmarkTempURL()  { return this.getBookmarkURL() + '.temp' }
```

默认 `bookmark_file: 'bookmarks.xbel'`，`bookmark_file_type: 'xbel'`（也可 `'html'`，Netscape 格式）。

文件内容（`WebDav.ts` 末尾 `createXBEL()`）就是 XBEL 标准 XML：

```xml
<!DOCTYPE xbel PUBLIC "+//IDN python.org//DTD XML Bookmark Exchange Language 1.0//EN//XML" ...>
<xbel version="1.0">
<!--- highestId :1234: for Floccus bookmark sync browser extension -->
  ...序列化后的树...
</xbel>
```

`highestId` 塞在 XML 注释里，读回来时逐行扫 `<!--- highestId :`（`pullFromServer()` 里的 `byNL` 循环）。这是个典型的「把元数据藏在注释里」的土办法。

**结论：Floccus 在文件型后端上没有分片、没有 manifest、没有增量。**「只下载变化的部分」这件事完全不存在 —— 每次都是整文件 GET + 整文件 PUT。分片能力只存在于 Nextcloud Bookmarks（`bulkImportFolder` 超过 75 条拒绝，`Default#executeCreate` 按 70 条分块导入）。

### 1.3 WebDAV 具体调用了哪些 HTTP 方法

全部在 `src/lib/adapters/WebDav.ts`，浏览器侧走 `fetch`，原生侧走 `CapacitorHttp`。**没有用任何 WebDAV 客户端库，是手写的。**

| 方法 | 用途 | 关键细节 |
|---|---|---|
| `GET` | 下载 `bookmarks.xbel` | 也用于下载 `.lock` 判断是否被锁 |
| `PUT` | 上传 | `Content-Type: application/xml`（xbel）/ `text/html`（html）；`Authorization: Basic base64(user:pass)`；`credentials: include` 或 `omit`（由 `includeCredentials` 配置决定） |
| `PROPFIND` + `Depth: 0` | 取远端文件大小 | 解析 `<...getcontentlength>...</...>` 正则；`cache: 'no-store'`。**原生端改用 `HEAD`**（CapacitorHttp 不支持 PROPFIND） |
| `MOVE` + `Overwrite: T` | `.temp` → 正式文件（原子替换） | 必须手动 percent-encode `Destination` 头里的非 ASCII 文件名（`encodeDestinationURL`），因为 header 值不会被 fetch 自动编码 |
| `DELETE` | 删 `.lock`、删 `.temp` | 删锁重试最多 10 次，间隔 1 秒，接受 200/204/404 |

**上传的完整序列**（`uploadBookmarkFile`，这是最值得抄的一段）：

```
PUT  <file>.temp                     （传完整数据）
  ↓ PROPFIND 校验 .temp 的字节数 == 本地 TextEncoder().encode(data).length
  ↓ 不匹配 → DELETE .temp → 重试（PUT_FILE_SIZE_RETRIES = 2，即最多 3 次）
MOVE <file>.temp → <file>            （Overwrite: T）
  ↓ PROPFIND 再校验正式文件的字节数
MOVE 409（服务端不认 Overwrite: T）→ DELETE 目标 → 重试 MOVE 一次
```

注释写得很直白：这是防「某些服务端 / 代理在传输中截断或改写 body，导致静默写入损坏文件」。

`allowRedirects` 为 false 时用 `redirect: 'manual'`，并且 **`res.status === 0` 会被当作 `RedirectError`**（opaque redirect 的经典症状）。

### 1.4 冲突控制：`.lock` 软锁 + 本地缓存三方合并

**锁协议**（`obtainLock` / `setLock` / `freeLock`）：

```
GET  <file>.lock
  ├─ 200 + Last-Modified 且未超过 LOCK_TIMEOUT(15min) → 抛 ResourceLockedError（别人在同步）
  ├─ 200 + 已超时                                 → 强行接管（this.locked = true）
  ├─ 404                                           → PUT <file>.lock，内容 '<html><body>I am a lock file</body></html>'
  └─ 其他状态码                                     → 抛 LockFileError

同步期间：每 LOCK_INTERVAL(2min) PUT 一次 .lock 续期
结束：    DELETE .lock（失败重试 10 次，间隔 1 秒）
```

PUT `.lock` 收到 423 Locked / 409 Conflict 时也转成 `ResourceLockedError`。**这本质上是拿文件系统语义模拟 WebDAV 的 LOCK/UNLOCK** —— 因为不是所有 WebDAV 服务端都实现 RFC 4918 的 LOCK，而普通 PUT 到已存在文件总是成功。

**诚实评价：这个锁不提供互斥保证。** 两个客户端并发时都能 PUT 成功 `.lock`，最后都以为自己拿到了锁。它只是「大概率避免」而非「保证避免」。Floccus 真正的正确性来源是下面的合并逻辑。

### 1.5 diff / 合并算法（核心）

分两个文件：`src/lib/Scanner.ts`（算 diff，18.7K）+ `src/lib/strategies/Default.ts`（2584 行，编排，105K）。

**三棵树**：

- `localTreeRoot` —— 浏览器书签
- `serverTreeRoot` —— 服务端文件
- `cacheTreeRoot` —— **上次成功同步的服务端快照**，存在 `browser.storage.local` 的 `bookmarks[<id>].cache`

cacheTree 就是三方合并的「共同祖先」。

**子树哈希**（`Tree.ts` `hash()`）：每个 item 算 `sha256(JSON.stringify({title, url, tags}))`，folder 的 hash 递归包含 children（可配置 `preserveOrder` / `hashFn` ∈ sha256|xxhash3|murmur3 / `syncTags`）。

> 源码注释里的警告值得抄下来：
> `// Nextcloud Bookmarks hashes the very same JSON server-side, with the fields in exactly this order (fields[]=title&fields[]=url&fields[]=tags) and the tags sorted the same way ... so don't reorder or add keys here lightly.`

**哈希缓存在 folder 上，任何 mutation 必须 `invalidateHashUpwards` 向上作废** —— 漏一处就会「scanner 认为什么都没变」。有 `FLOCCUS_VERIFY_INDEX=true` 环境变量做全量重建交叉校验。

**Scanner 三步**（`run()`）：

1. `diffItem(old, new)` —— 递归比对，产出 `CREATE / UPDATE / MOVE / REMOVE / REORDER` 五个 `Diff`。UPDATE 靠子树哈希判定。
2. `findMoves()` —— **最有意思的部分**。把 CREATE 和 REMOVE 配对转成 MOVE，配对条件是 `mergeable()`：
   - `Bookmark.canMergeWith(other)` = **URL 相等**（`Tree.ts:190`）
   - `Folder.canMergeWith(other)` = **title 相等**（`Tree.ts:527`）
   - 先找直接配对，再找「被删项的后代 ↔ 被建项的祖先」这类间接配对（移动整个文件夹）
   - 无 cache 时 folder 还要求 `childrenSimilarity >= 0.8`（children title 集合的 Jaccard 相似度，`Tree.ts:532`）
   - 每次配对成功就 `reconciled = true` 重跑，直到不动点收敛。循环里每 1000 次 `await yieldToEventLoop()`
3. `addReorders()` —— 在 diff 之前先算顺序差异（注释：REORDER 必须在 diff 任何东西之前算，否则 reorders 不是 "from tree" 状态）

**Default 策略的 5 个阶段**（`Default.ts` 注释里的 Stage 0~4）：

```
Stage 0  scan        localScanner + serverScanner，得到两侧 ScanResult
Stage 1  reconcile   把 sourceScanResult 和 targetScanResult 交叉消解成 PlanStage1
Stage 2  execute     对服务端执行 serverPlanStage2
Stage 3  execute     对本地执行 planStage3Local（懒建，因为要先拿 Stage2 的新 id）
Stage 4  reordering  localReorders + serverReorders 收尾排序
```

`reconcileDiffs` 的消解规则（`Default.ts:1200+`）：

- **source REMOVE vs target 也 REMOVE**（同一 item，通过 mappings 可映射）→ 认为「两边都删了」，**什么都不做**
- **source MOVE vs target 也 MOVE**，且 target 是 master → master 优先
- **source CREATE vs target 也 CREATE 且父节点相同 + `canMergeWith`** → 起一个**子 Scanner** 再 diff 一遍，把并集写进 plan（**同名文件夹在两边同时被建 = 合并而非覆盖**）
- `Mappings.wouldEvictUnrelatedMapping(...)` 作为守卫，防止错误配对挤掉别人的映射
- 移动时若父节点没变，`browser.bookmarks.move` 会被跳过 —— 因为「不带 index 的 move 会追加到文件夹末尾」（`#2361`），排序是 REORDER 的职责

### 1.6 删除熔断（failsafe）—— 最该抄的一段

`Default.ts:996-1021`：

```js
// 普通书签：{ minTotal: 5, minChanged: 0,  ratio: 0.2, maxChanged: 1000 }
// 标签页：  { minTotal: 5, minChanged: 50, ratio: 0.5, maxChanged: 1000 }
if ((countTotal > minTotal && countDeleted >= minChanged && countDeleted / countTotal > ratio)
    || countDeleted > maxChanged) {
  throw new ClientsideDeletionFailsafeError(percentage)   // 或 Serverside...
}
```

**一次要删超过总数的 20%，或绝对值超过 1000 条，直接中止同步并报错。** 用户手动往 trash 里一拖 2000 条书签就不会把同步搞成灾难。只有 `server.failsafe === false` 才跳过（显式豁免）。

同理有 `applyAdditionFailsafe`。这两个 failsafe 是异步的，**必须 await**（AGENTS.md 里专门强调）。

### 1.7 加密（v5 实测：AES-GCM，不是 OpenPGP）

`src/lib/Crypto.ts`：

```js
Crypto.iterations = 250000
Crypto.ivLength  = 16

prepareKey(passphrase, salt):
  PBKDF2(passphrase, salt, iterations=250000, hash=SHA-256) → AES-GCM 256-bit key

encryptAES: iv = randomBytes(16); ciphertext = AES-GCM(iv, key, msg); return base64(iv || ciphertext)
```

存储格式（`WebDav.ts` `onSyncComplete`）：

```js
const salt = bufferToHexstr(getRandomBytes(64))          // 64 随机字节
const ciphertext = await Crypto.encryptAES(passphrase, xbel, salt)
xbel = JSON.stringify({ciphertext, salt})                 // 整个文件变成这个 JSON
```

读取时（`pullFromServer`）有**格式嗅探回退**，向后兼容三代格式：

1. 先 `JSON.parse` 当 `{ciphertext, salt}` 解
2. 失败则把整个 body 当 ciphertext、salt 用 `bookmark_file` 文件名（更老的格式）
3. 还失败，但内容里含 `<?xml version="1.0"` 或 `<!DOCTYPE NETSCAPE-Bookmark-file-1>` → 判定「本来就是明文」，noop
4. 否则抛 `DecryptionError`

**注意 salt 是每次上传都重新随机生成的** —— 意味着每次同步整个文件密文都不同，无法用「密文是否变化」判断内容是否变化。Floccus 判断「要不要上传」用的是**明文树的哈希**（`onSyncComplete` 里比较 `newTreeHash !== initialTreeHash`），不是密文哈希。**这个设计是对的。**

哈希可选函数：`sha256`（默认，WebCrypto）/ `xxhash3`（ts-xxhash）/ `murmur3`（自带的 murmurhash3.js）。

### 1.8 定时同步的调度方式（MV3 下的正解参考）

`src/lib/browser/BrowserController.js:126`：

```js
browser.alarms.create('checkStorage', { periodInMinutes: 15 })
browser.alarms.create('checkSync',   { periodInMinutes: 1  })
browser.alarms.onAlarm.addListener(async alarm => { await this.alarms[alarm.name]() })
addEventListener('online', () => setTimeout(() => this.alarms.checkSync(true), NETWORK_SETTLE_TIMEOUT))
```

**这是关键设计：不是「按用户设置的间隔建 alarm」，而是「建一个固定 1 分钟的 tick，自己在 `SyncSchedule.isSyncDue()` 里判断到不到点」。**

`src/lib/SyncSchedule.ts` 的规则：

- `DEFAULT_SYNC_INTERVAL = 15` 分钟
- `isSyncDue(data, now, online, networkRestored)`：
  - `data.scheduled` → true
  - 有 error → 只有 `isTransientError` 且在线才按退避重试
  - 否则 `now > syncInterval * 60000 + lastSync`
- **指数退避**：`getBackoffInterval` = `min(1min * 2^(errorCount-1), 1h, syncInterval)`，起始 1 分钟
- **离线不重试**：`online === false` 直接返回 false，等 `online` 事件恢复后立刻重试
- `syncsAutomatically(data)` = `enabled || syncIntervalEnabled || syncOnStartupEnabled`

这样 alarm 数量恒定、间隔恒定，改用户设置不用重建 alarm，也不会出现「多个不同周期的 alarm 堆积」。

原生端（Capacitor）用 `Network` 插件的 `networkStatusChange` 监听在线状态，`checkSync` 周期是 25 秒。

### 1.9 断点续传（continuation）—— MV3 下的血泪史

因为 service worker 随时会被杀，Floccus 把同步进度持久化：

- **续传状态**：`src/lib/Continuation.ts` 拆成「一个 structure 记录 + 每个 action 一行（键 `(diffId, seq)`）」。浏览器端存 IndexedDB `floccus_continuations`（object stores `meta` 和 `actions`），原生端存 SQLite `continuation_actions` 表
- **diff id 带 per-process 随机前缀**，所以续跑不会误采纳上一轮的残留行
- **只对非原子服务端持久化**（`isAtomic() === false` 才有必要）
- **30 分钟过期**：`Account#sync` 丢弃 `createdAt` 早于半小时的 continuation
- **限流**：`progressInterval(items)` = 0.2ms/条，钳制在 1.5~10 秒；`retuneProgressInterval()` 在树加载完成后重建 throttle
- **失败时**：`keepsContinuation`（E026 中断、网络错误、failsafe 触发）→ `persistFinalProgress()`，因为「最后一个 throttled tick 可能落后 10 秒，重放会重复创建条目」
- 续跑时**恢复的两个 reorder 列表都在的话，直接跳到 `executeReorderingStage()`**，避免重新 plan 出的 reorders 输给存下来的

### 1.10 其他值得注意的细节

- **「静默损坏」防护**：下载后立刻校验 `PROPFIND` 字节数 == `TextEncoder().encode(text).length`，不等就当损坏重试。
- **Dropbox 的 5xx 重试**（`Dropbox.ts:74`）：
  > A 5xx response doesn't tell us whether the server applied the request or not, so retrying is only safe for calls that have no side effects when repeated. The Dropbox API uses POST for everything, including reads, so unlike with other adapters we cannot decide this by HTTP verb — callers opt in via `request()`'s `retriable` parameter instead.

  最多 3 次，延迟指数退避（`1000 * 2^attempt`）。
- **Git 适配器的 IndexedDB 陷阱**（AGENTS.md 专门记了）：只能删自己创建的 lightning-fs 库（`isDisposableFsDatabase` 校验库名 `/^[0-9a-f]{64}(\d{13})$/` = sha256(配置) + 时间戳）。删别人的库会 blocked，blocked 后 `indexedDB.databases()` 永远不 resolve。
- **Nextcloud 导入返回值的坑**：该端点是「追加」语义且只返回导入的部分，所以 `NextcloudBookmarks#bulkImportFolder` 要把返回值 append 到已有 children 上，不能替换 —— 否则分块导入只剩最后一块（`bulkImportAppendsChildren = true` 这个 flag 就是告诉 `Default#executeCreate` 该端点可以分块）。
- **性能基准**（README，4000 条书签）：

| adapter | 冷启动首次同步 | 热同步无改动 |
|---|---|---|
| nextcloud-folders | ~7min | ~20s |
| webdav | ~4min | ~10s |

  **冷启动 4 分钟 ≈ 危险地接近 MV3 service worker 单事件 5 分钟上限。**

- **CSV / 权限提示**：README 里明说 `host_permissions` 不能收窄，「Unfortunately, floccus also gets access to all the data the browser has collected on those websites」。

---

## 2. xBrowserSync

仓库：https://github.com/xBrowserSync/api（服务端）　https://github.com/xBrowserSync/core（新版客户端）
官方文档：https://www.xbrowsersync.com/

### 2.1 API 形态（`src/routers/bookmarks.router.ts`）

版本路由用 `express-routes-versioning`，靠请求头 **`Accept-Version`** 选择实现：

```js
createRoute(Verb.post, '/',              { '~1.0.0': createBookmarks_v1, '^1.1.3': createBookmarks_v2 })
createRoute(Verb.get,  '/:id',           { '^1.0.0': getBookmarks })
createRoute(Verb.put,  '/:id',           { '~1.0.0': updateBookmarks_v1, '^1.1.3': updateBookmarks_v2 })
createRoute(Verb.get,  '/:id/lastUpdated', { '^1.0.0': getLastUpdated })
createRoute(Verb.get,  '/:id/version',     { '^1.1.3': getVersion })
// 另有 GET /info
```

- **sync ID = 去掉连字符的 UUIDv4**（32 位小写 hex），服务端用 `convertUuidStringToBinary` 校验；客户端用正则 `^[a-f0-9]{32}$`
- **v1.0.0 是「直接 POST 整棵树的 JSON 字符串」；v1.1.3 引入了 `version`（数据格式版本）字段**
- `GET /info` 返回服务版本，客户端校验 `isVersionAtLeast(info.version, MIN_API_VERSION)`，不满足抛 `UnsupportedApiVersionError`
- 客户端**故意不 pin `Accept-Version`**，让服务端选它的默认版本

### 2.2 乐观并发：lastUpdated 比对（核心）

`src/services/bookmarks.service.ts` `updateBookmarks_v2`：

```js
const existing = await BookmarksModel.findById(id)
if (!existing) throw new SyncNotFoundException()
// 客户端带上自己上次看到的 lastUpdated
if (lastUpdated && lastUpdated !== existing.lastUpdated.toISOString()) {
  throw new SyncConflictException()      // → HTTP 409
}
```

**这是教科书式的 compare-and-set。** 服务端不存历史、不做合并，只回答「你看到的还是现在的吗」。整个冲突处理责任 100% 在客户端。

### 2.3 客户端的三路合并（`src/sync/merge.ts`，203 行）

```ts
threeWayMerge(base, local, remote) → Bookmark[]
```

文件头注释把规则写得很清楚：

> 纯结构化合并，**不做逐操作变更追踪**。身份是内容派生的（folder 按 title、bookmark 按 URL、separator 按位置，同一 folder 内重复项按出现顺序配对），不需要稳定 ID。
>
> | 情形 | 结果 |
> |---|---|
> | 属性只在一侧改 | 取那一侧 |
> | 属性两侧都改 | **remote 赢** |
> | 一侧删除、另一侧未动 | 尊重删除 |
> | 一侧删除、另一侧修改 | **保留被修改的** |
> | 任一侧新增 | 保留 |

合并后 `stripIds()` —— **每次上传都重新分配 ID**。这和 Floccus 用 `highestId` 单调递增的做法完全不同，xBrowserSync 干脆不要 ID。

`decide()` / `pick()` / `mergeOrder()` 是具体实现，`mergeOrder` 专门处理顺序冲突。

### 2.4 sync 引擎的决策（`src/sync/sync-engine.ts`）

```js
remoteLastUpdated = await api.getLastUpdated(syncId)
localLastUpdated  = await store.getLastUpdated()
remoteChanged = remoteLastUpdated !== localLastUpdated
dirty          = await this.isDirty()

!remoteChanged && !dirty  → 'idle'
!remoteChanged &&  dirty  → push()      'pushed'
 remoteChanged && !dirty  → pull()      'pulled'
 remoteChanged &&  dirty  → 下载 remote + threeWayMerge(base, local, remote)
                        → 本地应用 → 用「合并时所依据的那个 lastUpdated」上传 → 'merged'
```

**「用我合并时所依据的时间戳上传」是精髓** —— 如果这期间服务端又被别人改了，上传会撞 409，客户端重试整个循环。所有设备都会收敛到同一个结果（因为合并规则确定性：两侧都改时 remote 赢，而 remote 是同一个值）。

三个方向模式的语义（`push-only` / `pull-only` / 双向），其中 `push-only` 设备的注释值得抄：

> 上传时用服务端**当前**时间戳，这样永远不会冲突 —— 它是数据源，而 pull（唯一能解决冲突的方式）恰恰是它不被允许做的。
>
> 刻意**不做**的事：绝不把本地时间戳推进到「本设备拒绝应用的那个版本」。那会让设备以为自己持有服务端状态但其实没有，这个谎会一直存在 —— 之后切回双向，它会对一个从未见过的同步报 `idle`，下一次 push 就静默覆盖掉。

`store.getCachedBookmarks()` 就是「上次共同状态」—— **和 Floccus 的 cacheTree 同一个角色**。

### 2.5 加密（`src/crypto/crypto.ts`）

```ts
keyDerivationAlgorithm: 'PBKDF2'
keyDerivationIterations: 250_000      // 和 Floccus 一样
keyDerivationHash: 'SHA-256'
encryptionAlgorithm: 'AES-GCM'
ivLengthBytes: 16
```

`getPasswordHash(password, salt)` 产出 base64 的 AES key，**约定用 sync ID 当 salt**（客户端算一次后缓存，所以不重复跑 PBKDF2）。`encrypt` 返回 `base64(IV || ciphertext)`。解不开会抛错（AES-GCM auth 失败）。

注意：**没有 RSA / 公钥体系**。所谓「可选 E2EE」实际上是「你设不设密码」—— 不设密码时服务端明文存书签。**sync ID 本身就是 bearer token**（知道 ID 就能读写，除非有密码）。

### 2.6 服务端 URL 校验（安全设计值得抄）

`normalizeServiceUrl()` 的注释列了三条攻击面：

- 非 HTTPS → 泄露 sync ID，且把响应内容交给攻击者。（http 只允许 loopback）
- 带 query string / fragment → 会把 `/info`、`/bookmarks/{id}`、`/lastUpdated` 全部塌缩到同一个 URL，「一个精心构造的响应就能替其他所有端点通过 getInfo 检查」
- 内嵌凭据 → 会被发到服务端并写进日志

---

## 3. 其他参考对象

### 3.1 Firefox Sync

参考：
- https://blog.nightly.mozilla.org/2018/05/14/deep-dive-new-bookmark-sync-in-nightly/（Lina Cambridge）
- https://mozilla.github.io/dogear/print.html
- https://wiki.mozilla.org/Services/Sync/Developer/StorageFormat
- https://github.com/mozilla/application-services/blob/HEAD/components/sync15/README.md

**数据模型**：每个数据类型（bookmarks / history / tabs / passwords）配一个 **tracker / store / engine** 三件套。tracker 记录变化，超过阈值时唤醒 engine。

**服务端是「一堆扁平、无序、加密的 record」**（WBO）。文件夹持有子节点指针，子节点反向指父。**移动书签或删文件夹需要同时上传多条 record。**

**record 结构**：`{ id, modified, sortindex, payload, ttl? }`；书签历史上有 `parentid` / `predecessorid`，v5 起这两个字段被加密进 payload 内部。

**加密**：Browser Object payload 用对称密钥加密，逐 record 独立 IV，附 HMAC；密钥本身用 RSA 包裹存在 `/crypto/record`（**这是真 E2EE 的密码管理器级做法，Floccus 没有**）。

**增量**：`GET /storage/<collection>?newer=<last_sync_server_timestamp>&full=1`，支持 `Accept: application/newlines` 流式。上传按 **100 条或 1MB** 分批。

**冲突解决的演进史值得看**：

- **早期**：逐 record 独立比对 `modified` 时间戳，时间新的赢。记录级冲突解决。原文明确说「Timestamps are subject to clock drift in the best case, and wildly inaccurate in the worst」。
- Bugzilla 720592 记录了当时的困境：
  > Local change occurs to something we don't care about... Without a Git-esque knowledge of previous state, we simply don't know for sure which fields are canonical, and which changed on each end. (In short: we cannot do a three-way merge, because we don't know the shared parent.)
- **iOS**：引入 **mirror + buffer** 架构，存共享父版本（真正三方合并）。像 Git 一样「shared parent / local / buffer」。
- **Desktop**：不存共享父版本，**只做两路合并**。Dogear 文档的取舍说明很坦率：
  > Since the only indication of an item changed is its `needs_merge` flag, and there's no shared parent tree, Dogear can't know which fields changed... the algorithm is a two-way merge, not a three-way merge. This is a trade-off between simplicity and correctness, and it means that clients don't need to persist snapshots of the shared tree. However, it also means that some conflicts will cause changes to revert on one side, which is a form of data loss.
- **删除 vs 修改的特殊规则**（这部分设计很精细）：
  - 非文件夹项一边改一边删 → **忽略删除、复活该项**
  - 非根文件夹一边改一边删 → **保持删除**，把新后代递归移到最近的存活父目录
  - 根文件夹被删 → 忽略删除并复活（只可能是服务端损坏）
- **Dedupe**：远端同 GUID 但本地没有时，用 `fetch_new_remote_contents` 找内容相似的候选去重（**只对从未上传过的项生效** —— 「an item that is already on the server will never dedupe to one another, even if they match」）。
- **降级收敛**：mirror 先把下到的 record 暂存成树，能处理「缺子节点」「父文件夹还不存在」，所以 record 的到达顺序不重要。mirror 的 `Store::fetch_*` 必须返回**完整**的树，不能留孤儿。

### 3.2 Chrome bookmarks sync

Google 私有协议，没有公开规范，不可被第三方扩展调用。**对 BYOK 设计没有参考价值，跳过。**

### 3.3 Bitwarden / 1Password / LastPass

- **Bitwarden**：`/sync` 端点返回**全量** JSON（`profile.ciphers` 等），响应头 `Last-Modified` 扮演 ETag。客户端流程：
  ```
  GET /sync  →  200 → 本地 vault 日期比服务端新 → push
                      → 服务端新 → pull（不 pull 除非有本地改动）
                      → 都改过 → pull + merge（vault 级别字段级合并）→ push
                      → 304 Not Modified → 不动
  ```
  push 时把上次拿到的 `Last-Modified` 作为 `If-Modified-Since` 发回，服务端据此做乐观锁。**没有 Floccus 那种删除熔断。**
- **1Password**：更细粒度，每个 item 一条记录，各自带 `updatedAt` / `version`，按 item 粒度做 last-writer-wins，item 内部再做字段合并。
- **LastPass**：blob 级同步，靠 `updated` 时间戳 + vault ID，历史上有著名的「同时编辑导致数据丢失」问题。
- **共同点**：全部是 **自建云**。对 BYOK 没有直接可抄的实现，但**「ETag / Last-Modified 做乐观锁 + 冲突时拉下来做字段级合并」这个模式值得照搬**（xBrowserSync 已经把它压缩到 203 行了）。

### 3.4 Wallabag / ArchiveBox 类自托管

纯粹的「本地应用 + 自托管服务端」，用户数据在服务端的数据库里，不是 BYOK 文件。**参考价值低，跳过。**

### 3.5 Rewind / Recall 类

屏幕录像 SaaS，数据量极大，走「事件流 + 时间窗口分片上传 + 服务端聚合」，与书签这类小数据集的同步模型正交。**跳过。**

---

## 4. 用 WebDAV 做同步的开源项目与客户端库选型

### 4.1 值得参考的项目思路

- **rclone**：`serve webdav` 的 CORS 默认只放行 `POST, OPTIONS, GET, HEAD`，**PROPFIND / MOVE 会被浏览器拦掉**（issue #7444）。修法：
  1. 把 `Access-Control-Allow-Methods` 补全成完整的 WebDAV 方法集（`COPY, DELETE, GET, HEAD, LOCK, MKCOL, MOVE, OPTIONS, POST, PROPFIND, PROPPATCH, PUT, TRACE, UNLOCK`）
  2. **把 `Depth`、`Destination` 等请求头也列进 `Access-Control-Allow-Headers`**，否则报 `Request header field depth is not allowed by Access-Control-Allow-Headers in preflight response`
  3. 顺便：`Access-Control-Request-Method` 是**请求头不是响应头**，rclone 里发错了
- **dufs**：`--enable-cors` 即可，是目前对浏览器最友好的 WebDAV server。
- **isomorphic-git + @isomorphic-git/lightning-fs**（Floccus 的 Git 适配器用的）：纯 JS git 实现配 IndexedDB 虚拟文件系统。Git 适配器 `depth: 10` 浅 fetch，仓库不存在时自动 `init` + 写 README + `renameBranch` + push。**关键坑**：只能删自己创建的 DB，删别人的会导致 `delete` 永久 pending，之后 `indexedDB.databases()` 永不 resolve。

### 4.2 npm WebDAV 客户端选型

| 包 | 浏览器可用 | 打包体积 / 依赖 | 建议 |
|---|---|---|---|
| **`webdav`**（perry-mitchell） | ✅ v3+ 起支持；v5 是纯 ESM，`webdav/web` 与 `webdav` 两个入口在支持 ESM 的 bundler 下都可用 | 依赖 `md5`、`base-64`、`url-parse`、`fast-xml-parser`、`@buttercup/fetch`（Node 侧会拉 `node-fetch`）；浏览器端走原生 fetch | **首选**。作者自己写明「Nextcloud / ownCloud 默认不返回友好的 CORS 头，浏览器里用这个库会失败」—— 但**扩展的 host_permissions 路径不需要 CORS 头**，所以这个警告对扩展场景不适用 |
| `webdav-client` | ⚠️ 官方 README 直接写「It is not meant to be used on browsers yet」，要用 browserify 打包；内部依赖 `request` 包 | 老旧 | **不要用** |
| `tndrle/node-webdav` | ⚠️ Node 专用（用 `http` 模块 + `fs`） | — | 扩展里不可用 |
| `@zhxlp/webdav` | fork，自称 v3 浏览器兼容 | 同 `webdav` 系 | 可忽略 |
| `willkan/webdav-client` | 「written in JavaScript for NodeJS」 | — | 不推荐 |

**共同坑（`webdav` 包 README 原文）**：
> Streams are not available within the browser, so `createReadStream` and `createWriteStream` are just stubbed. Calling them will throw an exception.

**但 Floccus 的选择更值得参考：手写 ~200 行 fetch 封装，不引入任何库。** 理由是它只需要 5 个动词（GET / PUT / PROPFIND(Depth:0) / MOVE / DELETE）+ 3 个自定义头，库带来的 `md5` / `url-parse` / CORS 假设全是负担。如果需要目录遍历（PROPFIND Depth:1 递归枚举）、ETag、条件请求这些，`webdav` 包能省事；**如果只是「读一个文件 / 写一个文件」，手写更干净。**

---

## 5. Chrome MV3 做 WebDAV 同步的已知坑

### 5.1 CORS / host_permissions

**规则**（MV3 Extension Dev Hub、Moderok 博客）：

- **扩展上下文**（service worker、popup、options、side panel）拥有 `chrome-extension://<id>` 源。**列在 `host_permissions` 里的主机，Chrome 直接豁免 CORS 检查，服务端不需要返回任何 CORS 头。**
- **content script 不是扩展上下文。** 自 Chrome 85 起，content script 的请求按**页面源**走，`host_permissions` 对它无效，必须经 `runtime.sendMessage` 转发到 service worker。Chrome 的理由：「a compromised renderer process should not be able to use an extension's host permissions to read arbitrary cross-origin data」。
- **Firefox 反过来**：Firefox 126 及更早，MV3 host permission **不在安装时授予也不展示给用户**，content script 带 host permission 仍有跨域特权。**Chrome-only 的失败在 Firefox 上不复现。**
- **Firefox 127 起** host permission 会在安装提示里展示并授予，但用户随时可撤销 → **防御性代码要 `chrome.permissions.contains()` 检查后再发请求，或运行时 `chrome.permissions.request()` 申请。**
- `host_permissions` 是**用户可见**的。`*://*/*` 会给出「读取和更改您在所有网站上的数据」的安装警告。**能用 `optional_host_permissions` + 运行时申请就别写死。**
- match pattern **必须含 scheme 和路径通配**：`https://api.example.com`（无 `/*`）不是合法 pattern，manifest 加载失败。
- **Chrome 侧仍可能对某些请求发 preflight，但不执行响应的 CORS 头** —— host permission 已经豁免了。
- WebDAV 的 `Depth`、`Destination` 等自定义头在**纯 CORS 场景**（比如 web 页面里调）需要服务端在 `Access-Control-Allow-Headers` 里列出；host_permissions 豁免路径不需要。

**Floccus 的做法**（`WebDav.ts onSyncStart`）：

```js
hasPermissions = await browser.permissions.contains({ origins: [this.server.url + '/'] })
if (!error && !hasPermissions && !isOrion) throw new MissingPermissionsError()
```

即：**manifest 里写 `*://*/*` 兜底，运行时再按用户实际配的服务器 URL 精确检查是否被授予。** 同时 `ui/store/actions.js:214` 有 `browser.permissions.request({ origins: ['*://*/*'] })` 的引导流程。

### 5.2 Service worker 生命周期（最大的坑）

Chrome 官方（https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle）原文：

> Chrome 在以下情况终止 service worker：
> - **30 秒空闲**后。接收事件或调用扩展 API 会重置此计时器。
> - **单个请求或事件处理超过 5 分钟**时。
> - **一个 `fetch()` 响应超过 30 秒才到达**时。

**对同步的影响**：

- **冷启动 4000 条书签要 4 分钟**（Floccus 实测），逼近 5 分钟硬上限。用户网络慢一点、大书签多一点就必然被腰斩。
- **被杀不会报错** —— SW 直接消失，`finally` 不执行，锁文件留在服务器上（15 分钟后其他设备才能接管）。
- Floccus 的对策就是整套 continuation 持久化（见 1.9）。**如果不想实现 continuation，唯一可行的简化是「同步粒度小到能在 30 秒内跑完」，即分片。**
- **延长生命周期的手段**（Chrome 官方列出）：
  - 活跃的 `WebSocket` 连接（收发消息重置 idle 计时器）
  - 定期调扩展 API（每次 `chrome.storage` 调用都重置）
  - `chrome.offscreen` 文档（MV3 里跑长任务的官方手段）
  - `runtime.connectNative()` 保持端口（host 崩溃后 SW 在计时器走完后终止）
- **不要把状态放在模块作用域变量里** —— 每次事件处理都当 SW 刚启动。listener 必须**同步注册在顶层**，注册在 `await` 之后会错过唤醒事件。这是 chromium-extensions 群里最常见的「本地好好的、装成 packed 就不跑」的根因：**unpacked 开发构建不 clamp，packed 才 clamp**。
- 排查时：SW 的 CORS 错误**不会出现在页面 console**。要去 `chrome://extensions` → 开发者模式 → 点「service worker」链接开 DevTools。

### 5.3 chrome.alarms 定时

Chrome 官方文档原文（本次已直接核对 developer.chrome.com/docs/extensions/reference/api/alarms）：

> 为了减轻用户机器的负载，Chrome 将闹钟限制为**最多每 30 秒触发一次**，但可能会将闹钟延迟任意时长。也就是说，将 `delayInMinutes` 或 `periodInMinutes` 设置为小于 `0.5` 的值，系统将不会接受该值，并会发出警告。`when` 可以设置为「现在」之后的不到 30 秒，系统不会发出警告，但实际上至少要过 30 秒闹钟才会响铃。
>
> **为了帮助您调试应用或扩展程序，当您以未打包的形式加载时，闹钟的触发次数不受限制。**

- 30 秒下限是 **Chrome 120** 引入的（之前是 1 分钟）。
- **unpacked 开发构建豁免 clamp** → 本地 `periodInMinutes: 0.25` 跑得好好的，发布后变成 30 秒。**这是最容易漏测的坑**，因为 `getAll()` 还会回显你请求的值。
- `persistAcrossSessions` 是 **Chrome 150+ 的新属性**（Chrome 里默认 `true`）。Chrome 150 之前以及其他浏览器不保证 → **官方建议每次 SW 启动时检查并重建 alarm**：

```js
async function checkAlarmState() {
  const alarm = await browser.alarms.get("my-alarm")
  if (!alarm) await browser.alarms.create("my-alarm", { periodInMinutes: 1 })
}
checkAlarmState()   // 顶层直接调
```

- **扩展更新时 alarm 会被清空**，用户拿到新版本后必须重建。
- **创建同名 alarm 是覆盖而非「仅当不存在才创建」** —— 每次 SW 唤醒都无条件 `create` 会不断重置周期，导致 alarm 永远不触发。
- **设备休眠**：alarms 继续跑但不会唤醒设备；唤醒后错过的 alarm 会响一次，重复 alarm 的下次时间从唤醒时算起。
- **Floccus 的 1 分钟固定 tick + 自己判到期**（见 1.8）是最佳实践参考，比「按用户设置的间隔建一堆 alarm」健壮得多。
- **Firefox 121+ MV3 同样有 1 分钟下限**；Safari 17+ clamp 更激进且加电源状态节流，1 分钟的 alarm 在电池上可能实际触发得更少。

### 5.4 其他 MV3 细节

- MV3 SW 里**没有 DOM**：`window`、`document`、`XMLHttpReader`、`localStorage` 都没了。用 `fetch` 和 `chrome.storage`。
- `top-level await` 允许，但**长初始化不会让 SW 保持存活**。
- `chrome.runtime.getURL` 在 install 期间不可靠，要懒解析（在事件处理函数里）。
- **扩展更新后 SW 会被重启**，未持久化的中间状态全丢。
- Firefox MV2 manifest 是 background page，Firefox MV3 是 `scripts`；Floccus 用 `manifest-firefox-override.sh` 处理差异。

---

## 6. 给 one-tab 的可执行结论

如果要给 one-tab 加 BYOK 同步（用户自带 WebDAV / Google Drive），按「最小可用且不会丢数据」排序：

1. **抄 xBrowserSync 的并发模型，不要抄 Floccus 的锁。** `.lock` 软锁给不了互斥保证；`lastUpdated` / `ETag` 比对（409）是真的一致性保证。WebDAV 有 `ETag` 和 `Last-Modified`，直接用。
2. **抄 Floccus 的删除熔断。** `一次删除 > 20% 或 > 1000 条 → 中止并报错`。这是唯一能挡住「误清空 localStorage / 误触发全量重建」的防线。one-tab 已有 silent-empty read 那类数据丢失防线，熔断是同一层级的最后一道。
3. **必须存「上次成功同步的服务端快照」作为共同祖先**，否则只能做两路合并（会丢数据）。one-tab 的 groups 是扁平数组（不像书签有深层树），冲突面小很多，这部分实现成本应该比 Floccus 低得多。
4. **MV3 下要么分片、要么持久化断点。** one-tab 的数据量应该远小于 4000 条书签，冷启动大概率在秒级，可以先不做 continuation —— **但必须测一次真实的最坏情况耗时**，超过 60 秒就要重新设计。
5. **用固定周期 alarm（1 分钟）+ 自己判到期**，参照 `SyncSchedule.ts` 的 `isSyncDue` + 指数退避 + 离线不重试。
6. **host_permissions 尽量收窄**：如果 V1 只支持一种存储，就 `optional_host_permissions` 运行时申请，别一开始就 `*://*/*`（会拿「所有网站数据」的安装警告）。
7. **手写 fetch 封装，不引 WebDAV 库。** 只需要 GET / PUT / PROPFIND(Depth:0) / MOVE / DELETE。库在浏览器里没有 Stream，且带来一堆 Node 假设。
8. **加密用 `PBKDF2(passphrase, salt, 250000, SHA-256) → AES-256-GCM`**，和 Floccus / xBrowserSync 一致。salt 每次随机，密文格式 `base64(iv || ciphertext)`。判「要不要上传」用**明文哈希**，不用密文哈希。
9. **上传用 `.temp` + `MOVE` + 字节数校验**（Floccus 的 `uploadBookmarkFile`）。这条直接防「写入被静默截断」，代价只有两次 PROPFIND。

---

## 附录：来源清单

**源码（一手，本次实际克隆阅读）**

- https://github.com/floccusaddon/floccus
  - `src/lib/adapters/WebDav.ts`、`Git.ts`、`Dropbox.ts`、`GoogleDrive.ts`、`NextcloudBookmarks.ts`、`Caching.ts`
  - `src/lib/Crypto.ts`、`DefunctCrypto.js`
  - `src/lib/Scanner.ts`、`Diff.ts`、`Tree.ts`、`Mappings.ts`、`Account.ts`、`SyncSchedule.ts`
  - `src/lib/strategies/Default.ts`
  - `src/lib/browser/BrowserController.js`
  - `src/lib/serializers/Xbel.ts`
  - `AGENTS.md`（该仓库自带一份非常详细的 AI agent 指南，含 continuation / hash / mapping 的坑）
- https://github.com/xBrowserSync/api — `src/routers/bookmarks.router.ts`、`src/services/bookmarks.service.ts`
- https://github.com/xBrowserSync/core — `src/sync/merge.ts`、`sync-engine.ts`、`crypto/crypto.ts`、`api/xbrowsersync-api.ts`、`openapi/xbrowsersync-api.yaml`

**官方文档**

- Floccus 官网与指南：https://floccus.org/ 　https://floccus.org/guides/
- Chrome service worker 生命周期：https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- Chrome alarms API：https://developer.chrome.com/docs/extensions/reference/api/alarms
- Firefox 书签同步架构解析：https://blog.nightly.mozilla.org/2018/05/14/deep-dive-new-bookmark-sync-in-nightly/
- Dogear 合并算法文档：https://mozilla.github.io/dogear/print.html
- Firefox Sync 存储格式：https://wiki.mozilla.org/Services/Sync/Developer/StorageFormat
- Mozilla application-services sync15：https://github.com/mozilla/application-services/blob/HEAD/components/sync15/README.md
- xBrowserSync：https://www.xbrowsersync.com/
- webdav npm：https://www.npmjs.com/package/webdav 　https://github.com/perry-mitchell/webdav-client

**Issue / 讨论**

- Chrome alarms 与 MV3 SW inactive：https://groups.google.com/a/chromium.org/g/chromium-extensions/c/k5upFLVnPqE
- rclone WebDAV CORS（PROPFIND 被拦）：https://github.com/rclone/rclone/issues/7444
- Firefox Sync 冲突与三方合并困境：https://bugzilla.mozilla.org/show_bug.cgi?id=720592
- Nextcloud Bookmarks + Floccus 用户调查（已知问题清单：重复书签、同步失败、清空文件夹）：https://help.nextcloud.com/t/nextcloud-bookmarks-floccus-user-survey/133856

**未能获取一手源的部分（说明）**

- Bitwarden / 1Password / LastPass 的具体实现：官方未公开规范，本节基于公开的 sync 流程描述与社区分析，**未读源码**。
- Chrome bookmarks sync 私有协议：无公开资料，未展开。
- DeepWiki 未收录 floccus 仓库，无法用其索引。
