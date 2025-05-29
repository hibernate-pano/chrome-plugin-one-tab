import React, { useMemo, useState } from 'react';
import { useAppSelector } from '@/store/hooks';
import { Tab, TabGroup } from '@/types/tab';

interface ReorderViewProps {
  onClose: () => void;
}

type SortType = 'time-desc' | 'time-asc' | 'domain-asc' | 'domain-desc';

function getDomain(url: string) {
  try {
    const hostname = new URL(url).hostname;
    const parts = hostname.split('.');
    if (parts.length >= 2) {
      // 处理如 www.sub.example.co.uk 只取 example.co.uk
      // 简单规则：取倒数两段
      return parts.slice(-2).join('.');
    }
    return hostname;
  } catch {
    return '';
  }
}

function flattenTabs(groups: TabGroup[]): (Tab & { groupName: string })[] {
  return groups.flatMap(group => group.tabs.map(tab => ({ ...tab, groupName: group.name })));
}

function sortTabs(tabs: (Tab & { groupName: string })[], sortType: SortType) {
  switch (sortType) {
    case 'time-desc':
      return [...tabs].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
    case 'time-asc':
      return [...tabs].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
    case 'domain-asc':
      return [...tabs].sort((a, b) => getDomain(a.url).localeCompare(getDomain(b.url)));
    case 'domain-desc':
      return [...tabs].sort((a, b) => getDomain(b.url).localeCompare(getDomain(a.url)));
    default:
      return tabs;
  }
}

const sortOptions = [
  { value: 'time-desc', label: '按保存时间（新→旧）' },
  { value: 'time-asc', label: '按保存时间（旧→新）' },
  { value: 'domain-asc', label: '按域名（A→Z）' },
  { value: 'domain-desc', label: '按域名（Z→A）' },
];

const ReorderView: React.FC<ReorderViewProps> = ({ onClose }) => {
  const groups = useAppSelector(state => state.tabs.groups);
  const [sortType, setSortType] = useState<SortType>('time-desc');

  const flatTabs = useMemo(() => sortTabs(flattenTabs(groups), sortType), [groups, sortType]);

  return (
    <div className="p-4 bg-white dark:bg-gray-800 min-h-[60vh] rounded shadow">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center space-x-2">
          <label htmlFor="sortType" className="text-sm text-gray-700 dark:text-gray-200">
            排序方式：
          </label>
          <select
            id="sortType"
            value={sortType}
            onChange={e => setSortType(e.target.value as SortType)}
            className="border rounded px-2 py-1 text-sm dark:bg-gray-700 dark:text-gray-100"
          >
            {sortOptions.map(opt => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={onClose}
          className="px-3 py-1 rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-300 dark:hover:bg-gray-600"
        >
          返回分组视图
        </button>
      </div>
      <ul className="divide-y divide-gray-200 dark:divide-gray-700">
        {flatTabs.map(tab => (
          <li key={tab.id} className="flex items-center py-2">
            <span className="truncate flex-1" title={tab.title}>
              {tab.title}
            </span>
            <span className="ml-2 text-xs text-gray-400">{getDomain(tab.url)}</span>
            <span className="ml-2 text-xs text-gray-400">
              {new Date(tab.createdAt).toLocaleString()}
            </span>
            <span className="ml-2 text-xs text-gray-400" title={`原分组：${tab.groupName}`}>
              [{tab.groupName}]
            </span>
          </li>
        ))}
      </ul>
      {flatTabs.length === 0 && <div className="text-center text-gray-400 py-8">暂无标签</div>}
    </div>
  );
};

export default ReorderView;
