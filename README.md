# TapStack

当前版本：`1.12.0`

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
- 登录后，云端数据仅用于你主动触发的同步
- 你应当把同步理解为“由你控制的数据搬运”，而不是后台持续同步

## 仓库

- 项目主页：[hibernate-pano/chrome-plugin-one-tab](https://github.com/hibernate-pano/chrome-plugin-one-tab)
- 问题反馈：[Issues](https://github.com/hibernate-pano/chrome-plugin-one-tab/issues)

## License

MIT
