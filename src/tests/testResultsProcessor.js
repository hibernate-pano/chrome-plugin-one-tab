/**
 * Jest测试结果处理器
 * 生成详细的测试报告和覆盖率分析
 */

const fs = require('fs');
const path = require('path');

/**
 * 处理测试结果
 * @param {Object} results Jest测试结果对象
 * @returns {Object} 处理后的结果
 */
function processResults(results) {
  const {
    numTotalTests,
    numPassedTests,
    numFailedTests,
    numPendingTests,
    testResults,
    coverageMap,
    startTime,
    success
  } = results;

  // 计算测试统计
  const testStats = {
    total: numTotalTests,
    passed: numPassedTests,
    failed: numFailedTests,
    pending: numPendingTests,
    passRate: numTotalTests > 0 ? (numPassedTests / numTotalTests * 100).toFixed(2) : 0,
    duration: Date.now() - startTime
  };

  // 分析测试文件
  const fileStats = testResults.map(result => {
    const relativePath = path.relative(process.cwd(), result.testFilePath);
    
    return {
      file: relativePath,
      numTests: result.numPassingTests + result.numFailingTests + result.numPendingTests,
      passed: result.numPassingTests,
      failed: result.numFailingTests,
      pending: result.numPendingTests,
      duration: result.perfStats.end - result.perfStats.start,
      coverage: extractFileCoverage(result.testFilePath, coverageMap)
    };
  });

  // 生成报告
  const report = {
    timestamp: new Date().toISOString(),
    success,
    stats: testStats,
    files: fileStats,
    slowTests: findSlowTests(fileStats),
    failedTests: findFailedTests(testResults),
    coverage: analyzeCoverage(coverageMap)
  };

  // 保存报告
  saveReport(report);

  // 输出摘要
  printSummary(report);

  return results;
}

/**
 * 提取文件覆盖率信息
 * @param {string} testFilePath 测试文件路径
 * @param {Object} coverageMap 覆盖率映射
 * @returns {Object} 覆盖率信息
 */
function extractFileCoverage(testFilePath, coverageMap) {
  if (!coverageMap) return null;

  // 尝试找到对应的源文件
  const sourceFile = testFilePath
    .replace('__tests__/', '')
    .replace('.test.', '.')
    .replace('.spec.', '.');

  const coverage = coverageMap[sourceFile];
  if (!coverage) return null;

  return {
    lines: coverage.lines,
    functions: coverage.functions,
    branches: coverage.branches,
    statements: coverage.statements
  };
}

/**
 * 查找慢测试
 * @param {Array} fileStats 文件统计
 * @returns {Array} 慢测试列表
 */
function findSlowTests(fileStats) {
  return fileStats
    .filter(file => file.duration > 1000) // 超过1秒的测试
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 10) // 取前10个最慢的
    .map(file => ({
      file: file.file,
      duration: file.duration,
      testsCount: file.numTests
    }));
}

/**
 * 查找失败的测试
 * @param {Array} testResults 测试结果
 * @returns {Array} 失败测试列表
 */
function findFailedTests(testResults) {
  const failedTests = [];

  testResults.forEach(result => {
    if (result.numFailingTests > 0) {
      result.testResults.forEach(test => {
        if (test.status === 'failed') {
          failedTests.push({
            file: path.relative(process.cwd(), result.testFilePath),
            testName: test.fullName,
            error: test.failureMessages[0],
            duration: test.duration
          });
        }
      });
    }
  });

  return failedTests;
}

/**
 * 分析覆盖率
 * @param {Object} coverageMap 覆盖率映射
 * @returns {Object} 覆盖率分析
 */
function analyzeCoverage(coverageMap) {
  if (!coverageMap) return null;

  const files = Object.keys(coverageMap);
  let totalLines = 0;
  let coveredLines = 0;
  let totalFunctions = 0;
  let coveredFunctions = 0;
  let totalBranches = 0;
  let coveredBranches = 0;
  let totalStatements = 0;
  let coveredStatements = 0;

  const lowCoverageFiles = [];

  files.forEach(file => {
    const coverage = coverageMap[file];
    
    totalLines += coverage.lines.total;
    coveredLines += coverage.lines.covered;
    totalFunctions += coverage.functions.total;
    coveredFunctions += coverage.functions.covered;
    totalBranches += coverage.branches.total;
    coveredBranches += coverage.branches.covered;
    totalStatements += coverage.statements.total;
    coveredStatements += coverage.statements.covered;

    // 检查低覆盖率文件
    const linesCoverage = coverage.lines.total > 0 ? (coverage.lines.covered / coverage.lines.total * 100) : 100;
    if (linesCoverage < 70) {
      lowCoverageFiles.push({
        file: path.relative(process.cwd(), file),
        linesCoverage: linesCoverage.toFixed(2),
        functionsCoverage: coverage.functions.total > 0 ? (coverage.functions.covered / coverage.functions.total * 100).toFixed(2) : 100,
        branchesCoverage: coverage.branches.total > 0 ? (coverage.branches.covered / coverage.branches.total * 100).toFixed(2) : 100
      });
    }
  });

  return {
    overall: {
      lines: totalLines > 0 ? (coveredLines / totalLines * 100).toFixed(2) : 0,
      functions: totalFunctions > 0 ? (coveredFunctions / totalFunctions * 100).toFixed(2) : 0,
      branches: totalBranches > 0 ? (coveredBranches / totalBranches * 100).toFixed(2) : 0,
      statements: totalStatements > 0 ? (coveredStatements / totalStatements * 100).toFixed(2) : 0
    },
    lowCoverageFiles: lowCoverageFiles.sort((a, b) => parseFloat(a.linesCoverage) - parseFloat(b.linesCoverage))
  };
}

/**
 * 保存测试报告
 * @param {Object} report 测试报告
 */
function saveReport(report) {
  const reportsDir = path.join(process.cwd(), 'test-reports');
  
  // 确保报告目录存在
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  // 保存JSON报告
  const jsonReportPath = path.join(reportsDir, 'test-results.json');
  fs.writeFileSync(jsonReportPath, JSON.stringify(report, null, 2));

  // 生成HTML报告
  generateHtmlReport(report, reportsDir);

  // 生成Markdown报告
  generateMarkdownReport(report, reportsDir);
}

/**
 * 生成HTML报告
 * @param {Object} report 测试报告
 * @param {string} reportsDir 报告目录
 */
function generateHtmlReport(report, reportsDir) {
  const htmlContent = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OneTab Plus - 测试报告</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .header { text-align: center; margin-bottom: 30px; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .stat-card { background: #f8f9fa; padding: 20px; border-radius: 6px; text-align: center; }
        .stat-value { font-size: 2em; font-weight: bold; color: #007bff; }
        .stat-label { color: #6c757d; margin-top: 5px; }
        .section { margin-bottom: 30px; }
        .section h2 { color: #333; border-bottom: 2px solid #007bff; padding-bottom: 10px; }
        table { width: 100%; border-collapse: collapse; margin-top: 15px; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
        th { background-color: #f8f9fa; font-weight: 600; }
        .success { color: #28a745; }
        .danger { color: #dc3545; }
        .warning { color: #ffc107; }
        .coverage-bar { width: 100%; height: 20px; background: #e9ecef; border-radius: 10px; overflow: hidden; }
        .coverage-fill { height: 100%; background: linear-gradient(90deg, #dc3545 0%, #ffc107 50%, #28a745 100%); }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>OneTab Plus - 测试报告</h1>
            <p>生成时间: ${report.timestamp}</p>
            <p class="${report.success ? 'success' : 'danger'}">
                测试状态: ${report.success ? '✅ 通过' : '❌ 失败'}
            </p>
        </div>

        <div class="stats">
            <div class="stat-card">
                <div class="stat-value">${report.stats.total}</div>
                <div class="stat-label">总测试数</div>
            </div>
            <div class="stat-card">
                <div class="stat-value success">${report.stats.passed}</div>
                <div class="stat-label">通过</div>
            </div>
            <div class="stat-card">
                <div class="stat-value danger">${report.stats.failed}</div>
                <div class="stat-label">失败</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${report.stats.passRate}%</div>
                <div class="stat-label">通过率</div>
            </div>
        </div>

        ${report.coverage ? `
        <div class="section">
            <h2>代码覆盖率</h2>
            <div class="stats">
                <div class="stat-card">
                    <div class="stat-value">${report.coverage.overall.lines}%</div>
                    <div class="stat-label">行覆盖率</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${report.coverage.overall.functions}%</div>
                    <div class="stat-label">函数覆盖率</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${report.coverage.overall.branches}%</div>
                    <div class="stat-label">分支覆盖率</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${report.coverage.overall.statements}%</div>
                    <div class="stat-label">语句覆盖率</div>
                </div>
            </div>
        </div>
        ` : ''}

        ${report.failedTests.length > 0 ? `
        <div class="section">
            <h2>失败的测试</h2>
            <table>
                <thead>
                    <tr>
                        <th>文件</th>
                        <th>测试名称</th>
                        <th>错误信息</th>
                    </tr>
                </thead>
                <tbody>
                    ${report.failedTests.map(test => `
                        <tr>
                            <td>${test.file}</td>
                            <td>${test.testName}</td>
                            <td class="danger">${test.error.split('\n')[0]}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
        ` : ''}

        ${report.slowTests.length > 0 ? `
        <div class="section">
            <h2>慢测试 (>1秒)</h2>
            <table>
                <thead>
                    <tr>
                        <th>文件</th>
                        <th>测试数量</th>
                        <th>耗时</th>
                    </tr>
                </thead>
                <tbody>
                    ${report.slowTests.map(test => `
                        <tr>
                            <td>${test.file}</td>
                            <td>${test.testsCount}</td>
                            <td class="warning">${(test.duration / 1000).toFixed(2)}s</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
        ` : ''}
    </div>
</body>
</html>
  `;

  const htmlReportPath = path.join(reportsDir, 'test-results.html');
  fs.writeFileSync(htmlReportPath, htmlContent);
}

/**
 * 生成Markdown报告
 * @param {Object} report 测试报告
 * @param {string} reportsDir 报告目录
 */
function generateMarkdownReport(report, reportsDir) {
  const markdownContent = `# OneTab Plus - 测试报告

**生成时间:** ${report.timestamp}  
**测试状态:** ${report.success ? '✅ 通过' : '❌ 失败'}

## 📊 测试统计

| 指标 | 数值 |
|------|------|
| 总测试数 | ${report.stats.total} |
| 通过 | ${report.stats.passed} |
| 失败 | ${report.stats.failed} |
| 跳过 | ${report.stats.pending} |
| 通过率 | ${report.stats.passRate}% |
| 总耗时 | ${(report.stats.duration / 1000).toFixed(2)}s |

${report.coverage ? `
## 📈 代码覆盖率

| 类型 | 覆盖率 |
|------|--------|
| 行覆盖率 | ${report.coverage.overall.lines}% |
| 函数覆盖率 | ${report.coverage.overall.functions}% |
| 分支覆盖率 | ${report.coverage.overall.branches}% |
| 语句覆盖率 | ${report.coverage.overall.statements}% |
` : ''}

${report.failedTests.length > 0 ? `
## ❌ 失败的测试

${report.failedTests.map(test => `
### ${test.file}
- **测试:** ${test.testName}
- **错误:** ${test.error.split('\n')[0]}
`).join('\n')}
` : ''}

${report.slowTests.length > 0 ? `
## 🐌 慢测试 (>1秒)

| 文件 | 测试数量 | 耗时 |
|------|----------|------|
${report.slowTests.map(test => `| ${test.file} | ${test.testsCount} | ${(test.duration / 1000).toFixed(2)}s |`).join('\n')}
` : ''}

---
*报告由 OneTab Plus 测试系统自动生成*
`;

  const markdownReportPath = path.join(reportsDir, 'test-results.md');
  fs.writeFileSync(markdownReportPath, markdownContent);
}

/**
 * 打印测试摘要
 * @param {Object} report 测试报告
 */
function printSummary(report) {
  console.log('\n' + '='.repeat(60));
  console.log('📋 OneTab Plus 测试报告摘要');
  console.log('='.repeat(60));
  console.log(`📅 时间: ${report.timestamp}`);
  console.log(`🎯 状态: ${report.success ? '✅ 通过' : '❌ 失败'}`);
  console.log(`📊 统计: ${report.stats.passed}/${report.stats.total} 通过 (${report.stats.passRate}%)`);
  
  if (report.coverage) {
    console.log(`📈 覆盖率: ${report.coverage.overall.lines}% 行, ${report.coverage.overall.functions}% 函数`);
  }
  
  if (report.failedTests.length > 0) {
    console.log(`❌ 失败: ${report.failedTests.length} 个测试失败`);
  }
  
  if (report.slowTests.length > 0) {
    console.log(`🐌 慢测试: ${report.slowTests.length} 个测试超过1秒`);
  }
  
  console.log('='.repeat(60));
  console.log(`📁 详细报告已保存到: test-reports/`);
  console.log('='.repeat(60) + '\n');
}

module.exports = processResults;
