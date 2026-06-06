-- TabStack 测试项目建表脚本
-- 用途：在新建的 Supabase 测试项目（oymtwynwxessqtavviwu）上重建表结构，
--      用于验证「删除传播 tombstone 修复」，不碰生产库。
-- 来源：从生产库 reccclnaxadbuccsrwmg 的真实 schema 考古而来（2026-06-06）。
--
-- 用法：复制全文 → 新项目 Supabase 控制台 → SQL Editor → 粘贴 → Run。
--
-- 关键点：tab_groups 保留生产库已有的 pending_delete 字段（tombstone 软删用），
--        本次删除传播修复就是要把它接通（markCloudGroupsAsDeleted 改写它而非硬删行）。

-- ── 1. tab_groups（核心表，标签组）──────────────────────────────────
create table if not exists public.tab_groups (
  id              text primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  name            text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  is_locked       boolean not null default false,
  device_id       text,
  last_sync       timestamptz,
  compressed_data text,
  tabs_data       jsonb,                       -- 加密后的标签数据 blob
  pending_delete  boolean default false        -- tombstone 软删标记（修复要接通它）
);

-- ── 2. tabs（生产库已废弃，0 行；建出来仅为 schema 对齐）─────────────
create table if not exists public.tabs (
  id            text primary key,
  group_id      text not null references public.tab_groups(id) on delete cascade,
  url           text not null,
  title         text not null,
  favicon       text,
  created_at    timestamptz not null default now(),
  last_accessed timestamptz not null default now()
);

-- ── 3. user_settings（用户设置）─────────────────────────────────────
create table if not exists public.user_settings (
  user_id                      uuid primary key references auth.users(id) on delete cascade,
  auto_save                    boolean default false,
  auto_save_interval           integer default 5,
  group_name_template          text default 'Group %d',
  show_favicons                boolean default true,
  show_tab_count               boolean default true,
  auto_close_tabs              boolean default true,
  confirm_before_delete        boolean default true,
  allow_duplicate_tabs         boolean default false,
  sync_interval                integer default 1,
  sync_enabled                 boolean default true,
  auto_close_tabs_after_saving boolean default true,
  delete_strategy              text default 'everywhere',
  use_double_column_layout     boolean default true,
  show_notifications           boolean default false,
  sync_strategy                text default 'newest',
  device_id                    text,
  last_sync                    timestamptz,
  theme_mode                   text default 'auto',
  theme_style                  text,
  collect_pinned_tabs          boolean default false,
  layout_mode                  text default 'single' check (layout_mode = any (array['single','double'])),
  reorder_mode                 boolean default false
);

-- ── 4. 行级安全（RLS）：与生产库一致，用户只能读写自己的数据 ──────────
alter table public.tab_groups   enable row level security;
alter table public.tabs         enable row level security;
alter table public.user_settings enable row level security;

-- tab_groups 四条策略（SELECT/INSERT/UPDATE/DELETE，全部限制 auth.uid() = user_id）
create policy "Users can view own tab_groups"   on public.tab_groups for select using ((select auth.uid()) = user_id);
create policy "Users can insert own tab_groups" on public.tab_groups for insert with check ((select auth.uid()) = user_id);
create policy "Users can update own tab_groups" on public.tab_groups for update using ((select auth.uid()) = user_id);
create policy "Users can delete own tab_groups" on public.tab_groups for delete using ((select auth.uid()) = user_id);

-- user_settings 同样的四条
create policy "Users can view own settings"   on public.user_settings for select using ((select auth.uid()) = user_id);
create policy "Users can insert own settings" on public.user_settings for insert with check ((select auth.uid()) = user_id);
create policy "Users can update own settings" on public.user_settings for update using ((select auth.uid()) = user_id);
create policy "Users can delete own settings" on public.user_settings for delete using ((select auth.uid()) = user_id);

-- tabs 表（虽废弃，仍给策略避免 RLS 锁死）
create policy "Users can manage own tabs" on public.tabs for all
  using (exists (select 1 from public.tab_groups g where g.id = tabs.group_id and g.user_id = (select auth.uid())));
