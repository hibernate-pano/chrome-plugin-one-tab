-- 迁移 20261020150000：align_version_guard_with_op_stamp
--
-- ─────────────────────────────────────────────────────────────
-- TapStack: version 守卫退化为「无印记时的兜底」，裁决权归印记全序
--
-- 【本迁移修的缺陷（P0）】
--   云端同时存在**两套裁决规则**：
--     ① guard_tab_group_version  —— 按 version 比大小裁决
--     ② guard_tab_group_op_stamp —— 按操作印记（seq → device）全序裁决
--   两者都是 BEFORE UPDATE 触发器，任一返回 NULL 就整行丢弃
--   （HTTP 200、无 error 的**静默吞写**）。
--
--   问题在于 version 是**每台设备各自的本地计数器**，跨设备根本不可比：
--     设备 A 改了 3 次 → version=4、印记 (devA, 5000)
--     设备 B 离线期间改了 1 次 → version=2、印记 (devB, 5001)
--   B 的印记更大 = **B 才是更晚保存的一方**，但旧 version 守卫判
--   `NEW.version(2) < OLD.version(4)` → RETURN NULL → **B 的整行被静默吞掉**，
--   云端状态停在 4|5000|devA，B 的 tabs_data 永远上不去。
--   这与 README「同一会话在两台设备上被同时编辑时，以最后保存的一方为准」
--   正好相反，且那次编辑在两台设备上都**永久丢失**。
--
-- 【现在的分工：印记是唯一裁决源】
--   · 两侧都有完整印记 ⇒ version **不参与裁决**，放行，
--     交给 guard_tab_group_op_stamp 按全序裁决（与客户端
--     core/opStamp.compareStamps 同一把尺子）。
--   · 只有一侧有完整印记 ⇒ 放行（「NULL 不是最小印记，是不知道」，
--     与 op_stamp 守卫的 NULL 三态同口径）。
--   · 两侧都没有印记 ⇒ 保留旧 version 判据（老客户端没有印记，
--     version 是服务端唯一可用的信号）。
--
-- ⚠️ **不要把 version 判据加回「两侧都有印记」的分支。**
--   那正是本缺陷的成因：两套裁决规则并存，version 在印记之外又开了一条
--   「按本地计数大小裁决」的旁路，于是「更晚保存的一方」会输。
--   version 的定位从此是「无印记时的兜底」，不是裁决源。
--
-- 幂等：CREATE OR REPLACE FUNCTION（不改签名、不改归属、不改 ACL）。
-- 顺序：必须排在 20260826064109（version 守卫现行版本）之后、
--      20260909（印记列）之后、20260913132928（守卫加固）之后。
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.guard_tab_group_version()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- 「两侧都没有完整印记」= 老客户端 / 老数据：此时没有印记可比，
  -- version 是服务端唯一可用的信号 ⇒ 保留旧判据兜底。
  IF (OLD.last_op_seq IS NULL OR OLD.last_op_device IS NULL)
     AND (NEW.last_op_seq IS NULL OR NEW.last_op_device IS NULL) THEN
    -- 兜底判据 1：墓碑翻转总是允许（删除意图必须传播，与 version 无关）
    IF NEW.is_deleted IS DISTINCT FROM OLD.is_deleted THEN
      RETURN NEW;
    END IF;
    -- 兜底判据 2：两侧都有 version 且新 version 严格更小 ⇒ 丢弃
    -- （沿用 20260826064109 的判据，仅在无印记时生效）
    IF OLD.version IS NOT NULL AND NEW.version IS NOT NULL THEN
      IF NEW.version < OLD.version THEN
        RETURN NULL;
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- 至少一侧带完整印记：
  --   · 两侧都有 ⇒ 交给 guard_tab_group_op_stamp 按印记全序裁决，
  --     version 在这里**不参与**（否则就是两套规则并存）；
  --   · 只有一侧 ⇒ 印记不完整 = 「不知道」= 无从裁决，放行。
  RETURN NEW;
END;
$$;

-- CREATE OR REPLACE 会用新定义覆盖函数的 SET 配置，
-- 所以这里重新钉一次 search_path（20260913132928 的加固不能被本迁移抹掉）。
ALTER FUNCTION public.guard_tab_group_version()
  SET search_path = public;

-- 守卫函数只能以触发器方式被调用，EXECUTE 权限不是攻击面；
-- 但 20260913132928 已经收过一遍，这里保持一致（CREATE OR REPLACE 不改 ACL，
-- 重复 REVOKE 是幂等的）。
REVOKE EXECUTE ON FUNCTION public.guard_tab_group_version()
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.guard_tab_group_version() FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.guard_tab_group_version() FROM authenticated';
  END IF;
END $$;
