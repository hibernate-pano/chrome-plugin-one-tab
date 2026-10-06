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
--
-- ⚠️ 用 DO 块包起来、且逐个角色判断存在性（2026-10-05 真实执行才发现）：
--   `REVOKE ... FROM anon` 在**该角色不存在**的库里会直接
--   ERROR: role "anon" does not exist —— 而 supabase-migrate.mjs 是
--   单次 multi-statement query（整文件隐式单事务），一报错**整条迁移回滚**，
--   留下「函数建了但权限没收回」的半成品：比不跑更危险，因为它看起来跑过了。
--   （本机复现：PostgreSQL 16 上无 anon 角色 → 迁移在第一条 REVOKE 就中断。）
--   DO 块里用 pg_roles 判存在性，缺角色就跳过，两个环境都能安全执行。
--   PUBLIC 是内建角色、恒存在，可以直接写。
REVOKE EXECUTE ON FUNCTION public.body_tombstone_expiry_days() FROM PUBLIC;

DO $body$
DECLARE
  missing text[];
  r_name text;
BEGIN
  -- ⚠️ 用显式 FOR 循环而不是 `unnest(...) AS r` + WHERE：
  --    集合别名在 PG 里不能在同一层查询的 WHERE 中引用，会报
  --    "missing FROM-clause entry for table r"（2026-10-05 本地实跑才发现）。
  missing := ARRAY[]::text[];
  FOREACH r_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r_name) THEN
      missing := missing || r_name;
    END IF;
  END LOOP;

  IF array_length(missing, 1) > 0 THEN
    RAISE NOTICE '跳过不存在的角色：%', array_to_string(missing, ', ');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RETURN;
  END IF;

  EXECUTE 'REVOKE EXECUTE ON FUNCTION public.body_tombstone_expiry_days() FROM anon';
  EXECUTE 'REVOKE EXECUTE ON FUNCTION public.body_tombstone_expiry_days() FROM authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.body_tombstone_expiry_days() TO service_role';
END
$body$;

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
--
-- ⚠️ 同样用 DO 块 + 角色存在性判断（理由见上面 TTL 常量处的注释）：
--   角色不存在时直接 REVOKE 会 ERROR → 整条迁移回滚 → 留下半成品。
REVOKE EXECUTE ON FUNCTION public.purge_expired_cloud_tombstones() FROM PUBLIC;

DO $body$
DECLARE
  missing text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'anon / authenticated / service_role 角色不存在（非 Supabase 环境），跳过 REVOKE/GRANT。';
    RETURN;
  END IF;

  EXECUTE 'REVOKE EXECUTE ON FUNCTION public.purge_expired_cloud_tombstones() FROM anon';
  EXECUTE 'REVOKE EXECUTE ON FUNCTION public.purge_expired_cloud_tombstones() FROM authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.purge_expired_cloud_tombstones() TO service_role';
END
$body$;

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

  -- ⚠️ 文案里不能出现「>%」：RAISE 把 % 当占位符，`>%` 会被解析成
  -- 「> 加一个参数」，而这里只传了 2 个参数 ⇒ ERROR: too few parameters。
  -- （2026-10-05 真实执行才发现；静态检查与 dry-run 都不会暴露。）
  -- 改用「超过 N 天」的中文表述，彻底避开 % 号。
  RAISE NOTICE '已到期（超过 % 天）的墓碑行：% 条（TTL=% 天，本次不自动执行删除）', v_ttl, v_count, v_ttl;

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
    '     SELECT cron.schedule(''tapstack-tombstone-expiry'', ''0 3 * * 1'',\n'
    '                     $q$SELECT public.purge_expired_cloud_tombstones()$q$);\n'
    '  B) Supabase Scheduled Job / 任何外部调度器，定时执行（需 service_role）：\n'
    '     SELECT * FROM public.purge_expired_cloud_tombstones();\n'
    '先干跑确认影响面（会真删，先在 staging 试，当前线上为每周一 03:00 UTC）：\n'
    '  SELECT * FROM public.purge_expired_cloud_tombstones();\n'
    '  或只读查看：\n'
    '  SELECT count(*) FROM public.tab_groups\n'
    '   WHERE is_deleted = true\n'
    '     AND COALESCE(deleted_at, updated_at) < now() - interval ''30 days'';\n'
    '幂等性：重新执行本迁移会用相同定义替换函数，但 REVOKE 不会重授 EXECUTE，\n'
    '  重复执行是安全的。';
END
$$;
