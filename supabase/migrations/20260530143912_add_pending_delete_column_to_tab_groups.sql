-- 迁移 20260530143912：add_pending_delete_column_to_tab_groups
-- 说明：该迁移早期直接在 Supabase Dashboard 建立，仓库此前缺少对应文件；
-- 现从远端迁移历史（supabase_migrations.schema_migrations.statements）原样还原，
-- 使仓库成为 schema 的完整描述。

ALTER TABLE public.tab_groups ADD COLUMN IF NOT EXISTS pending_delete boolean DEFAULT false;
