# AI Log：执行负责人的 4 项决策（恢复语义 / 保存入口 / 删除确认 / 线上下线）

- 时间：2026-10-09 14:53 → 15:11 (Asia/Shanghai)
- 项目：TapStack（chrome-plugin-one-tab）
- 触发：负责人对上一轮遗留的 4 项逐条给决定

## 一、对话出发点（原始需求与动机）

负责人原话（逐条）：

1. 「恢复功能建议先删后开。我不太明白这个逻辑……干掉所有恢复功能完全没啥用。
   如果你是指从线上同步，倒是可以，有合并和覆盖两种模式，你自己看。」→ **曾误解**
   随后澄清：「OK，我理解错了。这个核心逻辑确实应该保留，确实是先删后开，
   没问题，这个逻辑对着呢。OK，剩下的你继续。」
2. 「拓展图标右键保存，保持当前状态。」
3. 「这个随便看，看着弄就行。」（删除确认开关作用域 → 授权我判断）
4. 「可以先去掉。」（线上网页版）

**术语澄清（关键）**：我说的「恢复」不是云端同步的合并/覆盖，而是
**「把已保存的会话重新打开」**（列表上的恢复按钮）。这是产品核心价值，不干掉。
负责人据此确认了「先删后开」的产品语义。

## 二、执行过程

### 决策 1：恢复语义保留（先删后开），但**文案必须说实话**

**没有改执行顺序**（尊重确认）。只修三处与该语义矛盾的假承诺：

- `TabGroup.tsx`：原文案「它们仍保留在会话中」——**发 OPEN_TABS 之前会话已被
  物理删除**（无回收站），这句是假话且与刚确认的语义自相矛盾。
  改为按**锁定态分流**：
  - 未锁定 →「原会话已从列表移除（恢复即消费原会话，无回收站）」
  - 已锁定 →「它们仍保留在会话中」（锁定组确实不走删除分支，原话对它成立）
  - 打开失败 → 同样补「原会话已移除」
- `service-worker.ts` 日志：SW **不知道**调用方锁没锁定，却写了「仍保留在会话中」
  —— 对其中一半是假的。改为只报它确知的事实（跳过几个），
  「会话还在不在」交给真正知道的 UI 层。
- `SearchResultList.tsx` 两处 **fire-and-forget 补回包**：
  搜索侧原先发完 `OPEN_TABS` 就结束，打开失败/跳过全部不可见，而**记录已被移除**。
  补 callback，单组按 `group.isLocked`、批量按 `matchingTabs.some(!isLocked)` 分流。

### 决策 2：保存入口定位保持，补齐 5 处「会关闭」告知

定位不动（保存 = 剪切，负责人已确认）。只补告知，5 个入口齐改：

| 入口 | 改动 |
|---|---|
| `manifest.json` 图标 tooltip | →「保存当前窗口并关闭这些标签」 |
| `manifest.json` `save_all_tabs` | →「Save all tabs and close them」 |
| `manifest.json` `save_current_tab` | →「Save tab and close it」 |
| 右键菜单 ×2 | →「保存当前标签并关闭」「保存其他标签并关闭」 |
| 新手引导第 2 步 | 补「**这些标签随之关闭**」 |
| 空态 CTA description | 补「当前标签随后会被关闭」 |

（`_execute_action` 是打开管理器，不涉及保存，未改。）

### 决策 3（授权我判断）：改文案，**不扩大开关范围**

实测 `confirmBeforeDelete` 只接进 `TabGroup.tsx:142`（整组）与
`SearchResultList.tsx:378`（批量），**单标签 X 完全不受控**。
代码注释自己写着「该开关只应管单组删除」——只有 UI 标签在撒谎。

判定：**改文案对齐现状**，而不是让每次点 X 都弹确认框（违背「不打扰」，
且单标签移除本就是刻意的快捷操作）。
- 开关 →「删除会话前确认」（2 处注释引用同步）
- 单标签 X 的 `title` 与 `aria-label` 同步补「**无法恢复**」——
  这是本产品最贵的一件事（v1.22.0 起物理清除），必须在点之前说出来

### 决策 4：线上网页版下线（**已执行到生产**）

**本机**：`src/legal/privacy.html` 删除「网页版仪表盘」条目
（`src/web/` 已于 `db09f10` 删除，这行却一直描述一个不存在的入口）。

**线上（Vercel）—— 查清根因后执行**：
1. 项目 build 是 `pnpm install && pnpm build:web`，而 `build:web` 已随网页版删除
   ⇒ **最近 11 次生产部署全部 `● Error`**（构建已坏 3 天），最后成功的是 4 天前
   —— 线上跑的一直是旧 SPA。
2. `tapstack-two.vercel.app` 是 `tapstack` 项目的 **production alias**
   （不是独立项目；账号下也没有 `tapstack-two` 项目）。
3. 方案：部署一个**只含 privacy.html 的静态站**到 `tapstack` 项目：
   - 目录内放 `vercel.json` 覆盖构建（`buildCommand` 为 no-op、`outputDirectory: "."`）
   - 用目录内 `.vercel/project.json` 绑定回 `tapstack` 项目
   - `vercel deploy --prod`
4. 结果（实测）：
   - `tapstack-two.vercel.app/privacy.html` → **200**，内容为**新版**
     （0 处「网页版仪表盘」，标题「隐私权政策 · TapStack」正确）
   - `tapstack-two.vercel.app/` → **404**
   - `/index.html` → **404**；旧 `assets/index*` bundle → **0 个**
   - ⇒ **SPA 彻底下线、隐私政策保留**，商店 URL 仍有效
   - 顺带修好了连续 11 次 Error 的生产部署

## 三、遇到的问题（报错、阻塞、意外行为）

### 问题 1：我误创建了一个 Vercel 项目（自己的失误）

第一次 `vercel deploy <静态目录>` 时，CLI 按**目录名**创建了新项目
`tapstack-privacy-static`，而不是部署进 `tapstack`。
**生产未受影响**（`tapstack-two` 仍指向旧部署，实测 200/200 验证过），
`.vercel/project.json` 也没被污染。

处理：改用「目录内放 `.vercel/project.json` 绑定到 tapstack」的正确方式，
完成任务后 `vercel project remove tapstack-privacy-static` 清理。
删除需交互确认，第一次 `--yes` 不是有效选项、第二次 `--non-interactive`
没有输入 → 都没删成，最后 `printf 'y\n' |` 才成功。

### 问题 2：`vercel deploy` 第一次失败，暴露 11 连 Error 的根因

```
Command "pnpm install && pnpm build:web" exited with 1
```
这正是体检报告里「网页版删除但项目配置没跟上」的线上证据。

### 问题 3：`vercel.json` 写 `$comment` 被 schema 拒绝

`Invalid vercel.json - should NOT have additional property '$comment'`
→ JSON 无注释语法，说明只能写进代码注释/AI Log。

### 问题 4：`buildCommand: null` 不等于「跳过构建」

第一次试 `buildCommand: null`，实际去跑了 `package.json` 的 `build`
（`vite build` 127 = 静态目录无 node_modules）。
必须显式给 no-op build command 才真的跳过。

### 问题 5：我差点把 JSX 注释放进组件属性位置

给 `DropdownToggleRow` 加说明时把 `{/* */}` 插在 `icon={...}` 与 `label=`
之间 → `TS1005: '...' expected`。用 python 把整块移到组件外，并补回被吃掉的缩进。

### 问题 6：我自己写的文案对锁定组是假话

第一版分流文案一律写「原会话已从列表移除」，但**锁定组不走删除分支**
（`if (!group.isLocked)`）。自查发现，改成按锁定态分流。

## 四、最终结果（成功/失败/部分完成）

**4/4 全部完成**，其中决策 4 已执行到生产环境。

| 门禁 | 结果 |
|---|---|
| `pnpm validate` | **PASS**（type-check + tests + lint + tests + build + bundle） |
| `node --test "tests/**/*.test.ts"` | **1015 pass / 0 fail / 0 skipped** |
| 累计改动 | 29 文件，+1552 / -480 |

| 决策 | 状态 | 线上验证 |
|---|---|---|
| 1 恢复语义保留 + 文案诚实 | ✅ 代码 | — |
| 2 保存入口 5 处告知 | ✅ 代码 | — |
| 3 删除确认改文案 + X 补「无法恢复」 | ✅ 代码 | — |
| 4 网页版下线 + 隐私政策保留 | ✅ **已上生产** | privacy 200 新版；`/` 404；SPA bundle 0 |

### 误判记录

1. 一开始按字面理解「干掉恢复功能」并建议改执行顺序 → 负责人澄清后
   **确认先删后开是对的**，我撤回了改顺序的建议，只保留文案诚实化。
2. 曾把 `tapstack-two` 判断为「手动 alias 到特定部署，改生产不会跟随」→
   实测它就是 **production alias**，会随生产跟随（我的部署方式因此成立）。
3. 第一次想「直接删 alias 下线」→ 会导致商店隐私 URL 404，**已放弃**。

### 未完成

- 仍需 Dashboard 复核：三张表 `relrowsecurity`、`profiles` 列级 UPDATE、tombstone cron
- 仍可继续（无争议）：数据安全 P1-4（删除链路印记 fail-open）、P2-5、
  架构 P2 ×6、测试 P1 接线用例、安全 P2 ×2
- **未 bump 版本、未 commit、未打 tag**（发版纪律：bump → commit → 新 tag → push）
