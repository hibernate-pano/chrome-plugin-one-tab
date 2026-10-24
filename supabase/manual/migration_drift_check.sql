-- Supabase 生产库迁移漂移核对（只读）
--
-- 为什么要这个文件：仓库里的 supabase/migrations/ 没有「已应用台账」，
-- 光看 git 无法回答「生产库到底跑了哪几条」。下面的查询按优先级排序，
-- 每条都写明了「看到什么算正常 / 看到什么算漂移」。
--
-- 用法：Supabase Dashboard → SQL Editor → New query，整段粘进去跑。
-- 全部是 SELECT，不写库、不改数据。

-- ═══════════════════════════════════════════════════════════════
-- Q0【最关键的安全项】RLS 到底开没开？（**策略存在 ≠ 策略生效**）
-- ═══════════════════════════════════════════════════════════════
-- 为什么单列一条（2026-10-24 审计 RLS-DRIFT）：
--   在 PostgreSQL 里，`CREATE POLICY` 只在 `pg_class.relrowsecurity = t`
--   时才参与判定 —— **开关关着时，策略行再多也全是死策略**。
--   20261009120000 之前，仓库只建了 12 条策略、从没 ENABLE ROW LEVEL SECURITY
--   ⇒ anon key（随扩展产物公开，Supabase 设计如此）能 GET 全站浏览历史、
--   能 DELETE 别人的会话。而「只数策略条数」的核对**完全看不出这件事**。
--
-- 正常：7 张表全部 rls_on = t；三张浏览历史表 policy_kinds = 4。
-- 漂移：任何一张 rls_on = f ⇒ 该表的策略全部失效（数据对 anon 敞开）。
-- 漂移：tab_groups / tabs / user_settings 的 policy_kinds < 4
--       ⇒ 20261009120000 的前提不成立，或策略被人删过
--       （此时若 RLS 是开的，产品会因「默认拒绝」而**锁死**）。
--
-- ⚠️ 用 pg_catalog.pg_policy **基表**，不用 pg_policies 视图：
--   视图按当前角色过滤，非 owner 看不见 ⇒ 会静默误判成「没有策略」。
SELECT c.relname AS table_name,
       c.relrowsecurity AS rls_on,
       (SELECT count(*) FROM pg_catalog.pg_policy pol WHERE pol.polrelid = c.oid) AS policy_count,
       (SELECT count(DISTINCT pol.polcmd) FROM pg_catalog.pg_policy pol
         WHERE pol.polrelid = c.oid AND pol.polcmd IN ('r','a','w','d')) AS policy_kinds,
       CASE
         WHEN NOT c.relrowsecurity THEN 'DRIFT: RLS 未启用（策略全是死策略）'
         WHEN c.relname IN ('tab_groups','tabs','user_settings')
              AND (SELECT count(DISTINCT pol.polcmd) FROM pg_catalog.pg_policy pol
                    WHERE pol.polrelid = c.oid AND pol.polcmd IN ('r','a','w','d')) < 4
           THEN 'DRIFT: 策略类数不足 4（RLS 开着时会出现默认拒绝）'
         ELSE 'ok'
       END AS verdict
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relname IN ('tab_groups','tabs','user_settings',
                    'profiles','ai_usage_logs','sync_snapshots','sync_updates')
ORDER BY c.relname;

-- ═══════════════════════════════════════════════════════════════
-- Q1【最关键】线上守卫函数是哪个版本？权限/search_path 钉住了吗？
-- ═══════════════════════════════════════════════════════════════
-- 正常：guard_tab_group_op_stamp = 'TIEBREAK (20260913)'
-- 正常：guard_tab_group_version   = 'VERSION-FALLBACK (20261020)'
-- 漂移：'SEQ-ONLY (20260910)' 或 'LEGACY <= (20260909 BUG)' → 20260913 的
--       同 seq 跨设备决胜没上线，两台设备同 seq 离线编辑会丢标签。
-- 漂移：search_path_cfg = '(mutable search_path)' → 20260826 的加固没上线。
-- 漂移：anon_may_execute = t → 触发器函数对匿名用户开放，属于安全项。
--
-- ⚠️ 为什么必须有 'VERSION-FALLBACK (20261020)' 这一支（2026-10-24 审计
--    RLS-DRIFT）：`guard_tab_group_version` 在 20261020150000 之后有了**新形状**
--    （version 只在「两侧都无印记」时兜底）。在这支之前它落到 ELSE = UNKNOWN，
--    而把该函数**回退成旧版**时输出**逐字节相同** ⇒ 这条查询对它零检测力。
--    判据取「有 last_op_seq IS NULL 门 + 有 version 严格比较」两条同时成立：
--      · 现行版：两者都有 ⇒ 认得出；
--      · 旧版（20260826064109）：只有 version 比较、没有印记门 ⇒ UNKNOWN
--        ⇒ 回退**会被看出来**（这正是原来缺的检测力）。
SELECT p.proname,
       COALESCE(array_to_string(p.proconfig, ','), '(mutable search_path)') AS search_path_cfg,
       p.prosecdef AS security_definer,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_may_execute,
       CASE
         WHEN p.proname NOT LIKE 'guard_tab_group%' THEN 'n/a'
         WHEN p.proname = 'guard_tab_group_version'
              AND pg_get_functiondef(p.oid) LIKE '%last_op_seq IS NULL%'
              AND pg_get_functiondef(p.oid) LIKE '%NEW.version < OLD.version%'
           THEN 'VERSION-FALLBACK (20261020)  <- want this'
         WHEN pg_get_functiondef(p.oid) LIKE '%last_op_device%COLLATE%' THEN 'TIEBREAK (20260913)  <- want this'
         WHEN pg_get_functiondef(p.oid) LIKE '%NEW.last_op_seq <= OLD.last_op_seq%' THEN 'LEGACY <= (20260909 BUG)'
         WHEN pg_get_functiondef(p.oid) LIKE '%NEW.last_op_seq < OLD.last_op_seq%' THEN 'SEQ-ONLY (20260910)'
         ELSE 'UNKNOWN - read prosrc'
       END AS detected_version
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('guard_tab_group_op_stamp', 'guard_tab_group_version', 'handle_new_user')
ORDER BY p.proname;

-- ═══════════════════════════════════════════════════════════════
-- Q2 tab_groups 的列到位了吗？
-- ═══════════════════════════════════════════════════════════════
-- 漂移：没有 deleted_at → 20260926 的墓碑过期没上线，而
--       supabase/manual/tombstone_expiry_cron.sql 会对着不存在的列跑（该 cron 会物理删行）。
-- 漂移：没有 last_op_device / last_op_seq → 20260909 没上线。
SELECT c.column_name, c.data_type, c.is_nullable,
       CASE c.column_name
         WHEN 'is_deleted'     THEN '20260825130248'
         WHEN 'last_op_seq'    THEN '20260909'
         WHEN 'last_op_device' THEN '20260909'
         WHEN 'version'        THEN '20260827_add_tab_group_version_guard'
         WHEN 'deleted_at'     THEN '20260926090000_tombstone_expiry'
       END AS introduced_by
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND c.table_name = 'tab_groups'
  AND c.column_name IN ('id','user_id','name','is_deleted','deleted_at','version',
                        'tabs_data','last_op_device','last_op_seq')
ORDER BY c.column_name;

-- ═══════════════════════════════════════════════════════════════
-- Q3 触发器真的挂着吗？
-- ═══════════════════════════════════════════════════════════════
-- 漂移：少 tab_group_version_guard → 20260827 没上线，历史版本号还在偷偷覆盖新数据。
-- 漂移：少 tab_group_op_stamp_guard → 20260909 没上线，印记根本不记。
SELECT t.trigger_name, t.action_timing, t.event_manipulation, t.action_statement
FROM information_schema.triggers t
WHERE t.event_object_schema = 'public'
  AND t.event_object_table = 'tab_groups'
ORDER BY t.trigger_name;

-- ═══════════════════════════════════════════════════════════════
-- Q4 pnpm supabase:migrate 全量重放会不会中途挂掉？
-- ═══════════════════════════════════════════════════════════════
-- ⚠️ 历史缺陷，已修：原 20260923160000_fix_rls_initplan.sql 是裸 DROP POLICY
-- （没有 IF EXISTS），第二次重放必然报错 → 迁移循环 process.exit(1) → 排在它
-- 后面的 20260924 / 20260926 永远不会执行，verify() 也不会跑，没有报错信号。
-- 该文件现已把 4 条 DDL 全部包进带存在性守卫的 DO 块，重放安全。
-- 所以本查询的 CASE 字符串（下面 SELECT 内）已经过时、不要再照字面读：
-- 这里查到该 policy 现在只意味着「策略还没被删掉」，不再意味着「重放会挂」。
-- 仍有用的是：查到它 = 20260923160000 还没在生产库跑过（跑过就会删掉它）。
-- 重放安全性要验的话，用临时库跑两遍该文件，而不是看这条查询。
SELECT tablename, policyname, cmd, roles::text,
       CASE WHEN policyname = 'Users can view own profile'
            THEN 'EXISTS -> 20260923160000 已应用过，全量重放会挂（见文件头注释）'
            ELSE 'present' END AS note
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'profiles'
ORDER BY policyname;

-- ═══════════════════════════════════════════════════════════════
-- Q5 Y 影子表在不在？
-- ═══════════════════════════════════════════════════════════════
-- 漂移：只有 tab_groups → 20260924090000_y_sync_tables 没上线，
--       但代码已经在往 sync_updates / sync_snapshots 写，写不进去。
SELECT t.table_name,
       (SELECT string_agg(c.column_name, ', ' ORDER BY c.column_name)
          FROM information_schema.columns c
         WHERE c.table_schema = 'public' AND c.table_name = t.table_name) AS columns
FROM information_schema.tables t
WHERE t.table_schema = 'public'
  AND t.table_type = 'BASE TABLE'
  AND t.table_name IN ('tab_groups', 'sync_updates', 'sync_snapshots')
ORDER BY t.table_name;

-- ═══════════════════════════════════════════════════════════════
-- Q6 现有数据里有没有会卡住的行？
-- ═══════════════════════════════════════════════════════════════
-- seq_set_device_null__WOULD_BE_REJECTED > 0 的话，将来若上线任何「设备名为空即拒绝」
--   的守卫，这些行会直接更新不动。源码上应该恒为 0（yTranslate.ts 原子写两个字段），
--   但没对过真实数据，所以要跑。
SELECT
  count(*) FILTER (WHERE last_op_seq IS NOT NULL AND last_op_device IS NULL) AS seq_set_device_null,
  count(*) FILTER (WHERE last_op_seq IS NULL     AND last_op_device IS NOT NULL) AS device_set_seq_null,
  count(*) FILTER (WHERE last_op_seq IS NOT NULL) AS rows_with_any_stamp,
  count(*) AS total_rows
FROM public.tab_groups;

-- ═══════════════════════════════════════════════════════════════
-- Q7 你有没有权限改这些函数？（只是确认，不是漂移）
-- ═══════════════════════════════════════════════════════════════
-- owner ≠ SQL Editor 当前角色 → 后续任何 ALTER FUNCTION 都得换角色跑。
SELECT p.proname, pg_get_userbyid(p.proowner) AS owner,
       pg_has_role(current_user, p.proowner, 'USAGE') AS current_role_can_alter
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('guard_tab_group_op_stamp', 'guard_tab_group_version', 'handle_new_user')
ORDER BY p.proname;

-- ═══════════════════════════════════════════════════════════════
-- 附：Q1 之外，Supabase Dashboard → Advisors → Security 面板
--     会直接列出 search_path 可变 / 函数权限过宽的问题，
--     可以交叉验证 Q1 的结论。20260923160000 就是照着 advisor 写的。
-- ═══════════════════════════════════════════════════════════════
