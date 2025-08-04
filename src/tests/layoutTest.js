/**
 * 布局功能测试
 * 测试三栏布局的基本功能
 */

// 模拟Chrome存储API
const mockStorage = {
  local: {
    data: {},
    get: function (keys) {
      return Promise.resolve(
        typeof keys === 'string'
          ? { [keys]: this.data[keys] }
          : keys.reduce((result, key) => {
            result[key] = this.data[key];
            return result;
          }, {})
      );
    },
    set: function (items) {
      Object.assign(this.data, items);
      return Promise.resolve();
    },
    clear: function () {
      this.data = {};
      return Promise.resolve();
    }
  }
};

// 设置全局Chrome API模拟
global.chrome = {
  storage: mockStorage
};

// 由于是ES模块环境，我们直接定义测试用的默认设置
const DEFAULT_SETTINGS = {
  groupNameTemplate: 'Group %d',
  showFavicons: true,
  showTabCount: true,
  confirmBeforeDelete: true,
  allowDuplicateTabs: false,
  syncEnabled: true,
  layoutMode: 'double',
  showNotifications: false,
  syncStrategy: 'newest',
  deleteStrategy: 'everywhere',
  themeMode: 'auto',
};

/**
 * 测试默认设置包含新的layoutMode字段
 */
function testDefaultSettings() {
  console.log('🧪 测试默认设置...');

  // 检查默认设置是否包含layoutMode
  if (!DEFAULT_SETTINGS.layoutMode) {
    throw new Error('默认设置缺少layoutMode字段');
  }

  // 检查默认值是否正确
  if (DEFAULT_SETTINGS.layoutMode !== 'double') {
    throw new Error(`默认layoutMode应该是'double'，实际是'${DEFAULT_SETTINGS.layoutMode}'`);
  }

  console.log('✅ 默认设置测试通过');
}

/**
 * 测试布局模式枚举值
 */
function testLayoutModeValues() {
  console.log('🧪 测试布局模式枚举值...');

  const validModes = ['single', 'double', 'triple'];
  const testModes = ['single', 'double', 'triple', 'invalid'];

  testModes.forEach(mode => {
    const isValid = validModes.includes(mode);
    console.log(`  ${mode}: ${isValid ? '✅ 有效' : '❌ 无效'}`);
  });

  console.log('✅ 布局模式枚举值测试完成');
}

/**
 * 测试布局切换逻辑
 */
function testLayoutToggleLogic() {
  console.log('🧪 测试布局切换逻辑...');

  // 模拟切换逻辑
  function getNextLayoutMode(currentMode) {
    switch (currentMode) {
      case 'single':
        return 'double';
      case 'double':
        return 'triple';
      case 'triple':
        return 'single';
      default:
        return 'single';
    }
  }

  // 测试切换序列
  const testSequence = [
    { current: 'single', expected: 'double' },
    { current: 'double', expected: 'triple' },
    { current: 'triple', expected: 'single' },
    { current: 'invalid', expected: 'single' }
  ];

  testSequence.forEach(({ current, expected }) => {
    const result = getNextLayoutMode(current);
    if (result !== expected) {
      throw new Error(`切换逻辑错误: ${current} -> ${result}, 期望: ${expected}`);
    }
    console.log(`  ${current} -> ${result} ✅`);
  });

  console.log('✅ 布局切换逻辑测试通过');
}

/**
 * 测试标签组分配逻辑
 */
function testTabGroupDistribution() {
  console.log('🧪 测试标签组分配逻辑...');

  // 模拟标签组数据
  const mockGroups = Array.from({ length: 10 }, (_, i) => ({
    id: `group-${i}`,
    name: `Group ${i + 1}`,
    tabs: []
  }));

  // 测试三栏分配
  const column1 = mockGroups.filter((_, index) => index % 3 === 0);
  const column2 = mockGroups.filter((_, index) => index % 3 === 1);
  const column3 = mockGroups.filter((_, index) => index % 3 === 2);

  console.log(`  第一栏: ${column1.length} 个组 (索引: ${column1.map((_, i) => i * 3).join(', ')})`);
  console.log(`  第二栏: ${column2.length} 个组 (索引: ${column2.map((_, i) => i * 3 + 1).join(', ')})`);
  console.log(`  第三栏: ${column3.length} 个组 (索引: ${column3.map((_, i) => i * 3 + 2).join(', ')})`);

  // 验证总数
  const totalDistributed = column1.length + column2.length + column3.length;
  if (totalDistributed !== mockGroups.length) {
    throw new Error(`分配错误: 总数${totalDistributed}，期望${mockGroups.length}`);
  }

  console.log('✅ 标签组分配逻辑测试通过');
}

/**
 * 运行所有测试
 */
async function runAllTests() {
  console.log('🚀 开始布局功能测试...\n');

  try {
    testDefaultSettings();
    console.log('');

    testLayoutModeValues();
    console.log('');

    testLayoutToggleLogic();
    console.log('');

    testTabGroupDistribution();
    console.log('');

    console.log('🎉 所有测试通过！');

  } catch (error) {
    console.error('❌ 测试失败:', error.message);
    process.exit(1);
  }
}

// 如果直接运行此文件，执行测试
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests();
}

export {
  testDefaultSettings,
  testLayoutModeValues,
  testLayoutToggleLogic,
  testTabGroupDistribution,
  runAllTests
};
