-- 迁移 20251014063149：enable_realtime_for_tables
-- 说明：该迁移早期直接在 Supabase Dashboard 建立，仓库此前缺少对应文件；
-- 现从远端迁移历史（supabase_migrations.schema_migrations.statements）原样还原，
-- 使仓库成为 schema 的完整描述。

-- 为 tab_groups 表启用 Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE tab_groups;

-- 为 user_settings 表启用 Realtime  
ALTER PUBLICATION supabase_realtime ADD TABLE user_settings;
