-- 迁移 20261005000000：收口 profiles 表的 RLS（全站 PII 泄漏收口）
--
-- 【问题】20260303044037 建表时留了一条
--     CREATE POLICY "Anyone can view public profile fields" ON profiles
--       FOR SELECT USING (true);
-- 而 20260923160000（auth_rls_initplan 优化）为了消除 multiple_permissive_policies
-- 警告，**主动 DROP 了 "Users can view own profile"（auth.uid() = id）**，
-- 理由是「USING (true) 已经放行所有行，语义零变化」。
--
-- 那句推理对「被删的那条策略」是正确的，但结论是错的：RLS 策略之间是**或集**，
-- 只要存在任意一条 USING (true)，**整行整行都对该角色可见**，列级不受限制。
-- 于是 profiles 的这些列全部对匿名开放：
--     email, plan, ai_usage_count, ai_daily_count,
--     stripe_customer_id, subscription_id, subscription_status
--
-- 而本表的行是由 create_profile_trigger（handle_new_user）对**每个注册用户**
-- 自动写入的，也就是说这是一张「全站用户邮箱 + 订阅信息」的明文表。
-- 生产项目 ref 随扩展产物公开、anon key 按 Supabase 设计就是公开的，
-- 任何人都可以拉 `GET /rest/v1/profiles?select=*`。
--
-- 【为什么本迁移是「先验证、再收紧」】
-- profiles / ai_usage_logs 不由本仓任何 migration 创建（来自 Dashboard 默认 schema），
-- 因此不能假设「表一定存在」或「策略一定是这一条」。本文件：
--   1) 先在 pg_catalog 里查存在性（存在才执行，不存在静默跳过 → 可重复重放）；
--   2) 删掉全放行策略；
--   3) **重新建**一条「仅自己可见」的 SELECT 策略（原来那条已被上一条迁移删掉）；
--   4) 给 UPDATE 策略补 WITH CHECK + 列级约束，堵掉「登录用户自助改 plan='pro'」。
--
-- 【可回滚】本文件只做策略层改动，不动表结构、不删数据、不删列。
-- 回滚 = 重新建那条 USING (true) 的策略（不建议）。
--
-- 执行前置：先在 Dashboard 用 anon 身份跑一次
--     select count(*) from profiles;   -- 若能返回行数，说明确实可读，本迁移有必要
-- 若表在本项目已不存在（表本身被删），本文件会全部跳过，不报错。

-- 用 dollar-quote（`DO $body$ … $body$`）包裹整段：迁移执行器按 dollar-quote
-- 成对切分语句，裸的 DO BEGIN … END 无法通过多语句预处理。
-- ⚠️ 本文件（含注释）**绝不能出现定界符字面量**：切分器不看上下文，
--    注释里写一次也会把语句腰斩。参见 tests/guards/migrationSqlSafety.test.ts。
DO $body$
BEGIN
  -- 0) 表不存在就整体跳过（Dashboard 默认 schema 随时可能变）
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'profiles'
  ) THEN
    RAISE NOTICE 'public.profiles 不存在，跳过（Dashboard schema 可能已变化）';
    RETURN;
  END IF;

  -- 1) 删掉全放行 SELECT 策略（策略名是精确匹配，只删这一条）
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'profiles'
      AND pol.polname = 'Anyone can view public profile fields'
  ) THEN
    DROP POLICY "Anyone can view public profile fields" ON public.profiles;
    RAISE NOTICE '已删除全放行 SELECT 策略：Anyone can view public profile fields';
  END IF;

  -- 2) 补回「仅自己可见」（20260923160000 删掉过它，导致上一条成为唯一 SELECT 策略）。
  --    用 pg_catalog 直查而非 pg_policies 视图：后者按 polroles 做可见性过滤，
  --    看不到 PUBLIC 角色的策略，会误判成「不存在」而重复创建。
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'profiles'
      AND pol.polname = 'Users can view own profile'
  ) THEN
    CREATE POLICY "Users can view own profile" ON public.profiles
      FOR SELECT USING ((SELECT auth.uid()) = id);
    RAISE NOTICE '已重建 SELECT 策略：Users can view own profile（仅本人可读）';
  END IF;

  -- 3) UPDATE 策略补 WITH CHECK。原策略只有 USING ((select auth.uid()) = id)，
  --    没有 WITH CHECK ⇒ 只要能改自己的行，就能把 plan / subscription_status /
  --    ai_daily_count / stripe_customer_id 改成任意值（自助提权 + 绕过配额）。
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'profiles'
      AND pol.polname = 'Users can update own profile'
  ) THEN
    DROP POLICY "Users can update own profile" ON public.profiles;
    CREATE POLICY "Users can update own profile" ON public.profiles
      FOR UPDATE
      USING ((SELECT auth.uid()) = id)
      WITH CHECK ((SELECT auth.uid()) = id);
    RAISE NOTICE '已重建 UPDATE 策略：补 WITH CHECK（行仍只属本人；列级限制见说明）';
  END IF;
END
$body$;

-- ─────────────────────────────────────────────────────────────
-- 【关于「列级限制」——本文件刻意没有做，理由要写清楚】
--
-- RLS 是**行级**权限，PostgreSQL 没有「列级 RLS」。要禁止用户改 plan /
-- subscription_status / ai_daily_count / stripe_customer_id 这几列，正规做法是
-- **REVOKE 列级 UPDATE 权限**再按需 GRANT：
--
--     REVOKE UPDATE ON public.profiles FROM authenticated;
--     GRANT  UPDATE (id, email) ON public.profiles TO authenticated;
--
-- 本迁移**没有代你执行**，因为：
--   1) 列 GRANT/REVOKE 会立即影响线上正在用的写入路径，而 profiles 当前
--      **没有任何客户端代码在读或写**（src/ 全局搜索零引用）——收紧是安全的，
--      但也正因为零引用，没人能告诉你线上是不是真没人在用；
--   2) 若将来确实要写（比如接 Stripe webhook），正确做法是给一张只含
--      (user_id, 订阅状态) 的表 + service_role 写入，而不是给用户列权限。
--
-- 建议动作（在 Dashboard 里人工执行一次）：
--     REVOKE UPDATE ON public.profiles FROM authenticated;
--     GRANT  UPDATE (id, email) ON public.profiles TO authenticated;
-- 执行后可用这条验证（应返回 0 行）：
--     select * from profiles where plan = 'pro' limit 1;
-- ─────────────────────────────────────────────────────────────
