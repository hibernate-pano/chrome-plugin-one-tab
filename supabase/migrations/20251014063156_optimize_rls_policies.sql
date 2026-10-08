-- 迁移 20251014063156：optimize_rls_policies
-- 说明：该迁移早期直接在 Supabase Dashboard 建立，仓库此前缺少对应文件；
-- 现从远端迁移历史（supabase_migrations.schema_migrations.statements）原样还原，
-- 使仓库成为 schema 的完整描述。
--
-- ─────────────────────────────────────────────────────────────
-- 幂等性（2026-10-07 新增，真库 PG 16 两遍重放实测）
--
-- 旧版本是 8 条裸 `CREATE POLICY`（PostgreSQL 没有 CREATE POLICY IF NOT EXISTS
-- 这种写法）。第二次重放必然抛 42710 duplicate_object：
--   ERROR: policy "Users can view own tab_groups" for table "tab_groups" already exists
-- 叠加上排在前面的 20251014063149 也非幂等，整条重放链路在最初的几个文件里就断了。
--
-- 现在每条先查 pg_catalog.pg_policy（查**基表**而不是 pg_policies 视图 ——
-- 视图按 pg_has_role(polroles,'USAGE') 过滤，非表 owner 角色会看不见策略、
-- 被误判成「不存在」而静默跳过），不存在才创建。存在即跳过，终态不变。
-- ─────────────────────────────────────────────────────────────

-- 删除现有的宽松策略（这两条本来就带 IF EXISTS，重放安全）
DROP POLICY IF EXISTS "Allow all operations for authenticated users" ON tab_groups;
DROP POLICY IF EXISTS "Allow all operations for authenticated users" ON user_settings;

-- dollar-quote 块分隔符：提到它的说明文字一律独占整行（见 20251014063149 的注释）。
DO $$
BEGIN
  -- ── tab_groups ──────────────────────────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'tab_groups'
      AND pol.polname = 'Users can view own tab_groups'
  ) THEN
    CREATE POLICY "Users can view own tab_groups" ON tab_groups
      FOR SELECT USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'tab_groups'
      AND pol.polname = 'Users can insert own tab_groups'
  ) THEN
    CREATE POLICY "Users can insert own tab_groups" ON tab_groups
      FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'tab_groups'
      AND pol.polname = 'Users can update own tab_groups'
  ) THEN
    CREATE POLICY "Users can update own tab_groups" ON tab_groups
      FOR UPDATE USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'tab_groups'
      AND pol.polname = 'Users can delete own tab_groups'
  ) THEN
    CREATE POLICY "Users can delete own tab_groups" ON tab_groups
      FOR DELETE USING (auth.uid() = user_id);
  END IF;

  -- ── user_settings ───────────────────────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'user_settings'
      AND pol.polname = 'Users can view own user_settings'
  ) THEN
    CREATE POLICY "Users can view own user_settings" ON user_settings
      FOR SELECT USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'user_settings'
      AND pol.polname = 'Users can insert own user_settings'
  ) THEN
    CREATE POLICY "Users can insert own user_settings" ON user_settings
      FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'user_settings'
      AND pol.polname = 'Users can update own user_settings'
  ) THEN
    CREATE POLICY "Users can update own user_settings" ON user_settings
      FOR UPDATE USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'user_settings'
      AND pol.polname = 'Users can delete own user_settings'
  ) THEN
    CREATE POLICY "Users can delete own user_settings" ON user_settings
      FOR DELETE USING (auth.uid() = user_id);
  END IF;
END
$$;
