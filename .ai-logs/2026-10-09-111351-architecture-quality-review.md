# AI Log：TapStack 架构质量审查（只读）

## 对话出发点

- Jasper 要求以「事故时会怎样」为标准，对 Chrome MV3 扩展 TapStack 做只读架构质量审查。
- 重点核对：单一事实来源、循环依赖、Redux 与 chrome.storage/IndexedDB 双源真相、MV3 service worker 生命周期、死代码、大文件边界、散落常量。
- 硬约束：完整读取 `.codex/agents/_shared.md`；不修改产品代码；任何 grep/rg 零命中结论必须二次复核；报告必须区分确认缺陷、误判撤回和未验证项。

## 执行过程

- 读取 `_shared.md` 全文，确认陷阱 1/3/4/5 与数据安全不可变量。
- 读取记忆中的 storage 读-改-写防线，重点核对 `getGroupsForWrite()`、`cachedAsyncFn`、fail-closed 契约。
- 解析 `src` 下 136 个 TS/TSX 模块，重建多行 import 依赖图并运行 Tarjan SCC；结果为 0 个 size>1 的环、0 个自环。
- 审计键位与集合清单：确认 `MIGRATION_SCAN_KEYS` 已由 `STORAGE_KEYS` + `LEGACY_KEYS` 派生，并由 `tests/storageKvConvergence.test.ts` 做双向断言。
- 审计 SW 生命周期：确认 IndexedDB 死句柄 5 秒看门狗、`onblocked` 拒绝、上传 alarm 兜底、`pending_upload` 持久化存在。
- 审计状态管理：确认 groups 的权威源是 KV、Redux 是 UI 投影；发现管理页（源码目录名 `popup`，实际是完整标签页）的迁移写路径绕过 SW 单写者队列。
- 运行临时探针（文件在 `/tmp`，未写入产品代码）：
  1. 模拟加密 `migration_flags` 从 chrome.storage 迁入 KV，发现适配器完成标志覆盖了原有业务标志，并可让残留 localStorage 旧数据覆盖当前 KV 新数据。
  2. 模拟设备绑定 V2 密文在 deviceId 迁移后解密，得到 `OperationError`。
- 全量测试第二次执行：995 tests / 995 pass / 0 fail / 0 skipped。第一次并行执行出现一次 `tests/guards/globRecursion.test.ts` 红，单独复跑和第二次全量复跑均通过，按外部并行干扰处理，未列为产品缺陷。

## 遇到的问题

- 第一版依赖图正则漏掉多行 `import { ... } from`，一度把 `diagnostics.ts`、`search.ts` 误判为零入边；已用更严格解析器重建图并撤回该判断。
- 第一次全量测试的 `globRecursion` 红与当前 `package.json` 内容不一致；复核文件内容、单独跑守卫、再跑全量后均为绿，符合“外部自动化可能并行改动”的陷阱 4。
- 临时探针首次因 `/tmp` 相对 loader 路径和 `g` 声明顺序失败；改为绝对 loader 路径并重新生成探针后成功。

## 最终结果

- 完成只读架构质量审查，未修改任何产品代码。
- 确认 2 个 P0：迁移标志覆盖导致旧数据回滚风险；管理页迁移写入绕过 SW 单写者队列。
- 确认 1 个 P1：旧设备绑定密文迁移后无法解密，下载侧会跳过该组并保留云端行。
- 其余发现归为 P2：散落键名/常量、敏感键分类不一致、主题集合手抄、死代码候选与大文件拆分建议。
- 循环依赖实测为零；版本六处同步、manifest 权限与使用面未发现漂移。
