# TapStack 安全与合规审查

## 对话出发点（用户原始需求和动机）

用户（Jasper）要求以「安全与合规专家」身份，对 TapStack（Chrome MV3 扩展，收集浏览器
浏览历史，信任是其命脉）做一次**只读**安全审查，覆盖 8 个维度：
RLS 策略与越权面、SECURITY DEFINER 函数与默认 ACL、manifest 权限面、
web_accessible_resources、CSP、凭证泄露、出网面、隐私承诺可执行性。

动机：用户的核心约束是「不要从代码推断生产库状态」。项目没有迁移 ledger，
历史已发生过一次治理事故（profiles 表带 `USING (true)` 全放行策略上线，
anon key 可拉走全站 email / stripe_customer_id / subscription_status 并能 PATCH 提权，
止血是绕过迁移链直接在库里跑的）。因此每条数据库结论必须区分
「代码侧已收口」与「线上真实状态需 Dashboard 复核」。

硬约束：
- 只读审查，不修改产品代码，不跑带 `--write` 的探针，不执行迁移。
- 任何「grep 零命中 ⇒ 不存在」的结论必须用第二种方式（Read / python）复核。
- 检查 git 历史泄露时不得打印完整密钥。
- 不得把「我推测有风险」写成「已确认的缺陷」。

## 执行过程（做了什么、怎么做的）

1. **必读前置**：完整读取 `.codex/agents/_shared.md`（204 行），重点消化第七节
   发布纪律与第八节 Supabase 迁移陷阱（无 ledger、dollar-quote 地雷、
   必须查 `pg_catalog.pg_policy` 基表而非 `pg_policies` 视图）。

2. **迁移逐条审查**：`cat -n` 读完 `supabase/migrations/` 全部 24 个文件
   （输出过长被截断后，改为分批单文件读取，确保无遗漏）。
   统计 `ENABLE ROW LEVEL SECURITY`、`CREATE/ALTER POLICY`、`GRANT/REVOKE` 出现位置。

3. **真库复现（本地 PostgreSQL 16.15，只读性质的产品库验证）**：
   - `initdb` 起临时集群 `/tmp/pgsec2`（trust 认证、专用 socket、127.0.0.1:55433）。
   - 构造 Supabase 形状的 baseline：`anon`/`authenticated`/`service_role` 角色、
     `auth` schema + `auth.uid()` + `auth.users`、以及**先于仓库迁移存在**的
     `tab_groups` / `tabs` / `user_settings` 三张 Dashboard 表
     （它们不由本仓任何 migration 创建）。
   - 按文件名字典序全量重放 24 条迁移：**第一遍 0 失败**，
     **第二遍 0 失败**（幂等性成立）。
   - 查 `pg_class.relrowsecurity` / `pg_policies` / `pg_proc.proacl`。
   - 以 `set role anon` / `set role authenticated` + `request.jwt.claim.sub` 实测读写。
   - 验证完 `pg_ctl stop -m fast` 清理后台进程。

4. **跑项目自己的门禁**：
   `env -u NODE_OPTIONS node --test ... tests/guards/migrationReplay.pg.test.ts`
   → 11 pass / 0 fail / 0 skipped。随后反向追问「它到底断言了什么」。

5. **扩展侧静态审查**：manifest CSP/permissions/host_permissions/WAR、
   凭证文件与 `.gitignore`、`git log --all` 历史路径扫描、
   src 硬编码 JWT、出网 host 枚举（python 直读文件，非 grep 单一方法）。

6. **线上只读探针**：`node scripts/anon-rls-probe.mjs`（**不加 --write**）。

7. **隐私承诺逐条对照**：`src/legal/privacy.html`（正文抽出）、
   `CHROMEWEBSTORE.md` 商店文案、`README.md`、30 天清理实现链路、
   `privacy@tapstack.app` 的 DNS MX（走权威 NS，并用 google.com 做阳性对照）。

## 遇到的问题（报错、阻塞、意外行为）

1. **首批迁移重放批量报错**：我最初只建了空 `auth` schema，缺 `auth.uid()`
   与 `auth.users`，导致 11 条迁移失败（`function auth.uid() does not exist` /
   `relation "auth.users" does not exist`）。这是**我的测试夹具缺陷，不是产品缺陷**。
   补上 Supabase 形状的 auth shim 后全量重放 0 失败。

2. **`pre.sql` 因 role 已存在被 `ON_ERROR_STOP` 中断**，后续建表语句没执行，
   又造成一轮 `relation does not exist`。拆分 role 创建与建表后修复。

3. **profiles 外键种子失败**：`profiles.id REFERENCES auth.users(id)`，
   我没先插 `auth.users` 导致 `violates foreign key constraint`。补插后验证成功。

4. **表级 GRANT 影响隔离**：为验证列级提权，我先加了 Supabase 的
   `alter default privileges ... grant all on tables`，这同时把
   `profiles` 的表权限给了 anon，造成一次 `permission denied` 反复横跳。
   重新分层隔离后才得到可信结果。

5. **`write_stdin` 工具参数类型报错**：多次把 `max_output_tokens` / `yield_time_ms`
   传成浮点数，连续 6 次 `invalid type: floating point`。改为用独立
   `exec_command` 跑有界查询解决。

6. **生产探针 0 行产生歧义**：`anon-rls-probe.mjs` 只读模式对 4 张表全部
   返回 `200 → 0 行`，脚本自己的注释明确写着「0 行分不清表空与 RLS 全挡」。
   我尝试用 `HEAD + Prefer: count=exact` 区分，发现同样无法区分
   （匿名身份 RLS 过滤后 count 就是 0）。**承认这是环境限制，不强行下结论。**

7. **曾误判 `handle_new_user` 回退成 SECURITY INVOKER**：单独重放
   `20260525151413_fix_security_definer_function.sql` 后看到 `secdef=f`，
   差点写成缺陷。核对字典序发现
   `20260826_fix_handle_new_user_security_definer.sql` 排在它**之后**并改回
   SECURITY DEFINER，全链重放终态为 `secdef=t, search_path=public,
   anon_x=f`。**撤回该判断**，记入误判记录。

8. **一个成功的阳性质控**：DNS 查询 `tapstack.app` 的 A 记录返回
   `198.18.0.161`（RFC 2544 基准测试保留段），说明本机代理劫持了 DNS。
   为避免把代理假象当成「域名没解析」，改查权威 NS 并用
   `dig @8.8.8.8 MX google.com`（返回 `10 smtp.google.com.`）做对照，
   确认 resolver 可用后再判定 `tapstack.app` 无 MX。

## 最终结果（成功 / 部分完成 + 具体产出）

**成功（只读，未修改产品代码、未跑 --write、未执行迁移、未写生产库）。**

核心产出：

- **P0 ×1**：`tab_groups` / `tabs` / `user_settings` 三张存浏览历史的表，
  迁移链全量重放后 `relrowsecurity = f` —— 策略存在但不生效。
  本地真库实测 anon 可读全站会话、可删他人数据。
  生产状态**不可从代码证明**（脚本注释称历史 --write 实测 42501，即生产已开）。
  真正的 P0 是**可证明性缺失**：`verify()` 只查 `profiles`，
  `migration_drift_check.sql` 也不查这三张表，门禁全部绿灯。
- **P1 ×3**：删除请求邮箱无 MX（承诺不可执行）、商店文案「从不上传浏览历史」
  自相矛盾、登录用户自助提权 profiles 列级（本地确证，生产可能已由
  应急脚本收口但未验证）。
- **P2 ×3**：README「30 天自动清理」对沉睡账号不成立、
  `body_tombstone_expiry_days()` search_path 可变、`unlimitedStorage` 无代码依据。

**实测门禁表**（本机真实执行，非引用文档）：
| 项目 | 命令 | 结果 |
|---|---|---|
| 迁移全量重放 | 24 文件按字典序逐个 `psql -v ON_ERROR_STOP=1` | 第一遍 0 失败 |
| 幂等性 | 第二遍重放 | 0 失败 |
| 项目 PG 门禁 | `env -u NODE_OPTIONS node --test tests/guards/migrationReplay.pg.test.ts` | 11 pass / 0 fail / 0 skipped |
| 匿名读会话 | `set role anon; select ... from tab_groups/tabs` | 返回全站行（本地复现库） |
| 列级提权 | `set role authenticated` 后 `UPDATE profiles SET plan='pro',...` | UPDATE 1，提权成功 |
| 函数 ACL | `has_function_privilege('anon',..., 'EXECUTE')` | 5/5 = false |
| git 历史凭证 | `git rev-list --all \| wc -l`；`git log --all -- .codex` | 636 commits；触碰 .codex 的 0 |
| 商店隐私页 | `curl -L https://tapstack-two.vercel.app/privacy.html` | HTTP 200，内容与 `src/legal/privacy.html` 一致 |
| 联系邮箱 MX | 权威 NS 查询 + google.com 阳性对照 | `tapstack.app` 无 MX；对照正常 |

**肯定的做得好的地方**：
- 全链 24 条迁移真库两遍重放 0 失败，幂等纪律真实成立。
- 守卫查询一律用 `pg_catalog.pg_policy` 基表，避开 `pg_policies` 角色过滤陷阱。
- SECURITY DEFINER 函数 5/5 对 anon 拒绝 EXECUTE，`purge` 函数真 DELETE 已收回权限。
- 加密失败会 `throw` 中止上传（fail-closed），不会明文上云。
- 无 analytics、无第三方 SDK，出网面只有 Supabase + 一个 GitHub issue 链接。
- `web_accessible_resources` 完全未声明，零暴露面。
- git 历史 636 个 commit 中 `.codex/`、`.env`、`.env.local` 全部从未入库。
- README 对 E2EE 的披露诚实（明说「不是端到端加密、密钥由账户 ID 派生」）。
- `privacy.html` 对 30 天清理的「沉睡账号会推迟」披露诚实。
