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

-- 幂等性（2026-10-07 新增，真库 PG 16 两遍重放实测）：下面 4 条原本是裸 create policy，
-- 第二次重放必抛 42710 duplicate_object（本文件排在 20251014063149 之后，
-- 前者的非幂等已经让整条重放链路提前断了，所以这个坑此前从未暴露）。
-- 守卫查 pg_catalog.pg_policy 基表，不存在才建；存在即跳过，终态不变。
-- 下面的 alter policy 不改：ALTER 是幂等的（就地重写 qual），重放不会失败。
-- dollar-quote 块分隔符：提到它的说明文字必须独占整行（见 20251014063149 的注释）。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'tabs'
      AND pol.polname = 'Users can view own tabs via group'
  ) THEN
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
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'tabs'
      AND pol.polname = 'Users can insert own tabs via group'
  ) THEN
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
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'tabs'
      AND pol.polname = 'Users can update own tabs via group'
  ) THEN
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
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'tabs'
      AND pol.polname = 'Users can delete own tabs via group'
  ) THEN
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
  END IF;
END
$$;

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
