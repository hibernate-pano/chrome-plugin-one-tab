-- ─────────────────────────────────────────────────────────────
-- TapStack: 修复 version 守卫触发器误吞软删
--
-- 上一 migration (20260827_add_tab_group_version_guard.sql) 的
-- `NEW.version <= OLD.version → RETURN NULL` 会静默吞掉所有软删操作：
-- markCloudGroupsAsDeleted (src/utils/supabase.ts:782-786) 调
-- `.update({ is_deleted: true, updated_at: ... })` 不带 version 字段，
-- 触发器看到 NEW.version = OLD.version = 1 → 跳过 → 用户删除的组从未传播到云端
-- → 下次后台轮询把云端仍活跃的行以 remote-only 身份拉回来 → 幽灵复活循环。
--
-- 修复：
-- 1. 墓碑操作总是允许：is_deleted 翻转（false↔true）必须传播，与 version 无关
-- 2. 仅 NEW.version < OLD.version 严格更小时拒绝（旧版本）：之前的 <= 误杀
--    "相同 version 的合法更新"（如 uploadTabGroups 重发同 version 行）
-- 3. NULL version 放行（兼容老数据/旧客户端），保持原有兼容承诺
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.guard_tab_group_version()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- 1. 墓碑翻转（is_deleted 状态变化）总是允许：
  -- 删除意图必须传播，version 比较无意义。
  IF NEW.is_deleted IS DISTINCT FROM OLD.is_deleted THEN
    RETURN NEW;
  END IF;

  -- 2. 两侧都有 version 且新 version 严格小于旧 version 时跳过：
  -- 旧设计的 <= 会把 "客户端重发同 version 行" 也当冲突误杀；
  -- 改为 < 仅捕获真正的过期写入（晚到的低版本写赢）。
  IF OLD.version IS NOT NULL AND NEW.version IS NOT NULL THEN
    IF NEW.version < OLD.version THEN
      RETURN NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- trigger 已存在 (CREATE TRIGGER 在上 migration 里)，函数替换后自动生效。
-- 验证：\d+ public.tab_groups 应仍显示 tab_group_version_guard 触发器。