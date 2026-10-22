-- 迁移 20261022120000：add_session_sort_to_user_settings
-- 说明：会话列表的排序此前是**写死**的「最近保存」（createdAt 倒序），用户没有任何
-- 排序入口（2026-10-22 审计 L-10）。现在排序键是设置项，与 layoutMode 同性质
-- （界面偏好）⇒ 允许随设置跨设备漫游。
--
-- 取值：'saved'（最近保存，默认）/ 'accessed'（最近访问）/ 'name'（名称）/
-- 'size'（会话大小 = 标签数）。
-- 默认值 'saved' 就是旧版写死的顺序 ⇒ 存量用户升级后看到的列表顺序不变。
--
-- 客户端侧已有 42703 降级（上传缺列则剔掉该列重试；下载缺列则走 DEFAULT 合并），
-- 所以本迁移执行前后都不阻塞同步 —— 先发版后执行迁移是安全的。
--
-- `not null default 'saved'`：旧客户端上传时**不带**这一列 ⇒ 走数据库默认值，
-- 不会撞 NOT NULL（23502 降级路径也就不需要为这一列兜底）。

alter table public.user_settings
  add column if not exists session_sort text not null default 'saved';
