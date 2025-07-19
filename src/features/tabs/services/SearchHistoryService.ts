import { storage } from '@/shared/utils/storage';
import { logger } from '@/shared/utils/logger';
import { SearchQuery, SearchMode } from './SearchService';

/**
 * 搜索历史项接口
 */
export interface SearchHistoryItem {
  id: string;
  query: SearchQuery;
  timestamp: string;
  resultCount: number;
  executionTime: number;
  isFavorite: boolean;
}

/**
 * 搜索统计接口
 */
export interface SearchStatistics {
  totalSearches: number;
  averageExecutionTime: number;
  mostUsedKeywords: Array<{ keyword: string; count: number }>;
  mostUsedFilters: Array<{ filter: string; count: number }>;
  searchModeUsage: Record<SearchMode, number>;
}

/**
 * 搜索历史管理服务
 * 负责搜索历史的存储、管理和统计分析
 */
export class SearchHistoryService {
  private readonly STORAGE_KEY = 'search_history';
  private readonly MAX_HISTORY_SIZE = 100;
  private readonly MAX_FAVORITES = 20;

  /**
   * 添加搜索历史记录
   */
  async addSearchHistory(
    query: SearchQuery,
    resultCount: number,
    executionTime: number
  ): Promise<void> {
    try {
      const history = await this.getSearchHistory();
      
      const newItem: SearchHistoryItem = {
        id: this.generateId(),
        query: { ...query },
        timestamp: new Date().toISOString(),
        resultCount,
        executionTime,
        isFavorite: false
      };

      // 检查是否已存在相同的搜索
      const existingIndex = history.findIndex(item => 
        this.isSameQuery(item.query, query)
      );

      if (existingIndex !== -1) {
        // 更新现有记录的时间戳和统计信息
        history[existingIndex] = {
          ...history[existingIndex],
          timestamp: newItem.timestamp,
          resultCount,
          executionTime
        };
      } else {
        // 添加新记录
        history.unshift(newItem);
      }

      // 限制历史记录数量
      if (history.length > this.MAX_HISTORY_SIZE) {
        // 保留收藏的记录
        const favorites = history.filter(item => item.isFavorite);
        const nonFavorites = history.filter(item => !item.isFavorite);
        
        const trimmedHistory = [
          ...favorites.slice(0, this.MAX_FAVORITES),
          ...nonFavorites.slice(0, this.MAX_HISTORY_SIZE - favorites.length)
        ];
        
        await this.saveSearchHistory(trimmedHistory);
      } else {
        await this.saveSearchHistory(history);
      }

      logger.debug('搜索历史已添加', { query: query.keyword, resultCount });
    } catch (error) {
      logger.error('添加搜索历史失败', error);
    }
  }

  /**
   * 获取搜索历史
   */
  async getSearchHistory(): Promise<SearchHistoryItem[]> {
    try {
      const history = await storage.get(this.STORAGE_KEY);
      return Array.isArray(history) ? history : [];
    } catch (error) {
      logger.error('获取搜索历史失败', error);
      return [];
    }
  }

  /**
   * 获取收藏的搜索
   */
  async getFavoriteSearches(): Promise<SearchHistoryItem[]> {
    try {
      const history = await this.getSearchHistory();
      return history.filter(item => item.isFavorite);
    } catch (error) {
      logger.error('获取收藏搜索失败', error);
      return [];
    }
  }

  /**
   * 切换搜索收藏状态
   */
  async toggleFavorite(searchId: string): Promise<void> {
    try {
      const history = await this.getSearchHistory();
      const item = history.find(h => h.id === searchId);
      
      if (item) {
        item.isFavorite = !item.isFavorite;
        await this.saveSearchHistory(history);
        logger.debug('搜索收藏状态已切换', { searchId, isFavorite: item.isFavorite });
      }
    } catch (error) {
      logger.error('切换搜索收藏状态失败', error);
    }
  }

  /**
   * 删除搜索历史记录
   */
  async deleteSearchHistory(searchId: string): Promise<void> {
    try {
      const history = await this.getSearchHistory();
      const filteredHistory = history.filter(item => item.id !== searchId);
      await this.saveSearchHistory(filteredHistory);
      logger.debug('搜索历史已删除', { searchId });
    } catch (error) {
      logger.error('删除搜索历史失败', error);
    }
  }

  /**
   * 清空搜索历史
   */
  async clearSearchHistory(keepFavorites: boolean = true): Promise<void> {
    try {
      if (keepFavorites) {
        const favorites = await this.getFavoriteSearches();
        await this.saveSearchHistory(favorites);
      } else {
        await this.saveSearchHistory([]);
      }
      logger.debug('搜索历史已清空', { keepFavorites });
    } catch (error) {
      logger.error('清空搜索历史失败', error);
    }
  }

  /**
   * 获取搜索建议（基于历史）
   */
  async getSearchSuggestions(keyword: string, limit: number = 5): Promise<string[]> {
    try {
      if (!keyword || keyword.length < 2) {
        return [];
      }

      const history = await this.getSearchHistory();
      const suggestions = new Set<string>();
      const lowerKeyword = keyword.toLowerCase();

      // 从历史搜索中提取建议
      history.forEach(item => {
        if (item.query.keyword.toLowerCase().includes(lowerKeyword)) {
          suggestions.add(item.query.keyword);
        }
      });

      return Array.from(suggestions).slice(0, limit);
    } catch (error) {
      logger.error('获取搜索建议失败', error);
      return [];
    }
  }

  /**
   * 获取搜索统计信息
   */
  async getSearchStatistics(): Promise<SearchStatistics> {
    try {
      const history = await this.getSearchHistory();
      
      if (history.length === 0) {
        return {
          totalSearches: 0,
          averageExecutionTime: 0,
          mostUsedKeywords: [],
          mostUsedFilters: [],
          searchModeUsage: {
            [SearchMode.SIMPLE]: 0,
            [SearchMode.FUZZY]: 0,
            [SearchMode.REGEX]: 0,
            [SearchMode.ADVANCED]: 0
          }
        };
      }

      // 计算统计信息
      const totalSearches = history.length;
      const averageExecutionTime = history.reduce((sum, item) => sum + item.executionTime, 0) / totalSearches;

      // 统计关键词使用频率
      const keywordCounts = new Map<string, number>();
      history.forEach(item => {
        if (item.query.keyword) {
          const count = keywordCounts.get(item.query.keyword) || 0;
          keywordCounts.set(item.query.keyword, count + 1);
        }
      });

      const mostUsedKeywords = Array.from(keywordCounts.entries())
        .map(([keyword, count]) => ({ keyword, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      // 统计过滤器使用频率
      const filterCounts = new Map<string, number>();
      history.forEach(item => {
        Object.keys(item.query.filters).forEach(filter => {
          const count = filterCounts.get(filter) || 0;
          filterCounts.set(filter, count + 1);
        });
      });

      const mostUsedFilters = Array.from(filterCounts.entries())
        .map(([filter, count]) => ({ filter, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      // 统计搜索模式使用频率
      const searchModeUsage = {
        [SearchMode.SIMPLE]: 0,
        [SearchMode.FUZZY]: 0,
        [SearchMode.REGEX]: 0,
        [SearchMode.ADVANCED]: 0
      };

      history.forEach(item => {
        searchModeUsage[item.query.mode]++;
      });

      return {
        totalSearches,
        averageExecutionTime,
        mostUsedKeywords,
        mostUsedFilters,
        searchModeUsage
      };
    } catch (error) {
      logger.error('获取搜索统计失败', error);
      throw error;
    }
  }

  /**
   * 保存搜索历史
   */
  private async saveSearchHistory(history: SearchHistoryItem[]): Promise<void> {
    await storage.set(this.STORAGE_KEY, history);
  }

  /**
   * 判断两个查询是否相同
   */
  private isSameQuery(query1: SearchQuery, query2: SearchQuery): boolean {
    return (
      query1.keyword === query2.keyword &&
      query1.mode === query2.mode &&
      JSON.stringify(query1.filters) === JSON.stringify(query2.filters)
    );
  }

  /**
   * 生成唯一ID
   */
  private generateId(): string {
    return `search_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

// 导出单例实例
export const searchHistoryService = new SearchHistoryService();
