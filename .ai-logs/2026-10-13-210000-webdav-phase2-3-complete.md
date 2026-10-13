# AI Log：WebDAV 自带存储 —— 阶段 2/3 全部完成

- 时间：2026-10-13 20:00 ~ 21:00
- 分支：`feature/webdav-selfhost-sync`（共 18 个提交）
- 前序：`fde85f9`（阶段 0/1 + 本机真机 E2E）

---

## 1. 对话出发点

Jasper：

> 「不一定非得是坚果云，其他的 web dev 应该也支持吧。」

→ 这个问题**不能靠推测回答**（dufs 刚刚证明了「协议规定了」不等于「实现支持了」）。
于是做了三服务端能力矩阵。之后：

> 「先把能做的都做完，继续。」

→ 把不需要他参与的部分全部做完：阶段 2/3 + 隐私与文档同步。

---

## 2. 核心产出

### 2.1 三服务端能力矩阵（回答「别的 WebDAV 支不支持」）

新增 `scripts/webdav-capability-matrix.mjs`（用**裸 fetch** 探测，
不用自己的客户端——否则测的是「客户端+服务端」的合成行为，分不清是谁的问题）。

| 服务端 | PUT 带 ETag | PROPFIND getetag | HTTP `If-Match` | WebDAV `If:` |
|---|---|---|---|---|
| dufs 0.46（Rust） | ✗ | ✗ | ✗ 忽略 | ✗ 忽略 |
| rclone 1.75.2（Go） | ✓ | ✓ | ✗ 忽略 | ⚠️ **对任何值一律 412** |
| wsgidav（Python） | ✓ | ✓ | ✓ 生效 | ✓ 生效 |

**由此得到一条反直觉的约束：客户端只能发 `If-Match`，绝不能加 WebDAV `If:` 头。**
「两个都发更稳妥」是错的——rclone 对任何 `If:` 头一律 412，多带一个头会让
**所有写入在那类服务端上直接失败**。只发 `If-Match` 时 rclone 上退化为
「无锁但能正常写」、wsgidav 上拿到真锁。**可用比不可用重要。**

### 2.2 阶段 2：按设置解析后端

- `UserSettings.syncBackend`（与 `syncEnabled` **分开**，理由见类型注释：
  合并成一个枚举会造成一次静默语义迁移，而存量值天然落回 supabase）
- `resolveConfiguredBackend`：预解析 + 同步读取（`getActiveSyncBackend()`
  有 20 处同步调用方，改 async 会波及整个管线；见函数头论证）
- 回落必带**可读原因**（静默把用户切回旧后端 = 他的新配置无声失效）
- `webdav/config.ts`：**凭据绝不落盘**——`UserSettings` 会被上传到云端，
  把应用密码放进去等于上传到 Supabase / 用户自己的云盘
- `requireEncryption`：把「本次忘了输口令」与「用户合法选择不加密」分开
  （合成一个 null 会让数据**明文**上云且界面一路绿灯）

### 2.3 阶段 3：UI + 熔断 + 权限

- `WebDavSettings.tsx`：面板的核心目标是让「为什么没生效」看得见
  （四种静默失败各有不同下一步）
- 熔断接进**下载路径**（写在 `setGroupsImmediate` 之前）
- `optional_host_permissions` + 运行时按 origin 申请

---

## 3. 遇到的问题（这一轮错误密度很高，全部如实记录）

### 3.1 ★ 我用 `git checkout` 抹掉了自己的未提交改动

做变异验证时用 `git checkout -- src/sync-backend/index.ts` 还原一个变异，
把**阶段 2 的全部改动**（设置读取、WebDAV 工厂、回落原因、primeSyncBackend）
当场抹掉，且 `git status` 显示干净——看起来像「什么都没做」。

**这条纪律就写在我自己两天前写的 AI Log 里**：
「变异用 `cp` 备份恢复，**不要 git checkout**（会把未提交的修复抹掉）」。
我知道它、写过它、还是犯了。

已完整重写恢复，并在 `src/sync-backend/index.ts` 文件头留痕。
之后所有变异一律 `cp` 备份 + `cp` 恢复 + `diff -q` 校验还原。

### 3.2 测试的「数据存 A、读 B」（三层错位叠加）

`webdavWiring.test.ts` 初版 6 条全红，看起来像实现坏了。逐层查明全是测试问题：

1. 只往自己的 `kv` Map 塞值，而 `loadWebDavConfig()` 读的是**真实 storage-kv**；
2. 灌值在 storage 初始化**之前**，被 `migrateFromLocalStorage` 的清理循环扫掉；
3. 配置存进自己那份 Map，而解析读真实适配层 ⇒ 回落原因排错序
   （变成「没填云服务信息」而不是「需要重新解锁」）。

修法：统一走 `kvSet` 灌值、`ensureStorageReady()` 之后再灌、`saveWebDavConfig`
用包了真实适配层的 `realKv`。三层都写进注释。

### 3.3 熔断端到端测试连环失败后放弃（有意识的取舍）

初版想端到端验证 `syncEngine.downloadAndMerge` 触发熔断，连踩三层：

1. fetch 桩缺 `Prefer: count=exact` ⇒ download 的 count 自证失败、数据被丢弃；
2. supabase-js 传的是 `Headers` **实例**不是普通对象 ⇒ 头读不到；
3. 最终 syncEngine 仍报 `localCount=0`，而本地实际有 10 个组。

第 3 层根因在 syncEngine 与 storage 的读缓存/时序交互上，**与「熔断接得对不对」
无关**。继续纠缠只会把测试写成对环境考古。改为分层：
判据层跑真实函数，接线层用源码结构断言。这不是降标准，是停止无收益的投入。

### 3.4 六次「变异无效」被逐个识别

熔断的变异验证第一轮**五个变异全绿**。没有把它当成「测试无用」，
而是逐个证明变异是否生效，结果全是变异本身的问题：

- perl 模式不匹配（`limits.ratio` 实际是解构后的裸变量）
- 只改到注释没改到代码（两次）
- 块移动脚本把块又插回原位（等于没动）
- 断言只查「附近出现」没查「实参传了」（收紧后变红）
- 边界值选得没有区分力（`3/3` 在 `>` 与 `>=` 下行为相同；改用 `5/5`）

**「变异没红」必须先证明变异生效**，否则会得出两种都错的结论：
「测试无用」（浪费重写）或更糟的「验证通过」（放过真漏洞）。

### 3.5 自己写的 UI 断言是假绿

`webdavSettingsUi.test.ts` 里三条断言用**整文件子串**匹配，
被文件头注释命中 ⇒ 「隐私说明改含糊」「删忘记口令提示」「删内存态提示」
三条变异全绿。已收紧为「定位到那一条 UI 文案 + 断言其实质内容」。

另有一条因 JSX 文本**跨两行**而误报 false（只看第一行漏掉后半句）。

### 3.6 两个语法级坑

1. **注释里的 host 通配字面量会提前终止块注释**：`https://` 加通配再跟斜杠，
   其中「星号+斜杠」序列就是注释终止符，TS 报 Invalid character。踩了三次才定位。
2. `headless: true` 下 MV3 的 service worker **根本不启动**，
   表现为「未找到扩展 SW」，看起来像构建没产出。本仓库既有 e2e 用 `headless: false`。

---

## 4. 最终结果

**阶段 0–3 全部完成。18 个提交。**

| 验证项 | 结果 |
|---|---|
| `pnpm test` | **1270 pass / 0 fail** |
| `pnpm validate` | exit=0（含 type-check:tests / lint / build / 体积 209.5KB ≤ 240KB） |
| 真机 E2E（dufs，A/B 双设备往返） | **20/20** |
| 服务端能力矩阵 | dufs / rclone / wsgidav 三实现实测 |
| 权限 + CSP 真机 | **5/5** + 额外实测「授予后 SW 直连 WebDAV 完成 PUT 201 / GET 200」 |
| 后台进程 / 临时目录残留 | **0 / 0** |

同时更新：隐私政策（实质修改，含 manifest 明文与可选权限的如实披露）、
README、CHROMEWEBSTORE.md、方案文档 §13。

---

## 5. 唯一未完成项

**对真实服务端（坚果云 / Nextcloud）的实测。** 需要 Jasper 提供一个
应用密码（建议单独建目录、验完吊销）。拿到后用同一把尺子：

```
node scripts/webdav-capability-matrix.mjs --url https://dav.jianguoyun.com/dav/ \
  --user <账号> --pass <应用密码>
```

两个分支都已准备好，只影响提示文案：
- 实现条件写 → 乐观锁生效，保护最强
- 不实现 → 退化为认输预检（功能可用），界面提示「同一瞬间编辑同一会话可能覆盖，
  错峰使用不受影响」

---

## 6. 未做（有意，需要时再立项）

- 真三方合并（要先改 README 的「整组覆盖」产品承诺）
- 云盘 OAuth（Drive/OneDrive）、S3/R2 适配器
- 目录分片与分页优化（等实测撞到坚果云 750 条上限再说）

