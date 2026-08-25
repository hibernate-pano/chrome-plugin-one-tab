-- ─────────────────────────────────────────────────────────────
-- TapStack: Web 端删除改软删（云端 tombstone）
--
-- 背景
--   扩展端与 Web 端共用 tab_groups 表。Web 端删除用硬删（DELETE），
--   扩展端下次上传时会把已删的云端行“复活”（upsert onConflict: id）。
--   跨端一致的解法是云端保留墓碑行（is_deleted=true），合并层按
--   版本/时间比较决定是否应用删除。
--
-- 执行方式
--   ① Supabase 控制台 → SQL Editor → 粘贴本文件全部内容 → Run
--   ② 或 `supabase db push`（需要 Supabase CLI + 链接项目）
--
-- 代码侧已做双轨兼容：未执行本 migration 时降级为硬删（原行为），
-- 执行后自动启用软删墓碑。
-- ─────────────────────────────────────────────────────────────

ALTER TABLE tab_groups
  ADD COLUMN IF NOT EXISTS is_deleted boolean NOT NULL DEFAULT false;

-- 删除语义索引：列表查询只取活跃行，墓碑行仍保留用于同步传播
CREATE INDEX IF NOT EXISTS idx_tab_groups_user_deleted
  ON tab_groups (user_id, is_deleted);