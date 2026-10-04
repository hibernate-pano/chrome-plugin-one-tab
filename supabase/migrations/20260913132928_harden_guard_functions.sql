-- 迁移 20260913132928：harden_guard_functions
-- 说明：该迁移早期直接在 Supabase Dashboard 建立，仓库此前缺少对应文件；
-- 现从远端迁移历史（supabase_migrations.schema_migrations.statements）原样还原，
-- 使仓库成为 schema 的完整描述。

-- Supabase advisor hardening: fixed search_path + revoke direct RPC execution.

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
