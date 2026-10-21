# WebDAV 自托管同步迁移 · 代码质量审查报告
<!-- doc-status:已归档（历史记录） -->
>
> **文档状态：已归档（历史记录）**
> 审查对象 `feature/webdav-selfhost-sync` 分支已合并进 `main` 并删除。本文是对**当时那次审查**的记录，其中指出的问题与给出的建议已随 v1.25.1 一并处理；若要照本文改代码，先核对当前实现。


- **审查对象**：`feature/webdav-selfhost-sync` 分支
- **基线**：`main` @ `86c4c45`（tag v1.23.1）
- **审查日期**：2026-10-14
- **审查方式**：专家团队（架构评审 + 测试验证并行）+ 主理人横切抽查
- **改动规模**：19 提交 / 44 文件 / +9146 −35 行

---

## 一、结论摘要

**整体判断：架构方向正确、注释质量罕见地高，但存在 1 个 P1 功能缺陷需要修复后再上线。**

这不是「AI 生成的糊弄代码」。相反，代码里处处能看到**实测驱动的诚实记录**：分支自己
推翻了「WebDAV 天然支持条件写」的错误前提，实测了 3 个独立实现的服务端行为，并据此实现了
能力探测。删除熔断的判据有出处（对齐 Floccus 事实值），冲突裁决注释明确标注「这是测试抓到的
真 bug，别删」。这种把**推翻自己的过程也留痕**的做法，是这个分支最大的资产。

主要风险不在架构，而在**接线遗漏**——有一处为同步路径设计的权限预检函数从未被调用。

| 维度 | 评价 |
|---|---|
| 架构设计 | 良好。端口/适配器抽象成立，依赖方向干净 |
| 一致性语义 | 有防御纵深（认输预检 + If-Match + 能力探测） |
| 加密边界 | 正确。PBKDF2 250k / AES-256-GCM / IV 每次随机 / 密钥不可导出 |
| 注释与文档 | 优秀，但有孤儿注释需要清理 |
| 遗留标记 | **零**（无 TODO / FIXME / @ts-ignore / as any） |
| 测试覆盖 | 主要路径有覆盖，关键一致性路径与权限模块有缺口 |

---

## 二、问题清单

| # | 严重度 | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| 1 | **P1** | `permission.ts:84-87` | `hasHostPermission` 零调用，同步路径缺权限预检 → 静默失败 | 同步入口调用它，false 时抛 `PERMISSION_DENIED_MESSAGE` |
| 2 | **P2** | `crypto.ts:80-91, 191-199` | 孤儿 JSDoc：描述已删除的 `encryptJson`/`decryptJson`，且与现行设计矛盾 | 删除或改写为Vault 语义 |
| 3 | **P2** | `adapter.ts:738` vs `core/opStamp.ts:22` | `compareStamps` 双实现，无印记口径不一致（`-Infinity` vs `0`） | 统一到 `core/opStamp` |
| 4 | **P2** | `manifest.json:8` | `connect-src` 放宽到 `https://*` 全网通配 | 已知必要改动，记为安全债 |
| 5 | **P2** | `tests/` | `permission.ts`(97 行) 零测试覆盖 | 补origin 解析 / 拒绝 / 环境不支持三个分支 |
| 6 | **P2** | `crypto.ts:18` | 「见 encryptJson 的 salt 注释」是死锚点，读者按指引会扑空 | 指向 `Vault` 接口注释 |

### P1 详述：权限预检未接线

`permission.ts:84-87` 定义并导出了 `hasHostPermission`，注释明确写着用途：

```ts
/** 不带 request 的只读检查（同步路径用，无用户手势也安全）。 */
export function hasHostPermission(baseUrl: string, api?: PermissionApi): Promise<boolean> {
  return ensureHostPermission(baseUrl, { request: false, api });
}
```

同文件开头 `:9-11` 也描述了没权限时的症状：

> 不申请会怎样：fetch 被浏览器在本地拦下，表现是我们传输层的
> `WebDavError(status 0, '请求根本没发出去')`。用户看到的是「连接失败」，
> 而真正的原因（没给权限）他完全无从得知 —— 又一个静默失败。

**但全项目 grep 显示它只被定义、从未被调用。** 唯一调用点是 UI 的
`WebDavSettings.tsx:127`（用户点「测试连接」按钮，`request: true`）。

后果：用户完成授权后若手动撤销权限、或浏览器策略变更，自动同步路径不会做
`contains()` 检查就直接发出请求，被浏览器在本地拦下，抛出 `status 0`，
用户只看到「连接失败」——**这恰好是新模块开头批评 Supabase 侧的那种静默失败，
在新模块里复现了**。

修法：同步路径（adapter 入口或 service 层）先调 `hasHostPermission`，
返回 false 时直接抛 `PERMISSION_DENIED_MESSAGE`，而不是让 `status 0` 冒泡。

---

## 三、值得肯定的设计决策

1. **推翻自己的前提并留痕**。`docs/webdav-selfhost-sync-plan.md:313-358` 明确记录
   「文件后端天然支持条件写」**是错的**，附3 个服务端实测对照表，并得出反直觉约束：
   **客户端只能发 `If-Match`，绝不能加 WebDAV `If:` 头**（多带一个头会让所有写入失败）。

2. **能力探测而非假设**。`adapter.ts:636-693` 的 `probeConditionalWrites()`
   用一个探针文件发一次必然失败的条件写，实测服务端是否真的实现 If-Match。

3. **认输预检修补了 If-Match 的盲区**（`adapter.ts:371-385`）。If-Match 只能发现
   「我读完之后有人改了」，**发现不了「我的版本本来就更旧」**——一台久未同步的设备会用旧内容
   静默覆盖云端新版。第 382 行的stamp 比较正是这条防线，注释标注「测试抓到的真 bug，别删」。

4. **删除熔断判据有出处**（`failsafe.ts:15-20`）。20% 阈值来自 Floccus 事实值，
   `minTotal`/`maxChanged` 分别给比例判断设下限、绝对量设上限，边界完整（`deleteCount <= 0`
   放行、严格大于、比例+绝对双阈值）。

5. **`Vault` 解决PBKDF2 性能问题**（`crypto.ts:92-127`）。初版每次加密都跑 250k 轮PBKDF2，
   分片存储下 300 个会话 ≈ 数分钟纯CPU，撞上 MV3 service worker 单事件 5 分钟硬上限。
   改为「salt 每库一个 + IV 每次随机」，一次派生多次使用。

6. **不把明文哈希写进明文 manifest**（`adapter.ts:387-393`）。理由写得很清楚：
   把明文哈希写进明文 manifest 等于给攻击者「已知明文确认」的口子，会削弱端到端加密。

7. **`syncBackend` 与 `syncEnabled` 分开**（`tab.ts:211-227`）。注释解释：合成一个枚举会造成
   **静默语义迁移**——存量用户的 `syncEnabled: true` 该映射成 `supabase` 还是 `webdav`？
   两个都「合理」，选错的后果是老用户突然被指向一个没配过的后端。

8. **最小权限原则**（`permission.ts:13-26`）。用 `optional_host_permissions` +
   按 origin 逐个申请，把授权推迟到用户真的配置云盘那一刻，避免安装时就警告
   「读取和更改您在所有网站上的数据」。

9. **`compareStamps` 口径与命名诚实**（`adapter.ts:737`）。注释标注「稳定短哈希（FNV-1a）
   **不用于安全用途**」，避免了常见的自定义哈希误用。

---

## 四、架构层面的债（记录，不必现在修）

- **`supabaseAdapter.ts` 是过渡兼容层**。双轨共存期间，WebDAV 分支下它仍被编译进包。
  迁移稳定后应评估移除，减少包体积与维护面。
- **`connect-src https://*` 是最宽口径**。虽属必要（原 CSP 只允许 `supabase.co`，
  见 plan:240），但可以考虑更收敛的方案。
- **`permission.ts` 缺少测试**，而它恰好是最需要测试的模块（分支最多、失败模式最隐蔽）。

---

## 五、建议的修复顺序

1. **修 P1**：同步路径接入 `hasHostPermission`（约 3 行改动 + 一处错误文案）
2. **补测试**：给 `permission.ts` 加origin 解析 / 用户拒绝 / 环境不支持三个用例
3. **清 P2**：删/改 `crypto.ts` 孤儿注释，统一 `compareStamps`
4. **回归**：`pnpm validate` + `pnpm test` 全绿后再上线

---

*本报告由主理人独立核实源码后产出，架构师与 QA 的深度评审结论见附报告（如已生成）。*