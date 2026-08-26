# TapStack

当前版本：`1.16.0`

最近变更：`main` 补齐“保存后自动上传”承诺接入点——TabManager 在 `saveAllTabs` / `saveTab` 后调用 `syncEngine.scheduleUpload(3000)`，未登录安全跳过。同步引擎 `upload()` 进入点懒恢复登录态（SW 是独立执行上下文）。验证 E2E：`scripts/e2e-auto-upload-test.mjs`、`scripts/e2e-background-sync-test.mjs`。

另：`main` 修复“点开标签 / 删除会话后 60s 被云端复活”——`scheduleUpload` 从 `setTimeout` 改为 `chrome.alarms`（MV3 SW idle 被杀后 timer 会丢），并加 35s 上传保护窗口，避免上传完成前下载误覆盖。验证：`scripts/e2e-local-delete-no-resurrect.mjs`。

接着二次加固：添加持久化 `pending_upload` 标志（跨进程跨 SW 重启保留）——`scheduleUpload` 写 storage，`upload` 成功才清。`cancelPendingUpload` 只清内存 timer/alarm，**不动**持久化意图。后台轮询 `performBackgroundSync` 改为**先上传后下载**，避免后台轮询在上传意图丢失后用云端旧版本覆盖本地新版本。下载完成后若 `pending_upload` 仍为 true 重新调度上传。验证：`scripts/e2e-stress-no-resurrect.mjs`（4-tab 会话连点 3 个，关闭 popup 90s 跨两个 alarm 周期仍 1 tab）。

TapStack 是一个面向重度浏览器用户的工作会话保险箱。它的核心目标不是“多一个标签管理器”，而是帮助你把当前窗口保存成可找回、可恢复的工作现场。

![TapStack](icons/icon128.png)

## 产品定位

- Save the session
- Find it later
- Restore it when you need it

适合这几类用户：

- 开发者：文档、PR、Issue、控制台、监控、后台同时开很多页
- 研究型用户：论文、论坛、竞品、视频、资料长时间并行打开
- 内容作者：选题、草稿、引用、素材、后台需要反复切换
- 销售 / 招聘 / 投资：CRM、表格、邮件、公司页、Notion 长时间保持上下文

## 当前能力

- 保存当前窗口中的标签页为一个工作会话
- 以后按会话名称、标签标题、URL 找回内容
- 支持按会话备注搜索，并收藏关键会话
- 在新窗口中恢复整个会话，尽量不打乱当前窗口
- 新会话默认按保存时间生成时间戳名称，可按需重命名
- 支持导入 / 导出 OneTab 文本格式
- 支持会话重命名、备注、收藏、删除、锁定、基础整理
- 登录后自动同步：数据变更自动上传，登录时自动从云端合并下载

## 当前同步模式

当前版本采用**增量自动同步**，并保留手动入口。

- **自动上传**：保存 / 重命名 / 删除 / 移动 / 锁定等数据变更后，自动防抖推送到云端（删除为软删除 + 云端同步标记）。
- **自动下载**：已登录用户打开应用时，自动从云端合并拉取到本地（跨设备找回）。
- **合并安全**：下载采用「快照 → 下载 → 合并 → 校验 → 写入」，合并结果异常时自动回滚，避免同步覆盖丢失本地数据。
- **手动入口**：工具栏同步按钮仍可手动上传（覆盖 / 合并）与下载（覆盖 / 合并），由单一 SyncEngine 统一调度。
- **跨端软删**：Web 端删除改为云端墓碑（`is_deleted` 列，需 Supabase migration `supabase/migrations/20260825130248_add_is_deleted_tombstone.sql`，已在生产库执行）；扩展端同步时按版本 / 时间比较应用删除，不会“复活”已删行。
- **单引擎**：所有同步（自动 + 手动 + 设置同步）统一走 `syncEngine.ts`，旧 `syncService` / `smartSyncService` / `tabSyncWorkflow` 已移除。
- 没有登录时不触发云端同步。
- **保存路径**：popup 按钮 / 快捷键 / 右键菜单都走 SW `TabManager.saveAllTabs()` → `storage.setGroups()` 后立刻调 `syncEngine.scheduleUpload(3000)`（防抖）推送。`autoSyncMiddleware` 负责捕获 store 侧的重命名 / 删除 / 锁定 / 拖拽 `dispatch` thunk 的 fulfilled 动作；MV3 SW 是独立执行上下文，`syncEngine.upload()` 进入点懒恢复登录态（重复调用是 no-op，与 `backgroundSync` 一致）。

## 不承诺的能力

当前版本不把以下能力作为已交付承诺：

- 多端实时并发协同编辑（优先级冲突仍按合并策略解决，非实时）
- 严格意义上的端到端加密声明（客户端加密 key 相关细节见代码注释）

## 安装

### 从 Chrome 商店安装

- 访问 [Chrome Web Store](https://chrome.google.com/webstore) 并搜索 `TapStack`

### 开发模式安装

```bash
git clone https://github.com/hibernate-pano/chrome-plugin-one-tab.git
cd chrome-plugin-one-tab
pnpm install
pnpm build
```

然后在 `chrome://extensions/` 中开启开发者模式并加载 `dist` 目录。

## 使用方式

### 保存会话

- 点击扩展图标，或在主界面点击“保存会话”
- 当前窗口中的标签页会被保存成一个新会话
- 可配置是否一并保存固定标签页

### 找回会话

- 在搜索框中输入会话名、备注、标签标题或 URL
- 搜索结果会优先展示匹配到的会话，再展开具体标签命中
- 可按域名、固定标签、保存时间继续筛选

### 恢复会话

- 点击会话卡片上的“恢复整个会话”
- 会在新窗口中恢复该会话
- 未锁定会话恢复后会从列表中移除；锁定会话会保留

### 会话命名

- 新保存的会话默认命名为 `标签组 + 保存时间`
- 你可以在保存后手动重命名，让会话更容易再次找回

### 导入 / 导出

- 支持 JSON 备份导出
- 支持 OneTab 文本导入和导出

## 开发

```bash
pnpm type-check
pnpm lint
pnpm build
pnpm validate
```

`pnpm validate` 会先校验扩展元数据，再执行类型检查、Lint 和构建。

如果你要验证真实 Supabase 数据链路，可以额外执行：

```bash
TEST_EMAIL="your-test-user@example.com" TEST_PASSWORD="your-password" pnpm test:supabase-smoke
```

这个 smoke test 会验证登录、设置同步、会话写入和 RLS 生效情况，并在结束后自动清理临时测试数据。

## 隐私与数据

- 本地数据默认保存在浏览器扩展存储中
- 登录后，云端数据仅用于跨设备找回和主动触发的同步
- 同步采用增量防抖：保存 / 重命名 / 删除 / 锁定后自动上传云端；后台 alarm 每 60s 自动拉取云端变更到本地（未登录不触发）
- 你可以随时用手动入口（同步按钮）切换“合并 / 覆盖”模式或强制重新同步

## 仓库

- 项目主页：[hibernate-pano/chrome-plugin-one-tab](https://github.com/hibernate-pano/chrome-plugin-one-tab)
- 问题反馈：[Issues](https://github.com/hibernate-pano/chrome-plugin-one-tab/issues)

## License

MIT
