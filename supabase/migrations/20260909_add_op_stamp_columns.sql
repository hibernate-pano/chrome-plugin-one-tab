-- ─────────────────────────────────────────────────────────────
-- TapStack: tab_groups 加操作印记列 + 守护触发器
--
-- 背景：阶段二合并语义从「version + 时间戳 LWW」切换到「OpStamp 全序」。
-- 旧 version 触发器（20260827_add_tab_group_version_guard）保留为兼容（老客户端
-- 仍可能存在）；新 stamp 触发器守护升级后的客户端写入。
--
-- 兼容性：
-- 1. ALTER TABLE IF NOT EXISTS：幂等
-- 2. 新列 nullable：老行 last_op_seq=NULL → 触发器视为最小值（OLD NULL ≥ NEW NULL 跳过）
--    客户端带 stamp 上传时必填，触发器才能正确守护
-- 3. 旧 `version` 列 + `guard_tab_group_version` 触发器**保留**（老客户端守护），
--    阶段三（或客户端全部升级后）可清理
-- ─────────────────────────────────────────────────────────────

ALTER TABLE public.tab_groups
  ADD COLUMN IF NOT EXISTS last_op_device text,
  ADD COLUMN IF NOT EXISTS last_op_seq    bigint;

CREATE INDEX IF NOT EXISTS idx_tab_groups_op_stamp
  ON public.tab_groups (user_id, last_op_seq DESC NULLS LAST);

-- 守护：BEFORE UPDATE，若 NEW.last_op_seq ≤ OLD.last_op_seq 则跳过。
-- 处理 NULL：NULL 列视为最小值。
--   - 两侧都 NULL：跳过（无 stamp 信息，老客户端间互写无意义）
--   - OLD NULL, NEW 有值：放行（新客户端接管老行）
--   - OLD 有值, NEW NULL：跳过（老客户端不清空新客户端的 stamp——防止数据丢失）
CREATE OR REPLACE FUNCTION public.guard_tab_group_op_stamp()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.last_op_seq IS NOT NULL AND NEW.last_op_seq IS NOT NULL THEN
    IF NEW.last_op_seq <= OLD.last_op_seq THEN
      RETURN NULL;
    END IF;
  ELSIF OLD.last_op_seq IS NULL AND NEW.last_op_seq IS NOT NULL THEN
    -- 老客户端无 stamp，新客户端带 stamp → 放行
    RETURN NEW;
  ELSE
    -- OLD 有但 NEW NULL（老客户端写空 stamp 列），或两侧都 NULL → 跳过
    -- 这条分支涵盖「老客户端存在期间防止覆盖新客户端 stamp」的边界
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tab_group_op_stamp_guard ON public.tab_groups;
CREATE TRIGGER tab_group_op_stamp_guard
BEFORE UPDATE ON public.tab_groups
FOR EACH ROW EXECUTE FUNCTION public.guard_tab_group_op_stamp();

-- 备注：客户端 stamp 仅写入「组级」操作（saveGroup/deleteGroup/restoreGroup/renameGroup/
-- toggleGroupLock/moveGroup/moveTab/deleteAllGroups/importGroups）。tab 印记内嵌在
-- tabs_data JSON 中，不参与云端列判定（详见规格 §5.3）。
--
-- 已升级客户端（带 stamp）写：触发器放行（NEW > OLD 或 OLD NULL）。
-- 老客户端（不带 stamp）写：触发器会拦截——这是设计意图，强制升级。
-- 已在 catch 阶段就清空 last_op_seq 的旧数据迁移脚本在 web 仪表盘同步时
-- 自动用 lastOp 字段填充（详见 webApi 阶段二补丁，独立 commit）。