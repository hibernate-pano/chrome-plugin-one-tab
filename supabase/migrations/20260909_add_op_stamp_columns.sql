-- ─────────────────────────────────────────────────────────────
-- TapStack: tab_groups 加操作印记列（last_op_device / last_op_seq）
--
-- 背景：阶段二合并语义从「version + 时间戳 LWW」切换到「OpStamp 全序」。
-- 旧 version 触发器（20260826_add_tab_group_version_guard）保留为兼容（老客户端
-- 仍可能存在）；印记触发器守护升级后的客户端写入。
--
-- 本文件只负责**列 + 索引**（DDL）；守护触发器与函数在
-- 20260910_fix_op_stamp_guard_strict_lt.sql —— 拆开是为了让「守卫规则」只有一处定义，
-- 避免两份函数体漂移（这个仓库已经因为守卫规则写错付出过两次代价）。
--
-- 兼容性：
-- 1. ALTER TABLE IF NOT EXISTS：幂等
-- 2. 新列 nullable，语义由 20260910 的守卫实现（两侧 NULL/OLD NULL 放行、NEW NULL 拒收）
-- 3. 旧 `version` 列 + `guard_tab_group_version` 触发器保留（老客户端守护），
--    阶段三（或客户端全部升级后）可清理
-- ─────────────────────────────────────────────────────────────

ALTER TABLE public.tab_groups
  ADD COLUMN IF NOT EXISTS last_op_device text,
  ADD COLUMN IF NOT EXISTS last_op_seq    bigint;

CREATE INDEX IF NOT EXISTS idx_tab_groups_op_stamp
  ON public.tab_groups (user_id, last_op_seq DESC NULLS LAST);
