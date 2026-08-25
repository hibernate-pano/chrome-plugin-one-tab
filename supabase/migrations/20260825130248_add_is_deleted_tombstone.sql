-- ─────────────────────────────────────────────────────────────
-- TapStack: Web 端删除改软删（云端 tombstone）
--
-- 状态：✅ 已通过 Supabase MCP 在 2026-08-25 应用到生产库
--       （版本号 20260825130248，可查 supabase_migrations.schema_migrations）
--
-- 背景
--   扩展端与 Web 端共用 tab_groups 表。Web 端删除用硬删（DELETE），
--   扩展端下次上传时会把已删的云端行“复活”（upsert onConflict: id）。
--   跨端一致的解法是云端保留墓碑行（is_deleted=true），合并层按
--   版本/时间比较决定是否应用删除。
--
-- 代码侧双轨兼容（无需回退）：本 migration 未执行时降级为硬删，
-- 执行后自动启用软删墓碑（supportsCloudTombstone 探测）。
-- ─────────────────────────────────────────────────────────────

ALTER TABLE public.tab_groups
  ADD COLUMN IF NOT EXISTS is_deleted boolean NOT NULL DEFAULT false;

-- 删除语义索引：全表扫描仍按 user_id 走，此索引加速活跃/墓碑混合过滤
CREATE INDEX IF NOT EXISTS idx_tab_groups_user_deleted
  ON public.tab_groups (user_id, is_deleted);

-- 清理死列：pending_delete 由 20260530143912 migration 添加，
-- 仓库代码自始至终未引用（grep 确认），一并移除避免混淆
ALTER TABLE public.tab_groups
  DROP COLUMN IF EXISTS pending_delete;