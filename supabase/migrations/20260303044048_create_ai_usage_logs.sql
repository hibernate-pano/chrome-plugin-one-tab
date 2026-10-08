-- 迁移 20260303044048：create_ai_usage_logs
-- 说明：该迁移早期直接在 Supabase Dashboard 建立，仓库此前缺少对应文件；
-- 现从远端迁移历史（supabase_migrations.schema_migrations.statements）原样还原，
-- 使仓库成为 schema 的完整描述。

-- 创建 ai_usage_logs 表
CREATE TABLE IF NOT EXISTS ai_usage_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  response_code TEXT,
  tokens_used INT DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_user_id ON ai_usage_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_created_at ON ai_usage_logs(created_at DESC);

-- RLS
ALTER TABLE ai_usage_logs ENABLE ROW LEVEL SECURITY;

-- 幂等性（2026-10-07 新增，真库 PG 16 两遍重放实测）：旧版本是 2 条裸 CREATE POLICY，
-- 在 ai_usage_logs 表与策略都已存在的库上重放必抛 42710 duplicate_object。
-- 守卫查 pg_catalog.pg_policy 基表，不存在才创建；存在即跳过，终态不变。
-- dollar-quote 块分隔符：提到它的说明文字必须独占整行（见 20251014063149 的注释）。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'ai_usage_logs'
      AND pol.polname = 'Users can view own AI usage'
  ) THEN
    CREATE POLICY "Users can view own AI usage" ON ai_usage_logs
      FOR SELECT USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'ai_usage_logs'
      AND pol.polname = 'Users can insert own AI usage'
  ) THEN
    CREATE POLICY "Users can insert own AI usage" ON ai_usage_logs
      FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
END
$$;
