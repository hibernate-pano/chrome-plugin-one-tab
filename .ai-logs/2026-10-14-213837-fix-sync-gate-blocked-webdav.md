# AI Log：修「同步门禁把自带存储用户挡在门外」

- 时间：2026-10-14 21:38
- 分支：`feature/webdav-selfhost-sync`
- 前序：P0 修复提交 97c3eaa 后，Jasper 让先本地 E2E 跑一遍（坚果云信息待办）

## 1. 对话出发点

Jasper：「那你先本地跑一遍吧，我现在去申请坚果云的具体信息，一会儿再测坚果云。」

## 2. 执行过程

先跑通已有两条 E2E（`e2e-webdav-local.mjs` 20 项、`e2e-webdav-permission.mjs` 5 项，全过）。
但我判断 P0 修复依赖「真实浏览器里的跨上下文路径」，单测覆盖不到，于是新写
`scripts/e2e-webdav-lock.mjs`。**这个脚本抓出了 P0 修复本身是失效的。**

## 3. 遇到的问题（按发现顺序）

### 3.1 ★ 真 P0：同步门禁把自带存储用户挡在门外
`ensureAuthenticated` 只问「有没有 Supabase 账号」，WebDAV 用户没有 ⇒
upload/download 两条路径都在门禁处 return「用户未登录」，
**永远走不到锁定后端那句「去重新解锁」**。
上一轮说 P0「修完了」在真实链路上不成立 —— 单测直接构造「已登录」态绕过了门禁。

修（方案 2，Jasper 拍板）：门禁判据从「有没有账号」改为「后端是否就绪」，
`authGuard` 加 `backendId`，webdav 直接放行到后端层。

### 3.2 ★ 动态 import 在 SW 里炸，且被 catch 吞成旧 bug
`readConfiguredBackendId` 用了 `await import('@/storage-kv/storageAdapter')`，
打包后变成懒加载 chunk，在 service worker 里抛
`ReferenceError: document is not defined`（栈在 supabase-vendor）。
我的 `catch` 把它吞成 `'supabase'` ⇒ 门禁退回旧行为 ⇒ **症状与要修的 bug 一模一样**。
改静态 import 后正常。

这一条最险：`catch` 返回的兜底值恰好等于「修复前的行为」，
于是「代码看起来修了」与「实际没修」无法从症状上区分。

### 3.3 SW 的后端缓存没有刷新路径
用户改完设置、SW 未重启时，SW 里 `activeBackend` 仍是旧值，
`ensureBackendPrimed()` 见缓存非空就返回，永不自愈。
修：`resyncAlarm` 顺带 invalidate + 重解析（用 promise 链，不在同步 listener 里写 await）。

### 3.4 门禁读了缓存而非当前设置
`getActiveSyncBackendId()` 读缓存 ⇒ 又回到 3.3。
修：新增 `readConfiguredBackendId()` 直读设置，门禁用它。

### 3.5 E2E 脚本自身的问题（如实记录）
- 第一版在 SW 的 evaluate 里给自己发消息 ⇒ 端口必然关闭，报「SW 无响应」，
  两条断言因此**假通过**。
- 第二版用 `chrome.permissions.request` 拿权限 ⇒ 无人值守下永远不返回，脚本挂死，
  留下一个 Playwright 浏览器进程（手动清理）。
- 配置种在 `chrome.storage.local`，而解析层读 storage-kv（IndexedDB）⇒
  种在了没人读的地方。踩坑后改为种到解析层真正读取的位置，
  并对「前提是否成立」显式断言（前提不成立时断言含义会漂移，比失败更坏）。
- `forceRemote` 必加：否则卡在 `recent_upload_guard`，测不到下载路径。
- CDP `Browser.grantPermissions` 对扩展 optional host 权限**无效**，
  无人值守也拿不到 ⇒ 最终把「停在权限预检」当作已验证行为。

### 3.6 变异验证第一次误判
第一次跑变异（门禁回到旧行为）时我用 grep 匹配脚本整体结论，
看到「全部通过」就以为没抓住。实际上**两条断言都变红了**，
是我的判读方式错了（该看断言行为，不是脚本总结行）。
补测后确认三个变异全部被抓住：门禁回退 / 门禁读缓存 / 锁定文案改含糊。

## 4. 最终结果

- 修复完成：门禁按后端分流（3.1）+ 静态 import（3.2）+ SW 缓存失效（3.3）+
  门禁直读设置（3.4）。
- 新增测试：`tests/syncBackendGateWiring.test.ts`（6 条接线断言）、
  `tests/authGuard.test.ts` +3 条、`scripts/e2e-webdav-lock.mjs`（7 项真机）。
- 验证：type-check / type-check:tests / lint / lint:tests 全过；
  **1311 单测全绿**；build + 体积门过（198.5KB ≤ 240KB）；
  三条 E2E 全过且后台进程已清理。
- 未做：坚果云/Nextcloud 真机（等 Jasper 的应用密码）。
- 教训留痕：**兜底 catch 的返回值不能等于「修复前的行为」**，
  否则「以为修好了」和「真的修好了」在症状上不可区分。
