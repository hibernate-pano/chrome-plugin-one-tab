-- 迁移 20260303044037：create_profiles
-- 说明：该迁移早期直接在 Supabase Dashboard 建立，仓库此前缺少对应文件；
-- 现从远端迁移历史（supabase_migrations.schema_migrations.statements）原样还原，
-- 使仓库成为 schema 的完整描述。

-- 创建 profiles 表
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  plan TEXT DEFAULT 'free' CHECK (plan IN ('free', 'pro')),
  ai_usage_count INT DEFAULT 0,
  ai_daily_count INT DEFAULT 0,
  ai_reset_at DATE DEFAULT CURRENT_DATE,
  stripe_customer_id TEXT,
  subscription_id TEXT,
  subscription_status TEXT DEFAULT 'inactive'
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_profiles_email ON profiles(email);
CREATE INDEX IF NOT EXISTS idx_profiles_plan ON profiles(plan);

-- 启用 RLS
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- 创建策略
CREATE POLICY "Users can view own profile" ON profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can update own profile" ON profiles
  FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "Anyone can view public profile fields" ON profiles
  FOR SELECT USING (true);
