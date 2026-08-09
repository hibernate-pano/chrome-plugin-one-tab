# Changelog

All notable changes to TabStack will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.13.6] - 2026-06-28

### Refactor
- **syncEngine 依赖注入（DI）**：构造函数接受可选 `SyncEngineDeps`，生产代码路径不变（`syncEngine` singleton），测试可通过 `new SyncEngine(deps)` 注入 fake storage + stub supabase。这是同步层可测试性的根本性解锁。
- `store.getState` 也可注入，避免测试时拉起 Redux singleton
- 新增 `SyncEngine.__resetInstanceForTesting()` 静态方法

### Tests
- 22 个 syncEngine 集成测试（DI 注入 fakeStorage + stub download/upload/markDeleted/GC + fake getState）
  - 覆盖：鉴权 / 并发锁 / forceRemote / 验证失败回滚 / 成功后副作用（lastSyncTime + snapshot 清理）/ 上传活跃 vs 软删 / GC fire-and-forget / 错误处理 / 调度上传
- 15 个 syncPreview 预览统计测试
- 11 个 runtimeInfo + productEvents 测试
- 测试总数：198 → 246（+48）
- 覆盖率：~33% → ~40%（同步层最后盲区已覆盖）

### Audit
- 运行 `npx ts-prune` 审计未使用导出
- 85 个标记中绝大多数是 ts-prune 假阳性（React default export + thunk name 引用）
- 确认无关键死代码
- 保留的唯一 TODO：supabase.ts Database 接口定义（不在本 sprint 范围）

## [1.13.5] - 2026-06-28

### Tests
- 17 个数据迁移测试（migrationUtils.ts）
- 覆盖：shouldRunMigration / migrateFaviconUrls（xss 过滤）/ removeRecentRestoreHistory / runMigrations 端到端 / 数据完整性不变量
- 使用 fake-indexeddb 集成测试
- 测试总数：181 → 198（+9%）
- 覆盖率：~30% → ~33%

## [1.13.4] - 2026-06-28

### Tests
- 37 个搜索测试（search.ts）：基础匹配 / exactMatch / caseSensitive / 字段开关 / 过滤器 / 评分排序 / matches 元数据 / suggestions / filterOptions / applySearchFilters / buildSessionSearchResults
- 18 个标签组自动删除测试（tabGroupUtils.ts）
- 17 个错误处理测试（errorHandler.ts）：ErrorCodes / createAppError / handle 输入类型 / 选项行为 / 返回值
- 测试总数：108 → 181（+67%）
- 覆盖率：~20% → ~30%

### Note
- errorHandler 测试需要显式设置 `globalThis.__TABSTACK_META_ENV__`（v2 依赖 import.meta.env.DEV）。已记录在测试文件 header。

## [1.13.3] - 2026-06-28

### Tests
- 33 个新增纯函数测试：
  - versionHelper: 17 个（incrementVersion / updateGroupWithVersion / updateDisplayOrder / initializeVersionFields）
  - oneTabFormatParser: 16 个（parseOneTabFormat / formatToOneTabFormat / 往返）
- 测试总数：75 → 108（+44%）
- 覆盖率：~15% → ~20%

### Developer
- 新增 `pnpm verify` 脚本（一次性跑 validate + test）
- 新增 `pnpm audit:fix` 脚本（report-only，支持 `--strict` 模式）
- CI workflow 改用 `pnpm verify`，增加 `pnpm audit:fix` 作为 informational check

## [1.13.2] - 2026-06-28

### Tests
- 13 个新增存储层集成测试（fake-indexeddb + chrome polyfill）
- 覆盖：setGroups/getGroups 往返、加密 V2 前缀、不变量「解密失败不固化缓存」、syncSnapshot 生命周期、settings 往返
- 测试总数：62 → 75（+21%）
- 真实覆盖率提升：~5% → ~15%（storage.ts 是 syncEngine 之后第二大安全路径）

### Developer
- 新增 devDep: `fake-indexeddb` ^6.2.5

## [1.13.1] - 2026-06-28

### Security
- 修复 32 个依赖漏洞（46 → 14）。包含唯一的运行时漏洞 `@supabase/auth-js`。
- @supabase/supabase-js 2.49.4 → 2.75.1
- lodash 4.17.21 → 4.18.1
- 传递依赖覆盖：glob / minimatch / brace-expansion / undici / picomatch / flatted / postcss

### Removed
- 删 `master` 分支（落后 main 59 commit，无标签）

### Tests
- 8 个新增 tombstone 跨设备删除传播测试（钉死生产路径关键不变量）

### Note
- supabase-vendor bundle 增 ~40KB（106KB → 146KB），是接受的安全代价

## [1.13.0] - 2026-06-28

### Fixed
- 部分用户报告"点击扩展图标后看到空白界面"——已修复（empty read 不再被固化为已加载）
- 跨设备删除现在正确传播（不再出现"另一台设备删的组又回来"）

### Changed
- 打包体积更小：清理了未使用的 `@dnd-kit/*` 依赖
- 同步引擎重构为单一入口（开发者向，普通用户无感）

### Security
- 同步系统新增 tombstone GC 机制，自动清理 30 天以上的软删标记

## [1.12.0] - 2026-06-06

### Added
- 跨设备云同步（需注册账号，AES-GCM 端到端加密）
- 8 套主题：原始 / 经典 / 极光 / 奶油 / 粉红 / 薄荷 / 赛博 / 棱镜
- 智能防抖自动同步

### Fixed
- 同步过程中可能丢数据的边界条件（合并前快照 + 验证后写入 + 失败回滚）
- Service Worker 周期同步导致的 CPU 占用（移至 popup 上下文）

### Changed
- 同步层重构为单一 `SyncEngine` 入口，删除 3 条历史遗留的同步路径

## [1.11.8] - 2026-05-26

### Changed
- 品牌名统一为 **TabStack**（原 TabVault Pro）
- UI 动画与可访问性优化

## [1.11.0] - 2026-05

### Added
- 初次公开发布准备
- 一键保存 / 一键恢复
- 智能搜索
- 基础主题系统
