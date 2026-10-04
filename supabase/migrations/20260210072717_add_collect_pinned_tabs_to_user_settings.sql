-- 迁移 20260210072717：add_collect_pinned_tabs_to_user_settings
-- 说明：该迁移早期直接在 Supabase Dashboard 建立，仓库此前缺少对应文件；
-- 现从远端迁移历史（supabase_migrations.schema_migrations.statements）原样还原，
-- 使仓库成为 schema 的完整描述。

alter table public.user_settings
  add column if not exists collect_pinned_tabs boolean not null default false;
