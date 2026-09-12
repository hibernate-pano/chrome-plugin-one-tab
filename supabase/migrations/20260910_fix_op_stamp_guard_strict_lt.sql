-- ─────────────────────────────────────────────────────────────
-- TapStack: 修正操作印记守护触发器的放行条件（严格 `<` + NULL 语义三态）
--
-- 背景：20260909 引入的 guard_tab_group_op_stamp 用 `NEW.last_op_seq <= OLD.last_op_seq
-- → RETURN NULL`，把三类合法写入整行吞掉（客户端只收到 error=null，无从得知）：
--   * 标签级操作（规格 §5.3 removeTab）刻意不盖组印记 → 重发时 NEW = OLD
--   * Web 控制台（src/web/webApi.ts）的局部 UPDATE 不带印记列 → NEW = OLD
--   * 老客户端 upsert 不知道印记列 → ON CONFLICT 不 SET 该列 → NEW = OLD
-- 后果：标签墓碑上不了云（跨设备删除失效、幽灵复活）、Web 端改名/删除/恢复全部静默失效。
-- 这与 20260826 fix_version_guard_for_tombstones 修掉的是同一类错误（`<=` 误杀同版本重发）。
--
-- 为什么墓碑翻转【不】无条件豁免：规格 §5 明确「isDeleted 的墓碑同样参与比印记」——
-- 删除靠 deleteGroup 盖新印记传播，恢复靠「更新的印记天然赢过旧墓碑」。若让翻转无条件赢，
-- 落伍设备能越过因果序复活/删除别人的组，且翻转会把印记改小 → 守卫对后续写入持续失效。
-- 真实删除路径全部满足 NEW ≥ OLD（客户端盖新印记 / Web 局部 UPDATE = OLD /
-- markCloudGroupsAsDeleted = OLD+1），不需要豁免。
--
-- 幂等：CREATE OR REPLACE FUNCTION + DROP/CREATE TRIGGER，可重复执行。
-- 行为矩阵由 tests/opStampGuard.pg.test.ts 在真实 Postgres 上钉死。
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.guard_tab_group_op_stamp()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- 1. OLD 有印记而 NEW 显式为 NULL → 拒收。
  --    「清空印记」必须禁止：印记一没，本守卫对后续写入全失效；
  --    而且该行内容会被发件方（可能很旧的副本）以旧盖新。
  --    （老客户端不会命中：它根本不发该列，ON CONFLICT 下 NEW 保留 OLD 值。）
  IF OLD.last_op_seq IS NOT NULL AND NEW.last_op_seq IS NULL THEN
    RETURN NULL;
  END IF;

  -- 2. 任一侧无印记 → 无从比较，不仲裁（放行）。
  --    NULL 不是「最小印记」而是「不知道」：拿不存在的序否决写入，
  --    只会让老客户端与未迁移老行变成静默只读。
  IF OLD.last_op_seq IS NULL OR NEW.last_op_seq IS NULL THEN
    RETURN NEW;
  END IF;

  -- 3. 仅拒收严格更旧的写入；相等必须放行（同印记重发、局部 UPDATE、老客户端）。
  IF NEW.last_op_seq < OLD.last_op_seq THEN
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
-- 已升级客户端（带 stamp）写：NEW ≥ OLD 放行（含相等）；NEW < OLD（更旧的写入）跳过。
-- 老客户端（不带 stamp 列）：ON CONFLICT 不 SET 该列 → NEW = OLD → 行为与新客户端一致。
-- 未迁移老行（OLD NULL）：放行，由新客户端接管写入。
-- ⚠️ 客户端一旦发送印记列就必须带值：显式 NULL 会清空云端印记 → 被守卫拒收（守卫第 1 条）。
