# OneTab Plus 新功能使用指南

## 🚀 快速开始

### 启用新的增强功能

1. **启动开发环境**
```bash
cd d:\Code\Panbo\chrome-plugin-one-tab
pnpm install  # 如果还没安装依赖
pnpm dev
```

2. **在Chrome中加载扩展**
   - 打开 Chrome 扩展管理页面 (`chrome://extensions/`)
   - 启用"开发者模式"
   - 点击"加载已解压的扩展程序"
   - 选择项目的 `dist` 目录

## ✨ 新功能介绍

### 1. 智能自动同步 🔄

**位置**: 后台自动运行
**功能**: 
- 数据变化时自动同步到云端
- 网络恢复时自动同步
- 智能解决同步冲突

**配置选项**:
```typescript
// 在 EnhancedAppIntegrated.tsx 中可调整
const syncConfig = {
  triggers: {
    onDataChange: true,      // 数据变化时同步
    onNetworkRestore: true,  // 网络恢复时同步
    onAppFocus: false,       // 窗口获得焦点时同步
    periodic: 300            // 定期同步间隔(秒)
  }
}
```

### 2. 快捷操作面板 ⚡

**快捷键**: `Ctrl + K` (Windows) 或 `Cmd + K` (Mac)

**功能**:
- 快速搜索标签页
- 一键同步数据
- 批量操作标签组
- 导入/导出功能

**使用方法**:
1. 按 `Ctrl + K` 打开面板
2. 输入命令或搜索关键词
3. 使用方向键选择操作
4. 按 `Enter` 执行

### 3. 增强搜索 🔍

**支持的搜索语法**:
- **普通搜索**: `github` (模糊匹配标题和URL)
- **标签搜索**: `#开发` (搜索特定标签)
- **域名搜索**: `domain:github.com` (搜索特定域名)
- **正则搜索**: `/https?:\/\/.*\.com/` (使用正则表达式)

**智能分组建议**:
- 按域名自动分组
- 按主题内容分组
- 按时间范围分组

### 4. 虚拟化标签列表 📋

**功能**:
- 支持大量标签页流畅滚动
- 分组折叠/展开
- 拖拽重新排序
- 搜索结果高亮

**操作**:
- 点击分组标题展开/折叠
- 拖拽标签页或分组重新排序
- 使用搜索框快速筛选

## 🎯 实用技巧

### 快捷键大全
- `Ctrl + K`: 打开快捷操作面板
- `Alt + Shift + S`: 保存所有标签页
- `Alt + S`: 保存当前标签页
- `Escape`: 关闭面板或取消操作

### 搜索技巧
1. **组合搜索**: 使用空格分隔多个关键词
2. **排除搜索**: 使用 `-关键词` 排除特定内容
3. **精确匹配**: 使用引号 `"完全匹配"`

### 同步设置
1. **手动同步**: 点击头部的同步按钮
2. **自动同步**: 在设置中启用自动同步
3. **冲突解决**: 选择"保留新数据"或"手动合并"

## 🔧 自定义配置

### 修改同步策略
编辑 `src/components/EnhancedAppIntegrated.tsx`:
```typescript
const defaultSyncConfig: SyncConfig = {
  triggers: {
    onDataChange: true,        // 是否在数据变化时同步
    onNetworkRestore: true,    // 是否在网络恢复时同步
    onAppFocus: false,         // 是否在应用获得焦点时同步
    periodic: 300              // 定期同步间隔(秒)，null为禁用
  },
  conflictResolution: {
    strategy: 'auto',          // 'auto' | 'manual'
    autoMergeRules: {
      preferNewer: true,       // 优先使用更新的数据
      preserveLocal: true,     // 保留本地独有数据
      preserveRemote: true     // 保留远程独有数据
    }
  },
  optimization: {
    batchUpdates: true,        // 批量更新
    deltaSync: true,           // 增量同步
    compression: true,         // 数据压缩
    maxRetries: 3              // 最大重试次数
  }
};
```

### 修改虚拟化设置
编辑 `src/components/tabs/VirtualizedTabListFixed.tsx`:
```typescript
const defaultProps = {
  itemHeight: 60,          // 每项高度
  containerHeight: 600,    // 容器高度
  overscan: 5             // 预渲染项目数
};
```

## 🐛 故障排除

### 常见问题

**Q: 快捷键不响应**
A: 检查是否有其他扩展占用相同快捷键，尝试重新加载扩展

**Q: 同步失败**
A: 
1. 检查网络连接
2. 确认已登录账户
3. 查看浏览器控制台错误信息

**Q: 搜索结果不准确**
A: 
1. 检查搜索语法是否正确
2. 尝试使用不同的关键词
3. 清除搜索框重新输入

**Q: 虚拟列表显示异常**
A:
1. 刷新页面
2. 检查数据是否过大
3. 尝试关闭部分分组

### 开发调试

启用调试模式:
```javascript
// 在浏览器控制台中运行
localStorage.setItem('oneTabDebug', 'true');
```

查看详细日志:
```javascript
// 开启详细同步日志
localStorage.setItem('syncDebug', 'true');
```

## 📞 技术支持

如遇到问题，可以:
1. 查看浏览器开发者工具的控制台错误
2. 检查 `docs/PROJECT_COMPLETION_REPORT.md` 中的技术细节
3. 参考 `src/tests/integration.test.ts` 中的测试用例

## 🔄 版本更新

当前版本: **v1.6.0 Enhanced**

主要改进:
- ✅ 智能自动同步
- ✅ 虚拟化性能优化  
- ✅ 增强搜索功能
- ✅ 快捷操作面板
- ✅ 现代化UI设计

---

**享受全新的OneTab Plus体验！** 🎉
