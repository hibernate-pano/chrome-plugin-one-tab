# 调研报告：WebDAV 类云盘作为浏览器扩展数据后端的可行性工程细节

- **调研日期**：2026-10-13
- **调研者**：Codex 调研 agent（只读调研，未修改仓库任何代码）
- **项目**：chrome-plugin-one-tab（多标签组 + 同步扩展）
- **调研目的**：评估「把浏览器扩展的数据后端换成 WebDAV 类云盘（尤其坚果云）」的工程可行性，为同步方案选型提供依据。

---

## 0. 核心结论（TL;DR）

**「Chrome 扩展能否直接 fetch 坚果云 WebDAV？」→ 能，但必须声明 `host_permissions`。**

这是本次调研最重要、最容易被误解的一点，结论分两层：

| 层 | 结论 | 证据 |
|---|---|---|
| 浏览器通用 CORS 规则 | 坚果云 WebDAV **不支持 CORS**，普通网页/未授权扩展发 `PROPFIND` 会被浏览器**在发出前拦掉**（`Failed to fetch`） | §1.3 实测 + §1.4 负向对照 |
| Chrome MV3 扩展特权 | 声明 `host_permissions: ["https://dav.jianguoyun.com/*"]` 后，扩展 service worker 的 `fetch` **绕过 CORS**，PROPFIND/MKCOL/PUT 等非简单方法都能打到服务器 | §1.5 实测（Chrome for Testing 真机加载 MV3 扩展） |

关键澄清：网上大量「WebDAV 不能在浏览器里用」的说法是**对的但不完整**——对普通网页成立，但对拥有 host 权限的 MV3 扩展**不成立**。真正需要 host 权限（而非 CORS）这件事，是 MV3 的设计意图（见 §1.6 Chrome 官方原文）。

**给 one-tab 的建议**：坚果云可以作为「个人自用 / 小众用户」的后端；但不适合作为默认主推后端，因为**无增量变更接口（没有 changeToken/change feed）**，只能靠全量 PROPFIND 轮询，且有硬性频率/条目数限制（见 §1.7、§5）。若要做「多设备增量同步」，Google Drive `changes` / OneDrive `delta` 这类带 pageToken 的 API 在增量能力上明显更强（见 §2）。

---

## 1. 坚果云（Nutstore）WebDAV 深度调研

### 1.1 服务器地址（已验证事实）

- **地址**：`https://dav.jianguoyun.com/dav/`
- 来源（官方帮助中心，多篇一致）：
  - Zotero 连接教程：https://help.jianguoyun.com/?p=3168 —— 原文「依次填写【网址】即坚果云的服务器地址：https://dav.jianguoyun.com/dav/」
  - WPS 教程：https://help.jianguoyun.com/?p=2622 —— 原文提到 `https://dav.jianguoyun.com/dav`，并提示「注意需要删除原有的 `http://`」（即必须用 https）
  - Tampermonkey 教程：https://help.jianguoyun.com/?p=5627
- 实测确认（无凭证 curl）：
  - `GET https://dav.jianguoyun.com/dav/` → `HTTP/2 401`，`www-authenticate: Basic realm="nutstore"`
  - `GET https://dav.jianguoyun.com/`（不带 /dav/）→ `HTTP/2 403`
  - 即：必须带 `/dav/` 前缀；服务器要求 HTTP Basic Auth。

### 1.2 认证方式（已验证事实）

- **HTTP Basic Auth**，用户名 = 坚果云账号，密码 = **「应用密码」（application password）**，不是账号登录密码。
- 生成方式（官方）：登录坚果云网页版 → 右上角账户名 → 【账户信息】→【安全选项】→ 「第三方应用管理」→「添加应用密码」→ 输入名称 → 生成。
  - 来源：https://help.jianguoyun.com/?p=2064
- 实测确认：`WWW-Authenticate: Basic realm="nutstore"`（curl 与真实扩展内 fetch 均观测到该响应头）。
- 应用密码可创建多个、可单独吊销（一个第三方应用一个密码），这是它相对「主账号密码」的安全优势（见 §3）。

### 1.3 CORS 支持情况 —— 关键实测（已验证事实）

坚果云 WebDAV **不返回任何 CORS 响应头**。实测（curl，带 `Origin` 与预检头）：

```
OPTIONS https://dav.jianguoyun.com/dav/
  -H "Origin: chrome-extension://<id>"
  -H "Access-Control-Request-Method: PROPFIND"
  -H "Access-Control-Request-Headers: authorization,depth,content-type"
→ HTTP/2 401
   （无 access-control-allow-origin，无 access-control-allow-methods）
```

对照实验（同一请求，不同 Origin，结果一致）：
- `Origin: https://evil.example.com` → 401，无 ACAO
- `Origin: https://www.jianguoyun.com`（同站） → 401，无 ACAO
- `Origin: chrome-extension://...` → 401，无 ACAO
- 根路径 `https://dav.jianguoyun.com/` 与 `https://www.jianguoyun.com/dav/`（后者直接 501不支持 OPTIONS）→ 同样无 ACAO

**结论（事实层）**：坚果云 WebDAV 不实现 CORS。对任何**没有 host 权限**的 JS 上下文，浏览器会在请求发出前拦截，JS 侧看到 `TypeError: Failed to fetch`。

**但这不等于「扩展不能用」**——见 §1.5 的实测与 §1.6 的官方规则。真正决定性的是浏览器把请求交不交出去，而 host 权限正是用来买这个通行权的。

### 1.4 负向对照实验（已验证事实，用于证明测试可信）

为了排除「探针脚本写错了、其实能通」的可能，我做了一个**对照实验**：同一个 fetch，只改扩展是否声明 `host_permissions`。

用 Playwright + Chrome for Testing 真实加载两个 MV3 扩展，对 `https://dav.jianguoyun.com/dav/` 发 GET/PROPFIND/OPTIONS：

```
A：声明 host_permissions: ["https://dav.jianguoyun.com/*"]
    GET      -> HTTP 401
    PROPFIND -> HTTP 401
    OPTIONS  -> HTTP 401
    （401 = 请求确实到达了服务器，只是缺认证）

B：不声明任何 host_permissions（负向对照）
    GET      -> ERR: Failed to fetch
    PROPFIND -> ERR: Failed to fetch
    OPTIONS  -> ERR: Failed to fetch
    （Failed to fetch = 浏览器在本地拦下，请求从未发出）
```

这个对照证明：① 探针有能力区分「被 CORS 拦」和「到达服务器」；② 决定两者差异的**唯一变量就是 host_permissions**。

### 1.5 WebDAV 方法与条件请求实测（已验证事实，但注意认证前置）

在**有 host 权限的 MV3 扩展 service worker 内**实测，对 `https://dav.jianguoyun.com/dav/` 依次发：

| 方法 | 结果 | 说明 |
|---|---|---|
| GET / HEAD / PROPFIND / MKCOL / PUT / DELETE / OPTIONS | 全部 `HTTP 401` + `WWW-Authenticate: Basic realm="nutstore"` | 请求都**到达了服务器**；401 是「未带/带错 Basic 认证」的服务端响应 |
| PROPFIND + XML body + `Content-Type: application/xml` + `Authorization: Basic ...` | `HTTP 401`，仍回 `WWW-Authenticate: Basic realm="nutstore"` | 带 XML 请求体和 Basic 头也不会被浏览器拦（在扩展上下文中），服务器仍要求认证 |
| PUT + `If-None-Match: *` | `HTTP 401` | 条件请求头可正常发出（服务器先要认证） |

**重要限定**：以上是**无有效凭证**的探测，所以停在 401。**我没有坚果云真实账号与应用密码，无法验证认证通过后的行为**，因此以下仍是「推测」而非事实：
- PROPFIND 是否正确返回 207 Multi-Status、是否返回 `getetag`/`getlastmodified`；
- MKCOL 创建目录的实际返回码；
- `If-Match` / `If-None-Match` 在认证后是否会正确返回 `412 Precondition Failed`（协议规定应如此，见 §4.1，但坚果云实现需实测）。

不过从「方法 + 认证头 + 条件头」都能原样发到服务器这一点看，**协议层兼容性风险很低**，剩下的主要是业务实现细节。

### 1.6 为什么 MV3 扩展能绕过 CORS（已验证事实，官方来源）

Chrome 官方文档 Cross-origin network requests（https://developer.chrome.com/docs/extensions/develop/concepts/network-requests）原文：

> "Regular web pages can use the `fetch()` or `XMLHttpRequest` APIs to send and receive data from remote servers, but they're limited by the same origin policy. Content scripts initiate requests on behalf of the web origin that the content script has been injected into and therefore content scripts are also subject to the same origin policy. **Extension origins aren't so limited. A script executing in an extension service worker or foreground tab can talk to remote servers outside of its origin, as long as the extension requests host permissions.**"

同页还明确：

> "Cross-origin requests are always treated as such in **content scripts**, even if the extension has host permissions."

即：
- 在 **service worker / popup / options 页（扩展自身页面）** 里发请求 → host 权限生效，绕过 CORS；
- 在 **content script** 里发请求 → 即使有 host 权限也仍受同源策略约束。

这对 one-tab 有直接的工程含义：**所有 WebDAV 请求必须在 background service worker（或 popup/options 页面）里发，绝对不能放在 content script 里。**

补充（manifest 权限）：https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions —— host_permissions 可写完整主机名（`https://dav.jianguoyun.com/`）或匹配模式（`https://*.jianguoyun.com/`）。权限按「主机 + scheme」授予，要 http 需单独声明 http。

### 1.7 官方硬性限制（已验证事实）

来源：https://help.jianguoyun.com/?p=2064（「第三方应用访问的限制」小节，原文）：

| 限制项 | 免费版 | 付费用户 |
|---|---|---|
| 访问频率 | 每 30 分钟不超过 **600 次请求** | 每 30 分钟不超过 **1500 次请求** |
| 单次上传大小 | 500 MB（与网页端一致，私有云可调） | 同 |
| 单次请求文件数 | **750 个**（含文件和文件夹），支持分页多次加载 | 同 |

原文另有一句对第三方工具很重要：

> "如果您使用 WebDAV 的三方工具未实现按分页多次加载，可能会出现**文件同步不完整**的情况。"

**工程含义**：
1. 免费版 600 次/30 分钟 ≈ 平均 0.33 QPS。对一个「标签组数量几十」的轻量数据同步完全够用（一次全量 PROPFIND 拉所有目录 + 若干 PUT）；但**绝不能做高频轮询**。
2. 750 条/请求的上限意味着**必须实现分页**（PROPFIND 的分页/或按子目录分批），否则会「静默同步不完整」——这正是 one-tab 记忆里那条「静默空读」的同类陷阱：不是报错，是**少数据**。
3. 坚果云**没有 changeToken/change feed**（无增量变更接口），只能靠「定期全量 PROPFIND + 比对 etag/lastmodified」来发现变化。这与 §2 里 Drive/OneDrive 的增量能力形成对比。

### 1.8 MKCOL / PROPFIND / 条件请求的协议依据（已验证事实，来自 RFC）

- WebDAV 方法与状态码定义：RFC 4918（https://www.rfc-editor.org/rfc/rfc4918.txt）
  - `MKCOL` 创建集合；`PROPFIND` 取属性；`412 Precondition Failed`（§12.1）为条件请求失败码。
  - RFC 4918 §9.6.x 及示例说明：可用 `If-Match: "xxx"` 表达「基于 ETag 的乐观并发」，若不匹配返回 412。
- HTTP 条件请求语义：RFC 9110（https://www.rfc-editor.org/rfc/rfc9110.txt）
  - §13.1.1 `If-Match` / §13.1.2 `If-None-Match`；条件不满足时返回 `412`（对部分方法亦可用 `304`）。

**推测（需认证后实测确认）**：坚果云作为成熟 WebDAV 服务，大概率实现了 ETag 与 If-Match/If-None-Match；但「是否对 PUT 严格返回 412」「etag 格式是否为标准弱/强 ETag」需实测。

---

## 2. 其他可作为后端的方案横向对比

### 2.1 对比总表

| 维度 | 坚果云 WebDAV | Dropbox API | Google Drive API v3 | OneDrive / Graph | S3 兼容(MinIO/R2) | Cloudflare R2 | 通用 WebDAV 服务器 |
|---|---|---|---|---|---|---|---|
| 鉴权方式 | HTTP Basic（应用密码） | OAuth2 Bearer | OAuth2 Bearer | OAuth2 Bearer | AWS SigV4（AccessKey+Secret） | S3 API Token / AWS SigV4 | HTTP Basic 或 Bearer |
| 浏览器端安全持凭证 | 一般（应用密码可单独吊销，非主密码） | 较好（OAuth，可 scope+revoke） | 较好（OAuth） | 较好（OAuth，MSAL） | 差（Secret 等于账号钥匙，需极谨慎） | 中（可 bucket 级 scope 的 User token） | 取决于部署 |
| CORS 支持 | **无**（实测）；但扩展有 host 权限可用 | **有**（实测回显 Origin） | **有**（实测回显 Origin） | **有**（实测回显 `*`） | 取决配置（R2 可配） | 需在 bucket 上配 CORS 策略 | 取决服务器 |
| 增量变更查询 | ❌ 无 changeToken，只能全量 PROPFIND 轮询 | ✅ cursor / `has_more` | ✅ `changes` + pageToken | ✅ `delta` link | ⚠️ 无原生 change feed，靠 ListObjects+ETag 对比 | ⚠️ 同 S3 | ❌ 通常无，靠 ETag 对比 |
| 文件操作原子性 | 单文件 PUT 原子；无跨文件事务 | 单文件原子 | 单文件原子 | 单文件原子 | 单对象 PUT 原子（S3 单次 PUT 要么成功要么不变） | 同 S3 | 取决于实现 |
| 条件写(If-Match/If-None-Match) | 推测支持（协议要求，实测需认证） | ✅ 支持（content upload 带 `If-Match`/`If-None-Match`） | ✅ 支持（ETag + If-Match） | ✅ 支持（eTag + If-Match） | ✅ 支持（S3 条件写） | ✅ 支持（S3 API 条件操作） | 取决于实现 |

### 2.2 Dropbox API（已验证事实 + 部分推测）

- **CORS**：实测 `POST https://api.dropboxapi.com/2/files/list_folder` 带 `Origin: chrome-extension://...` → 返回 `access-control-allow-origin: <回显的 origin>`，并 expose 了 `ETag, Dropbox-API-Result` 等。→ **原生支持浏览器端调用**。
  - 来源/验证：直接对 `api.dropboxapi.com` 发起带 Origin 的请求，观察到 ACAO 回显。
- **鉴权**：OAuth2 Bearer。扩展需 `chrome.identity.launchWebAuthFlow` 走 OAuth（PKCE），token 存本地。
- **增量**：`files/list_folder` 返回 `has_more` + `cursor`，`list_folder/continue` 续拉——是真正的增量/分页游标。
- **速率限制**：**未验证**。Dropbox 开发者文档（https://www.dropbox.com/developers/documentation/http/documentation）为 JS 动态渲染，多次抓取（curl/wayback/text-proxy）均未取到 rate-limit 正文，故此处**不下断言**，见 §6「未验证项」。

### 2.3 Google Drive API v3（已验证事实）

- **CORS**：实测 `GET https://www.googleapis.com/drive/v3/files` 带 Origin → `access-control-allow-origin: <回显 origin>`。→ **支持浏览器端调用**。
- **增量**：`changes` 集合 + pageToken（`changes.getStartPageToken` → `changes.list`），可只取「自某时间点以来变化的文件」。
  - 来源：https://developers.google.com/drive/api/guides/about-changes —— 原文「The collection works by providing the current state of each item, **if and only if the item has changed since a given point in time**」「Google Drive keeps a **change log** for each user and shared drive」。
- **速率限制与退避**（官方）：
  - 用量限制：每分钟每项目 1,000,000 quota units；每分钟每用户每项目 325,000 units（来源：https://developers.google.com/drive/api/guides/limits）。
  - 超限返回 `403 rateLimitExceeded` / `403 userRateLimitExceeded`；Drive 后端还可能返回 `429`。
  - 官方处理建议：**用指数退避（exponential backoff）重试**、批处理合并请求。
  - 来源：https://developers.google.com/drive/api/guides/handle-errors —— 对 `rateLimitExceeded` / `userRateLimitExceeded` 均给出「Use exponential backoff to retry」「Batch requests」。
- **条件请求**：Drive 用 `ETag` + `If-Match` 做乐观并发。

### 2.4 OneDrive / Microsoft Graph（已验证事实）

- **CORS**：实测 `GET https://graph.microsoft.com/v1.0/me/drive/root/children` 带 Origin → `Access-Control-Allow-Origin: *`。→ **支持浏览器端调用**。
- **增量**：`delta` 链接（`/me/drive/root/delta`）返回增量变更 + `deltaLink`。
- **限流与退避**（官方，来源：https://learn.microsoft.com/en-us/graphql/throttling 与 https://learn.microsoft.com/en-us/onedrive/developer/rest-api/concepts）：
  - 超限返回 `429 Too Many Requests`，并带 **`Retry-After` 响应头**。
  - 最佳实践原文要点：「按 Retry-After 退避是最快的恢复方式」「**避免立即重试**」「没有 Retry-After 时用指数退避」。
  - 另提醒：持续轮询扫描资源集合容易触发限流，应优先用 change tracking / notifications。
- **条件请求**：driveItem 有 `eTag` / `cTag`，写操作支持 `If-Match`。
- 注：OneDrive API 官方明确有一节「Calling the API from JavaScript and CORS」，是官方承认的浏览器端调用场景。

### 2.5 S3 兼容（MinIO）/ Cloudflare R2（已验证事实）

- **条件写（原子性关键）**：S3 的 `PutObject` 支持 `If-None-Match: *`（仅当对象不存在时写入）与 `If-Match`（仅当 ETag 匹配时覆盖）——这是实现「无服务端也能原子去重/防覆盖」的关键原语。
  - AWS 条件请求文档：https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-requests.html （该页为 JS 渲染，正文经 R2 文档转述确认，见下）
  - R2 S3 API 兼容表：https://developers.cloudflare.com/r2/api/s3/api/ —— 明确列出 HeadObject/GetObject/PutObject 支持 Conditional Operations：`If-Match` ✅、`If-Modified-Since` ✅、`If-None-Match` ✅、`If-Unmodified-Since` ✅。
- **CORS（R2）**：需在 bucket 上配置 CORS 策略；官方示例显式包含 `ExposeHeaders: ["ETag"]`（注释：ETag 对校验上传有用）。
  - 来源：https://developers.cloudflare.com/r2/buckets/cors/ —— 原文「Set ExposeHeaders to allow your JavaScript to read response headers like ETag, which contains the object's hash and is useful for verifying uploads」。
- **凭证**：
  - R2 API Token 分 Account / User 两类；可按 bucket scope；**Secret Access Key 只在创建时显示一次**，之后不可再取（原文「You will not be able to access your Secret Access Key again after this step」）。
  - 来源：https://developers.cloudflare.com/r2/api/tokens/
  - **推测/风险**：S3 的 Secret Key 权限很大（等同账号钥匙），在浏览器端长期持有风险高；R2 的 bucket-scope token 相对收敛，但仍需谨慎。
- **无原生 change feed**：靠 `ListObjectsV2` + ETag/LastModified 对比实现增量发现；没有 Drive 那样的 pageToken 级变更日志。

---

## 3. 凭证安全：Chrome 扩展里存 token / 应用密码的现实做法与风险

### 3.1 chrome.storage.local 的信任边界（已验证事实，官方来源）

来源：https://developer.chrome.com/docs/extensions/reference/api/storage

- `storage.local` **默认对 content scripts 可见（exposed）**！原文：
  > "By default, it's exposed to content scripts, but this behavior can be changed by calling `browser.storage.local.setAccessLevel()`."

  → **这是一个高频踩坑点**：如果把 OAuth token / 应用密码直接放 `storage.local` 而不调 `setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'})`，理论上会被本扩展的 content script 读到。对 one-tab 这种扩展，建议**只存于 background、且显式设为 TRUSTED_CONTEXTS**。

- 容量：`local` 上限 10 MB（Chrome 113 及更早 5 MB），可用 `unlimitedStorage` 权限提升。
- 存储内容**不是加密存储**——`chrome.storage` 是明文 profile 文件，磁盘上以明文存在，能读用户 profile 的攻击者/恶意软件可直接读取。

### 3.2 「用 WebCrypto 加密后再存」是否可行？（已验证事实 + 分析）

**可行，但有前提与陷阱。**

可用工具（WebCrypto / SubtleCrypto 支持情况，来源 MDN https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto）：
- ✅ **PBKDF2**（deriveKey）——支持
- ✅ **AES-GCM**——支持
- ✅ HKDF、SHA-256 等——支持
- ❌ **Argon2 / scrypt**——**WebCrypto 不支持**（算法表里没有 Argon2/scrypt）；若要用 Argon2 得自己引 WASM 实现（增加体积与复杂度）。

**参数建议（OWASP 官方基线，来源 https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html）：**
- OWASP 推荐首选 **Argon2id**：≥19 MiB 内存、迭代 2、并行度 1。
- 无 Argon2 时用 **scrypt**：N=2^17、r=8、p=1。
- 仅当需要 FIPS-140 合规才用 **PBKDF2：work factor ≥ 600,000，HMAC-SHA-256**。
- 强调：**每个密码/密钥都要加唯一 salt**，防止彩虹表；快哈希（SHA-256）不适合。

**落到扩展里的现实权衡（分析/推测）**：
- OWASP 的 600,000 次 PBKDF2 是为「服务端、密码可能被离线爆破」设计的。扩展里用密码派生密钥来加密 token，好处是「profile 文件被拷走也无法直接解密」；代价是每次用凭证都要派生一次密钥（600k 次 PBKDF2 在 JS 里开销明显）。
- 一个常见折中是：**不要求用户每次输密码**，而是随机生成一个高熵「设备密钥」加密 token 存 storage，再把「设备密钥」用用户密码（低轮数派生）或 OS/平台钥匙串保护；但 MV3 扩展拿不到系统钥匙串，需自建。
- **核心权衡**：加解密只是「防磁盘明文」，**不防已经在扩展上下文里运行的恶意代码**——真正的防线是「不要把凭证交给 content script」「限制 host_permissions 范围」「用最小权限的 token」。

**推荐做法（综合）**：
1. OAuth 类（Drive/OneDrive/Dropbox）：优先 **PKCE + 最小 scope**，token 存 `storage.local` 且 `setAccessLevel(TRUSTED_CONTEXTS)`；refresh token 尤其要当敏感数据保护。
2. 坚果云应用密码：本身是「可单独吊销、非主密码」，风险等级中等；仍建议加密存储 + TRUSTED_CONTEXTS。
3. 若自建加密：WebCrypto **PBKDF2(HMAC-SHA-256) + AES-GCM**，salt 每条随机、随密文存储；轮数在 100k–600k 间按实测 UX 取舍（不要盲抄 600k），并明确记录「这是防离线明文，不是防运行时」。
4. **不要**把主账号密码、AWS Secret Key 这类「权限等同账号」的凭证交给浏览器端。

---

## 4. 冲突检测与解决（无服务端场景）

### 4.1 协议层原语（已验证事实）

- **乐观并发（首选）**：读取时拿 `ETag`，写入时带 `If-Match: "<etag>"`。若远端已被别人改过（ETag 不匹配），服务端返回 `412 Precondition Failed`。
  - 依据：RFC 4918 §12.1（WebDAV 412，https://www.rfc-editor.org/rfc/rfc4918.txt）；RFC 9110 §13.1.1/13.1.2（If-Match/If-None-Match，https://www.rfc-editor.org/rfc/rfc9110.txt）。
- **防重复创建（create-if-absent）**：`If-None-Match: *`，仅当资源不存在时写入；已存在则失败（412）。S3/R2 原生支持这个语义。
- **读缓存校验**：`If-None-Match`/`If-Modified-Since` 用于「没变就别回传」（304）。

### 4.2 三种策略对比

| 策略 | 做法 | 优点 | 缺点 | 适用 |
|---|---|---|---|---|
| **乐观锁（ETag + If-Match）** | 冲突时服务端直接 412，客户端拉取远端最新再让用户决定/合并 | 不静默丢数据，能真正检测冲突 | 需要后端支持条件写；冲突需用户介入 | 通用，**首选** |
| **Last-Writer-Wins（LWW）** | 按 `modifiedTime` 时间戳，谁新覆盖谁 | 实现最简单，无需用户交互 | 静默丢数据；时钟偏差会误判 | 数据「几乎不冲突」或可容忍丢失 |
| **三方合并（base/local/remote）** | 保留上次同步基线 base，用 diff3 风格合并 local vs remote | 可自动合并非重叠修改，体验好 | 需持久化 base；重叠修改仍需人工/规则决策 | 结构化数据（标签组列表可考虑） |

**业界实现参考**：
- Dropbox / Drive / OneDrive 均以 ETag + 条件写实现乐观并发（见 §2 各节）。
- S3/R2 的 `If-Match`/`If-None-Match` 是「无服务端原子去重」的教科书原语。
- **对 one-tab 的具体建议**：标签组是有序列表 + 名称 + tab URL 集合，属结构化数据。若要低摩擦同步，**三方合并（base/local/remote）**比纯 LWW 更安全（避免「两台设备各加一个组 → 静默丢一个」）；但工程量比 LWW 大。折中：先做 **ETag + 412 检测 + 冲突时提示用户**，把三方合并放 V2。

---

## 5. 速率限制与退避的现实参数（综合）

### 5.1 各后端的官方约束/退避建议

| 后端 | 限制/退避 | 来源 |
|---|---|---|
| 坚果云 WebDAV | 免费 600 次/30 分钟；付费 1500 次/30 分钟；单次 750 条（须分页） | https://help.jianguoyun.com/?p=2064 |
| Google Drive | 每分钟每用户每项目 325,000 units；超限 403/429；**指数退避 + 批处理** | https://developers.google.com/drive/api/guides/limits 、 https://developers.google.com/drive/api/guides/handle-errors |
| Microsoft Graph | 429 + **Retry-After** 头；按 Retry-After 退避；无该头时指数退避；**避免立即重试**；别持续轮询扫描 | https://learn.microsoft.com/en-us/graphql/throttling 、 https://learn.microsoft.com/en-us/onedrive/developer/rest-api/concepts |
| Dropbox | **未验证**（文档动态渲染未取到） | — |
| S3 / R2 | S3 有并发/QPS 限流（具体值按账号/区域）；429/503 SlowDown → 指数退避（AWS 通用惯例） | AWS 通用建议（未在本次逐条抓取 S3 具体数值） |

### 5.2 通用退避参数（工程常识 + 官方精神）

- **指数退避 + 抖动（jitter）**：基准 `delay = min(cap, base * 2^attempt)`，再乘随机抖动（全抖动/等抖动）避免惊群。base 取 1s 左右，cap 取 1–5 分钟，最多 3–5 次。
- **有 Retry-After 就优先用它**（Graph 官方明确「这是最快恢复方式」）。
- **区分可重试与不可重试**：网络错误、429、5xx 可重试；401（凭证错）、412（冲突）、4xx 参数错**不可重试**（重试无意义）。
- **并发上限**：即便后端不限，扩展侧也应限制并发请求数（如同时最多 3–5 个），并在 service worker 被终止时可恢复（MV3 SW 不常驻，不能假设内存态存活）。

---

## 6. 明确区分：已验证事实 vs 推测 vs 未验证

### 已验证事实（有本次实测或官方文档直接支撑）
1. 坚果云地址 `https://dav.jianguoyun.com/dav/`、Basic 应用密码认证（官方页 + 实测 401/`WWW-Authenticate`）。
2. 坚果云 WebDAV **不返回 CORS 头**（实测多 Origin、多路径一致）。
3. **MV3 扩展声明 `host_permissions` 后可绕过 CORS**打到坚果云，PROPFIND/MKCOL/PUT 等均到达服务器（真机 Chrome 加载 MV3 扩展实测 + 负向对照）。
4. content script 即使有 host 权限也仍受同源策略约束（Chrome 官方文档原文）。
5. `storage.local` 默认暴露给 content scripts，需 `setAccessLevel` 收紧（Chrome 官方文档原文）。
6. WebCrypto 支持 PBKDF2 + AES-GCM，不支持 Argon2/scrypt（MDN 算法表）。
7. OWASP 基线：Argon2id 首选；PBKDF2 ≥600k(HMAC-SHA-256) 仅 FIPS 场景（OWASP 官方）。
8. Dropbox / Google Drive / Microsoft Graph 均支持 CORS（实测回显 ACAO）。
9. Drive 有 `changes` + pageToken 增量（官方文档）；Graph 有 `delta`（官方）；两者官方都要求指数退避 / 按 Retry-After 退避。
10. R2/S3 支持 `If-Match`/`If-None-Match` 条件写；R2 需配 bucket CORS 且要 `ExposeHeaders: [ETag]`（官方文档）。
11. 坚果云官方硬限制：免费 600 次/30 分钟、付费 1500 次/30 分钟、单次 750 条须分页（官方文档）。
12. RFC 4918/9110 定义了 WebDAV/HTTP 的条件请求与 412（RFC 原文）。

### 推测（合理但未直接验证，需后续实测）
- 坚果云认证通过后，PROPFIND 会返回 207 + `getetag`/`getlastmodified`，MKCOL 正常，条件写返回 412。
- 坚果云 ETag 格式与强弱 ETag 语义细节。
- Dropbox 的具体速率限制数值与退避要求（文档未取到）。
- 自建 WebCrypto 加密中 PBKDF2 轮数在扩展里的最佳 UX 平衡点。
- S3/R2 在本项目实际用量下的具体 QPS 表现。

### 未验证 / 待补
- 坚果云真实账号下的端到端读写与分页行为（本 agent 无凭证）。
- Dropbox 限流正文（需能渲染 JS 的抓取方式或官方 SDK 文档）。
- S3 官方 conditional-requests 页正文（JS 渲染，已用 R2 兼容表转述佐证）。

---

## 7. 给 one-tab 的选型建议（基于以上事实的分析）

1. **「坚果云能不能在 Chrome 扩展里用」→ 能**（有 host 权限即可），所以它在「技术上」不是死路。
2. **但它不适合做「默认/主推」后端**，理由（均为已验证事实支撑）：
   - 没有增量变更接口，只能全量 PROPFIND 轮询，浪费 600 次/30 分钟的额度；
   - 单次 750 条上限要求正确分页，否则「静默同步不完整」；
   - CORS 不支持 → 强制所有请求走 service worker，不能在 content script 里做，架构上更受限。
3. **若追求「多设备可靠增量同步」**，Drive `changes` / OneDrive `delta` 在增量与限流退避上明显更成熟，且原生 CORS，工程复杂度更低；代价是要走 OAuth（用户授权门槛）。
4. **若追求「极简、自持凭证」**，R2/S3 用 bucket-scope token + `If-Match` 条件写，能在无服务端下实现安全的原子同步；风险是 Secret Key 权限大、且需自己配 CORS。
5. **凭证处理通则**：一律 `setAccessLevel(TRUSTED_CONTEXTS)`；OAuth 走 PKCE + 最小 scope；坚果云用「应用密码」而非主密码；任何凭证都不进 content script。

---

## 附：本次调研用到的关键来源清单

- 坚果云 WebDAV 开启/限制：https://help.jianguoyun.com/?p=2064
- 坚果云服务器地址（Zotero）：https://help.jianguoyun.com/?p=3168
- 坚果云服务器地址（WPS）：https://help.jianguoyun.com/?p=2622
- Chrome MV3 跨源请求/host 权限：https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
- Chrome 权限声明：https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions
- chrome.storage（默认暴露 content script）：https://developer.chrome.com/docs/extensions/reference/api/storage
- WebCrypto 支持矩阵：https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto
- OWASP 密码/密钥存储基线：https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- WebDAV 协议 RFC 4918：https://www.rfc-editor.org/rfc/rfc4918.txt
- HTTP 条件请求 RFC 9110：https://www.rfc-editor.org/rfc/rfc9110.txt
- Google Drive 用量限制：https://developers.google.com/drive/api/guides/limits
- Google Drive 错误与退避：https://developers.google.com/drive/api/guides/handle-errors
- Google Drive 变更追踪：https://developers.google.com/drive/api/guides/about-changes
- Microsoft Graph 限流：https://learn.microsoft.com/en-us/graphql/throttling
- OneDrive API 概念（含 CORS/delta）：https://learn.microsoft.com/en-us/onedrive/developer/rest-api/concepts
- R2 S3 API 兼容（条件操作）：https://developers.cloudflare.com/r2/api/s3/api/
- R2 CORS（ExposeHeaders ETag）：https://developers.cloudflare.com/r2/buckets/cors/
- R2 API Token（scope/一次性密钥）：https://developers.cloudflare.com/r2/api/tokens/
- AWS S3 条件请求：https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-requests.html

### 本次自建实验（可复现）
- 方法：用 Playwright + Chrome for Testing 加载两个最小 MV3 扩展（有/无 `host_permissions`），在扩展 service worker 内对 `https://dav.jianguoyun.com/dav/` 发 GET/HEAD/PROPFIND/MKCOL/PUT/DELETE/OPTIONS（带/不带 XML body、Basic 头、条件头），对比结果。结论见 §1.4/§1.5。实验结束后已关闭所有后台浏览器进程。
