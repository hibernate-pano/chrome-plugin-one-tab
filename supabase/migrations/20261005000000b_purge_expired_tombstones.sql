-- 迁移 20261005000000b：云端墓碑的服务端兜底清理（函数化，便于挂任意调度器）
--
-- ── 为什么从 supabase/manual/ 提到 migrations/ ────────────────────────
-- 原脚本 supabase/manual/tombstone_expiry_cron.sql 整段被注释，文件头写着
-- 「手动步骤，不随迁移自动启用」。核实现状：
--   - 客户端 purgeExpiredCloudTombstones 只挂在 upload 上（syncEngine.ts:574），
--     所以「再也不用这个账号」的墓碑行永远没人清；
--   - 服务端兜底整段注释、未启用；
--   ⇒ is_deleted 行对休眠账号无限堆积（隐私政策承诺 30 天后删除）。
--
-- ── 为什么本迁移只建函数、不建 cron ────────────────────────────────────
-- pg_cron 需要在 Dashboard → Database → Extensions 里手动勾选，迁移里直接
-- `cron.schedule(...)` 会在未启用扩展的项目上**整条迁移报错**。
-- 所以这里只做两件不会失败的事：
--   1) 建清理函数（幂等、可重复重放）；
--   2) 用 RAISE NOTICE 把启用步骤原样打出来 —— 让执行者不会漏掉最后一步。
--
-- 原文件头列的三个启用条件仍然成立，且第一条由本迁移的引入者确认：
--   1) 客户端清理已上线 ≥1 个版本（客户端为主清理，服务端只兜底休眠账号）；
--   2) 已在 staging 演练（先 SELECT 计数，再 DELETE）；
--   3) pg_cron 可用，或改用 Supabase Scheduled Job / Vercel Cron 调本函数。

-- ─────────────────────────────────────────────────────────────────────
-- 【TTL 天数必须与客户端一致】当前 30 天，写在两处：
--   客户端 purgeExpiredCloudTombstones(maxAgeDays = 30)（src/utils/supabase/upload.ts）
--   本函数 body_tombstone_expiry_days()（下面）
-- 改任何一边都必须同步改另一边，否则「服务端提前删、客户端还没广播完
-- → 离线设备把已删会话复活」。这是本脚本最危险的地方，所以做成函数：
-- 两边都能读到同一个值，日志里也会打印出来便于对账。
-- ─────────────────────────────────────────────────────────────────────

-- 1) TTL 常量：放在函数里而不是散在两处，客户端迁移时可直接对齐这个数字
CREATE OR REPLACE FUNCTION public.body_tombstone_expiry_days()
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $body$ SELECT 30 $body$;

-- 它是 IMMUTABLE 纯函数（无副作用、只返回一个数字），理论上被匿名调用无害。
-- 但仍收回 EXECUTE：① 默认 PUBLIC 可执行是 PostgreSQL 的经典坑，未来有人
-- 给它加逻辑（比如读一张表）就会变成漏洞；② 零成本，无需为"看起来更安全"
-- 找理由。真正需要它的是 purge 函数（表 owner）与调度器（service_role）。
REVOKE EXECUTE ON FUNCTION public.body_tombstone_expiry_days() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.body_tombstone_expiry_days() FROM anon;
REVOKE EXECUTE ON FUNCTION public.body_tombstone_expiry_days() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.body_tombstone_expiry_days() TO service_role;

-- 2) 清理函数本体。幂等：没有到期行时删 0 行。
--    SECURITY DEFINER：执行者是调度器（不是表 owner），需要绕过 RLS
--    才能删到 is_deleted 的行——那些行按现行策略对普通角色不可见。
--    搜索路径 钉死 public：SECURITY DEFINER 函数不设 search_path
--    会被评为高危（可被临时 schema 劫持）。
CREATE OR REPLACE FUNCTION public.purge_expired_cloud_tombstones()
RETURNS TABLE (deleted_count bigint, ttl_days integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ttl integer := public.body_tombstone_expiry_days();
  v_count bigint;
BEGIN
  DELETE FROM public.tab_groups
  WHERE is_deleted = true
    AND COALESCE(deleted_at, updated_at) < now() - (v_ttl || ' days')::interval;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN QUERY SELECT v_count, v_ttl;
END;
$$;

COMMENT ON FUNCTION public.purge_expired_cloud_tombstones() IS
  '删除 is_deleted 且龄期超过 TTL 的云端行。TTL 必须与客户端 '
  'purgeExpiredCloudTombstones(maxAgeDays) 保持一致（当前 30 天）。'
  '客户端为主清理路径，本函数只兜底「设备再也不上线」的休眠账号。'
  '⚠️ 本函数是 SECURITY DEFINER 且执行真 DELETE —— 已 REVOKE 掉 anon/authenticated 的'
  'EXECUTE，只留给表 owner 与 service_role（调度器用 service_role 调用）。';

-- ── 2.5) 收回默认的 EXECUTE 权限（2026-10-05 补）─────────────────────────
-- 【为什么必须做】PostgreSQL 给新函数默认授予 EXECUTE 给 PUBLIC。
-- 而 PUBLIC 包含 anon 与 authenticated —— 也就是说 anon key（随扩展产物公开）
-- 可以调 PostgREST /rest/v1/rpc/purge_expired_cloud_tombstones，让这个
-- SECURITY DEFINER 函数替他删数据。后果不只是「提前清理」：
--   * 函数对**全体用户**的到期行生效，不限于调用者自己的 → 一个匿名请求
--     就能删掉所有账号的墓碑行；
--   * 反复调用可以把「服务端兜底」这条隐私承诺（30 天后删除）提前变成事实，
--     而此时可能还有离线设备没完成删除广播 → 它们下次合并会把已删会话复活。
--
-- 对照：本仓已有的 4 个 op-stamp 守卫触发器同样是 SECURITY DEFINER，
-- 它们的 trigger 只能在写入时被动触发，攻击面比这个「可主动调用的函数」小。
REVOKE EXECUTE ON FUNCTION public.purge_expired_cloud_tombstones() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.purge_expired_cloud_tombstones() FROM anon;
REVOKE EXECUTE ON FUNCTION public.purge_expired_cloud_tombstones() FROM authenticated;
-- 调度器（Supabase Scheduled Job / pg_cron 以 postgres 角色跑）需要显式授权：
GRANT EXECUTE ON FUNCTION public.purge_expired_cloud_tombstones() TO service_role;

-- 3) 先跑一次看看有多少行会被清（只读，安全；结果直接打在迁移日志里）
DO $$
DECLARE
  v_ttl integer := public.body_tombstone_expiry_days();
  v_count bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'tab_groups'
  ) THEN
    RAISE NOTICE 'public.tab_groups 不存在，跳过（Dashboard schema 可能已变化）';
    RETURN;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.tab_groups
  WHERE is_deleted = true
    AND COALESCE(deleted_at, updated_at) < now() - (v_ttl || ' days')::interval;

  RAISE NOTICE '已到期（>% 天）的墓碑行：% 条（TTL=% 天，本次不自动执行删除）', v_ttl, v_count;

  RAISE NOTICE E'\n'
    '── 清理函数已就绪，但**尚未挂调度器**（最后一步需要你手动做）──\n'
    '客户端清理只挂在 upload 上，休眠账号的墓碑行要靠这个函数兜底。\n'
    '⚠️ 已 REVOKE 掉 PUBLIC/anon/authenticated 的 EXECUTE：anon 调不动它\n'
    '   （否则公开的 anon key 就能让这个 DEFINER 函数替所有账号删数据）。\n'
    '   调度器必须用 service_role（或表 owner / postgres）调用。\n'
    '启用方式二选一：\n'
    '  A) pg_cron（需先在 Dashboard → Database → Extensions 勾选 pg_cron）：\n'
    -- ⚠️ 这里**绝不能出现 dollar-quote 的定界符字面量**：supabase-migrate.mjs
    -- 的切分器只认它作定界符（注释里也不行，切分不看上下文），
    -- 字符串或注释里再写一次会在那个位置把语句切成两半，迁移执行时直接
    -- 语法错误。改用 $q$…$q$（不同定界符，语义等价且不冲突）。
    '     SELECT cron.schedule(''tapstack-tombstone-expiry'', ''0 3 * * *'',\n'
    '                     $q$SELECT public.purge_expired_cloud_tombstones()$q$);\n'
    '  B) Supabase Scheduled Job / 任何外部调度器，定时执行（需 service_role）：\n'
    '     SELECT * FROM public.purge_expired_cloud_tombstones();\n'
    '先干跑确认影响面（会真删，先在 staging 试）：\n'
    '  SELECT * FROM public.purge_expired_cloud_tombstones();\n'
    '  或只读查看：\n'
    '  SELECT count(*) FROM public.tab_groups\n'
    '   WHERE is_deleted = true\n'
    '     AND COALESCE(deleted_at, updated_at) < now() - interval ''30 days'';\n'
    '幂等性：重新执行本迁移会用相同定义替换函数，但 REVOKE 不会重授 EXECUTE，\n'
    '  重复执行是安全的。';
END
$$;
