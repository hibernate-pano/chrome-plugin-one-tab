#!/usr/bin/env node

/**
 * Store迁移脚本
 * 自动化处理从旧版store到新版store的迁移
 */

const fs = require('fs');
const path = require('path');

// 需要更新的文件列表
const FILES_TO_UPDATE = [
  'src/popup/App.tsx',
  'src/components/search/SearchResultList.tsx',
  'src/components/auth/UserProfile.tsx',
  'src/components/layout/Header.tsx',
  'src/components/performance/PerformanceTest.tsx',
  'src/components/sync/SyncSettings.tsx',
  'src/components/layout/SimpleThemeToggle.tsx',
  'src/components/tabs/ImprovedTabList.tsx',
  'src/components/auth/RegisterForm.tsx',
  'src/components/auth/LoginForm.tsx',
  'src/components/layout/HeaderDropdown.tsx',
  'src/components/tabs/TabList.tsx'
];

// 状态路径映射
const STATE_PATH_MAPPINGS = {
  'state.tabs.groups': 'state.tabGroups.groups',
  'state.tabs.isLoading': 'state.tabGroups.isLoading',
  'state.tabs.error': 'state.tabGroups.error',
  'state.tabs.syncStatus': 'state.sync.status',
  'state.tabs.lastSyncTime': 'state.sync.lastSyncTime',
  'state.tabs.backgroundSync': 'state.sync.backgroundSync'
};

// 导入路径替换
const IMPORT_REPLACEMENTS = [
  {
    from: "import { useAppDispatch, useAppSelector } from '@/store/hooks';",
    to: "import { useAppDispatch, useAppSelector } from '@/app/store/hooks';"
  },
  {
    from: "from '@/store/slices/tabSlice'",
    to: "from '@/features/tabs/store/tabGroupsSlice'"
  },
  {
    from: "from '@/store/slices/authSlice'",
    to: "from '@/features/auth/store/authSlice'"
  }
];

/**
 * 备份文件
 */
function backupFile(filePath) {
  const backupPath = `${filePath}.backup.${Date.now()}`;
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backupPath);
    console.log(`✅ 备份文件: ${filePath} -> ${backupPath}`);
    return backupPath;
  }
  return null;
}

/**
 * 更新文件内容
 */
function updateFileContent(filePath) {
  if (!fs.existsSync(filePath)) {
    console.log(`⚠️  文件不存在: ${filePath}`);
    return false;
  }

  let content = fs.readFileSync(filePath, 'utf8');
  let hasChanges = false;

  // 备份原文件
  backupFile(filePath);

  // 替换导入路径
  IMPORT_REPLACEMENTS.forEach(replacement => {
    if (content.includes(replacement.from)) {
      content = content.replace(new RegExp(replacement.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), replacement.to);
      hasChanges = true;
      console.log(`🔄 更新导入: ${filePath}`);
    }
  });

  // 替换状态路径
  Object.entries(STATE_PATH_MAPPINGS).forEach(([oldPath, newPath]) => {
    if (content.includes(oldPath)) {
      content = content.replace(new RegExp(oldPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), newPath);
      hasChanges = true;
      console.log(`🔄 更新状态路径: ${oldPath} -> ${newPath} in ${filePath}`);
    }
  });

  if (hasChanges) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`✅ 更新完成: ${filePath}`);
    return true;
  } else {
    console.log(`ℹ️  无需更新: ${filePath}`);
    return false;
  }
}

/**
 * 主迁移函数
 */
function migrateStore() {
  console.log('🚀 开始Store迁移...\n');

  let updatedCount = 0;
  let errorCount = 0;

  FILES_TO_UPDATE.forEach(filePath => {
    try {
      if (updateFileContent(filePath)) {
        updatedCount++;
      }
    } catch (error) {
      console.error(`❌ 更新失败: ${filePath}`, error.message);
      errorCount++;
    }
  });

  console.log('\n📊 迁移结果:');
  console.log(`✅ 成功更新: ${updatedCount} 个文件`);
  console.log(`❌ 更新失败: ${errorCount} 个文件`);

  if (errorCount === 0) {
    console.log('\n🎉 Store迁移完成！');
  } else {
    console.log('\n⚠️  迁移过程中遇到错误，请检查日志');
  }
}

// 执行迁移
if (require.main === module) {
  migrateStore();
}

module.exports = { migrateStore, updateFileContent, backupFile };
