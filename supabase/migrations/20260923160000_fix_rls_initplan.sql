-- Fix Supabase performance lints (auth_rls_initplan + multiple_permissive_policies).
--
-- 1) auth.uid() 在 RLS USING/WITH CHECK 里会被逐行重算，包一层 select 让它每条
--    查询只算一次。tab_groups / tabs / user_settings 的策略已经是这种写法，
--    这里补上 profiles 和 ai_usage_logs 的 3 个策略。
-- 2) "Users can view own profile" 是死策略："Anyone can view public profile
--    fields" 的 USING (true) 已经放行所有行，删掉它消除
--    multiple_permissive_policies WARN，语义零变化。

ALTER POLICY "Users can update own profile" ON public.profiles
  USING ((select auth.uid()) = id);

ALTER POLICY "Users can view own AI usage" ON public.ai_usage_logs
  USING ((select auth.uid()) = user_id);

ALTER POLICY "Users can insert own AI usage" ON public.ai_usage_logs
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY "Users can view own profile" ON public.profiles;
