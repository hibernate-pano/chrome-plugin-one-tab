-- 迁移 20261011190000：add_sync_interval_minutes_to_user_settings
-- 说明：1.23.0 自动同步默认关闭 + 四档间隔（5/10/30/60 分钟），档位需随设置漫游。
-- sync_enabled 列已存在（历史版本建的），只需补 sync_interval_minutes。
-- 客户端侧已有 42703 降级（上传缺列则忽略该字段重试；下载缺列则走 DEFAULT 合并），
-- 所以本迁移执行前后都不阻塞同步 —— 先发版后执行迁移是安全的。

alter table public.user_settings
  add column if not exists sync_interval_minutes integer not null default 10;
