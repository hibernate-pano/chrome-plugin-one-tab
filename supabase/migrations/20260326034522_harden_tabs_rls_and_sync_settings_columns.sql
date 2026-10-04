-- 迁移 20260326034522：harden_tabs_rls_and_sync_settings_columns
-- 说明：该迁移早期直接在 Supabase Dashboard 建立，仓库此前缺少对应文件；
-- 现从远端迁移历史（supabase_migrations.schema_migrations.statements）原样还原，
-- 使仓库成为 schema 的完整描述。

begin;

alter table public.user_settings
  add column if not exists layout_mode text default 'single',
  add column if not exists reorder_mode boolean default false;

update public.user_settings
set layout_mode = coalesce(layout_mode, case when use_double_column_layout is true then 'double' else 'single' end),
    reorder_mode = coalesce(reorder_mode, false)
where layout_mode is null or reorder_mode is null;

alter table public.user_settings
  alter column layout_mode set default 'single',
  alter column reorder_mode set default false;

alter table public.user_settings
  alter column layout_mode set not null,
  alter column reorder_mode set not null;

alter table public.user_settings
  drop constraint if exists user_settings_layout_mode_check;

alter table public.user_settings
  add constraint user_settings_layout_mode_check
  check (layout_mode in ('single', 'double'));

drop policy if exists "Allow all operations for authenticated users" on public.tabs;

create policy "Users can view own tabs via group"
on public.tabs
for select
using (
  exists (
    select 1
    from public.tab_groups
    where tab_groups.id = tabs.group_id
      and tab_groups.user_id = (select auth.uid())
  )
);

create policy "Users can insert own tabs via group"
on public.tabs
for insert
with check (
  exists (
    select 1
    from public.tab_groups
    where tab_groups.id = tabs.group_id
      and tab_groups.user_id = (select auth.uid())
  )
);

create policy "Users can update own tabs via group"
on public.tabs
for update
using (
  exists (
    select 1
    from public.tab_groups
    where tab_groups.id = tabs.group_id
      and tab_groups.user_id = (select auth.uid())
  )
)
with check (
  exists (
    select 1
    from public.tab_groups
    where tab_groups.id = tabs.group_id
      and tab_groups.user_id = (select auth.uid())
  )
);

create policy "Users can delete own tabs via group"
on public.tabs
for delete
using (
  exists (
    select 1
    from public.tab_groups
    where tab_groups.id = tabs.group_id
      and tab_groups.user_id = (select auth.uid())
  )
);

alter policy "Users can view own tab_groups"
on public.tab_groups
using ((select auth.uid()) = user_id);

alter policy "Users can insert own tab_groups"
on public.tab_groups
with check ((select auth.uid()) = user_id);

alter policy "Users can update own tab_groups"
on public.tab_groups
using ((select auth.uid()) = user_id);

alter policy "Users can delete own tab_groups"
on public.tab_groups
using ((select auth.uid()) = user_id);

alter policy "Users can view own user_settings"
on public.user_settings
using ((select auth.uid()) = user_id);

alter policy "Users can insert own user_settings"
on public.user_settings
with check ((select auth.uid()) = user_id);

alter policy "Users can update own user_settings"
on public.user_settings
using ((select auth.uid()) = user_id);

alter policy "Users can delete own user_settings"
on public.user_settings
using ((select auth.uid()) = user_id);

commit;
