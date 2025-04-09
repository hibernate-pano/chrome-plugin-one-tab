import React, { useState, useCallback } from 'react';
import { useAppDispatch } from '@/store/hooks';
import { setSearchQuery } from '@/store/slices/tabSlice';
import { debounce } from 'lodash';

export const SearchBar: React.FC = () => {
  const dispatch = useAppDispatch();
  const [localQuery, setLocalQuery] = useState('');

  // 使用debounce来优化搜索性能
  const debouncedSearch = useCallback(
    debounce((query: string) => {
      dispatch(setSearchQuery(query));
    }, 300),
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
        className="
          w-full px-4 py-2 pl-10
          rounded-lg
          bg-white dark:bg-gray-800
          border border-gray-300 dark:border-gray-700
          text-gray-900 dark:text-gray-100
          placeholder-gray-500 dark:placeholder-gray-400
          focus:outline-none focus:ring-2 focus:ring-blue-500
          transition duration-200
        "
      />
      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
        <svg
          className="h-5 w-5 text-gray-400"
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
          className="
            absolute inset-y-0 right-0 pr-3
            text-gray-400 hover:text-gray-500
            dark:text-gray-500 dark:hover:text-gray-400
            transition duration-200
          "
        >
          <svg
            className="h-5 w-5"
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