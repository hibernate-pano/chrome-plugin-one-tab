# AI Log：坚果云真机能力矩阵 + 全链路往返

- 时间：2026-10-14 22:05
- 前序：Jasper 提供了 `TabStack` 应用的应用密码

## 1. 对话出发点

Jasper 在对话里直接发了坚果云地址、账号、应用密码、应用名。
测完后已提醒他去坚果云删除重建（进过对话记录的密码必须换）。

## 2. 执行过程

### 2.1 能力矩阵（裸 fetch，不测自己的客户端）
```
reachable: 207, mkcol: 201, putEtag: null,
propfindGetetag: false, propfindGetlastmod: true,
getEtag: "zvJMridcrHRbudaSiox5yg",
httpIfMatch: honored, httpIfNoneMatch: ignored,
davIfHeader: ignored, ifUnmodifiedSince: ignored, probeCleaned: true
```

反例复核（裸 fetch，第二次探针）：
```
putStatus: 201, getEtag 可用于 If-Match（正确→204，过期→412），
If-None-Match 对不存在资源→201（首写可用）。
```

**坚果云是第四种形态**（dufs / rclone / wsgidav 之外）：
真乐观锁成立，但 PUT 响应不带 ETag、PROPFIND 不给 getetag。
ETag 只能从 GET / PROPFIND-D:0 拿（读单个资源时 XML 含 getetag）。

### 2.2 「PUT 不返回 ETag」引发的真 bug（已修）
manifest 条目的 etag 是下一次写该分片的 If-Match 条件。
旧实现存 PUT 响应给的 etag ⇒ 坚果云上恒为 null ⇒
下次不带条件 ⇒ 无条件覆盖 ⇒ **明明有锁却在裸写**。

修：`writeShard` 里若没给 ETag，用 `stat()` 读回一个再存 manifest。
读不回来只降级（认输预检仍在），不阻断写入。
变异验证：拿掉读回 ⇒ 2 条新测试变红。

### 2.3 坚果云全链路往返（专用子目录，结束必删）
A 首次全量（3 组）→ 自检（3 组 / 条件写 true）→ B 下载解密 →
B 改 → A 看到改动 → 过期副本认输 → 云端不动 → 删除广播 →
设置往返 → 中文路径 → 清理。**11 项全过。**

## 3. 遇到的问题

- `scripts/webdav-capability-matrix.mjs` 的 `--url` 只用于本地三家，
  不探远程。改用两个独立裸 fetch 探针脚本（/tmp，**不进仓库**）。
- 往返脚本第一次跑因 `yield_time_ms` 传了浮点失败（工具要 u64），
  重跑时用整数即好。

## 4. 最终结果

- 四服务端对照完成：坚果云 = If-Match 真生效 / PUT 无 ETag。
- 适配器修掉一处真 bug + 3 条回归测试（变异验证过）。
- 全量验证：1314 单测全绿；build + 体积门过（198.6KB ≤ 240KB）。
- 云端无残留（探针文件 + 测试目录全部删除）。
- `docs/webdav-selfhost-sync-plan.md` 的「唯一未完成项：真实服务端实测」
  —— 坚果云部分已完成，Nextcloud 仍待测。

## 5. 待办

- 应用密码必须换（已提醒 Jasper）。
- 裸 fetch 探针脚本在 /tmp，未进仓库 —— 有意。能力矩阵脚本
  若要支持远程，建议把这段逻辑并进去（当前它的结论段只写三家）。
