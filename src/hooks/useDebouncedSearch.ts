import { useState, useEffect, useCallback } from 'react';

/**
 * 防抖搜索Hook
 * 优化搜索性能，避免频繁触发搜索
 */
export const useDebouncedSearch = (
  initialValue: string = '',
  delay: number = 300
) => {
  const [searchValue, setSearchValue] = useState(initialValue);
  const [debouncedValue, setDebouncedValue] = useState(initialValue);

  // 防抖逻辑
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(searchValue);
    }, delay);

    return () => {
      clearTimeout(timer);
    };
  }, [searchValue, delay]);

  // 立即更新搜索值（用于UI显示）
  const handleSearchChange = useCallback((value: string) => {
    setSearchValue(value);
  }, []);

  // 清空搜索
  const clearSearch = useCallback(() => {
    setSearchValue('');
    setDebouncedValue('');
  }, []);

  return {
    searchValue,
    debouncedValue,
    handleSearchChange,
    clearSearch,
    isSearching: searchValue !== debouncedValue
  };
};
