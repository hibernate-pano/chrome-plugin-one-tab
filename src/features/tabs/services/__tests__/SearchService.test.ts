import { SearchService, SearchMode, SearchQuery } from '../SearchService';
import { TabGroup, Tab } from '@/shared/types/tab';

describe('SearchService', () => {
  let searchService: SearchService;
  let mockGroups: TabGroup[];

  beforeEach(() => {
    searchService = new SearchService();
    
    // 创建测试数据
    mockGroups = [
      {
        id: 'group1',
        name: 'Development Tools',
        tabs: [
          {
            id: 'tab1',
            title: 'GitHub - Microsoft/TypeScript',
            url: 'https://github.com/microsoft/typescript',
            favIconUrl: 'https://github.com/favicon.ico'
          },
          {
            id: 'tab2',
            title: 'Visual Studio Code',
            url: 'https://code.visualstudio.com/',
            favIconUrl: 'https://code.visualstudio.com/favicon.ico'
          }
        ],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        isLocked: false,
        color: 'blue',
        order: 0
      },
      {
        id: 'group2',
        name: 'Social Media',
        tabs: [
          {
            id: 'tab3',
            title: 'Twitter',
            url: 'https://twitter.com/',
            favIconUrl: 'https://twitter.com/favicon.ico'
          },
          {
            id: 'tab4',
            title: 'Facebook',
            url: 'https://facebook.com/',
            favIconUrl: 'https://facebook.com/favicon.ico'
          }
        ],
        createdAt: '2024-01-02T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
        isLocked: true,
        color: 'green',
        order: 1
      }
    ];
  });

  describe('简单搜索', () => {
    it('应该能够搜索标签组名称', async () => {
      const query: SearchQuery = {
        keyword: 'Development',
        mode: SearchMode.SIMPLE,
        filters: {},
        sortBy: 'relevance',
        sortOrder: 'desc'
      };

      const result = await searchService.search(mockGroups, query);
      
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].name).toBe('Development Tools');
    });

    it('应该能够搜索标签标题', async () => {
      const query: SearchQuery = {
        keyword: 'GitHub',
        mode: SearchMode.SIMPLE,
        filters: {},
        sortBy: 'relevance',
        sortOrder: 'desc'
      };

      const result = await searchService.search(mockGroups, query);
      
      expect(result.tabs).toHaveLength(1);
      expect(result.tabs[0].tab.title).toContain('GitHub');
    });

    it('应该支持区分大小写搜索', async () => {
      const query: SearchQuery = {
        keyword: 'github',
        mode: SearchMode.SIMPLE,
        caseSensitive: true,
        filters: {},
        sortBy: 'relevance',
        sortOrder: 'desc'
      };

      const result = await searchService.search(mockGroups, query);
      
      // 区分大小写时应该找不到 'GitHub'
      expect(result.tabs).toHaveLength(0);
    });
  });

  describe('模糊搜索', () => {
    it('应该能够进行模糊匹配', async () => {
      const query: SearchQuery = {
        keyword: 'Developmnt', // 故意拼错
        mode: SearchMode.FUZZY,
        fuzzyThreshold: 0.7,
        filters: {},
        sortBy: 'relevance',
        sortOrder: 'desc'
      };

      const result = await searchService.search(mockGroups, query);
      
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].name).toBe('Development Tools');
    });

    it('应该根据相似度阈值过滤结果', async () => {
      const query: SearchQuery = {
        keyword: 'xyz', // 完全不匹配的关键词
        mode: SearchMode.FUZZY,
        fuzzyThreshold: 0.8,
        filters: {},
        sortBy: 'relevance',
        sortOrder: 'desc'
      };

      const result = await searchService.search(mockGroups, query);
      
      expect(result.groups).toHaveLength(0);
      expect(result.tabs).toHaveLength(0);
    });
  });

  describe('正则表达式搜索', () => {
    it('应该支持正则表达式搜索', async () => {
      const query: SearchQuery = {
        keyword: 'github\\.com|code\\.visualstudio\\.com',
        mode: SearchMode.REGEX,
        filters: {},
        sortBy: 'relevance',
        sortOrder: 'desc'
      };

      const result = await searchService.search(mockGroups, query);
      
      expect(result.tabs).toHaveLength(2);
    });

    it('应该处理无效的正则表达式', async () => {
      const query: SearchQuery = {
        keyword: '[invalid regex',
        mode: SearchMode.REGEX,
        filters: {},
        sortBy: 'relevance',
        sortOrder: 'desc'
      };

      // 应该不抛出错误，而是回退到简单搜索
      const result = await searchService.search(mockGroups, query);
      
      expect(result).toBeDefined();
    });
  });

  describe('过滤器', () => {
    it('应该能够按域名过滤', async () => {
      const query: SearchQuery = {
        keyword: '',
        mode: SearchMode.SIMPLE,
        filters: {
          domain: 'github.com'
        },
        sortBy: 'relevance',
        sortOrder: 'desc'
      };

      const result = await searchService.search(mockGroups, query);
      
      expect(result.tabs).toHaveLength(1);
      expect(result.tabs[0].tab.url).toContain('github.com');
    });

    it('应该能够按锁定状态过滤', async () => {
      const query: SearchQuery = {
        keyword: '',
        mode: SearchMode.SIMPLE,
        filters: {
          isLocked: true
        },
        sortBy: 'relevance',
        sortOrder: 'desc'
      };

      const result = await searchService.search(mockGroups, query);
      
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].isLocked).toBe(true);
    });

    it('应该能够按标签数量过滤', async () => {
      const query: SearchQuery = {
        keyword: '',
        mode: SearchMode.SIMPLE,
        filters: {
          tabCount: { min: 2, max: 2 }
        },
        sortBy: 'relevance',
        sortOrder: 'desc'
      };

      const result = await searchService.search(mockGroups, query);
      
      expect(result.groups).toHaveLength(2); // 两个组都有2个标签
    });
  });

  describe('高级搜索表达式解析', () => {
    it('应该能够解析复合搜索表达式', async () => {
      const expression = 'domain:github.com locked:false';
      
      const result = await searchService.advancedSearch(mockGroups, expression);
      
      expect(result.tabs).toHaveLength(1);
      expect(result.tabs[0].tab.url).toContain('github.com');
    });

    it('应该能够解析标签数量表达式', async () => {
      const expression = 'tabs:>1';
      
      const result = await searchService.advancedSearch(mockGroups, expression);
      
      expect(result.groups).toHaveLength(2);
    });

    it('应该能够解析模糊搜索表达式', async () => {
      const expression = 'mode:fuzzy Developmnt';
      
      const result = await searchService.advancedSearch(mockGroups, expression);
      
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].name).toBe('Development Tools');
    });
  });

  describe('搜索建议', () => {
    it('应该能够生成搜索建议', async () => {
      const suggestions = await searchService.getSearchSuggestions(mockGroups, 'Dev');
      
      expect(suggestions).toContain('Development Tools');
    });

    it('应该支持模糊搜索建议', async () => {
      const suggestions = await searchService.getSearchSuggestions(mockGroups, 'Developmnt', SearchMode.FUZZY);
      
      expect(suggestions).toContain('Development Tools');
    });

    it('应该限制建议数量', async () => {
      const suggestions = await searchService.getSearchSuggestions(mockGroups, 'a');
      
      expect(suggestions.length).toBeLessThanOrEqual(10);
    });
  });

  describe('排序', () => {
    it('应该能够按相关性排序', async () => {
      const query: SearchQuery = {
        keyword: 'code',
        mode: SearchMode.SIMPLE,
        filters: {},
        sortBy: 'relevance',
        sortOrder: 'desc'
      };

      const result = await searchService.search(mockGroups, query);
      
      // 标题中包含完整关键词的应该排在前面
      if (result.tabs.length > 1) {
        expect(result.tabs[0].relevanceScore).toBeGreaterThanOrEqual(result.tabs[1].relevanceScore);
      }
    });

    it('应该能够按名称排序', async () => {
      const query: SearchQuery = {
        keyword: '',
        mode: SearchMode.SIMPLE,
        filters: {},
        sortBy: 'name',
        sortOrder: 'asc'
      };

      const result = await searchService.search(mockGroups, query);
      
      if (result.groups.length > 1) {
        expect(result.groups[0].name.localeCompare(result.groups[1].name)).toBeLessThanOrEqual(0);
      }
    });
  });
});
