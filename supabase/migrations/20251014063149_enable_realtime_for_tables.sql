-- 迁移 20251014063149：enable_realtime_for_tables
-- 说明：该迁移早期直接在 Supabase Dashboard 建立，仓库此前缺少对应文件；
-- 现从远端迁移历史（supabase_migrations.schema_migrations.statements）原样还原，
-- 使仓库成为 schema 的完整描述。
--
-- ─────────────────────────────────────────────────────────────
-- 幂等性（2026-10-07 新增，真库 PG 16 两遍重放实测）
--
-- 旧版本是两条裸 `ALTER PUBLICATION ... ADD TABLE`。在「表已经是该 publication
-- 成员」的库上执行必然抛 42710 duplicate_object：
--   ERROR: relation "tab_groups" is already member of publication "supabase_realtime"
-- 这在 Supabase 生产库上是**必然**发生的（Dashboard 建表时就已加入 realtime）。
--
-- 而本文件按文件名排序是所有迁移里的**第一个**。scripts/supabase-migrate.mjs
-- 用一个 try 包住整个 for 循环、出错即 process.exit(1)，于是它一挂：
--   · 后面 22 个文件从未被尝试 —— 其中包括 20261005000000（profiles 全表可读
--     PII 收口）与 20261005000001（purge 函数对 anon 的 REVOKE）；
--   · verify() 根本不执行。
-- 一次静默的重放中断：仓库里写着安全迁移，线上却从没跑过。
--
-- 现在两条都先查「publication 存在 + 表存在 + 尚未是成员」，三条全真才执行；
-- 已经是成员就跳过（正是「加过了」的语义），终态与首跑逐字一致。
-- 判定走 pg_catalog.pg_publication_tables —— 该视图按 puballtables 展开，
-- 比只看 pg_publication_rel 基表更完整（FOR ALL TABLES 的 publication 没有
-- pg_publication_rel 行）。
-- ─────────────────────────────────────────────────────────────

-- 下面用 dollar-quote 作块分隔符。切记：本文件中提到该分隔符的说明文字一律
-- 独占整行并以 -- 开头；若写在 DO 分隔符同一行，它会落进字符串内部并让
-- 字符串提前闭合（42601 语法错，首跑即失败）。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_publication WHERE pubname = 'supabase_realtime')
     AND EXISTS (
       SELECT 1 FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'tab_groups'
     )
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'tab_groups'
     )
  THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.tab_groups;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_publication WHERE pubname = 'supabase_realtime')
     AND EXISTS (
       SELECT 1 FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'user_settings'
     )
     AND NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'user_settings'
     )
  THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.user_settings;
  END IF;
END
$$;
