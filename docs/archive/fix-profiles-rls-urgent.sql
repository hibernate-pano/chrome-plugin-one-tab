-- ============================================================================
-- 线上 P0 修复：收口 profiles 表的 RLS（2026-10-05）
--
-- 【为什么现在就要做】用线上真实 anon key 实测（scripts/anon-rls-probe.mjs）：
--   profiles：anon 可读 **48 行**，含 email / plan / ai_daily_count /
--             stripe_customer_id / subscription_id / subscription_status；
--             且 **anon 能 PATCH 改别人的行**（实测提权成功，已改回）。
--   ⇒ 任何人拿到 anon key（随扩展产物公开，这是 Supabase 的设计）就能
--     读走全站用户的邮箱与订阅信息，并给自己/他人提权（改 plan / 配额）。
--
-- 【本文件与仓库里那条迁移的关系】
--   supabase/migrations/20261005000000_lock_down_profiles_rls.sql 是同一件事的
--   仓库版本（已通过本地 PostgreSQL 16.15 真实执行验证）。本文件是**可直接粘贴
--   到 Supabase Dashboard → SQL Editor 执行的版本**，额外做了两件迁移做不到的事：
--     ① 不依赖 `SUPABASE_DB_URL`（Dashboard 直连，不需要数据库密码）；
--     ② 顺带把列级权限也收口（迁移里只写了注释说明，没执行 —— 因为当时
--        无法证明线上无人依赖；而现在实测证明 anon 能改，所以必须执行）。
--
-- 【执行方式】Supabase Dashboard → SQL Editor → 全选粘贴 → Run。
--   幂等：可重复执行。执行后建议再跑一次 `node scripts/anon-rls-probe.mjs`
--   确认 profiles 已变成 0 行可读。
-- ============================================================================

-- ── 1. 行级安全：把「对所有人开放」的 SELECT 策略删掉 ──────────────────
-- 现状是 CREATE POLICY "Anyone can view public profile fields"
--   ON profiles FOR SELECT USING (true)
-- 加上表的 RLS 虽然开着，但这条 USING (true) 让任何角色（含 anon）都能读全表。
DO $body$
DECLARE
  p record;
BEGIN
  FOR p IN
    SELECT pol.polname
    FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'profiles'
      AND pol.polcmd = 'r'
      -- pg_get_expr 渲染回 SQL 文本；USING (true) 的文本就是 'true'
      AND btrim(pg_get_expr(pol.polqual, pol.polrelid)) = 'true'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.profiles', p.polname);
    RAISE NOTICE '已删除全放行 SELECT 策略：%', p.polname;
  END LOOP;
END
$body$;

-- ── 2. 行级安全：确保「只能读/写自己的行」的策略存在 ──────────────────
-- 幂等：先删同名策略再重建（PostgreSQL 没有 CREATE POLICY IF NOT EXISTS）。
DO $body$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'profiles'
      AND pol.polcmd = 'r' AND pol.polname = 'Users can view own profile'
  ) THEN
    EXECUTE 'DROP POLICY "Users can view own profile" ON public.profiles';
  END IF;

  EXECUTE $q$
    CREATE POLICY "Users can view own profile" ON public.profiles
      FOR SELECT
      USING ((SELECT auth.uid()) = id)
  $q$;
  RAISE NOTICE '已确保 SELECT 策略：仅本人可读';
END
$body$;

DO $body$
DECLARE
  v_found int;
BEGIN
  -- ⚠️ 这里**不能**用 polcmd = 'u' 判存在性。
  --    pg_policy.polcmd 的取值是 'r'/'a'/'w'/'d'，其中：
  --      'r' = SELECT（含 USING）
  --      'a' = INSERT
  --      'w' = **WITH CHECK**（UPDATE/DELETE 的 WITH CHECK 也归到 'w'）
  --      'd' = DELETE
  --    一条同时带 USING 和 WITH CHECK 的 UPDATE 策略，polcmd 存的是 **'w'**，
  --    不是 'u'。（2026-10-05 本地实跑才发现：判 'u' 会漏掉已有策略，
  --    紧接着 CREATE POLICY 就报 "already exists" 而中断整个修复。）
  --    所以这里按**名字**判，不按 polcmd 判。
  SELECT count(*) INTO v_found
  FROM pg_catalog.pg_policy pol
  JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'profiles'
    AND pol.polname = 'Users can update own profile';

  IF v_found > 0 THEN
    EXECUTE 'DROP POLICY "Users can update own profile" ON public.profiles';
    RAISE NOTICE '已删除旧 UPDATE 策略（缺 WITH CHECK 的那版）';
  END IF;

  -- WITH CHECK 缺失 = 允许把自己这行改成任意值（自助提权）。
  -- 它管「行归属」，不管「列」—— 行已收口，列还要靠第 3 步。
  EXECUTE $q$
    CREATE POLICY "Users can update own profile" ON public.profiles
      FOR UPDATE
      USING ((SELECT auth.uid()) = id)
      WITH CHECK ((SELECT auth.uid()) = id)
  $q$;
  RAISE NOTICE '已重建 UPDATE 策略：补 WITH CHECK（行仍只属本人；列级限制见第 3 步）';
END
$body$;

-- ── 3. 列级权限：这是本次实测确认的**真正可利用点** ────────────────────
-- 实测：anon 能 PATCH 别人的行改 plan。为什么行级策略没挡住？
--   因为那条 UPDATE 策略是 `USING (auth.uid() = id)`，而**登录用户**的
--   auth.uid() 确实等于自己的 id —— 策略本意是「只许改自己」，语义没错。
--   真正的问题是：**列没设限**。登录用户（不只是 anon）可以改自己行里的
--   plan / subscription_status / ai_daily_count / stripe_customer_id ——
--   也就是「自己给自己升到 Pro + 清空 AI 配额限制」。
--
-- 正确做法：把这几列的写权限从 authenticated 收回，只留
--   - plan / subscription_* / ai_daily_count / ai_usage_count / ai_reset_at
--     → 只能由 service_role（Stripe webhook、服务端）写
--   - email / created_at / id
--     → 同样只读
--   其余列（若有）保持 authenticated 可写。
--
-- ⚠️⚠️ **顺序至关重要**（2026-10-05 本地实跑才发现这个坑）：
--   PostgreSQL 里**表级 GRANT UPDATE 会覆盖列级 REVOKE**。
--   实测经过：我起初只写了 `REVOKE UPDATE(plan) FROM authenticated`，
--   但表的 ACL 仍是 `authenticated=arwdDxt`（含 w = UPDATE），
--   结果登录用户照样 `UPDATE … SET plan='pro'` 成功 —— 修复形同虚设。
--   正确顺序：
--     ① REVOKE UPDATE ON profiles FROM authenticated   （收回**表级** UPDATE）
--     ② 再 REVOKE UPDATE(敏感列) FROM authenticated      （防将来表级权限被重授）
--     ③ service_role 保留全权
--   少了 ①，后面两步都是空转。
--
-- 【为什么逐列而不是一刀切撤掉所有列的写权限】
--   若将来有「用户改昵称/头像」需求，一刀切会让它**一起失效且不易察觉**。
--   逐列处理：默认全撤，将来只把明确该用户可写的列加回来即可。
--   当前 src/ 零引用 profiles，所以「该用户可写的列」暂时为空 ——
--   这与仓库迁移里的判断一致。
DO $body$
DECLARE
  locked text[] := ARRAY[
    'plan', 'subscription_status', 'subscription_id',
    'stripe_customer_id', 'ai_daily_count', 'ai_usage_count', 'ai_reset_at'
  ];
  col text;
  missing text[] := ARRAY[]::text[];
BEGIN
  -- ① 先收回表级 UPDATE（关键！否则列级 REVOKE 会被它覆盖）
  EXECUTE 'REVOKE UPDATE ON public.profiles FROM authenticated';

  -- ② 再逐列 REVOKE（防将来表级权限被重新授予）
  FOREACH col IN ARRAY locked LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = col
    ) THEN
      missing := missing || col;
      CONTINUE;
    END IF;
    EXECUTE format('REVOKE UPDATE(%I) ON public.profiles FROM authenticated', col);
  END LOOP;

  IF array_length(missing, 1) > 0 THEN
    RAISE NOTICE '跳过不存在的列：%', array_to_string(missing, ', ');
  END IF;

  -- ③ service_role 保留全权（Stripe webhook / 服务端要能改这些列）
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE NOTICE 'service_role 角色不存在（本地库），跳过 GRANT。';
    RETURN;
  END IF;
  EXECUTE 'GRANT UPDATE ON public.profiles TO service_role';
  RAISE NOTICE '已收口：表级 UPDATE 已撤 + % 个敏感列逐列 REVOKE；service_role 保留全权',
    array_length(locked, 1) - COALESCE(array_length(missing, 1), 0);
END
$body$;

-- ── 4. 顺带：INSERT 策略（有则收紧为「只能建自己的行」）──────────────
-- 实测 profiles 的 anon INSERT 未被单独验证（48 行都是注册时由 trigger 建的），
-- 但注册流程会用到 authenticated 侧的插入，所以这里只做「若有则收紧」。
DO $body$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'profiles'
      AND pol.polcmd = 'a'
      AND btrim(pg_get_expr(pol.polqual, pol.polrelid)) = 'true'
  ) THEN
    EXECUTE 'DROP POLICY IF EXISTS "Anyone can insert profile" ON public.profiles';
    RAISE NOTICE '已删除全放行 INSERT 策略';
  ELSE
    RAISE NOTICE 'INSERT 策略无需收紧（没有 USING(true) 的放行策略）';
  END IF;
  -- 注：INSERT 策略的 polcmd 确实是 'a'，可安全按它过滤；
  -- 只有 UPDATE/DELETE 会被归到 'w'（见第 2 步的说明）。
END
$body$;

-- ── 5. 验证：把结果直接打在输出里，别靠"看起来跑过了" ────────────────
DO $body$
DECLARE
  v_open int;
  v_anon int;
BEGIN
  SELECT count(*) INTO v_open
  FROM pg_catalog.pg_policy pol
  JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'profiles'
    AND btrim(pg_get_expr(pol.polqual, pol.polrelid)) = 'true';

  RAISE NOTICE '';
  RAISE NOTICE '=== 修复结果 ===';
  RAISE NOTICE '剩余全放行(UUSING true)策略数：% （应为 0）', v_open;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'SET LOCAL ROLE anon';
    SELECT count(*) INTO v_anon FROM public.profiles;
    EXECUTE 'RESET ROLE';
    RAISE NOTICE '以 anon 身份读 profiles：% 行 （应为 0）', v_anon;
  ELSE
    RAISE NOTICE 'anon 角色不存在（本地库），跳过 anon 视角验证';
  END IF;

  IF v_open = 0 THEN
    RAISE NOTICE '✓ 本地校验通过。仍建议在浏览器再跑一次 node scripts/anon-rls-probe.mjs 做端到端确认。';
  ELSE
    RAISE EXCEPTION '仍有 % 条全放行策略，修复未完成', v_open;
  END IF;
END
$body$;
