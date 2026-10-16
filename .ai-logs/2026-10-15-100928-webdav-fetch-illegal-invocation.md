# WebDAV 测试连接报 Illegal invocation —— 根因定位（未修复）

## 对话出发点（原始需求和动机）

Jasper 原话：「配置好坚果云地址后，我点击测试，它提示了这个，这是什么问题？」
错误原文：`连接失败：PROPFIND 请求失败：Failed to execute 'fetch' on 'Window': Illegal invocation`

动机：判断是自己配错了（地址/应用密码），还是产品 bug。

## 执行过程（做了什么、怎么做的）

1. 记忆快查：`rg webdav|PROPFIND|Illegal invocation|测试连接 MEMORY.md` 无命中；`one-tab|同步` 只命中存储读-改-写防线那一组（Task Group），与本次无关，停止记忆挖掘，直接读代码。
2. `rg PROPFIND src` 定位传输层：`src/sync-backend/webdav/client.ts`；`rg 请求失败|testConnection` 确认报错链：
   `client.ts:234` 把底层异常包装成 `${method} 请求失败：...`（method=PROPFIND），UI 层再加 `连接失败：` 前缀。
3. 读 `client.ts:164`（构造参数 `fetchImpl: typeof fetch = fetch`）与唯一调用点 `:222`
   `res = await this.fetchImpl(url, {...})` —— 以方法调用形式调全局 fetch，receiver 变成 WebDavClient 实例。
4. `rg fetchImpl|new WebDavClient` 确认两条生产路径都中招：
   - `src/components/sync/WebDavSettings.tsx:139`（测试连接按钮）：`new WebDavClient({baseUrl,username,password})`，走默认参数 = 全局 fetch。
   - `src/sync-backend/index.ts:164-167`（真实同步）：显式传 `fetch`，同样中招。
   测试全部注入普通 async stub（不校验 this），所以全绿 —— Node 的 undici fetch 也不做 receiver 校验。

## 遇到的问题（报错、阻塞、意外行为）

- 无工具阻塞。注意：本次并行下发了两组重复的 rg 命令（返回相同结果），浪费一次调用，下次注意。

## 最终结果（成功/失败及具体产出）

- 定位成功，未改代码。结论：**代码 bug，不是用户配置问题**。
- 根因：Chrome 的 `fetch` 是 Window 上的 WebIDL 方法，调用时 receiver 必须是 Window（或空）。`this.fetchImpl(...)`
  把 receiver 设成 WebDavClient 实例，Chrome 直接抛 `TypeError: Illegal invocation`，请求根本没发出去，
  与地址/密码/网络无关 —— 用户侧怎么配都过不了测试连接。
- 为什么测试没抓住：单测注入的 stub 不检查 `this`，且 Node 环境的 fetch 不做 receiver 校验；
  属于「测试与生产行为不一致」的假绿盲区（与用户此前堵过的两类假绿同构）。
- 修复方向（已告知用户、待确认）：调用点改为 detached 调用
  （`const impl = this.fetchImpl; await impl(url, ...)`），并补一条带 receiver 校验的回归测试，
  按变异验证纪律先确认在旧代码上变红。
