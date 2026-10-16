# WebDAV 首次推送入口 + 远端已有数据的三选一决策

## 对话出发点

Jasper 报告：「使用外部 DEV（WebDAV）存储模式后，首次连接时本应把本地数据同步到云端，
实际打通后因远端无数据导致本地数据被清空」，要求修复。
澄清后补充关键信息：**只是配置好 WebDAV，返回标签管理界面时数据丢失**，没点任何下载按钮。
中途又观察到「数据又回来了」，并推测「可能是因为我刚才有保存的标签页」。

要求：
1. 手动触发首次上传的入口 + 提示用户确认
2. 若远端已有旧数据，考虑一般同步模式做法，确保数据不丢
3. 三个选项都给：合并 / 以本地为准 / 以云端为准

## 执行过程

### 1. 诊断：Jasper 的推测正确，且让问题更严重

确认 `TabManager.ts:157` 保存会话后调 `scheduleUpload` → 置位 `pending_upload` → 触发全量上传。
所以他的数据是被「保存标签页」顺手救上云的。

**这不是「运气好」，而是把缺陷掩盖了**：
| 用户行为 | 结果 |
|---|---|
| 配完 WebDAV + 保存过会话 | 碰巧成功，**看起来正常** |
| 配完 WebDAV + 换设备 | 新设备什么都没有（云端空）|
| 配完 WebDAV + 直接走人 | 数据永远出不了本机 |

根因一句话：**上传由 `pending_upload` 驱动，而该标志只在数据变更时置位；
「配好 WebDAV」本身不是变更 ⇒ 永远不触发上传。**
`firstSync = loaded === null` 的全量上传逻辑是有的，但没人触发它。

### 2. 排除项（实测，非推断）
- **下载合并路径安全**：真实跑 `mergeOpStamped + validateMergeResult + checkDeleteFailsafe`
  （本地 3 组 + 云端 0 组）→ merged=3、valid=true、failsafe allowed ✅
  代码上 `opStampMerge.ts:42` 对「本地有云端无」保留本地。
- **配置流程无写操作**：`handleSave` 只做存配置/存口令/切后端/重建 alarm/重解析。
- **「数据又回来了」证明是假空**：IndexedDB 被写空不会自愈（无回收站），
  所以磁盘数据一直完好，问题在读取/显示层。
- **覆盖下载会真丢**（实测 forceRemote=true 时 localGroups 被置空 →
  validateMergeResult 返回 valid:true，两道防线同时失效），
  但需用户点按钮，与本次场景不符。

### 3. 实测合并语义（决定默认选项的依据）
用真实 `mergeOpStamped` 跑「本地 3 组 + 新云端服务 2 组旧数据」→ **5 组全保留**。
不同 id 一个不丢；只有同 id 才按 stamp 决胜（实测云端 s=9 > 本地 s=1 → 云端赢）。
⇒ **合并在数据安全上接近「以云端为准」，但保留了把本地新数据带上去的能力**，
且与 Supabase 侧现有语义同一函数，不引入新概念。

### 4. 实现
- **新增 `src/sync-backend/webdav/firstSyncDecision.ts`**（纯函数，可单测）：
  `decideFirstSync` 把「远端状态 → 该做什么」钉成四分支：
  - `upload-all`（远端空，直接推，不打扰）
  - `ask-user`（远端有数据，必须显式选）
  - `nothing-to-do`（本地也空，不谎报成功）
  - **`blocked`（探测失败，绝不默认上传）** ← 最关键的一条
  `previewOutcome` 给三种选择的后果预览（数字 + 不可恢复警告）。
- **WebDavSettings.tsx**：常驻「首次配置后需把本机会话推送到云端」区块 +
  「检查并推送到云端」按钮 + 三选一确认框（合并默认选中，两个破坏性项二次确认）。
- 「以云端为准」的实现顺序：**先上传，再 forceRemote 下载**。
  顺序反了会先把本地冲掉，不可逆。

## 遇到的问题

1. **差点按错误结论收工**：最初把现象判为 P0 数据丢失；
   是 Jasper 报告「数据回来了」才推翻。数据自愈 = 假空。
2. **`storage` 导入方式错**：写成 `import * as storage`，实际是具名导出 `export const storage`。
3. **tsc 抓到死代码**：`choose` 分支里比较 `firstPush.kind === 'pushing'` 类型上不可能重叠，
   属真实冗余判断，已删。
4. **真机 UI 验证第一次失败**：直接改 chrome.storage 的 `user_settings` 不影响 Redux，
   面板仍显示 supabase。改为走真实「填表 → 保存并启用」流程后验证通过。

## 最终结果

**成功。**
- `pnpm test`：**1335 pass / 0 fail**（原 1325 + 新增 10）
- `pnpm validate`：**exit 0**（tsc ×2、lint ×2、build、体积 199.3KB ≤ 240KB）
- 变异验证 3/3 变红（unreachable→upload-all、has-data→upload-all、merge 预览换 local-wins）
- 真机 UI 验证：走真实保存流程后新入口出现，无 pageerror
- 新增：`firstSyncDecision.ts` + 10 条测试；改动：`WebDavSettings.tsx`
- 未提交 git；临时探针与 /tmp 已清理

## 未做（明确告知用户）

之前实测确认失效的**覆盖闸门**（forceRemote 覆盖模式下 `validateMergeResult`
拿到被置空的 localGroups，两道防线同时失效）**本次未修** —— 用户本轮只选了
「三个选项都给」，未确认是否一并处理。仍是待办。

## 沉淀的教训

1. **「用户报告的严重度」要用可观察事实校准**。「数据清空」与「数据显示为空」
   的修法完全不同；前者不可逆、后者可逆。判据是：数据会不会自愈。
2. **被掩盖的 bug 比暴露的 bug 更危险**。一个「碰巧被用户的后续操作救回来」的缺陷，
   在早期使用中完全看不出来，却一直存在。发现「为什么这次没出问题」比复现问题更有价值。
3. **不可逆操作前的探测失败必须 stop，绝不能 fallback 到破坏性默认值**。
   `blocked` 分支是这张表里最重要的一条。
4. **预览必须与执行同函数同入参**（复用 `mergeOpStamped`），否则会预告相反的结果。
5. 纯函数决策 + 单测是把「用户数据不该靠 UI 手工保证不丢」落地的手段。
