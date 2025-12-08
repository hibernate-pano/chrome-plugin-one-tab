# IndexedDB 迁移设计（草案）

目标：用 IndexedDB 取代现有 localStorage 持久化，提升容量、可靠性与批量操作能力，同时保持向下兼容与平滑迁移。

## 范围
- 当前使用 localStorage 的内容：折叠状态（tabGroup_*）、提示标记（syncPromptShown）、设备 ID（deviceId）。
- 后续可扩展到 tabs / groups / settings 的本地缓存与快照。

## 设计原则
- 向下兼容：首次运行检测 localStorage 数据，迁移成功后写入 `storage_version`，避免重复迁移；失败则回退 localStorage 读写。
- 单一存储抽象：暴露统一 API（CRUD、批量写、事务化语义），屏蔽底层实现；调用方不直接依赖 localStorage/IndexedDB。
- 幂等与事务：批量操作在一个事务内完成；写前去重，写后校验；失败路径带错误码与用户提示。
- 可观测性：统一错误收集与诊断日志（含操作名、key、错误类型）。

## 模块规划
- `src/storage/indexedDbClient.ts`：封装 DB 初始化、object store 定义、CRUD、批量/事务。
- `src/storage/localStorageFallback.ts`：兼容实现，API 与 indexedDbClient 一致。
- `src/storage/storageAdapter.ts`：对外统一接口，负责：
  - feature detection（IndexedDB 可用性）
  - 迁移流程（localStorage → IndexedDB）
  - 读写路由（优先 IndexedDB，失败降级 localStorage）
- `src/storage/types.ts`：数据模型与版本号定义。

## 数据模型（初版）
- Object stores（按需演进）：
  - `kv`: 通用键值（如提示标记、折叠状态、设备 ID）
  - `tabs`: { id, groupId, title, url, favIconUrl, pinned, createdAt, updatedAt }
  - `groups`: { id, name, color?, createdAt, updatedAt }
  - `settings`: { key, value, updatedAt }
- 版本号：`storage_version`（示例初始为 1），存放于 `kv`。

## 迁移流程（v1 -> v2 示例）
1. 检测 IndexedDB 可用；不可用则继续 localStorage 路径。
2. 读取 `storage_version`，若缺失则视为 v1（localStorage）。
3. v1→v2 迁移步骤：
   - 迁移折叠状态：`tabGroup_*_expanded` -> `kv`。
   - 迁移提示标记：`syncPromptShown` -> `kv`。
   - 迁移设备 ID：`deviceId` -> `kv`。
4. 写入 `storage_version=2`，记录迁移完成时间戳。
5. 迁移失败：记录错误并回退到 localStorage 读写路径，提示用户可导出/重试。

## 错误处理与提示
- 分类：初始化失败、事务失败、数据校验失败、超时。
- 处理：重试（有限次数）、回退 localStorage、向 UI 抛出友好提示（如“本地存储不可用，请导出数据后重试”）。

## 测试清单
- 单测：CRUD、批量、事务、降级、迁移幂等。
- 集成：首次启动迁移；迁移失败回退；大数据量（1k tabs）性能。
- 回归：service worker 事件下的存储调用；批量保存/删除路径。

## 发布与回滚
- 发布：随版本上线，默认启用 IndexedDB；保留 localStorage 回退。
- 回滚：发现严重问题时，可通过 feature flag 切回 localStorage（保留迁移后的 localStorage 回填逻辑）。

