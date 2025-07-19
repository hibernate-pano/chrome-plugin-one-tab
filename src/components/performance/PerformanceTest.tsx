import React, { useState } from 'react';
import { Profiler } from 'react';
import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import { TabGroup } from '@/components/tabs/TabGroup';
import { generateTestData, monitorRenderPerformance, measurePerformance } from '@/utils/performanceTest';
// 使用新版tabGroupsSlice中的setGroups功能
import { setGroups } from '@/features/tabs/store/tabGroupsSlice';

/**
 * 性能测试组件
 * 用于测试标签组和标签渲染性能
 */
const PerformanceTest: React.FC = () => {
  const dispatch = useAppDispatch();
  const groups = useAppSelector(state => state.tabGroups.groups);

  const [testResults, setTestResults] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [groupCount, setGroupCount] = useState(10);
  const [tabsPerGroup, setTabsPerGroup] = useState(20);

  // 生成测试数据
  const handleGenerateData = () => {
    setIsLoading(true);

    // 使用setTimeout避免阻塞UI
    setTimeout(() => {
      const testData = generateTestData(groupCount, tabsPerGroup);
      // 使用Redux action
      dispatch(setGroups(testData));
      setIsLoading(false);
    }, 100);
  };

  // 运行渲染性能测试
  const handleRunRenderTest = () => {
    setIsLoading(true);

    // 使用setTimeout避免阻塞UI
    setTimeout(() => {
      const result = measurePerformance(
        `渲染${groups.length}个标签组，每组${groups[0]?.tabs.length || 0}个标签`,
        () => {
          // 模拟渲染过程
          const container = document.createElement('div');
          groups.forEach(group => {
            const groupDiv = document.createElement('div');
            groupDiv.textContent = group.name;

            group.tabs.forEach(tab => {
              const tabDiv = document.createElement('div');
              tabDiv.textContent = tab.title;
              groupDiv.appendChild(tabDiv);
            });

            container.appendChild(groupDiv);
          });
        }
      );

      setTestResults(prev => [...prev, {
        name: `渲染${groups.length}个标签组，每组${groups[0]?.tabs.length || 0}个标签`,
        ...result,
        timestamp: new Date().toISOString()
      }]);

      setIsLoading(false);
    }, 100);
  };

  // 运行搜索性能测试
  const handleRunSearchTest = () => {
    setIsLoading(true);

    // 使用setTimeout避免阻塞UI
    setTimeout(() => {
      const result = measurePerformance(
        `搜索${groups.length}个标签组中的标签`,
        () => {
          // 模拟搜索过程
          const searchQuery = 'test';
          groups.filter(group => {
            if (group.name.toLowerCase().includes(searchQuery)) return true;

            return group.tabs.some(tab =>
              tab.title.toLowerCase().includes(searchQuery) ||
              tab.url.toLowerCase().includes(searchQuery)
            );
          });
        }
      );

      setTestResults(prev => [...prev, {
        name: `搜索${groups.length}个标签组中的标签`,
        ...result,
        timestamp: new Date().toISOString()
      }]);

      setIsLoading(false);
    }, 100);
  };

  // 清除测试结果
  const handleClearResults = () => {
    setTestResults([]);
  };

  return (
    <div className="p-4">
      <h1 className="text-2xl font-bold mb-4">性能测试</h1>

      <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-md">
        <h2 className="text-lg font-semibold mb-2">测试数据生成</h2>
        <div className="flex flex-wrap gap-4 mb-4">
          <div>
            <label className="block text-sm mb-1">标签组数量</label>
            <input
              type="number"
              value={groupCount}
              onChange={e => setGroupCount(parseInt(e.target.value) || 1)}
              className="border rounded px-2 py-1 w-24"
              min="1"
              max="100"
            />
          </div>
          <div>
            <label className="block text-sm mb-1">每组标签数量</label>
            <input
              type="number"
              value={tabsPerGroup}
              onChange={e => setTabsPerGroup(parseInt(e.target.value) || 1)}
              className="border rounded px-2 py-1 w-24"
              min="1"
              max="500"
            />
          </div>
        </div>
        <button
          onClick={handleGenerateData}
          disabled={isLoading}
          className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600 disabled:opacity-50"
        >
          {isLoading ? '生成中...' : '生成测试数据'}
        </button>
      </div>

      <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-md">
        <h2 className="text-lg font-semibold mb-2">运行测试</h2>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={handleRunRenderTest}
            disabled={isLoading || groups.length === 0}
            className="bg-green-500 text-white px-4 py-2 rounded hover:bg-green-600 disabled:opacity-50"
          >
            {isLoading ? '测试中...' : '测试渲染性能'}
          </button>
          <button
            onClick={handleRunSearchTest}
            disabled={isLoading || groups.length === 0}
            className="bg-purple-500 text-white px-4 py-2 rounded hover:bg-purple-600 disabled:opacity-50"
          >
            {isLoading ? '测试中...' : '测试搜索性能'}
          </button>
          <button
            onClick={handleClearResults}
            disabled={isLoading || testResults.length === 0}
            className="bg-red-500 text-white px-4 py-2 rounded hover:bg-red-600 disabled:opacity-50"
          >
            清除测试结果
          </button>
        </div>
      </div>

      {testResults.length > 0 && (
        <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-md">
          <h2 className="text-lg font-semibold mb-2">测试结果</h2>
          <div className="overflow-x-auto">
            <table className="min-w-full bg-white dark:bg-gray-700 rounded-md">
              <thead>
                <tr className="bg-gray-100 dark:bg-gray-800">
                  <th className="py-2 px-4 text-left">测试名称</th>
                  <th className="py-2 px-4 text-left">平均时间 (ms)</th>
                  <th className="py-2 px-4 text-left">最小时间 (ms)</th>
                  <th className="py-2 px-4 text-left">最大时间 (ms)</th>
                  <th className="py-2 px-4 text-left">时间戳</th>
                </tr>
              </thead>
              <tbody>
                {testResults.map((result, index) => (
                  <tr key={index} className={index % 2 === 0 ? 'bg-white dark:bg-gray-700' : 'bg-gray-50 dark:bg-gray-800'}>
                    <td className="py-2 px-4">{result.name}</td>
                    <td className="py-2 px-4">{result.avg.toFixed(2)}</td>
                    <td className="py-2 px-4">{result.min.toFixed(2)}</td>
                    <td className="py-2 px-4">{result.max.toFixed(2)}</td>
                    <td className="py-2 px-4">{new Date(result.timestamp).toLocaleTimeString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="mb-6">
        <h2 className="text-lg font-semibold mb-2">当前数据</h2>
        <div className="bg-gray-50 dark:bg-gray-800 p-2 rounded-md">
          <p>标签组数量: {groups.length}</p>
          <p>总标签数量: {groups.reduce((sum, group) => sum + group.tabs.length, 0)}</p>
        </div>
      </div>

      {/* 使用Profiler包装实际的标签组列表，监控渲染性能 */}
      <Profiler id="TabGroupList" onRender={monitorRenderPerformance()}>
        <div className="space-y-4 max-h-96 overflow-y-auto">
          {groups.slice(0, 5).map(group => (
            <TabGroup key={group.id} group={group} />
          ))}
          {groups.length > 5 && (
            <div className="text-center text-gray-500 py-2">
              显示前5个标签组，共{groups.length}个
            </div>
          )}
        </div>
      </Profiler>
    </div>
  );
};

export default PerformanceTest;
