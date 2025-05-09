# OneTabPlus 更新日志

本文档记录了 OneTabPlus 扩展的所有重要更改。

## [1.5.11] - 2024-09-01

### 新增

- 添加了"清理重复标签"功能，一键清理所有标签组中URL相同的重复标签页
- 添加了清理重复标签的确认对话框和结果提示
- 添加了详细的功能文档

### 改进

- 优化了标签页管理功能，提供更高效的标签组织方式
- 改进了重复标签的识别算法，保留最新访问的标签页

## [1.5.10] - 2024-08-28

### 新增

- 添加了云端数据加密功能，保护用户隐私
- 实现了加密数据与旧版明文数据的兼容处理

### 改进

- 延长了认证缓存有效期至30天，减少用户重新登录的频率
- 优化了深色模式下登录和注册框的显示效果
- 所有新上传的数据现在都会自动加密存储

## [1.5.9] - 2024-08-26

### 新增

- 支持与原版 OneTab 的数据兼容性
- 添加了导出为 OneTab 格式的功能
- 添加了导入 OneTab 格式数据的功能

### 改进

- 优化了导入/导出功能的用户界面
- 将导入/导出功能改为下拉菜单形式，支持多种格式

## [1.5.8] - 2024-08-25

### 新增

- 添加了深色模式支持，提供了浅色、深色和自动模式选项
- 自动模式会根据系统设置自动切换主题
- 将 Supabase 凭证和个人设置存入环境变量，提高安全性

### 改进

- 删除了设置页面，简化界面，将主题切换功能集成到主界面
- 优化了界面元素在深色模式下的显示效果
- 使用 Tailwind CSS 的深色模式类实现了一致的深色主题
- 使用 React Context API 管理主题状态

## [1.5.7] - 2024-08-20

### 修复

- 修复了字符串分割相关的错误，解决了 "TypeError: Failed to fetch" 问题
- 修复了当拖动导致标签组没有数据时，自动删除空标签组
- 进一步优化了拖拽逻辑，使从上向下拖动更加流畅

## [1.5.6] - 2024-08-19

### 修复

- 修复了上方标签向下拖动时，下方标签没有向上滑动的问题
- 改进了拖拽时的视觉反馈，增加了上下边距来提供更明显的空间
- 优化了标签容器和标签项的过渡效果

## [1.5.5] - 2024-08-18

### 优化

- 优化了拖拽排序功能，使用原生 CSS 过渡效果实现流畅的拖拽体验
- 添加了拖拽时的视觉反馈，包括阴影、缩放和背景色变化
- 优化了标签组和标签页的过渡效果
- 使用防抖动机制减少拖拽时的性能开销

## [1.5.4] - 2024-08-17

### 新增

- 完全重写了拖拽排序功能，使用 framer-motion 实现流畅的动画效果
- 添加了标签拖拽时的平滑过渡动画
- 添加了标签组展开/折叠的动画效果
- 添加了标签页添加/删除时的动画效果

## [1.5.3] - 2024-08-16

### 修复

- 修复了向下拖动标签时没有视觉反馈的问题
- 修正了拖拽逻辑中的方向判断错误
- 增强了拖拽时的视觉反馈效果

## [1.5.2] - 2024-08-15

### 改进

- 优化了标签拖拽功能，增强了拖拽时的视觉反馈
- 添加了防抖动机制，避免拖拽时频繁触发更新
- 优化了拖拽时的性能，减少了界面卡顿
- 添加了拖拽阈值区域，避免小范围移动鼠标导致的频繁重排

## [1.5.1] - 2024-08-10

### 修复

- 移除了未使用的 alarms 权限，解决了 Chrome 商店审核问题
- 修复了恢复标签组时标签页顺序混乱的问题，现在恢复的标签页顺序与保存时一致

## [1.5.0] - 2024-08-01

### 新增

- 标签管理器的搜索框内增加了清空搜索内容的按钮

### 改进

- 改进了数据同步逻辑，当云端没有数据时直接上传，当本地没有数据时直接下载

### 修复

- 修复了刷新页面时双栏布局闪烁的问题
- 修复了下载-覆盖模式中的错误

## [1.4.7] - 2024-07-25

### 修复

- 修复了点击保存全部标签页时，部分未完全加载的页面无法保存的问题
- 改进了标签页保存逻辑，即使标签页正在加载也能正确保存
- 添加了详细的调试日志，便于排查标签页保存问题

## [1.4.6] - 2024-07-20

### 新增

- 实现了实时双向同步功能，使用 Supabase Realtime 技术
- 标签拖拽操作现在会自动同步到云端
- 优化了同步逻辑，使用通用同步函数减少代码重复

### 更改

- 将数据存储格式从分表存储改为 JSONB 格式，提高性能
- 优化了同步时的错误处理和日志记录

### 修复

- 修复了多设备同步时可能出现的数据不一致问题
- 修复了用户登录状态变化时同步状态不正确的问题

## [1.4.0] - 2024-06-15

### 新增

- 添加失去焦点自动关闭下拉菜单功能

### 改进

- 合并右上角的下拉菜单，避免重复显示
- 优化了界面交互体验

### 修复

- 修复了 Service Worker 加载失败的问题
- 修复了设置页面返回按钮导致 404 错误的问题
- 修复了路径不一致导致的各种问题

## [1.2.0] - 2024-06-12

### 新增

- 添加了数据压缩功能，减少网络使用和提高同步速度
- 添加了压缩统计信息显示
- 添加了 `SyncStatus` 组件，用于显示同步状态和压缩统计信息

### 改进

- 优化了同步策略，实现智能增量合并
- 改进了同步流程，先上传本地数据，再下载云端数据
- 添加了同步策略设置，允许用户选择冲突解决策略和删除策略
- 更新了用户界面，提供更清晰的同步状态显示

### 修复

- 修复了同步失败时的错误处理
- 修复了数据同步时可能丢失本地数据的问题
- 修复了 `null value in column "updated_at"` 错误
- 添加了数据验证，确保所有必需字段都有值

## [1.0.0] - 2024-06-10

### 新增

- 初始版本发布
- 基本的标签管理功能
- 拖放功能支持重新排序标签和标签组
- 搜索功能
- 基本的云端同步功能
- 用户注册和登录
- 设置选项
