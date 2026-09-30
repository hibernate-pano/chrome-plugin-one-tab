-- Fix Supabase performance lints (auth_rls_initplan + multiple_permissive_policies).
--
-- 1) auth.uid() 在 RLS USING/WITH CHECK 里会被逐行重算，包一层 select 让它每条
--    查询只算一次。tab_groups / tabs / user_settings 的策略已经是这种写法，
--    这里补上 profiles 和 ai_usage_logs 的 3 个策略。
-- 2) "Users can view own profile" 是死策略："Anyone can view public profile
--    fields" 的 USING (true) 已经放行所有行，删掉它消除
--    multiple_permissive_policies WARN，语义零变化。
--
-- ─────────────────────────────────────────────────────────────
-- 幂等性（本版本新增）
--
-- 旧版本是 3 条裸 ALTER POLICY + 1 条裸 DROP POLICY，整段没有任何存在性守卫：
--   * DROP POLICY 在第二次重放时必然抛 42704 undefined_object（策略上一轮已经
--     被自己删掉了）。supabase-migrate.mjs 的循环在文件出错时
--     process.exit(1)，于是排在它后面的 20260924090000 / 20260926090000
--     永远不执行，verify() 也不会跑 —— 没有报错信号的重放中断。
--   * 三条 ALTER POLICY 在「策略已被别处改名/删除」时抛 42704，在表不存在
--     （profiles / ai_usage_logs 不由本仓任何 migration 创建，来自 Dashboard
--     默认 schema）时抛 42P01。
--
-- 现在四条 DDL 全部先在 pg_catalog 里查存在性（pg_policy 直查，不过
-- pg_policies 视图的 polroles 可见性过滤），存在才执行：
--   * 存在 → 执行，结果与旧版本逐字等价（ALTER 整体替换 USING/WITH CHECK；
--     DROP 只在策略还在时删，正好就是旧版本「第一次跑」的情形）。
--   * 不存在 → 静默跳过。旧版本在这种情况下是「整文件报错回滚」，终态同样
--     什么都没改；跳过不改变终态，只是把硬失败换成 no-op。
-- 因此无论第几次执行，本文件的终态收敛到同一结果。
-- ─────────────────────────────────────────────────────────────

-- 用 $$ 而非 $tag$：scripts/supabase-migrate.mjs 的 --dry-run 预览切分器只认 $$
-- （注释必须独占整行：写在 `DO $$` 同行会落进 dollar-quoted 字符串内部，
--  而本注释里含第二个 $$，会让字符串提前闭合 → 42601 语法错，首跑即失败。）
DO $$
BEGIN
  -- 1) profiles / update：把 auth.uid() 包进 (select ...)，消掉 auth_rls_initplan
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'profiles'
      AND pol.polname = 'Users can update own profile'
  ) THEN
    ALTER POLICY "Users can update own profile" ON public.profiles
      USING ((select auth.uid()) = id);
  END IF;

  -- 2) ai_usage_logs / select：同上
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'ai_usage_logs'
      AND pol.polname = 'Users can view own AI usage'
  ) THEN
    ALTER POLICY "Users can view own AI usage" ON public.ai_usage_logs
      USING ((select auth.uid()) = user_id);
  END IF;

  -- 3) ai_usage_logs / insert：同上
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'ai_usage_logs'
      AND pol.polname = 'Users can insert own AI usage'
  ) THEN
    ALTER POLICY "Users can insert own AI usage" ON public.ai_usage_logs
      WITH CHECK ((select auth.uid()) = user_id);
  END IF;

  -- 4) 删死策略。重放时它已经不在了 → 守卫让它变成 no-op（这是本文件唯一的
  --    重放硬失败点，Q4 记的就是这一句）。
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'profiles'
      AND pol.polname = 'Users can view own profile'
  ) THEN
    DROP POLICY "Users can view own profile" ON public.profiles;
  END IF;
END
$$;
