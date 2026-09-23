-- ─────────────────────────────────────────────────────────────
-- TapStack V2 影子双写：Y 同步表（sync_updates + sync_snapshots）
--
-- additive only + 全幂等（可重复应用，无破坏性语句）：
-- - 仅 CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--   DO 块内条件加列与条件建策略；无 DROP / ALTER COLUMN / DELETE。
-- - RLS：两表均 ENABLE ROW LEVEL SECURITY，按 user_id 隔离
--   （USING/WITH CHECK 用 (select auth.uid()) 包一层，避免逐行重算，
--   与 20260923160000_fix_rls_initplan.sql 同口径）。
-- - 本期 Y-update 存明文（base64 文本）；E2EE 是 V3 范畴，
--   届时 update 列语义切换为密文，schema 不变。
-- - compact 阈值（客户端常量，见 src/core/yShadowConfig.ts）：
--   本地 update 日志 >500 条或 >256KB → 置 needsSnapshot，由 V2 同步面
--   上传 snapshot（up_to_seq 推进）后服务端可裁剪已覆盖的 updates。
-- ─────────────────────────────────────────────────────────────

-- 1) sync_updates：Y 增量 update 日志（doc 粒度全序 seq）
CREATE TABLE IF NOT EXISTS public.sync_updates (
  doc_id      text        NOT NULL,
  user_id     uuid        NOT NULL,
  seq         bigint      NOT NULL,
  base_vector text        NULL,
  update      text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_sync_updates PRIMARY KEY (doc_id, seq)
);

-- 幂等补列（首次建表已含；老表结构演进时补齐）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sync_updates' AND column_name = 'base_vector'
  ) THEN
    ALTER TABLE public.sync_updates ADD COLUMN base_vector text NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sync_updates_user_doc_seq
  ON public.sync_updates (user_id, doc_id, seq DESC);

ALTER TABLE public.sync_updates ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sync_updates' AND policyname = 'Users can view own sync updates') THEN
    CREATE POLICY "Users can view own sync updates" ON public.sync_updates
      FOR SELECT USING ((select auth.uid()) = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sync_updates' AND policyname = 'Users can insert own sync updates') THEN
    CREATE POLICY "Users can insert own sync updates" ON public.sync_updates
      FOR INSERT WITH CHECK ((select auth.uid()) = user_id);
  END IF;
END $$;

-- 2) sync_snapshots：doc 快照（compact 锚点，up_to_seq 覆盖 updates 前缀）
CREATE TABLE IF NOT EXISTS public.sync_snapshots (
  doc_id      text        NOT NULL PRIMARY KEY,
  user_id     uuid        NOT NULL,
  snapshot    text        NOT NULL,
  up_to_seq   bigint      NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sync_snapshots' AND column_name = 'up_to_seq'
  ) THEN
    ALTER TABLE public.sync_snapshots ADD COLUMN up_to_seq bigint NOT NULL DEFAULT 0;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sync_snapshots_user
  ON public.sync_snapshots (user_id);

ALTER TABLE public.sync_snapshots ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sync_snapshots' AND policyname = 'Users can view own sync snapshots') THEN
    CREATE POLICY "Users can view own sync snapshots" ON public.sync_snapshots
      FOR SELECT USING ((select auth.uid()) = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sync_snapshots' AND policyname = 'Users can upsert own sync snapshots') THEN
    CREATE POLICY "Users can upsert own sync snapshots" ON public.sync_snapshots
      FOR INSERT WITH CHECK ((select auth.uid()) = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sync_snapshots' AND policyname = 'Users can update own sync snapshots') THEN
    CREATE POLICY "Users can update own sync snapshots" ON public.sync_snapshots
      FOR UPDATE USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);
  END IF;
END $$;
