# 重构落地方案（TabVault Pro）

> 目标：收敛重复逻辑、拆分同步模块、提升可维护性与测试能力。

---

## ✅ 目标架构

### 1) 清晰分层

```
src/
├── app/                 # UI & 页面（React）
├── background/          # 仅事件绑定，不包含业务逻辑
├── domain/              # 业务核心（标签组、同步策略、规则）
├── services/            # 外部服务适配（Supabase、Storage）
├── store/               # Redux（只做状态映射）
├── utils/               # 纯工具
```

### 2) 统一业务核心（domain）

新增：

```
src/domain/tabGroup/
  ├── factory.ts        # createTabGroup, normalizeTabs
  ├── filters.ts        # filterInternalTabs
  ├── merge.ts          # mergeGroups / conflict resolution
  └── index.ts
```

**所有保存/过滤/创建逻辑**必须通过 domain 层，不得散落在 background / thunk / UI。

---

## ✅ 阶段性重构计划

### Phase 1：合并 background 逻辑（最高优先级）

目标：消除 `background.ts` / `service-worker.ts` / `TabManager.ts` 三套重复逻辑。

#### 工作项

1. **确定唯一入口**

   - 保留 `service-worker.ts` 作为入口
   - `background.ts` 移除或迁移为 helper

2. **抽离业务到 domain/tabGroup**

   - `filterValidTabs` → `domain/tabGroup/filters.ts`
   - `createTabGroup` → `domain/tabGroup/factory.ts`
   - 保存/关闭逻辑 → `background/handlers.ts`（薄逻辑）

3. **TabManager 精简**
   - 只做页面激活 / 通知 / UI 引导
   - 业务逻辑完全移出

> 交付标志：`service-worker.ts` 仅事件绑定，业务逻辑全部走 domain。

---

### Phase 2：同步逻辑拆层

目标：`utils/supabase.ts` 过载 → 模块化拆分。

#### 拆层结构

```
src/services/sync/
  ├── auth.ts           # ensureSession, getUser
  ├── mapper.ts         # convert groups/tabs
  ├── crypto.ts         # encrypt/decrypt
  ├── uploader.ts       # upload / download
  └── index.ts
```

#### 同步流程拆解

- `ensureSession()`
- `normalizeGroups()`
- `encryptGroups()`
- `upsertGroups()`
- `handleRlsError()`

> 交付标志：`utils/supabase.ts` 仅作 facade，核心逻辑集中在 `services/sync`。

---

### Phase 3：Redux 简化

目标：store 只映射状态，不做业务。

- `tabSlice` / `settingsSlice` 内的 thunk 仅调用 domain/service
- 逻辑路径：`thunk -> domain/service -> storage -> return`

---

### Phase 4：测试保障

优先覆盖纯逻辑：

1. 标签组生成逻辑（factory）
2. 标签过滤规则（chrome:// 等过滤）
3. OneTab 导入解析
4. sync merge 策略

---

## ✅ 迁移执行策略（step-by-step）

1. **先新增 domain/tabGroup（不改旧逻辑）**
2. **service-worker 引用 domain**（替换内联逻辑）
3. **删除 background.ts 或标记废弃**
4. **TabManager 只保留流程/通知功能**
5. **同步拆层（supabase.ts → services/sync）**

---

## ✅ 验收标准

### 功能一致性

- 保存所有标签行为一致
- 右键菜单 / 快捷键触发结果一致
- UI 保存与后台保存产物一致

### 结构

- 业务逻辑全部在 domain
- background/service-worker 仅做事件绑定
- supabase 同步逻辑清晰可读

### 可测试性

- 标签过滤/生成逻辑可测试
- sync upload/download 至少一条单测

---

## ✅ 风险控制与回滚

### 风险

- background / service-worker 行为不一致
- sync 数据结构调整引起异常

### 解决策略

- 每阶段只改一个方向
- 保留旧逻辑分支可快速回滚
- 提供自测 checklist（保存 / 同步 / 导入导出）
