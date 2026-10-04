-- 迁移 20260525151413：fix_security_definer_function
-- 说明：该迁移早期直接在 Supabase Dashboard 建立，仓库此前缺少对应文件；
-- 现从远端迁移历史（supabase_migrations.schema_migrations.statements）原样还原，
-- 使仓库成为 schema 的完整描述。

-- Fix the handle_new_user function to be SECURITY INVOKER instead of SECURITY DEFINER
-- This prevents privilege escalation through the function
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email);
  RETURN NEW;
END;
$$;

-- Revoke execute from anon and authenticated roles to prevent direct calling
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO authenticated;

-- Enable leaked password protection in auth config
-- Note: This requires updating auth settings via the dashboard or API
-- We'll also set OTP expiry to recommended 3600 seconds (1 hour);
