import React, { useMemo, useState } from 'react';
import { useAppSelector, useAppDispatch } from '@/store/hooks';
import { Tab, TabGroup } from '@/types/tab';
import { updateGroup, deleteGroup } from '@/store/slices/tabSlice';
import { shouldAutoDeleteAfterTabRemoval } from '@/utils/tabGroupUtils';
import { SafeFavicon } from '@/components/common/SafeFavicon';

// 钉住图标
const PinIcon = () => (
  <svg className="w-3 h-3 text-blue-500 ml-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
  </svg>
);

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

function flattenTabs(groups: TabGroup[]): (Tab & { groupName: string; groupId: string })[] {
  return groups.flatMap(group =>
    group.tabs.map(tab => ({
      ...tab,
      groupName: group.name,
      groupId: group.id,
    }))
  );
}

function sortTabs(tabs: (Tab & { groupName: string; groupId: string })[], sortType: SortType) {
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

const ReorderView: React.FC = () => {
  const dispatch = useAppDispatch();
  const groups = useAppSelector(state => state.tabs.groups);
  const settings = useAppSelector(state => state.settings);
  const [sortType, setSortType] = useState<SortType>('time-desc');

  const flatTabs = useMemo(() => sortTabs(flattenTabs(groups), sortType), [groups, sortType]);

  const handleOpenTab = (tab: Tab & { groupId: string }) => {
    // 打开标签页并删除原标签
    chrome.runtime.sendMessage({
      type: 'OPEN_TABS',
      data: {
        tabs: [
          {
            url: tab.url,
            pinned: !!tab.pinned,
          },
        ],
      },
    });

    // 删除标签
    handleDeleteTab(tab);
  };

  const handleDeleteTab = (tab: Tab & { groupId: string }) => {
    // 找到对应的标签组
    const group = groups.find(g => g.id === tab.groupId);
    if (!group) return;

    // 如果标签组被锁定，不允许删除
    if (group.isLocked) return;

    // 使用工具函数检查是否应该自动删除标签组
    if (shouldAutoDeleteAfterTabRemoval(group, tab.id)) {
      dispatch(deleteGroup(group.id));
      console.log(`自动删除空标签组: ${group.name} (ID: ${group.id})`);
    } else {
      // 更新标签组，移除该标签页
      const updatedTabs = group.tabs.filter(t => t.id !== tab.id);
      const updatedGroup = {
        ...group,
        tabs: updatedTabs,
        updatedAt: new Date().toISOString(),
      };
      dispatch(updateGroup(updatedGroup));
      console.log(`从标签组删除标签页: ${group.name}, 剩余标签页: ${updatedTabs.length}`);
    }
  };

  return (
    <div className="container mx-auto max-w-6xl">
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-sm">
        <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <div className="flex items-center">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-5 w-5 text-gray-600 dark:text-gray-300 mr-2"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 6h16M4 12h16M4 18h16"
              />
            </svg>
            <h2 className="text-lg font-medium text-gray-800 dark:text-gray-100">标签重新排序</h2>
            <span className="ml-2 text-sm text-gray-500 dark:text-gray-400">
              共 {flatTabs.length} 个标签
            </span>
          </div>

          <div className="flex items-center space-x-3">
            <div className="flex items-center space-x-2">
              <label htmlFor="sortType" className="text-sm text-gray-700 dark:text-gray-200">
                排序方式：
              </label>
              <select
                id="sortType"
                value={sortType}
                onChange={e => setSortType(e.target.value as SortType)}
                className="border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-sm dark:bg-gray-700 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-primary-500"
              >
                {sortOptions.map(opt => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="overflow-hidden">
          {flatTabs.length > 0 ? (
            <ul className="divide-y divide-gray-200 dark:divide-gray-700">
              {flatTabs.map(tab => (
                <li
                  key={tab.id}
                  className="flex items-center py-3 px-4 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer"
                  onClick={() => handleOpenTab(tab)}
                >
                  {settings.showFavicons && (
                    <div className="mr-3 flex-shrink-0">
                      <SafeFavicon src={tab.favicon} alt="" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center">
                      <p
                        className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate"
                        title={tab.title}
                      >
                        {tab.title}
                        {tab.pinned && <PinIcon />}
                      </p>
                    </div>
                    <div className="flex items-center text-xs text-gray-500 dark:text-gray-400 mt-1">
                      <span className="truncate" title={tab.url}>
                        {tab.url}
                      </span>
                    </div>
                  </div>
                  <div className="ml-4 flex-shrink-0 flex items-center space-x-3">
                    <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                      {new Date(tab.createdAt).toLocaleString()}
                    </span>
                    <span
                      className="px-2 py-0.5 text-xs rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 whitespace-nowrap"
                      title={`原分组：${tab.groupName}`}
                    >
                      {tab.groupName}
                    </span>
                    <button
                      onClick={e => {
                        e.stopPropagation(); // 阻止事件冒泡
                        handleDeleteTab(tab);
                      }}
                      className="ml-2 p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-500 dark:text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors duration-150 flex-shrink-0"
                      title="删除标签页"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="h-4 w-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex flex-col items-center justify-center py-12 space-y-3 text-gray-500">
              <div className="w-16 h-16 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-10 w-10 text-gray-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                  />
                </svg>
              </div>
              <h3 className="text-lg font-medium text-gray-700 dark:text-gray-200">
                没有保存的标签页
              </h3>
              <p className="text-gray-500 dark:text-gray-400 max-w-md text-center">
                点击右上角的"保存所有标签"按钮开始保存您的标签页
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ReorderView;
