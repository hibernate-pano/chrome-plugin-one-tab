# Chrome Web Store Listing — TapStack

> Last Updated: 2026-09-24
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
· 会话整理：每个会话可重命名、加备注、收藏、锁定防误删、拖拽排序
· 快速恢复：一键在新窗口打开整组标签，不打乱当前窗口；点开单个标签直接继续工作，它会自动从会话中移除
· 会话搜索：按会话名、备注、标签标题/网址查找，支持按域名过滤，并提供按域名等维度的排序视图
· 误删保护：删除的会话进入回收站，随时可恢复
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
· Session tools: rename, add notes, favorite, lock against accidental deletion, drag to reorder
· Fast restore: reopen the whole session in a new window without disturbing the current one; click a single tab to jump straight back into work — it is then removed from the session
· Search: find sessions by name, notes, tab title or URL, filter by domain, and sort by domain and more
· Deletion protection: deleted sessions go to the recycle bin and can be restored anytime
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
| Screenshot 1 [REQUIRED] | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 2 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Not created | |
| Small Promo Tile [RECOMMENDED] | 440×280 | ⬜ Not created | |

### Screenshot Notes
<!-- 建议截图内容：1) 双列布局下有多个已保存会话的主界面；2) 搜索过滤效果；
     3) 拖拽排序/整理视图；4) 回收站恢复流程。展示使用中的界面，而非仅弹窗空壳。 -->

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

**Privacy Policy URL** [REQUIRED] ⚠️ 需确认

<!-- 隐私政策页面源码：src/web/public/privacy.html（最后更新 2026-02-13）。
     提交前填入该页面实际部署的公网地址。 -->

## Distribution

**Visibility**: Public ⚠️ 需确认
**Regions**: All regions ⚠️ 需确认

## Developer Info

**Publisher Name** [REQUIRED] ⚠️ 需确认（git 提交署名：panbo）

**Contact Email** [REQUIRED] ⚠️ 需确认
<!-- git 署名邮箱 panbo.coding@qq.com，请确认是否作为公开联系邮箱。 -->

**Support URL / Email** [RECOMMENDED]

https://github.com/hibernate-pano/chrome-plugin-one-tab/issues

**Homepage URL** [RECOMMENDED]

https://github.com/hibernate-pano/chrome-plugin-one-tab

## Version History

<!-- 每次提交到商店的版本都要加一条。 -->

| Version | Date | Changes | Status |
|---------|------|---------|--------|
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
- 云端同步删除的会话以「墓碑」形式保留，用于跨设备传播删除意图（跨设备恢复窗口）；
  墓碑的自动压缩清理（含云端确认与龄期判定）尚未实现，属后续版本。
