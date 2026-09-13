-- ─────────────────────────────────────────────────────────────
-- TapStack: 补齐 OpStamp 的 device 平局规则
--
-- 客户端 compareStamps 的全序是「先 seq，再 device 字典序」；20260910 的
-- 服务端守卫只比较 seq。两个设备并发产生相同 seq 时，服务端会成为“最后写入
-- 者获胜”，而客户端有确定的 device 顺序，可能导致云端状态与客户端不一致。
--
-- 本迁移保持既有 NULL 三态，只补齐平局：
-- - OLD 有值而 NEW 显式 NULL：拒收
-- - 任一侧缺完整印记：放行（兼容老行/老客户端）
-- - NEW.seq < OLD.seq：拒收
-- - seq 相同且 NEW.device < OLD.device：拒收
-- - 完全相同的印记：放行，支持重发与 Web 局部 UPDATE
--
-- 幂等：CREATE OR REPLACE FUNCTION + DROP/CREATE TRIGGER。
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.guard_tab_group_op_stamp()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (OLD.last_op_seq IS NOT NULL AND NEW.last_op_seq IS NULL)
     OR (OLD.last_op_device IS NOT NULL AND NEW.last_op_device IS NULL) THEN
    RETURN NULL;
  END IF;

  IF OLD.last_op_seq IS NULL OR NEW.last_op_seq IS NULL
     OR OLD.last_op_device IS NULL OR NEW.last_op_device IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.last_op_seq < OLD.last_op_seq
     OR (
       NEW.last_op_seq = OLD.last_op_seq
       AND NEW.last_op_device COLLATE "C" < OLD.last_op_device COLLATE "C"
     ) THEN
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tab_group_op_stamp_guard ON public.tab_groups;
CREATE TRIGGER tab_group_op_stamp_guard
BEFORE UPDATE ON public.tab_groups
FOR EACH ROW EXECUTE FUNCTION public.guard_tab_group_op_stamp();
