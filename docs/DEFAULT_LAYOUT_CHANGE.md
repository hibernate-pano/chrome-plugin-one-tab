# 默认布局修改：从双栏改为单栏

## 修改目标

将OneTab Plus插件的默认布局模式从双栏布局改为单栏布局，提升新用户的首次使用体验。

## 修改原因

### 用户体验考虑

- **单栏布局更适合新用户**：单栏布局更直观，标签组垂直排列，便于浏览
- **减少认知负担**：新用户不需要理解多栏布局的复杂排列逻辑
- **更好的移动端适配**：单栏布局在小屏幕设备上显示效果更好

### 技术考虑

- 保持现有的布局切换功能，用户仍可手动切换到双栏或三栏模式
- 不影响现有用户的设置，只影响新安装的用户

## 修改内容

### 1. 修改默认设置

**修改文件**: `src/utils/storage.ts`

**修改前**:

```typescript
export const DEFAULT_SETTINGS: UserSettings = {
  // ... 其他设置
  layoutMode: 'double' as LayoutMode, // 默认使用双栏布局
  // ... 其他设置
};
```

**修改后**:

```typescript
export const DEFAULT_SETTINGS: UserSettings = {
  // ... 其他设置
  layoutMode: 'single' as LayoutMode, // 默认使用单栏布局
  // ... 其他设置
};
```

### 2. 修改安装时默认设置

**修改文件**: `src/background.ts`

**修改前**:

```typescript
await storage.setSettings({
  // ... 其他设置
  layoutMode: 'double',
  // ... 其他设置
});
```

**修改后**:

```typescript
await storage.setSettings({
  // ... 其他设置
  layoutMode: 'single',
  // ... 其他设置
});
```

### 3. 修改重置到默认视图逻辑

**修改文件**: `src/components/layout/Header.tsx`

**修改前**:

```typescript
// 重置为默认布局模式（双栏）
if (settings.layoutMode !== 'double') {
  dispatch(setLayoutMode('double'));
  dispatch(
    saveSettings({
      ...settings,
      layoutMode: 'double',
      reorderMode: false,
    })
  );
}
```

**修改后**:

```typescript
// 重置为默认布局模式（单栏）
if (settings.layoutMode !== 'single') {
  dispatch(setLayoutMode('single'));
  dispatch(
    saveSettings({
      ...settings,
      layoutMode: 'single',
      reorderMode: false,
    })
  );
}
```

### 4. 修改测试文件

**修改文件**: `src/tests/layoutTest.js`

**修改前**:

```javascript
const DEFAULT_SETTINGS = {
  // ... 其他设置
  layoutMode: 'double',
  // ... 其他设置
};

// 检查默认值是否正确
if (DEFAULT_SETTINGS.layoutMode !== 'double') {
  throw new Error(`默认layoutMode应该是'double'，实际是'${DEFAULT_SETTINGS.layoutMode}'`);
}
```

**修改后**:

```javascript
const DEFAULT_SETTINGS = {
  // ... 其他设置
  layoutMode: 'single',
  // ... 其他设置
};

// 检查默认值是否正确
if (DEFAULT_SETTINGS.layoutMode !== 'single') {
  throw new Error(`默认layoutMode应该是'single'，实际是'${DEFAULT_SETTINGS.layoutMode}'`);
}
```

### 5. 修改测试HTML文件

**修改文件**: `test-reset-functionality.html`

**修改前**:

```html
<li><strong>重置布局模式</strong>：将布局模式重置为默认的双栏布局</li>

<!-- JavaScript代码 -->
// 重置为默认布局模式（双栏） if (currentLayoutMode !== 'double') {
dispatch(setLayoutMode('double')); // ... } alert('模拟重置到默认视图：\n✓ 清空搜索\n✓
退出重排序模式\n✓ 重置为双栏布局');
```

**修改后**:

```html
<li><strong>重置布局模式</strong>：将布局模式重置为默认的单栏布局</li>

<!-- JavaScript代码 -->
// 重置为默认布局模式（单栏） if (currentLayoutMode !== 'single') {
dispatch(setLayoutMode('single')); // ... } alert('模拟重置到默认视图：\n✓ 清空搜索\n✓
退出重排序模式\n✓ 重置为单栏布局');
```

## 影响范围

### 直接影响

- **新安装用户**：将默认使用单栏布局
- **重置功能**：点击重置按钮会回到单栏布局
- **测试用例**：相关测试会验证单栏作为默认值

### 不影响

- **现有用户**：已保存的设置不会改变
- **布局切换功能**：用户仍可手动切换到双栏或三栏模式
- **其他功能**：搜索、拖拽、同步等功能完全不受影响

## 用户体验改进

### 新用户首次使用

1. **更直观的界面**：标签组垂直排列，一目了然
2. **减少学习成本**：不需要理解多栏布局的排列逻辑
3. **更好的移动端体验**：单栏布局在小屏幕上显示更友好

### 现有用户

1. **保持选择权**：仍可自由选择喜欢的布局模式
2. **重置功能**：重置后会回到单栏布局，但可立即切换
3. **设置持久化**：个人偏好设置会被保存

## 技术实现

### 布局系统架构

- 使用 `LayoutMode` 类型定义三种布局模式：`'single'` | `'double'` | `'triple'`
- 通过 Redux 状态管理布局模式
- 响应式设计确保在不同屏幕尺寸下都有良好表现

### 默认值设置

- 在 `DEFAULT_SETTINGS` 中设置初始值
- 在 `background.ts` 中为新安装用户设置默认值
- 在 `Header.tsx` 中实现重置到默认值的逻辑

## 测试验证

### 功能测试

1. **新安装测试**：验证新用户默认使用单栏布局
2. **重置功能测试**：验证重置按钮正确回到单栏布局
3. **布局切换测试**：验证仍可正常切换到双栏和三栏模式

### 兼容性测试

1. **现有用户设置**：验证现有用户的布局设置不受影响
2. **数据迁移**：验证从旧版本升级的用户设置正确保留
3. **响应式测试**：验证在不同屏幕尺寸下的显示效果

## 总结

通过这次修改，我们成功地：

1. **改进了新用户体验** - 默认使用更直观的单栏布局
2. **保持了用户选择权** - 现有功能完全不受影响
3. **提升了移动端适配** - 单栏布局在小屏幕上表现更好
4. **维护了代码一致性** - 所有相关文件都进行了相应更新

这个修改体现了"以用户为中心"的设计理念，为新用户提供了更好的首次使用体验，同时保持了现有用户的满意度。
