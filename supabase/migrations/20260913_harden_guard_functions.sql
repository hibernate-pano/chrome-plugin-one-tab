-- ─────────────────────────────────────────────────────────────
-- TapStack: 收敛数据库函数权限与 search_path
--
-- Supabase 安全顾问指出：
-- - guard_tab_group_version / guard_tab_group_op_stamp 的 search_path 可变
-- - public.handle_new_user 作为 SECURITY DEFINER 函数可被 anon/authenticated
--   通过 PostgREST RPC 调用
--
-- 本迁移不改变业务行为：
-- - 两个 trigger function 固定 search_path，避免对象解析被调用方环境影响
-- - 仅 PostgreSQL trigger 需要执行这些函数，撤销客户端角色的 EXECUTE
-- - handle_new_user 仍由 auth.users 的注册触发器自动执行，但不允许直接 RPC 调用
-- ─────────────────────────────────────────────────────────────

ALTER FUNCTION public.guard_tab_group_version()
  SET search_path = public;

ALTER FUNCTION public.guard_tab_group_op_stamp()
  SET search_path = public;

REVOKE EXECUTE ON FUNCTION public.guard_tab_group_version()
  FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.guard_tab_group_op_stamp()
  FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.handle_new_user()
  FROM PUBLIC, anon, authenticated;
