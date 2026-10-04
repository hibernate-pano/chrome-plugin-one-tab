-- 迁移 20251014063156：optimize_rls_policies
-- 说明：该迁移早期直接在 Supabase Dashboard 建立，仓库此前缺少对应文件；
-- 现从远端迁移历史（supabase_migrations.schema_migrations.statements）原样还原，
-- 使仓库成为 schema 的完整描述。

-- 删除现有的宽松策略
DROP POLICY IF EXISTS "Allow all operations for authenticated users" ON tab_groups;
DROP POLICY IF EXISTS "Allow all operations for authenticated users" ON user_settings;

-- 为 tab_groups 表创建更精确的 RLS 策略
CREATE POLICY "Users can view own tab_groups" ON tab_groups
FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own tab_groups" ON tab_groups
FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own tab_groups" ON tab_groups
FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own tab_groups" ON tab_groups
FOR DELETE USING (auth.uid() = user_id);

-- 为 user_settings 表创建更精确的 RLS 策略
CREATE POLICY "Users can view own user_settings" ON user_settings
FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own user_settings" ON user_settings
FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own user_settings" ON user_settings
FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own user_settings" ON user_settings
FOR DELETE USING (auth.uid() = user_id);
