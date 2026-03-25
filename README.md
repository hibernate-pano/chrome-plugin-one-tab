# TabVault Pro

当前版本：`1.11.4`

TabVault Pro 是一个面向重度浏览器用户的工作会话保险箱。它的核心目标不是“多一个标签管理器”，而是帮助你把当前窗口保存成可找回、可恢复的工作现场。

![TabVault Pro](icons/icon128.png)

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
- 提供最近保存与最近恢复入口，继续上次的工作现场
- 支持导入 / 导出 OneTab 文本格式
- 支持会话重命名、备注、收藏、删除、锁定、基础整理
- 支持登录后手动上传到云端或从云端下载到本地

## 当前同步模式

当前版本是`手动同步`，不是实时自动同步。

- 上传：把本地会话手动推送到云端
- 下载：把云端数据手动拉回本地
- 每次操作前会明确让你选择“覆盖”还是“合并”
- 如果你没有登录，同步按钮不会出现

## 不承诺的能力

当前版本不把以下能力作为已交付承诺：

- 实时自动同步
- 自动跨设备一致性保证
- 严格意义上的端到端加密声明

## 安装

### 从 Chrome 商店安装

- 访问 [Chrome Web Store](https://chrome.google.com/webstore) 并搜索 `TabVault Pro`

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
- 最近恢复区会记录你上次是从哪里恢复的，方便再次打开

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

## 隐私与数据

- 本地数据默认保存在浏览器扩展存储中
- 登录后，云端数据仅用于你主动触发的同步
- 你应当把同步理解为“由你控制的数据搬运”，而不是后台持续同步

## 仓库

- 项目主页：[hibernate-pano/chrome-plugin-one-tab](https://github.com/hibernate-pano/chrome-plugin-one-tab)
- 问题反馈：[Issues](https://github.com/hibernate-pano/chrome-plugin-one-tab/issues)

## License

MIT
