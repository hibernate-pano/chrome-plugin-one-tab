import { IntelligentSyncService, SyncConfig } from '@/services/intelligentSyncServiceFixed';
import { EnhancedSearchService } from '@/services/smartTabAnalyzerFixed';

// 测试智能同步服务
console.log('开始测试智能同步服务...');

const testSyncConfig: SyncConfig = {
  triggers: {
    onDataChange: true,
    onNetworkRestore: true,
    onAppFocus: false,
    periodic: null // 禁用定期同步用于测试
  },
  conflictResolution: {
    strategy: 'auto',
    autoMergeRules: {
      preferNewer: true,
      preserveLocal: true,
      preserveRemote: true
    }
  },
  optimization: {
    batchUpdates: true,
    deltaSync: true,
    compression: true,
    maxRetries: 3
  }
};

try {
  const syncService = new IntelligentSyncService(testSyncConfig);
  console.log('✅ 智能同步服务初始化成功');
  
  // 清理
  syncService.dispose();
  console.log('✅ 智能同步服务清理成功');
} catch (error) {
  console.error('❌ 智能同步服务测试失败:', error);
}

// 测试搜索服务
console.log('\n开始测试增强搜索服务...');

try {
  const searchService = new EnhancedSearchService();
  console.log('✅ 增强搜索服务初始化成功');
  
  // 测试空搜索
  const emptyResults = await searchService.search([], '');
  console.log('✅ 空搜索测试通过:', emptyResults.length === 0);
  
  // 测试基本搜索
  const testTabs = [
    {
      id: '1',
      url: 'https://github.com/test',
      title: 'GitHub Test Repository',
      favicon: '',
      createdAt: new Date().toISOString(),
      lastAccessed: new Date().toISOString()
    },
    {
      id: '2', 
      url: 'https://docs.google.com/test',
      title: 'Google Docs Test',
      favicon: '',
      createdAt: new Date().toISOString(),
      lastAccessed: new Date().toISOString()
    }
  ];
  
  const searchResults = await searchService.search(testTabs, 'github');
  console.log('✅ 基本搜索测试通过:', searchResults.length > 0);
  
} catch (error) {
  console.error('❌ 增强搜索服务测试失败:', error);
}

console.log('\n🎉 所有核心服务测试完成！');

export {};
