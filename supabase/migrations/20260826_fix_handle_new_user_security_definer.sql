-- fix: handle_new_user trigger function must run as SECURITY DEFINER
-- 根因：函数以调用者权限执行 + public.profiles RLS 无 INSERT 策略
--       → 新用户注册时 trigger 插入 profile 被拒 → signUp 500
--        "Database error saving new user"
-- 修复：按 Supabase 官方模板补 security definer + 固定 search_path
-- 注：此函数/trigger 由 Supabase 后台直接创建，不在本仓库 migrations 历史中，
--     故此处仅记录修复，供生产库回放追溯。

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email);
  RETURN NEW;
END;
$$;