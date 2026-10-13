# AI Log：调研「WebDAV 类云盘作为浏览器扩展数据后端」可行性

- **时间**：2026-10-13 18:35（Asia/Shanghai）
- **执行者**：Codex（调研 agent，只读）
- **任务**：调研坚果云及其他云盘作为 chrome-plugin-one-tab 扩展数据后端的工程可行性，产出结构化报告。
- **关联产出**：`.ai-logs/research-webdav-backends.md`

## 对话出发点（原始需求与动机）
用户（Jasper）要求调研 WebDAV 类云盘能否作为浏览器扩展的数据后端，重点是坚果云 WebDAV 能否被 Chrome 扩展直接 fetch，并要求对比其他后端、凭证安全、无服务端冲突解决、速率退避。明确要求：中文、结构化报告、关键结论必须有来源 URL、区分「已验证事实」与「推测」、最终回复给 15 行内核心摘要。定位为只读调研 agent，不修改仓库其他文件。

## 执行过程
1. 轻量记忆检索 + 工具发现：确认无 exa/fetch 类 MCP 搜索工具可用，改用 curl + 本地代理（本机 `socks5://127.0.0.1:7897`，Node/curl 用 `http://127.0.0.1:7897`）。
2. 直接命中官方源：
   - 坚果云帮助中心 `?p=2064` 取到 WebDAV 开启方法 + 官方硬限制（免费 600 次/30 分钟、付费 1500 次/30 分钟、单次 750 条、单文件 500M）。
   - `?p=3168`/`?p=2622`/`?p=5627` 交叉确认服务器地址 `https://dav.jianguoyun.com/dav/`。
3. CORS 关键实测：对 `dav.jianguoyun.com` 发带 `Origin`/预检头的 OPTIONS 与各方法，多 Origin、多路径一致返回 401/501 且**无任何 access-control-* 头** → 判定坚果云不支持 CORS。
4. 决定性实验（避免只靠文档推测）：用 Playwright + 本地 Chrome for Testing 加载两个最小 MV3 扩展（有 / 无 `host_permissions`），在扩展 service worker 内对坚果云发 GET/PROPFIND/OPTIONS 等：
   - 有 host 权限 → 全部 HTTP 401（到达服务器，仅缺认证）；带 XML body + Basic 头 + `If-None-Match` 也能发出。
   - 无 host 权限（负向对照）→ 全部 `Failed to fetch`（浏览器本地拦截）。
   - 结论：MV3 扩展凭 host 权限绕过 CORS，可直接 fetch 坚果云 WebDAV。
5. 横向对比各后端（实测 CORS + 抓官方文档）：Dropbox API、Google Drive v3、Microsoft Graph 均实测回显 CORS 头；抓取 Drive/Graph 官方文档拿到增量（changes/delta）与退避（指数退避 / Retry-After）原文；抓 R2 文档拿到条件写（If-Match/If-None-Match）、CORS 需配 ExposeHeaders:[ETag]、token scope/一次性密钥。
6. 凭证安全：抓 Chrome storage 文档（`storage.local` 默认暴露 content scripts）、MDN SubtleCrypto（支持 PBKDF2/AES-GCM，不支持 Argon2/scrypt）、OWASP 密码存储基线（Argon2id 首选；PBKDF2 ≥600k 仅 FIPS）。
7. 协议依据：抓 RFC 4918（WebDAV/412）、RFC 9110（If-Match/If-None-Match）原文定位。
8. 写报告 `.ai-logs/research-webdav-backends.md`（373 行），并写本 AI Log。

## 遇到的问题
- **MCP 搜索工具不可用**：exa/fetch/playwright 等 deferred 工具经 tool_search 多次查询均返回 "No tools matched"，最终全程用 curl + 本地 Playwright（Chromium 已缓存）绕过。
- **Dropbox 官方文档无法抓取**：`developers.dropbox.com` 及 wayback/text-proxy 均失败（JS 动态渲染 / 404 / 代理鉴权），故 Dropbox 具体限流数值标为「未验证」，不做断言。
- **AWS S3 conditional-requests 页为 JS 渲染**，正文未取到，改用 Cloudflare R2 S3 兼容表（明确列出 If-Match/If-None-Match ✅）转述佐证。
- **Playwright 版本/浏览器不匹配**：新装 playwright 期望 chromium-1248 未下载；改用已缓存的 chromium-1228（Chrome for Testing）并显式指定 `executablePath` 解决。
- **`rm` 清理被安全策略拦截**：临时测试目录无法删除，仅确保所有后台 Chrome 进程已终止（`pkill` 后确认 0 残留），/tmp 下 davtest* 目录保留未删。
- **Bing 中文搜索严重污染**（坚果=干果、返回百度百科），多次搜索无效；改为直连官方文档 + 真实网络探测取证。

## 最终结果
- **成功**。产出结构化报告 `.ai-logs/research-webdav-backends.md`。
- **核心结论（已验证）**：Chrome MV3 扩展声明 `host_permissions: ["https://dav.jianguoyun.com/*"]` 后可绕过 CORS，直接 fetch 坚果云 WebDAV（PROPFIND/MKCOL/PUT 等到达服务器，401 仅因缺认证）；未声明 host 权限则被浏览器拦截。坚果云不支持 CORS，但 content script 内即使有 host 权限也受限，故所有 WebDAV 请求须走 service worker。
- 报告含全部关键来源 URL、官方硬限制、横向对比表、凭证安全建议（storage.local 默认暴露需 setAccessLevel 收紧、WebCrypto PBKDF2+AES-GCM、OWASP 参数）、无服务端冲突解决（ETag+If-Match 乐观锁/LWW/三方合并）、速率退避参数，并严格区分已验证事实/推测/未验证。
- 未修改仓库任何代码；仅在 `.ai-logs/` 新增报告与本日志两个文件；后台浏览器进程已清理干净。
