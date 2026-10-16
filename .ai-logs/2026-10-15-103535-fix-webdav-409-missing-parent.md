# 修复 WebDAV 首次配置 409（父目录不存在）P0

## 对话出发点

Jasper 本地重载扩展后报：
```
连接失败：GET 失败（HTTP 409）
dav.jianguoyun.com/dav/TapStack/manifest.json:1  Failed to load resource: 409
[SyncEngine] 上传失败: 你选择了「自带存储」，但还没有填写云服务信息。
```
并给出方案选项，我建议 2（读前建目录）+ 3（409 归入 notFound）一起做，他回「二加三」。

## 执行过程

### 1. 先确认「旧问题已好」，再定位新问题
`Illegal invocation` 消失、请求带 409 状态码到达坚果云 ⇒ 上一个 P0（fetch receiver）确实修好了。
409 指向 `GET /dav/TapStack/manifest.json`。

### 2. 定位根因
- `adapter.ts` 的 `p()` 直接把 `root`（默认 `TapStack`）拼进路径，**从不创建**这个目录。
- `client.ts` 自己的注释已写明 RFC 4918 语义：`409 Conflict = 父目录不存在`（MKCOL 同理）。
- 旧 `get()` 只把 404 当 notFound ⇒ 409 落入 `if (!res.ok) throw` ⇒ 报 `GET 失败（HTTP 409）`。
- `loadManifest()` 被 `checkConnection()` 与 `uploadGroups()` 同时作为第一步入场 ⇒ **首次配置必然双挂**。
- 「还没有填写云服务信息」是**连带现象**（未点「保存并启用」，配置未落盘），行为正确，不是 bug。

### 3. 真机复现（模拟坚果云语义 + 扩展真实代码路径）
| 场景 | 旧行为 |
|---|---|
| 父目录不存在 | `GET 失败（HTTP 409）`（与用户报错一字不差）|
| 父目录存在、文件不存在 | 返回 null（正确）|

### 4. 实现（2 + 3）
- **改动 3（传输层）**：`client.get()` 返回值改为可辨识联合 —— 内容 / `{notFound, reason}` / null；
  新增 `NotFoundReason = 'no-such-resource' | 'missing-parent'`；
  **404 与 409 都归入 notFound**，并如实记录来源。`stat()` 同步处理 409 → `exists:false`
  （否则探测条件写与读回 ETag 两处仍会撞 409）。`PUT`/`MKCOL` 的 409 语义**一字未改**。
- **改动 2（根治）**：`adapter.ensureRootDir()` 在 `loadManifest()` 读取前 `mkdirp(root)`；
  幂等（405 视为已存在），失败静默（预建不是安全边界，真错误由随后的 get 给出）。
- 适配全部 3 个 `client.get()` 调用点（`loadManifest` / `readShard` / `downloadSettings`）到新契约。

### 5. 回归测试 + 变异验证
- `FakeDav` 增加 `conflictOnMissingParent` 开关，模拟坚果云 409 语义。
- 新增 describe「首次配置：子目录尚不存在」5 条：checkConnection 成功 / uploadGroups 成功 /
  downloadGroups+downloadSettings 返回空 / 探测条件写不抛 / **403 仍必须报权限错误**（反向防线）。
- `webdavClient.test.ts`：404→notFound、409→missing-parent、**403 优先级**、stat 409→exists:false。

**变异验证（3 处，全部变红）**：
| 变异 | 结果 |
|---|---|
| 拿掉 `ensureRootDir()` 调用 | fail 1（checkConnection 断言 MKCOL 先于读 manifest）|
| `get()` 不再把 409 当 notFound | fail 1 |
| `stat()` 不再把 409 当 exists:false | fail 1 |
| 恢复后 | pass 76 / fail 0 |

### 6. 真机端到端
扩展上下文 + 模拟坚果云服务器：`MKCOL /dav/TapStack` 成功发出，
`GET manifest` 返回 `{"notFound":true,"reason":"missing-parent"}` —— **不再抛 409**。

## 遇到的问题

1. **自己写的「修复」第一版是错的**：把 `get()` 返回值塞成 `{body:'',etag:null,notFoundReason}` 而签名仍是 `| null`，
   若不察会让所有 `if (!got)` 判定失效（静默读到假内容）。立刻改成可辨识联合。
2. **变异验证抓到测试太弱**：删掉 `ensureRootDir()` 调用后测试**仍然全绿**——
   因为 `dav.dirs.has('TapStack')` 会被 PUT 时的隐式建目录满足。
   改用「MKCOL 必须发生在读 manifest **之前**」的时序断言才真正守住。
3. **时序断言参照点选错**：第一版拿「对 baseUrl 的连通性 PROPFIND」当参照点，
   而它本来就该先发生 ⇒ 修复态也红。改为参照「读 manifest 的那次请求」。
4. **正则批量改测试把代码改坏**（吃掉 `assert.equal(` 的开头），4 处语法错误 → 手工逐个修回。
5. **断言字段名/路径写错**：把 `writtenIds` 写成 `uploaded`；分片路径漏了 `TapStack/` 前缀。
6. **mock 自身有 bug**：真机探针里 `/dav/TapStack` 的父目录判定写错，导致 MKCOL 假报「父目录不存在」——
   这是 mock 的问题，不影响「GET 不再抛 409」这个结论，已在结论中说明。

## 最终结果

**成功。**
- `pnpm test`：**1325 pass / 0 fail**（原 1317 + 新增 8）
- `pnpm validate`：**exit 0**（tsc ×2、lint ×2、build、体积 199.2KB ≤ 240KB）
- 变异验证 3/3 变红
- 真机端到端：`GET manifest` 不再抛 409
- 改动：`client.ts`（NotFoundReason + get/stat 契约）、`adapter.ts`（ensureRootDir + 3 处调用点适配）、
  两个测试文件（新增回归与 FakeDav 开关）
- 未提交 git；临时探针与 /tmp 文件已清理

## 沉淀的教训

1. **服务端对「不存在」的响应码不唯一**。404 与 409 在「读一个可能还不存在的文件」语境下等价，
   但 409 在别的语境（条件写冲突）是真信号 —— 所以只能**在读路径上**归类，且要如实记录来源。
2. **「读路径的兜底」与「写路径的根治」要一起做**。只做兜底（409 当不存在）能跑通，
   但目录始终不存在，每次读都靠兜底；只做根治（建目录）则在服务端语义有差异时会再次崩。
3. **变异验证必须选「不会被顺带满足」的断言**。`dirs.has(x)` 会被 PUT 隐式建目录满足，
   必须断言**时序**（MKCOL 先于读）才守得住「根治」这半。
4. 联合返回类型比 `| null` 更安全：它让每个调用点**必须**处理 notFound 分支，
   类型系统直接指出 3 个需要适配的位置 —— 这正是 `as never` 那版错误被立刻发现的原因。
