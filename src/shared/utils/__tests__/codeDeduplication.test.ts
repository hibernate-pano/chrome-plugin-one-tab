/**
 * 代码去重工具测试
 */

import {
  AsyncOperationWrapper,
  CommonStateManager,
  CommonValidator,
  CommonFormatter,
  CommonUtils
} from '../codeDeduplication';

describe('AsyncOperationWrapper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('execute', () => {
    it('应该成功执行异步操作', async () => {
      const mockOperation = jest.fn().mockResolvedValue('success');
      
      const result = await AsyncOperationWrapper.execute(mockOperation);
      
      expect(result.success).toBe(true);
      expect(result.data).toBe('success');
      expect(result.message).toBe('操作成功完成');
      expect(mockOperation).toHaveBeenCalledTimes(1);
    });

    it('应该处理操作失败的情况', async () => {
      const mockError = new Error('操作失败');
      const mockOperation = jest.fn().mockRejectedValue(mockError);
      
      const result = await AsyncOperationWrapper.execute(mockOperation);
      
      expect(result.success).toBe(false);
      expect(result.error).toBe(mockError);
      expect(result.message).toBe('操作失败');
    });

    it('应该支持重试机制', async () => {
      const mockOperation = jest.fn()
        .mockRejectedValueOnce(new Error('第一次失败'))
        .mockRejectedValueOnce(new Error('第二次失败'))
        .mockResolvedValue('第三次成功');
      
      const result = await AsyncOperationWrapper.execute(mockOperation, {
        retry: {
          maxRetries: 3,
          baseDelay: 10,
          retryCondition: () => true
        }
      });
      
      expect(result.success).toBe(true);
      expect(result.data).toBe('第三次成功');
      expect(mockOperation).toHaveBeenCalledTimes(3);
    });

    it('应该在达到最大重试次数后失败', async () => {
      const mockError = new Error('持续失败');
      const mockOperation = jest.fn().mockRejectedValue(mockError);
      
      const result = await AsyncOperationWrapper.execute(mockOperation, {
        retry: {
          maxRetries: 2,
          baseDelay: 10,
          retryCondition: () => true
        }
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toBe(mockError);
      expect(mockOperation).toHaveBeenCalledTimes(3); // 初始调用 + 2次重试
    });
  });
});

describe('CommonStateManager', () => {
  describe('createLoadingState', () => {
    it('应该创建正确的加载状态管理器', () => {
      const loadingState = CommonStateManager.createLoadingState();
      
      expect(loadingState.loading).toBe(false);
      expect(loadingState.error).toBeNull();
      expect(loadingState.data).toBeNull();
      
      // 测试状态更新方法
      const loadingUpdate = loadingState.setLoading(true);
      expect(loadingUpdate.loading).toBe(true);
      expect(loadingUpdate.error).toBeNull();
      
      const errorUpdate = loadingState.setError(new Error('测试错误'));
      expect(errorUpdate.loading).toBe(false);
      expect(errorUpdate.error).toBeInstanceOf(Error);
      expect(errorUpdate.data).toBeNull();
      
      const dataUpdate = loadingState.setData('测试数据');
      expect(dataUpdate.loading).toBe(false);
      expect(dataUpdate.error).toBeNull();
      expect(dataUpdate.data).toBe('测试数据');
      
      const resetUpdate = loadingState.reset();
      expect(resetUpdate.loading).toBe(false);
      expect(resetUpdate.error).toBeNull();
      expect(resetUpdate.data).toBeNull();
    });
  });

  describe('createPaginationState', () => {
    it('应该创建正确的分页状态管理器', () => {
      const paginationState = CommonStateManager.createPaginationState(20);
      
      expect(paginationState.page).toBe(1);
      expect(paginationState.pageSize).toBe(20);
      expect(paginationState.total).toBe(0);
      expect(paginationState.hasMore).toBe(true);
      
      // 测试分页方法
      expect(paginationState.nextPage(1)).toBe(2);
      expect(paginationState.prevPage(2)).toBe(1);
      expect(paginationState.prevPage(1)).toBe(1); // 不能小于1
      
      expect(paginationState.updateHasMore(2, 20, 50)).toBe(true); // 2*20 < 50
      expect(paginationState.updateHasMore(3, 20, 50)).toBe(false); // 3*20 >= 50
    });
  });

  describe('createSelectionState', () => {
    it('应该创建正确的选择状态管理器', () => {
      const selectionState = CommonStateManager.createSelectionState();
      const initialSelected = new Set<string>();
      
      // 测试选择切换
      const afterToggle1 = selectionState.toggleSelection('item1', initialSelected);
      expect(afterToggle1.has('item1')).toBe(true);
      
      const afterToggle2 = selectionState.toggleSelection('item1', afterToggle1);
      expect(afterToggle2.has('item1')).toBe(false);
      
      // 测试全选
      const items = [{ id: 'item1' }, { id: 'item2' }, { id: 'item3' }];
      const allSelected = selectionState.selectAll(items);
      expect(allSelected.size).toBe(3);
      expect(allSelected.has('item1')).toBe(true);
      expect(allSelected.has('item2')).toBe(true);
      expect(allSelected.has('item3')).toBe(true);
      
      // 测试清空选择
      const cleared = selectionState.clearSelection();
      expect(cleared.size).toBe(0);
      
      // 测试选择状态查询
      expect(selectionState.isSelected('item1', allSelected)).toBe(true);
      expect(selectionState.isSelected('item4', allSelected)).toBe(false);
      expect(selectionState.getSelectedCount(allSelected)).toBe(3);
      
      // 测试选择模式切换
      expect(selectionState.toggleSelectionMode(false)).toBe(true);
      expect(selectionState.toggleSelectionMode(true)).toBe(false);
    });
  });
});

describe('CommonValidator', () => {
  describe('required', () => {
    it('应该验证必填字段', () => {
      expect(CommonValidator.required('', '用户名')).toBe('用户名不能为空');
      expect(CommonValidator.required(null, '用户名')).toBe('用户名不能为空');
      expect(CommonValidator.required(undefined, '用户名')).toBe('用户名不能为空');
      expect(CommonValidator.required('有值', '用户名')).toBeNull();
    });
  });

  describe('stringLength', () => {
    it('应该验证字符串长度', () => {
      expect(CommonValidator.stringLength('ab', 3, 10, '密码')).toBe('密码长度不能少于3个字符');
      expect(CommonValidator.stringLength('abcdefghijk', 3, 10, '密码')).toBe('密码长度不能超过10个字符');
      expect(CommonValidator.stringLength('abcde', 3, 10, '密码')).toBeNull();
    });
  });

  describe('url', () => {
    it('应该验证URL格式', () => {
      expect(CommonValidator.url('invalid-url', 'URL')).toBe('URL格式不正确');
      expect(CommonValidator.url('https://example.com', 'URL')).toBeNull();
      expect(CommonValidator.url('http://localhost:3000', 'URL')).toBeNull();
    });
  });

  describe('email', () => {
    it('应该验证邮箱格式', () => {
      expect(CommonValidator.email('invalid-email', '邮箱')).toBe('邮箱格式不正确');
      expect(CommonValidator.email('test@example.com', '邮箱')).toBeNull();
      expect(CommonValidator.email('user.name+tag@domain.co.uk', '邮箱')).toBeNull();
    });
  });

  describe('combine', () => {
    it('应该组合多个验证器', () => {
      const validators = [
        (value: string) => CommonValidator.required(value, '密码'),
        (value: string) => CommonValidator.stringLength(value, 8, 20, '密码')
      ];
      
      expect(CommonValidator.combine('', validators)).toEqual(['密码不能为空']);
      expect(CommonValidator.combine('123', validators)).toEqual(['密码长度不能少于8个字符']);
      expect(CommonValidator.combine('12345678', validators)).toEqual([]);
    });
  });
});

describe('CommonFormatter', () => {
  describe('fileSize', () => {
    it('应该正确格式化文件大小', () => {
      expect(CommonFormatter.fileSize(0)).toBe('0 B');
      expect(CommonFormatter.fileSize(1024)).toBe('1 KB');
      expect(CommonFormatter.fileSize(1024 * 1024)).toBe('1 MB');
      expect(CommonFormatter.fileSize(1536)).toBe('1.5 KB');
    });
  });

  describe('timeAgo', () => {
    it('应该正确格式化时间差', () => {
      const now = new Date();
      const oneMinuteAgo = new Date(now.getTime() - 60 * 1000);
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      
      expect(CommonFormatter.timeAgo(new Date(now.getTime() - 30 * 1000))).toBe('刚刚');
      expect(CommonFormatter.timeAgo(oneMinuteAgo)).toBe('1分钟前');
      expect(CommonFormatter.timeAgo(oneHourAgo)).toBe('1小时前');
      expect(CommonFormatter.timeAgo(oneDayAgo)).toBe('1天前');
    });
  });

  describe('number', () => {
    it('应该正确格式化数字', () => {
      expect(CommonFormatter.number(1234)).toBe('1,234');
      expect(CommonFormatter.number(1234.56, { decimals: 2 })).toBe('1,234.56');
      expect(CommonFormatter.number(1234, { prefix: '$' })).toBe('$1,234');
      expect(CommonFormatter.number(1234, { suffix: '元' })).toBe('1,234元');
    });
  });

  describe('truncate', () => {
    it('应该正确截断文本', () => {
      expect(CommonFormatter.truncate('Hello World', 5)).toBe('He...');
      expect(CommonFormatter.truncate('Hello', 10)).toBe('Hello');
      expect(CommonFormatter.truncate('Hello World', 8, '---')).toBe('Hello---');
    });
  });
});

describe('CommonUtils', () => {
  describe('debounce', () => {
    it('应该正确实现防抖功能', (done) => {
      const mockFn = jest.fn();
      const debouncedFn = CommonUtils.debounce(mockFn, 100);
      
      debouncedFn();
      debouncedFn();
      debouncedFn();
      
      expect(mockFn).not.toHaveBeenCalled();
      
      setTimeout(() => {
        expect(mockFn).toHaveBeenCalledTimes(1);
        done();
      }, 150);
    });
  });

  describe('throttle', () => {
    it('应该正确实现节流功能', (done) => {
      const mockFn = jest.fn();
      const throttledFn = CommonUtils.throttle(mockFn, 100);
      
      throttledFn();
      throttledFn();
      throttledFn();
      
      expect(mockFn).toHaveBeenCalledTimes(1);
      
      setTimeout(() => {
        throttledFn();
        expect(mockFn).toHaveBeenCalledTimes(2);
        done();
      }, 150);
    });
  });

  describe('deepClone', () => {
    it('应该正确深拷贝对象', () => {
      const original = {
        a: 1,
        b: {
          c: 2,
          d: [3, 4, { e: 5 }]
        },
        f: new Date('2023-01-01')
      };
      
      const cloned = CommonUtils.deepClone(original);
      
      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect(cloned.b).not.toBe(original.b);
      expect(cloned.b.d).not.toBe(original.b.d);
      expect(cloned.f).not.toBe(original.f);
    });
  });

  describe('generateId', () => {
    it('应该生成唯一ID', () => {
      const id1 = CommonUtils.generateId();
      const id2 = CommonUtils.generateId();
      const id3 = CommonUtils.generateId('prefix_');
      
      expect(id1).not.toBe(id2);
      expect(id3).toMatch(/^prefix_/);
      expect(typeof id1).toBe('string');
      expect(id1.length).toBeGreaterThan(0);
    });
  });

  describe('safeJsonParse', () => {
    it('应该安全解析JSON', () => {
      expect(CommonUtils.safeJsonParse('{"a": 1}', {})).toEqual({ a: 1 });
      expect(CommonUtils.safeJsonParse('invalid json', { default: true })).toEqual({ default: true });
    });
  });

  describe('isEmpty', () => {
    it('应该正确判断空值', () => {
      expect(CommonUtils.isEmpty(null)).toBe(true);
      expect(CommonUtils.isEmpty(undefined)).toBe(true);
      expect(CommonUtils.isEmpty('')).toBe(true);
      expect(CommonUtils.isEmpty('   ')).toBe(true);
      expect(CommonUtils.isEmpty([])).toBe(true);
      expect(CommonUtils.isEmpty({})).toBe(true);
      expect(CommonUtils.isEmpty('hello')).toBe(false);
      expect(CommonUtils.isEmpty([1])).toBe(false);
      expect(CommonUtils.isEmpty({ a: 1 })).toBe(false);
    });
  });

  describe('unique', () => {
    it('应该正确去重数组', () => {
      expect(CommonUtils.unique([1, 2, 2, 3, 3, 3])).toEqual([1, 2, 3]);
      
      const objects = [
        { id: 1, name: 'a' },
        { id: 2, name: 'b' },
        { id: 1, name: 'c' }
      ];
      
      const uniqueObjects = CommonUtils.unique(objects, item => item.id);
      expect(uniqueObjects).toHaveLength(2);
      expect(uniqueObjects[0].id).toBe(1);
      expect(uniqueObjects[1].id).toBe(2);
    });
  });

  describe('groupBy', () => {
    it('应该正确分组数组', () => {
      const items = [
        { category: 'A', value: 1 },
        { category: 'B', value: 2 },
        { category: 'A', value: 3 }
      ];
      
      const grouped = CommonUtils.groupBy(items, item => item.category);
      
      expect(grouped.A).toHaveLength(2);
      expect(grouped.B).toHaveLength(1);
      expect(grouped.A[0].value).toBe(1);
      expect(grouped.A[1].value).toBe(3);
      expect(grouped.B[0].value).toBe(2);
    });
  });
});
