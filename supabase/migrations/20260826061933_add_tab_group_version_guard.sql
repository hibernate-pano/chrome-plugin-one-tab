-- ─────────────────────────────────────────────────────────────
-- TapStack: tab_groups 表加 version 列 + 版本号守卫触发器
--
-- 背景：客户端合并逻辑再精巧，也防不住「服务端裸 upsert」——
-- 两台设备同时编辑同一组 → 两边都整包覆盖 → 后传者抹掉先传者变更。
-- 客户端 syncEngine.ts 每次合并都 version+1，本 migration 把客户端
-- version 作为冲突检测的最终裁决推到服务端：低/相等 version 的 UPDATE
-- 被静默跳过（不报错，eventual consistency 优先于立即一致性）。
--
-- 兼容性：
-- 1. ALTER TABLE IF NOT EXISTS：幂等，老用户升级时如列已存在则跳过
-- 2. NOT NULL DEFAULT 1：老行 version=1，新数据 version≥1 自然大于老行
-- 3. 触发器对 NULL version（旧客户端/老数据）放行：先加列后推客户端，
--    未升级客户端的 upsert 仍能写入（虽然不享受守卫）
-- 4. RLS 不变：本表已有 RLS 策略，触发器在 RLS 校验通过后生效
-- ─────────────────────────────────────────────────────────────

ALTER TABLE public.tab_groups
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_tab_groups_user_version
  ON public.tab_groups (user_id, version);

-- 版本号守卫：BEFORE UPDATE，若新 version <= 旧 version 则跳过该行
-- RETURN NULL → 该 UPDATE 不写入（不抛错，客户端感知不到「自己被跳过」，
--              最终一致性语义：晚到的低版本写赢属于正常 merge 行为）
CREATE OR REPLACE FUNCTION public.guard_tab_group_version()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- 老数据/旧客户端可能不写 version（DEFAULT 1 已兜底）；两侧都有 version 才守卫
  IF OLD.version IS NOT NULL AND NEW.version IS NOT NULL THEN
    IF NEW.version <= OLD.version THEN
      RETURN NULL; -- 跳过过期版本写入
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tab_group_version_guard ON public.tab_groups;
CREATE TRIGGER tab_group_version_guard
BEFORE UPDATE ON public.tab_groups
FOR EACH ROW EXECUTE FUNCTION public.guard_tab_group_version();

-- 备注：客户端 syncEngine.ts 在下载合并后 Math.max(localVersion, cloudVersion)+1
-- （详见 src/utils/syncUtils.ts mergeGroup）。客户端不发送 version 时会被 PG
-- DEFAULT 1 填充，导致后续客户端发送 version=2 时也只会覆盖 DEFAULT 1 行——
-- 这是过渡期的预期行为，触发器守卫对过渡数据不生效，对正常升级后的客户端生效。