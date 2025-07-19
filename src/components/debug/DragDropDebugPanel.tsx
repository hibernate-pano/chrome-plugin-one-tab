/**
 * 拖拽调试面板
 * 用于测试和验证拖拽功能的修复效果
 */

import React, { useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/app/store/hooks';
import { moveTab } from '@/features/tabs/store/dragOperationsSlice';
import { loadGroups } from '@/features/tabs/store/tabGroupsSlice';

export const DragDropDebugPanel: React.FC = () => {
  const dispatch = useAppDispatch();
  const { groups, isLoading, error } = useAppSelector(state => state.tabGroups);
  const { isProcessing } = useAppSelector(state => state.dragOperations);
  
  const [testResults, setTestResults] = useState<string[]>([]);

  const addTestResult = (result: string) => {
    setTestResults(prev => [...prev, `${new Date().toLocaleTimeString()}: ${result}`]);
  };

  const testDragDrop = async () => {
    if (groups.length < 2) {
      addTestResult('❌ 需要至少2个标签组来测试拖拽功能');
      return;
    }

    const sourceGroup = groups[0];
    const targetGroup = groups[1];

    if (sourceGroup.tabs.length === 0) {
      addTestResult('❌ 源标签组没有标签可以拖拽');
      return;
    }

    addTestResult('🚀 开始测试拖拽功能...');
    
    try {
      // 记录拖拽前的状态
      const beforeState = {
        sourceTabsCount: sourceGroup.tabs.length,
        targetTabsCount: targetGroup.tabs.length,
        movedTabTitle: sourceGroup.tabs[0].title,
      };
      
      addTestResult(`📊 拖拽前状态: 源组${beforeState.sourceTabsCount}个标签, 目标组${beforeState.targetTabsCount}个标签`);
      
      // 执行拖拽操作
      const startTime = performance.now();
      
      await dispatch(moveTab({
        sourceGroupId: sourceGroup.id,
        sourceIndex: 0,
        targetGroupId: targetGroup.id,
        targetIndex: 0,
      }));
      
      const endTime = performance.now();
      const duration = endTime - startTime;
      
      // 检查拖拽后的状态
      const updatedGroups = groups;
      const updatedSourceGroup = updatedGroups.find(g => g.id === sourceGroup.id);
      const updatedTargetGroup = updatedGroups.find(g => g.id === targetGroup.id);
      
      if (updatedSourceGroup && updatedTargetGroup) {
        const afterState = {
          sourceTabsCount: updatedSourceGroup.tabs.length,
          targetTabsCount: updatedTargetGroup.tabs.length,
        };
        
        addTestResult(`📊 拖拽后状态: 源组${afterState.sourceTabsCount}个标签, 目标组${afterState.targetTabsCount}个标签`);
        addTestResult(`⏱️ 拖拽操作耗时: ${duration.toFixed(2)}ms`);
        
        // 验证拖拽结果
        if (afterState.sourceTabsCount === beforeState.sourceTabsCount - 1 &&
            afterState.targetTabsCount === beforeState.targetTabsCount + 1) {
          addTestResult('✅ 拖拽功能正常工作！');
        } else {
          addTestResult('❌ 拖拽结果不正确');
        }
      }
      
    } catch (error) {
      addTestResult(`❌ 拖拽操作失败: ${error}`);
    }
  };

  const clearResults = () => {
    setTestResults([]);
  };

  const refreshGroups = () => {
    dispatch(loadGroups());
    addTestResult('🔄 重新加载标签组数据');
  };

  if (process.env.NODE_ENV !== 'development') {
    return null;
  }

  return (
    <div className="fixed bottom-4 right-4 w-96 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg shadow-lg p-4 z-50">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
          拖拽调试面板
        </h3>
        <div className="flex space-x-2">
          {isLoading && (
            <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          )}
          {isProcessing && (
            <div className="w-4 h-4 bg-yellow-500 rounded-full animate-pulse"></div>
          )}
        </div>
      </div>

      <div className="space-y-2 mb-4">
        <button
          onClick={testDragDrop}
          disabled={isLoading || isProcessing}
          className="w-full px-3 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          测试拖拽功能
        </button>
        
        <div className="flex space-x-2">
          <button
            onClick={refreshGroups}
            disabled={isLoading}
            className="flex-1 px-3 py-1 bg-gray-500 text-white rounded hover:bg-gray-600 disabled:opacity-50"
          >
            刷新数据
          </button>
          
          <button
            onClick={clearResults}
            className="flex-1 px-3 py-1 bg-red-500 text-white rounded hover:bg-red-600"
          >
            清空日志
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-3 p-2 bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300 rounded text-sm">
          错误: {error}
        </div>
      )}

      <div className="space-y-1">
        <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">测试日志:</h4>
        <div className="max-h-40 overflow-y-auto bg-gray-50 dark:bg-gray-700 rounded p-2 text-xs">
          {testResults.length === 0 ? (
            <div className="text-gray-500 dark:text-gray-400">暂无测试记录</div>
          ) : (
            testResults.map((result, index) => (
              <div key={index} className="mb-1 text-gray-800 dark:text-gray-200">
                {result}
              </div>
            ))
          )}
        </div>
      </div>

      <div className="mt-3 text-xs text-gray-500 dark:text-gray-400">
        当前标签组: {groups.length} 个
      </div>
    </div>
  );
};
