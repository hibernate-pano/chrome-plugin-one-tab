-- 迁移 20261009120000：启用三张浏览历史表的 RLS（P0 收口）
--
-- 【问题】`tab_groups` / `tabs` / `user_settings` **从未在任何迁移里被
-- `ENABLE ROW LEVEL SECURITY`**。策略一直在建（12 条：3 张表 × SELECT/INSERT/
-- UPDATE/DELETE），但 PostgreSQL 的 RLS 策略**只在 `relrowsecurity = t` 时参与
-- 判定** —— 策略行存在 ≠ 策略生效。于是它们全是死策略。
--
-- 后果：anon key 随扩展产物公开（Supabase 设计如此），任何人
--   GET /rest/v1/tabs?select=*   就能拉走全站浏览历史（url / title / favicon 明文）
--   DELETE from tab_groups       能删掉别人的会话
--
-- 2026-10-09 真库实测：24 条迁移按字典序全量重放后
--   pg_class.relrowsecurity → tab_groups=f tabs=f user_settings=f
--   而 profiles=t ai_usage_logs=t sync_snapshots=t sync_updates=t
--   匿名身份 `select from tab_groups` 读到全站行；`delete` 返回 DELETE 1。
--
-- 【为什么是「激活」不是「新建」】三张表各自已有 4 条正确的
-- `auth.uid() = user_id`（tabs 走 group_id 关联）策略，本文件只是把开关打开。
-- 已逐条核对：tab_groups/tabs/user_settings 的 SELECT/INSERT/UPDATE/DELETE
-- 各 1 条、共 12 条，全部存在（见下方 policy_count 断言）。
--
-- 【最危险的失败模式：RLS 开了但没策略】若表存在而策略缺失，启用后是
-- **默认拒绝** —— authenticated 读不到自己的一行，产品当场锁死，比漏洞更严重。
-- 因此本文件对每张表：表存在 ⇒ 必须先确认 4 类策略齐备，缺任何一条
-- RAISE EXCEPTION 中止迁移 —— 绝不启用一个会锁死产品的 RLS。
-- （「宁可迁移红，也不能悄悄留一个会静默锁库或静默漏数据的状态」。）
--
-- 【幂等】relrowsecurity 已是 t 时跳过；策略用 pg_catalog.pg_policy **基表**查
-- （视图 pg_policies 按角色过滤，非 owner 看不见会静默误判）。
--
-- 【可回滚】`ALTER TABLE ... DISABLE ROW LEVEL SECURITY`（不建议）。
--
-- 【只证明代码侧】本文件加入仓库 ≠ 生产库已执行。项目无迁移 ledger，
-- 线上真实状态必须用 supabase/manual/migration_drift_check.sql 或下方 Q1 到
-- Dashboard 复核 —— 这一点由 scripts/supabase-migrate.mjs 的 verify() 强制提醒。

-- dollar-quote 分隔符：提到它的说明文字一律独占整行。
-- 迁移器按 dollar-quote 成对切分语句；本文件（含注释）绝不能出现定界符字面量。
DO $$
DECLARE
  tbl text;
  policy_count int;
  rls_on boolean;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['tab_groups', 'tabs', 'user_settings'] LOOP
    -- 1) 表不存在 → 跳过（Dashboard schema 可能已变化，本迁移不该因此失败）
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = tbl
    ) THEN
      RAISE NOTICE 'public.% 不存在，跳过 RLS 启用（Dashboard schema 可能已变化）', tbl;
      CONTINUE;
    END IF;

    -- 2) 已启用 → 跳过（幂等；两遍重放必须给出相同终态）
    SELECT c.relrowsecurity INTO rls_on
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = tbl;

    IF rls_on THEN
      RAISE NOTICE 'public.% 已启用 RLS，跳过', tbl;
      CONTINUE;
    END IF;

    -- 3) 启用前必须确认 4 类策略齐备 —— 缺一条就是「默认拒绝」，产品会锁死。
    SELECT count(DISTINCT pol.polcmd) INTO policy_count
    FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = tbl
      AND pol.polcmd IN ('r', 'a', 'w', 'd');   -- select / insert / update / delete

    IF policy_count < 4 THEN
      RAISE EXCEPTION
        'public.% 只有 % 类策略（需要 SELECT/INSERT/UPDATE/DELETE 共 4 类）。'
        '拒绝启用 RLS —— 无策略时启用会走默认拒绝，authenticated 将读不到自己'
        '的数据（产品锁死）。先补 20251014063156（tab_groups/user_settings）'
        '与 20260326034522（tabs），再重跑本迁移。', tbl, policy_count;
    END IF;

    -- 4) 策略齐备，安全启用
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    RAISE NOTICE 'public.% 已启用 RLS（% 类策略齐备）', tbl, policy_count;
  END LOOP;
END $$;

-- ── 终态自检：三张表必须全部 relrowsecurity = t ──────────────────────────
-- 放在同一文件末尾，让「迁移成功」与「开关真的打开」是同一次执行的两个断言，
-- 而不是靠下游另一次查询去补。任何一张仍为 f 即 RAISE（迁移判红）。
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO bad
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND c.relname IN ('tab_groups', 'tabs', 'user_settings')
    AND NOT c.relrowsecurity;

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'RLS 仍未启用: %', bad;
  END IF;
END $$;
