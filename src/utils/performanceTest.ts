/**
 * 性能测试工具函数
 * 用于测量函数执行时间和性能指标
 */

/**
 * 测量函数执行时间
 * @param testName 测试名称
 * @param testFn 要测试的函数
 * @param iterations 测试迭代次数
 * @returns 测试结果，包括平均时间、最小时间和最大时间
 */
export function measurePerformance(
  testName: string,
  testFn: () => void,
  iterations: number = 10
): { avg: number; min: number; max: number } {
  console.log(`开始测试: ${testName}`);
  
  const times: number[] = [];
  
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    testFn();
    const end = performance.now();
    times.push(end - start);
  }
  
  const avg = times.reduce((sum, time) => sum + time, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);
  
  console.log(`测试结果: ${testName}`);
  console.log(`  平均时间: ${avg.toFixed(2)}ms`);
  console.log(`  最小时间: ${min.toFixed(2)}ms`);
  console.log(`  最大时间: ${max.toFixed(2)}ms`);
  
  return { avg, min, max };
}

/**
 * 监控React组件渲染性能
 * 使用React Profiler API监控组件渲染时间
 * @returns 渲染性能回调函数
 */
export function monitorRenderPerformance() {
  return (
    id: string, // 组件的 "id"
    phase: string, // "mount" 或 "update"
    actualDuration: number, // 本次渲染花费的时间
    baseDuration: number, // 估计不使用 memoization 的渲染时间
    startTime: number, // 本次更新开始渲染的时间
    commitTime: number // 本次更新被提交的时间
  ) => {
    // 记录性能数据
    if (actualDuration > 16) { // 超过16ms（60fps）的渲染
      console.warn(`组件 ${id} 渲染时间过长: ${actualDuration.toFixed(2)}ms`);
    }
    
    // 可以在这里添加更详细的性能日志或发送到性能监控服务
    if (process.env.NODE_ENV === 'development') {
      console.log(`组件 ${id} 渲染性能:`, {
        phase,
        actualDuration: `${actualDuration.toFixed(2)}ms`,
        baseDuration: `${baseDuration.toFixed(2)}ms`,
        renderTime: `${(commitTime - startTime).toFixed(2)}ms`
      });
    }
  };
}

/**
 * 生成测试用的大量标签数据
 * @param groupCount 标签组数量
 * @param tabsPerGroup 每个标签组的标签数量
 * @returns 生成的标签组数据
 */
export function generateTestData(groupCount: number, tabsPerGroup: number) {
  const groups = [];
  
  for (let i = 0; i < groupCount; i++) {
    const tabs = [];
    
    for (let j = 0; j < tabsPerGroup; j++) {
      tabs.push({
        id: `tab-${i}-${j}`,
        title: `测试标签 ${i}-${j}`,
        url: `https://example.com/page-${i}-${j}`,
        favicon: `https://example.com/favicon-${j}.ico`,
        createdAt: new Date().toISOString(),
        lastAccessed: new Date().toISOString(),
        lastSyncedAt: new Date().toISOString()
      });
    }
    
    groups.push({
      id: `group-${i}`,
      name: `测试标签组 ${i}`,
      tabs,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastSyncedAt: new Date().toISOString(),
      isLocked: i % 5 === 0, // 每5个标签组有1个锁定
      syncStatus: 'synced'
    });
  }
  
  return groups;
}

/**
 * 在控制台中显示性能比较结果
 * @param beforeResults 优化前的测试结果
 * @param afterResults 优化后的测试结果
 * @param testName 测试名称
 */
export function showPerformanceComparison(
  beforeResults: { avg: number; min: number; max: number },
  afterResults: { avg: number; min: number; max: number },
  testName: string
) {
  const avgImprovement = ((beforeResults.avg - afterResults.avg) / beforeResults.avg) * 100;
  const minImprovement = ((beforeResults.min - afterResults.min) / beforeResults.min) * 100;
  const maxImprovement = ((beforeResults.max - afterResults.max) / beforeResults.max) * 100;
  
  console.log(`性能比较: ${testName}`);
  console.log(`  平均时间改进: ${avgImprovement.toFixed(2)}%`);
  console.log(`  最小时间改进: ${minImprovement.toFixed(2)}%`);
  console.log(`  最大时间改进: ${maxImprovement.toFixed(2)}%`);
  
  if (avgImprovement > 0) {
    console.log(`  ✅ 性能提升: 优化后平均快 ${avgImprovement.toFixed(2)}%`);
  } else {
    console.log(`  ❌ 性能下降: 优化后平均慢 ${Math.abs(avgImprovement).toFixed(2)}%`);
  }
}
