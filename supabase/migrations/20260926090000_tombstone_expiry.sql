-- ─────────────────────────────────────────────────────────────
-- D3 墓碑 7 天 · 服务端列（additive-only，全幂等）：
-- - tab_groups.deleted_at：组级删除时刻（客户端 markCloudGroupsAsDeleted 随
--   墓碑 UPDATE 写入；缺失 → 对端回退 updatedAt，见 src/core/tombstone.ts）。
-- - sync_updates.tombstone_expires_at：墓碑 update 的到期时刻（仅审计/兜底
--   清理用，不参与同步语义）。
-- - 无 DROP / ALTER COLUMN / DELETE / 触发器变更；RLS 不动。
-- - 物理清除的定时任务见 supabase/manual/tombstone_expiry_cron.sql
--   （手动步骤，不随迁移自动启用——启用即开始删数据，需负责人确认）。
-- ─────────────────────────────────────────────────────────────

-- 1) tab_groups.deleted_at（组级删除时刻，可空；活跃组保持 NULL）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tab_groups' AND column_name = 'deleted_at'
  ) THEN
    ALTER TABLE public.tab_groups ADD COLUMN deleted_at timestamptz NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tab_groups_deleted_at
  ON public.tab_groups (user_id, deleted_at)
  WHERE is_deleted = true;

COMMENT ON COLUMN public.tab_groups.deleted_at IS
  'D3：组墓碑删除时刻。deleted_at + 7 天后由定时任务物理清除；缺失回退 updated_at。';

-- 2) sync_updates.tombstone_expires_at（墓碑 update 到期时刻，可空；普通 update 为 NULL）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sync_updates' AND column_name = 'tombstone_expires_at'
  ) THEN
    ALTER TABLE public.sync_updates ADD COLUMN tombstone_expires_at timestamptz NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sync_updates_tombstone_expiry
  ON public.sync_updates (tombstone_expires_at)
  WHERE tombstone_expires_at IS NOT NULL;
