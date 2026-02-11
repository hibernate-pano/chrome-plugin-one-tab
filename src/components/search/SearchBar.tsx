import React, { useState } from 'react';
import { useAppDispatch } from '@/store/hooks';
import { setSearchQuery } from '@/store/slices/tabSlice';
import { useDebouncedCallback } from '@/hooks/useDebounce';

export const SearchBar: React.FC = () => {
  const dispatch = useAppDispatch();
  const [localQuery, setLocalQuery] = useState('');

  // 使用防抖来优化搜索性能
  const debouncedSearch = useDebouncedCallback(
    (query: string) => {
      dispatch(setSearchQuery(query));
    },
    300,
    [dispatch]
  );

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    const query = e.target.value;
    setLocalQuery(query);
    debouncedSearch(query);
  };

  const handleClear = () => {
    setLocalQuery('');
    dispatch(setSearchQuery(''));
  };

  return (
    <div className="relative mb-4">
      <input
        type="text"
        value={localQuery}
        onChange={handleSearch}
        placeholder="搜索标签..."
        aria-label="搜索标签页"
        aria-describedby="search-description"
        className="search-bar-input"
      />
      <div id="search-description" className="sr-only">
        输入关键词搜索已保存的标签页
      </div>
      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
        <svg
          className="h-5 w-5 search-icon"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z"
            clipRule="evenodd"
          />
        </svg>
      </div>
      {localQuery && (
        <button
          onClick={handleClear}
          className="search-clear-btn flat-interaction"
          title="清除搜索"
        >
          <svg
            className="h-5 w-5 transform transition-transform hover:rotate-90"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      )}
    </div>
  );
};

export default SearchBar;