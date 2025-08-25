-- 为 tab_groups 表添加 version 列的迁移脚本
-- 执行时间：2024年

-- 1. 添加 version 列，默认值为 1
ALTER TABLE tab_groups 
ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1 NOT NULL;

-- 2. 为现有数据设置版本号
-- 如果数据已存在但 version 为 NULL，设置为 1
UPDATE tab_groups 
SET version = 1 
WHERE version IS NULL;

-- 3. 添加索引以提高查询性能（可选）
CREATE INDEX IF NOT EXISTS idx_tab_groups_version 
ON tab_groups(version);

-- 4. 添加索引组合以提高同步查询性能
CREATE INDEX IF NOT EXISTS idx_tab_groups_user_version 
ON tab_groups(user_id, version);

-- 5. 添加注释说明
COMMENT ON COLUMN tab_groups.version IS '乐观锁版本号，用于冲突检测和数据同步';

-- 6. 验证迁移结果
-- 检查列是否成功添加
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'tab_groups' 
        AND column_name = 'version'
    ) THEN
        RAISE EXCEPTION 'Migration failed: version column was not added to tab_groups table';
    END IF;
    
    RAISE NOTICE 'Migration successful: version column added to tab_groups table';
END $$;

-- 7. 显示迁移后的表结构（用于验证）
SELECT 
    column_name,
    data_type,
    is_nullable,
    column_default
FROM information_schema.columns 
WHERE table_name = 'tab_groups' 
ORDER BY ordinal_position;
