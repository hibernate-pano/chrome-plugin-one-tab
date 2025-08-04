# Favicon CSP 错误修复

## 问题描述

在数据上传/下载过程中，浏览器控制台出现大量 Content Security Policy (CSP) 错误：

```
Refused to load the image '<URL>' because it violates the following Content Security Policy directive: "img-src 'self' data: https:".
```

## 问题原因

1. **CSP 策略限制**：插件的 `manifest.json` 中设置了严格的 CSP 策略，只允许 `https:`、`data:` 和 `'self'` 协议的图片
2. **HTTP favicon**：许多网站的 favicon 使用 `http://` 协议，违反了 CSP 策略
3. **Chrome API 数据**：`chrome.tabs.Tab.favIconUrl` 可能包含不安全的 URL

## 解决方案

### 1. 创建 Favicon 安全处理工具

**文件：`src/utils/faviconUtils.ts`**

- `sanitizeFaviconUrl()`: 清理和验证 favicon URL
- `isFaviconUrlSafe()`: 检查 URL 是否符合 CSP 策略
- `sanitizeFaviconUrls()`: 批量处理 favicon URLs

**处理逻辑：**
- ✅ 保留安全协议：`https:`、`data:`、`chrome-extension:`
- 🔄 转换 `http:` 为 `https:`
- ❌ 过滤其他不安全协议：`ftp:`、`file:`、`javascript:` 等

### 2. 在数据保存时处理

**修改文件：**
- `src/background/TabManager.ts`
- `src/background.ts`

在保存标签页数据时，使用 `sanitizeFaviconUrl()` 清理 favicon URL，确保只保存安全的 URL。

### 3. 创建安全的 Favicon 组件

**文件：`src/components/common/SafeFavicon.tsx`**

统一的 favicon 显示组件，具有以下特性：
- 自动验证 URL 安全性
- 错误处理和回退机制
- 统一的样式和行为

### 4. 更新所有 Favicon 显示位置

**修改的组件：**
- `src/components/dnd/DraggableTab.tsx`
- `src/components/dnd/SortableTab.tsx`
- `src/components/search/SearchResultList.tsx`
- `src/components/tabs/ReorderView/index.tsx`

将原有的 `<img>` 标签替换为 `<SafeFavicon>` 组件。

### 5. 数据迁移

**文件：`src/utils/migrationUtils.ts`**

为现有数据创建迁移逻辑：
- 检查所有已保存的标签页
- 清理不安全的 favicon URL
- 标记迁移完成状态

**在应用启动时自动运行：**
- 修改 `src/components/tabs/TabList.tsx`
- 在加载数据前运行迁移

## 技术细节

### CSP 策略

当前的 CSP 配置（`manifest.json`）：
```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://*.supabase.co;"
}
```

### URL 转换示例

```typescript
// 输入 -> 输出
'http://example.com/favicon.ico'  -> 'https://example.com/favicon.ico'
'https://example.com/favicon.ico' -> 'https://example.com/favicon.ico'
'data:image/png;base64,abc'       -> 'data:image/png;base64,abc'
'ftp://example.com/favicon.ico'   -> '' (过滤掉)
'javascript:alert("xss")'         -> '' (过滤掉)
```

## 测试

创建了完整的单元测试：`src/utils/__tests__/faviconUtils.test.ts`

运行测试：
```bash
npm test faviconUtils
```

## 部署

1. 构建项目：`npm run build`
2. 重新加载 Chrome 扩展
3. 现有数据将在首次启动时自动迁移

## 使用方法

修复已经自动集成到项目中，无需额外配置：

1. **自动迁移**：首次启动时会自动清理现有的不安全 favicon URL
2. **新数据处理**：新保存的标签页会自动使用安全的 favicon URL
3. **统一显示**：所有 favicon 显示位置都使用了安全的组件

## 验证修复效果

1. 重新构建并加载扩展
2. 打开浏览器开发者工具的控制台
3. 进行数据上传/下载操作
4. 确认不再出现 CSP 相关的 favicon 错误

## 预期效果

- ✅ 消除所有 CSP 相关的 favicon 错误
- ✅ 保持 favicon 显示功能（尽可能）
- ✅ 提高安全性
- ✅ 向后兼容现有数据
- ✅ 统一的错误处理机制

## 注意事项

1. **HTTPS 转换**：某些网站可能不支持 HTTPS favicon，这些图标将不会显示
2. **性能影响**：首次启动时会进行数据迁移，可能需要几秒钟
3. **日志输出**：迁移过程会在控制台输出详细日志，便于调试

## 后续优化

1. 可以考虑实现 favicon 缓存机制
2. 添加 favicon 获取失败的重试逻辑
3. 考虑使用第三方 favicon 服务作为备选方案
