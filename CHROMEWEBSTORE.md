# Chrome Web Store Listing — TapStack

> Last Updated: 2026-10-04
> 本文件是 Chrome Web Store 上架信息的单一事实来源（chrome-extensions skill 约定）。
> 标注 ⚠️ 的字段需要发布者确认后才能提交。

## Store Listing

**Extension Name** [REQUIRED]

TapStack

**Short Description** [REQUIRED]
<!-- ≤132 字符。写具体功能，不写口号。中英双语拼接。 -->

保存、命名和恢复浏览器标签会话，跨设备同步找回。Save, restore & sync your tab sessions.

**Detailed Description** [REQUIRED]
<!-- 用户视角，禁提实现细节（API/框架/代码模式）。CWS 会剥离 markdown。中英双语用 --- 分隔。 -->

TapStack 把你当前浏览器窗口里的所有标签页保存为一个命名会话，随时找回、随时恢复，不让标签页堆积成灾难。

主要功能：
· 一键保存：把当前窗口的全部标签页存为会话；快捷键 Ctrl+Shift+S 打开管理器、Alt+Shift+S 保存全部、Alt+S 保存当前页
· 右键菜单：不打开管理界面，也能保存当前标签页或窗口里的其他标签页
· 会话整理：每个会话可重命名、加备注、收藏、锁定防误删
· 快速恢复：一键在新窗口打开整组标签，不打乱当前窗口；点开单个标签直接继续工作，它会自动从会话中移除
· 会话搜索：按会话名、备注、标签标题/网址查找，支持按域名过滤，并提供按域名等维度的排序视图
· 误删保护：删除前二次确认（「删除全部会话」强制确认并显示数量），删除后彻底清除
· 一键清理：清除重复标签页和空会话
· 导入导出：支持 OneTab 文本格式导入导出，以及 JSON 备份
· 登录同步：登录后会话自动同步云端，换设备、换浏览器也能找回你的工作现场

隐私说明：会话数据默认只保存在你的浏览器本地；仅当你登录并开启同步后，数据才会传输到你自己的云端账户。扩展不收集任何分析数据，也不上传你的浏览历史。

反馈与问题：https://github.com/hibernate-pano/chrome-plugin-one-tab/issues

---

TapStack saves every tab in your current window as a named session, so you can find and restore your work later — no more tab pileups.

Key features:
· One-click save: store all tabs of the current window as a session. Shortcuts: Ctrl+Shift+S opens the manager, Alt+Shift+S saves all tabs, Alt+S saves the current tab
· Right-click menu: save the current tab — or all other tabs — without opening the manager
· Session tools: rename, add notes, favorite, lock against accidental deletion
· Fast restore: reopen the whole session in a new window without disturbing the current one; click a single tab to jump straight back into work — it is then removed from the session
· Search: find sessions by name, notes, tab title or URL, filter by domain, and sort by domain and more
· Deletion protection: you confirm before anything is deleted (deleting all sessions always asks and shows the count), and a deleted session is permanently removed — there is no recycle bin and no undo
· One-click cleanup: remove duplicate tabs and empty sessions
· Import/export: OneTab text format, plus JSON backup
· Cloud sync: sign in and your sessions sync automatically, so you can pick up your work on any device or browser

Privacy: session data stays in your browser by default; it is sent to your own cloud account only when you sign in and enable sync. The extension collects no analytics and never uploads your browsing history.

Issues: https://github.com/hibernate-pano/chrome-plugin-one-tab/issues

**Category** [REQUIRED]

Productivity

**Single Purpose** [REQUIRED]

把当前浏览器窗口的标签页保存为命名会话，并可随时恢复或跨设备同步。

**Primary Language** [REQUIRED]

中文（简体）

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | icons/icon128.png |
| Screenshot 1 [REQUIRED] | 1280×800 | ✅ Ready | store-assets/screenshot-1-main.png（主界面：多会话 + 备注/收藏/锁定） |
| Screenshot 2 [RECOMMENDED] | 1280×800 | ✅ Ready | store-assets/screenshot-2-search.png（搜索命中高亮） |
| Small Promo Tile [RECOMMENDED] | 440×280 | ⬜ Not created | |

### Screenshot Notes
<!-- 建议截图内容：1) 双列布局下有多个已保存会话的主界面；2) 搜索过滤效果；
     3) 行内重命名/备注编辑态。展示使用中的界面，而非仅弹窗空壳。
     注：1.22.3 起不再有「拖拽排序/整理视图」，勿再为其截图。 -->
<!-- 1/2 已由 scripts/make-store-screenshots.mjs 生成（演示数据注入 dist 扩展后实拍，1280×800）。
     重新生成：pnpm build && node scripts/make-store-screenshots.mjs -->

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `tabs` | permissions | 读取当前窗口的标签页标题与网址，用于把标签页保存为会话；恢复会话时按保存的网址重新打开标签页。扩展功能的核心依赖。 |
| `storage` | permissions | 在本地保存用户的会话数据、设置与登录状态，保证离线可用。 |
| `unlimitedStorage` | permissions | 重度用户可能保存数百个会话、每个含几十个标签页，默认存储配额可能不足；解除本地存储上限。 |
| `notifications` | permissions | 保存成功/失败时给予确认（如"已将 N 个标签页保存为新会话"、"当前窗口没有可保存的标签页"），避免静默操作。 |
| `contextMenus` | permissions | 提供右键菜单项"保存当前标签页 / 保存其他标签页"，让用户不打开管理页也能保存。 |
| `alarms` | permissions | 定期（约每分钟）检查云端是否有其他设备保存的新会话并合并到本地；以及保存后延迟上传，保证多设备同步。 |
| `https://*.supabase.co/*` | host_permissions | 仅当用户登录 TapStack 云端账户时，用于登录鉴权与会话数据的跨设备同步。不访问其他任何网站。 |

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** Yes（仅登录同步场景；未登录时所有数据只留在本地）

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|-----------|------------------------|---------|---------------------------|
| Personally identifiable info | No | No | — | No |
| Health info | No | No | — | No |
| Financial info | No | No | — | No |
| Authentication info | Yes（登录邮箱/会话令牌） | Yes（仅传输到用户自己的云端账户） | 登录鉴权；标识数据归属 | No |
| Personal communications | No | No | — | No |
| Location | No | No | — | No |
| Web history | No（仅保存用户主动保存的标签页，不上传浏览历史） | — | — | — |
| User activity | 仅本地记录（产品事件仅存本地，不上传） | No | 改进功能参考 | No |
| Website content | Yes（用户主动保存的标签页网址与标题） | Yes（仅同步到用户自己的云端账户） | 跨设备恢复会话 | No |

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Privacy Policy

**Privacy Policy URL** [REQUIRED]

https://tapstack-two.vercel.app/privacy.html

<!-- 隐私政策页面源码：src/web/public/privacy.html（最后更新 2026-09-29）。
     2026-10-02 与线上商店页核对：商店 Privacy 区展示的就是该 URL。 -->

## Distribution

**Visibility**: Public（2026-10-02 线上商店页可公开访问，已核实）
**Regions**: All regions ⚠️ 需确认（商店页不直接展示区域配置，需后台核对）

## Developer Info

**Publisher Name** [REQUIRED]

Jasper Pan

<!-- 2026-10-02 线上商店页「Offered by」实测值。 -->

**Contact Email** [REQUIRED]

panbo362472407@gmail.com

<!-- 2026-10-02 线上商店页开发者信息区实测值（非 git 署名邮箱）。 -->

**Support URL / Email** [RECOMMENDED]

https://github.com/hibernate-pano/chrome-plugin-one-tab/issues

**Homepage URL** [RECOMMENDED]

https://github.com/hibernate-pano/chrome-plugin-one-tab

## Version History

<!-- 每次提交到商店的版本都要加一条。 -->
<!-- ⚠️ 1.21.1 的发布状态是本表唯一的空洞：它夹在「1.21.0 已上架」与「1.22.0 已提审」之间，
     历史 changelog 写的是回收站功能（该功能已被 1.22.0 废除）。是否真的上传过需向 Chrome
     Web Store 后台核对，核对前不要改写本行状态。 -->

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 1.22.7 | 2026-10-04 | 修复手动上传 / 下载弹窗里两张模式卡片标题栏错位：卡片是按钮元素，浏览器默认把按钮内容垂直居中，内容较高的一侧（带风险提示的覆盖模式）与较矮的一侧（合并模式）顶部对不齐。改为内容一律顶对齐，两个彩色标题栏现在齐平 | 未发布（本次提交审核） |
| 1.22.6 | 2026-10-04 | 修复「清理重复标签」后界面卡住：登记待删除会话时逐条读写整个队列，会话一多就是成千上万次存储往返（实测 2000 条约 9 秒）。改为批量登记，并让确认后立即关闭弹窗、清理在后台进行。清理完成后明确提示清掉了多少个重复标签页与空会话（此前成功后完全无反馈，用户分不清「没反应」与「没有可清理的」）。优化手动上传 / 下载弹窗：两张卡片的「新增 / 更新 / 删除」数字等宽对齐、新增「现有 → 预计（净变化）」一行直观展示数据量变化、配色跟随深浅主题、两个弹窗尺寸统一；修复窗口较矮时弹窗过高、标题与关闭按钮被顶出屏幕无法操作的问题 | 已发布（2026-10-04） |
| 1.22.5 | 2026-10-04 | 修复「清理重复标签」失败并反复报错：删除广播队列很长时（清理大量重复/空会话后）服务端请求 URL 超过网关上限被拒，导致云端删除标记失败、上传整体失败并无限重试。删除广播与上传读回改为分批查询，超长队列不再触发该错误。同时修复拖动标签时整个管理页刷新（每次落盘都把列表打回存储态）——自己发起的写入不再触发自身整页重载，且 30 秒缓存照常失效。登录 / 注册弹窗改为真正的全屏居中浮层，不再渲染在顶部栏内被裁切 | 已发布（2026-10-04） |
| 1.22.4 | 2026-10-03 | 界面新增 Apple、Chrome 原生、Claude 三套主题风格（连同原有共 6 套），每套的浅色/深色各有独立设计；下线「极光」主题，存量用户自动迁移到气质相近的主题。修复登录 / 注册弹窗在窗口较矮时位置过高、内容被裁掉无法完整显示的问题。并入 1.22.3 未发布的三项修复：① 开着管理页时，后台保存或云端合并后列表不刷新 ② 重命名 / 锁定 / 收藏 / 备注写入失败时界面照样显示「已保存」 ③ 同步「覆盖模式」在预览未就绪时即可点击且无确认。移除抢占浏览器快捷键的页内快捷键（Ctrl+S/F/L/D）与从未可用的会话拖拽排序功能 | 已发布（2026-10-03） |
| 1.22.3 | 2026-09-30 | 修复三个用户可见缺陷：① 开着管理页时，后台保存或云端合并后列表不刷新（旧监听器盯的是已废弃的 chrome.storage 键，事件永不触发）② 重命名/锁定/收藏/备注写失败时界面照样显示「已保存」，刷新后丢失；锁定状态不一致会直接导致会话被自动清理误删 ③ 同步「覆盖模式」在预览还没算完时就能点，一次点击清空对面全部会话且无确认——现在预览未就绪时按钮置灰，并需二次确认。移除抢占浏览器快捷键的页内快捷键（Ctrl+S/F/L/D），以及从未可用的会话拖拽排序功能 | 未上架（并入 1.22.4） |
| 1.22.2 | 2026-09-30 | 修复「切换双栏布局时凭空多出空标签组、每切一次就多一张」：本地存储里重复的会话记录（历史读-改-写竞态留下的脏数据）不再渲染成多张卡片；被锁定后又清空所有标签的空会话不再永久显示为空卡片——锁定保护的是会话内容，空壳不再受保护。手动清理按钮与拖拽移出标签的锁定豁免行为不变 | 已提交审核（2026-09-30，publish 返回 PENDING_REVIEW；线上 1.22.1 待过审后自动切换） |
| 1.22.1 | 2026-09-29 | 同步可靠性加固（用户可见的破坏性 bug 修复）：修复「在网页版删除或重命名会话后被扩展端静默撤销并复活」；修复「某台设备同步可能永久卡死、既不能上传也不能下载」；修复「导入备份与后台同步撞车导致导入内容两边一起丢失」；修复「会话部分标签还原失败时被整组截断、其余标签永久消失」；修复「删除广播在上传竞态中蒸发导致已删会话复活」；修复「纯键盘用户在折叠的会话里误删看不见的标签」；网页版补链接消毒（此前不拦截 `javascript:` 链接）；新增「导出诊断信息」（默认脱敏，不含任何网址/标题/会话名）；新增 GitHub Actions 持续集成 | 已提交审核（2026-09-29，publish 返回 OK） |
| 1.22.0 | 2026-09-29 | 简化删除模型：移除回收站与「墓碑」机制，删除即彻底清除（删除前仍有二次确认）；修复删除恢复不完整（标签计数虚高）；跨设备删除广播改由云端标记承载（30 天自动清理），标签增删按会话整组同步 | 已提交审核（2026-09-29） |
| 1.21.1 | 2026-09-26 | 防误删加固：「清空全部会话」现在始终弹出确认并显示会话数量；回收站新增「全部恢复」，误删后可一键找回；界面细节打磨（菜单布局、按钮配色统一） | ⚠️ **未确认**：该版本是否真的发布过，尚未澄清 |
| 1.21.0 | 2026-09-26 | 误删保护升级：删除的会话/标签 7 天内可在回收站恢复，7 天后自动彻底清除；同步引擎结构手术（日志收口、单写者路径拆分），无功能变化 | Published（2026-09-26 当天过审） |
| 1.20.2 | 2026-09-24 | 合并 1.19.3–1.20.2 一次性上架：同步可靠性加固（上传读回校验、软删失败阻断、落盘直写、彻底删除门禁）、点击体验（点开即响应、修复列表项闪现复活、防重复打开、成功操作静默）、增量同步探活（大幅降低流量）、网页版与扩展删除语义统一、RLS 性能优化 | Published |
| 1.19.3 | 2026-09-13 | 同步数据安全修复：云端守卫改严格 `<`（标签删除/网页版写入不再被静默吞掉）、操作印记跨设备可比（换机/重装后可正常保存）、存量迁移接线；网页版登录持久化修复；导入数据现在会自动上云；依赖安全治理 | 未上架（并入 1.20.2） |
| 1.19.2 | 2026-09-12 | 依赖安全治理：vite 4→6 等（GitHub 告警 50→1，high 21→0） | 未上架（仅 git tag） |
| 1.19.1 | 2026-09-12 | 同步层阶段二修复（同 1.19.3 的同步部分） | 未上架（仅 git tag） |
| 1.19.0 | 2026-09-12 | 阶段二：操作印记（OpStamp）全序决胜合并 | 未上架（仅 git tag） |
| 1.18.0 | 2026-09-08 | 同步层阶段一（单写者）：修复保存被同步覆盖、点开标签即时消失、上传延迟 30s→1.5-3s | 未上架（仅 git tag） |
| 1.17.3 | 2026-08-30 | 修复个别云端异常数据导致的加载崩溃（normalize tabs_data） | Published |
| 1.17.2 | 2026-08-26 | 同步稳定性修复 | Published |
| 1.17.1 | 2026-08-26 | hotfix：version 守卫吞掉全部云端软删 | Published |

## Review Notes

### Known Issues / Limitations
- 多设备同步要求登录；未登录用户仅使用本地功能。
- 删除的会话会从本设备彻底移除且无法恢复，因此每次删除前都会弹出确认框；
  为避免其他设备把已删除内容重新同步回来，云端会保留一条轻量的「已删除」标记 30 天后自动清除。
- 多设备同时编辑同一会话时，以最后保存的一方为准（错峰使用不受影响）。
