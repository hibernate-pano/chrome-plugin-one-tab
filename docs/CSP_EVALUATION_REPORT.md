# CSP unsafe-inline 评估报告

## 执行日期：2025-10-09

## 一、评估目标

评估 `manifest.json` 中 CSP 配置的 `'unsafe-inline'` 是否可以移除，以提升安全性。

**当前配置**：

```json
"style-src 'self' 'unsafe-inline';"
```

---

## 二、内联样式使用情况分析

### 发现的内联样式使用（共12处）

#### 1. **动态样式（必须保留 unsafe-inline）**

| 文件                        | 行数 | 用途                                    | 是否可移除                |
| --------------------------- | ---- | --------------------------------------- | ------------------------- |
| SyncButton.tsx              | 166  | `style={{ width: '${syncProgress}%' }}` | ❌ 动态进度条宽度         |
| SimpleDraggableTabGroup.tsx | 167  | `style={style}`                         | ❌ dnd-kit 拖拽库动态样式 |
| SortableTab.tsx             | 94   | `style={style}`                         | ❌ dnd-kit 拖拽库动态样式 |
| SortableTab.tsx             | 103  | `style={deleteButtonStyle}`             | ❌ 动态按钮样式           |
| SimpleDraggableTab.tsx      | 51   | `style={style}`                         | ❌ dnd-kit 拖拽库动态样式 |
| SortableTabGroup.tsx        | 204  | `style={style}`                         | ❌ dnd-kit 拖拽库动态样式 |
| SortableTabGroup.tsx        | 280  | `style={{ overflow: 'hidden' }}`        | ✅ 可用 CSS 类替代        |
| DraggableTabGroup.tsx       | 19   | `style={{...}}`                         | ❌ dnd-kit 拖拽库动态样式 |
| DraggableTab.tsx            | 183  | `style={{...}}`                         | ❌ dnd-kit 拖拽库动态样式 |
| TabPreview.tsx              | 66   | `style={{...}}`                         | ❌ 动态预览样式           |

#### 2. **静态样式（可优化）**

| 文件               | 行数 | 用途                                | 优化建议                               |
| ------------------ | ---- | ----------------------------------- | -------------------------------------- |
| Toast.tsx          | 96   | `style={{ pointerEvents: 'none' }}` | ✅ 可改为 CSS 类 `pointer-events-none` |
| LoadingOverlay.tsx | 20   | `style={{ pointerEvents: 'none' }}` | ✅ 可改为 CSS 类 `pointer-events-none` |

---

## 三、技术依赖分析

### 核心依赖：@dnd-kit（拖拽库）

项目使用 `@dnd-kit` 拖拽库，该库**需要动态设置内联样式**来实现：

- 拖拽时的 `transform` 变换
- 拖拽时的 `transition` 过渡效果
- 元素位置和层级控制

**dnd-kit 官方说明**：

> The library uses inline styles for transforms and transitions during drag operations.

**结论**：使用 dnd-kit 库时，`'unsafe-inline'` 在 `style-src` 中是**必需的**。

---

## 四、安全风险评估

### 当前风险等级：🟡 中等

#### 风险点：

1. **XSS 攻击风险**：如果存在用户输入未正确清理，攻击者可注入内联样式
2. **样式注入**：恶意样式可能用于钓鱼或界面劫持

#### 缓解措施（已实施）：

1. ✅ 所有用户输入均通过 React 自动转义
2. ✅ 不直接使用 `dangerouslySetInnerHTML`
3. ✅ URL 输入经过验证（faviconUtils, inputValidation）
4. ✅ 敏感信息已过滤（errorHandler）

---

## 五、优化建议

### 方案A：保持现状（推荐） ⭐

**理由**：

1. 拖拽功能是核心特性，依赖 dnd-kit 库
2. 当前已有充分的输入验证和 XSS 防护
3. 移除 unsafe-inline 需要完全重写拖拽功能（成本极高）

**措施**：

- 继续保持 `'unsafe-inline'` 在 CSP 中
- 加强输入验证和内容清理
- 定期安全审计

### 方案B：部分优化（可选）

**优化项**：

1. 将 2 处静态 `pointer-events` 样式改为 CSS 类
2. 添加 CSP 违规报告机制

**影响**：

- 仅减少 2 处内联样式，CSP 仍需保留 unsafe-inline
- 收益有限，不影响核心安全性

### 方案C：彻底移除（不推荐） ❌

**需要**：

1. 移除 @dnd-kit 库
2. 使用纯 CSS 或其他不需要内联样式的拖拽方案
3. 重写所有拖拽相关代码

**成本**：

- 开发时间：2-3周
- 测试时间：1周
- 风险：引入新 bug，用户体验可能下降

**结论**：成本远大于收益，不建议执行

---

## 六、最终建议

### ✅ 建议：保持 CSP 当前配置

**理由**：

1. **技术必要性**：dnd-kit 库必须使用内联样式
2. **安全充分性**：现有防护措施足够（React 自动转义、输入验证）
3. **成本考量**：移除 unsafe-inline 成本极高，收益有限

### 📝 后续改进措施

1. **短期（本周）**：

   - ✅ 优化 2 处静态 pointer-events 样式（可选）
   - ✅ 记录 unsafe-inline 使用原因（本文档）

2. **中期（1个月）**：

   - 添加 CSP 违规报告端点
   - 定期审查内联样式使用

3. **长期（6个月）**：
   - 关注 dnd-kit 是否支持非内联样式方案
   - 评估新的拖拽库选择

---

## 七、结论

**最终决定**：**保留 `'unsafe-inline'` 在 CSP 配置中**

**原因总结**：

- ✅ 技术上必需（dnd-kit 库依赖）
- ✅ 安全风险可控（已有充分防护）
- ✅ 符合最小化改动原则
- ✅ 成本收益比合理

**风险等级**：🟡 中等（可接受）

**建议措施**：

1. 继续加强输入验证
2. 定期安全审计
3. 关注拖拽库更新

---

**评估人员**：AI Assistant  
**评估日期**：2025-10-09  
**文档版本**：1.0.0  
**审核状态**：已完成
