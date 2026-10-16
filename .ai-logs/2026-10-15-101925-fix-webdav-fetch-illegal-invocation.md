# 修复 WebDAV「测试连接」Illegal invocation（P0）

## 对话出发点（原始需求和动机）

上一轮 Jasper 报「测试连接」报 `连接失败：PROPFIND 请求失败：Failed to execute 'fetch' on 'Window': Illegal invocation`，
我给出选项 1（一行修复）/ 2（修复 + 回归测试 + 变异验证），他选 2 并说「那就按照二来做」。

## 执行过程

### 1. 先证实「对不对」，而不是直接改

诊断结论是「`this.fetchImpl(url, ...)` 把 receiver 设成实例导致 Illegal invocation」。
在动手前我先在真 Chromium（headless `--dump-dom`）里做页面探针，结果**不抛**：
`holder.fetchImpl(...)` 返回了正常 Promise。第一反应是自己诊断错了，但没有下结论，而是回去对照生产代码形态。

### 2. 找到早期探针写错的地方

早期探针用 `var holder = { fetchImpl: fetch }` 写在页面顶层 —— V8 对这种静态绑定的对象字面量做了优化，
不会走 WebIDL brand check。把同样的写法放进**类**里就立刻现原形。这是「探针本身坏掉」的典型：
它给出「不抛」的假阴性。为确认探针有效，加了必抛的对照组
（`document.querySelector` 以错误 receiver 调用 → 确实抛 `Illegal invocation`）。

### 3. 真机复现（P0 定性）

用 Playwright 加载 `dist/` 真实扩展，在 options 页 + 本地 HTTP 服务器里一字不差复刻 `WebDavClient`：
两种形态（默认 fetch / 显式注入 fetch）都稳定复现 `Illegal invocation`。
隔离出最小对照：

| 形态 | 结果 |
|---|---|
| `class A { constructor(f = fetch){ this.f = f } async go(){ return this.f(url) } }` | THREW Illegal invocation |
| `class B { constructor(f){ this.f = f } ... }` | THREW |
| `class C { f = fetch; ... }` | THREW |
| `plain object { f: fetch, go(){ this.f(url) } }` | THREW |
| `class D { ... const g = this.f; return g(url) }` | 不抛（错误变成 `Failed to fetch`，即请求真的发出去了）|

关键补充事实：`constructor(config, fetchImpl = fetch)` 这一步**已经是 detached**（存的是裸函数），
赋值时摘干净不够，**调用点**必须摘。
另外确认 `btoa` 是同类陷阱但生产代码用的是裸 `btoa(binary)`，不触发，故未改。

### 4. 修复

`src/sync-backend/webdav/client.ts`：`request()` 内 `const doFetch = this.fetchImpl;`，调用点改 `doFetch(url, ...)`，
并把「为什么不能写 `this.fetchImpl(...)`」「为什么单测抓不到」写进注释（仓库注释是知识资产）。

### 5. 回归测试 + 变异验证

`tests/webdavClient.test.ts` 新增 describe「fetch 调用形态：不得把 WebDavClient 当 receiver」，3 条：
关键设计是 `brandCheckFetch()` **自己模拟 WebIDL brand check**，因为 Node 的 fetch（undici）
不做 receiver 校验 —— 直接注入真 fetch 等于没测。

第一版 brand check 我写成 `this !== globalThis`，被变异验证/真机对照打回：
模块作用域裸调用原生方法时 `this === undefined`，该判据会把 detached 调用也误判为非法。改成 `this !== undefined`。

变异验证：`doFetch` → `this.fetchImpl` ⇒ **fail 3 / pass 34**；恢复后 pass 37 / fail 0。

### 6. 真机端到端

本地 HTTP 服务器回 CORS 头 + 207 Multi-Status，扩展页内跑修复后的调用形态：
`FIXED => HTTP 207 etag="e1"`，服务器侧记录到 `OPTIONS /dav/` 与 `PROPFIND /dav/`（PROPFIND 真的到达了）。
未回 CORS 头时只到 OPTIONS 预检就停 —— 也反证了「请求确实发出去了」，不是被本地 brand check 挡掉。

### 7. 全量校验与清理

`pnpm test` 1317 pass / 0 fail；`pnpm validate` exit 0（含 tsc、lint、build、体积门控 199.1KB ≤ 240KB）。
删除临时探针脚本与 /tmp 文件；`git status` 仅 3 个预期改动 + 2 个 ai-log。

## 遇到的问题

- **自我诊断被自己的探针推翻**：早期探针因 V8 静态绑定优化给出假阴性。教训：探针必须带必抛对照组，否则「不抛」不可信。
- **brand check 判据写错**：第一版 `this !== globalThis` 会误判 detached 调用，靠「真机对照 + 变异验证」才发现。
- **测试替身的类型断言反噬**：`as unknown as typeof fetch` 让无参调用在 `tsc` 下报错（TS2554），validate 阶段才暴露；改为保留真实签名的独立类型别名解决。
- 本次并行下发过重复命令；Playwright 脚本必须放在项目目录内才能解析 `playwright` 包（放 /tmp 会 ERR_MODULE_NOT_FOUND）。

## 最终结果

- **成功**。用户点「测试连接」不再报 Illegal invocation；真机端到端 PROPFIND 收到 207 与 ETag。
- 产出：`src/sync-backend/webdav/client.ts`（修复 + 注释）、`tests/webdavClient.test.ts`（3 条回归 + 变异验证口径）。
- 全量：1317 测试全绿，validate exit 0。
- 未提交 git（留给 Jasper 决定）。

## 沉淀的教训

1. **`Illegal invocation` = 有人把原生方法当对象方法调了**。修法永远是「调用点摘 receiver」，不是构造时。
2. **「单测全绿 + 真机 100% 失败」几乎都是测试替身比真实环境宽松**。undici 的 fetch 不做 brand check，
   所以任何「fetch 调用形态」类断言都必须自带 brand check 替身，否则是假绿（与仓库既有两类假绿同构）。
3. **探针要带必抛对照组**。「不抛」只有在「同样的错误 receiver 会抛」被验证过后才可信。
4. 判 WebIDL receiver 的正确判据是 `this === undefined`（严格模式裸调用），不是 `this !== globalThis`。
