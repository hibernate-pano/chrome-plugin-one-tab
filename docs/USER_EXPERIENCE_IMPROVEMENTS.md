# OneTabPlus 用户体验改进指南

本文档提供了针对 OneTabPlus Chrome 扩展的用户体验改进建议，重点关注界面交互、视觉设计和功能可用性的提升。

## 用户体验现状分析

OneTabPlus 已经实现了许多用户友好的功能，如深色模式、拖拽排序和搜索功能。但通过进一步优化用户体验，可以显著提升用户满意度和使用效率。

## 改进策略

### 1. 标签预览功能

当用户悬停在标签上时，显示网站预览，帮助用户快速识别内容。

**实施方案**：

```jsx
// 标签预览组件
const TabPreview = ({ tab }) => {
  return (
    <div className="absolute z-10 bg-white dark:bg-gray-800 shadow-lg rounded-lg p-2 w-64">
      <div className="flex items-center mb-2">
        {tab.favicon && <img src={tab.favicon} alt="" className="w-4 h-4 mr-2" />}
        <h3 className="text-sm font-medium truncate">{tab.title}</h3>
      </div>
      <div className="bg-gray-100 dark:bg-gray-700 rounded h-32 flex items-center justify-center">
        {/* 可以是网站截图或元数据预览 */}
        <img 
          src={`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(tab.url)}&screenshot=true`} 
          alt="网站预览" 
          className="max-w-full max-h-full object-contain"
          onError={(e) => {
            e.target.onerror = null;
            e.target.src = tab.favicon || 'default-preview.png';
          }}
        />
      </div>
      <div className="mt-2 text-xs text-gray-500 dark:text-gray-400 truncate">
        {tab.url}
      </div>
    </div>
  );
};

// 在 DraggableTab 组件中使用
const DraggableTab = ({ tab, ...props }) => {
  const [showPreview, setShowPreview] = useState(false);
  const previewTimeoutRef = useRef(null);
  
  const handleMouseEnter = () => {
    previewTimeoutRef.current = setTimeout(() => {
      setShowPreview(true);
    }, 500); // 500ms 延迟，避免鼠标快速划过时显示预览
  };
  
  const handleMouseLeave = () => {
    clearTimeout(previewTimeoutRef.current);
    setShowPreview(false);
  };
  
  return (
    <div 
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className="relative"
    >
      {/* 标签内容 */}
      {showPreview && <TabPreview tab={tab} />}
    </div>
  );
};
```

### 2. 标签组折叠记忆功能

记住用户折叠/展开标签组的状态，下次打开时保持相同状态。

**实施方案**：

```jsx
// 在 TabGroup 组件中实现
const TabGroup = ({ group }) => {
  // 从本地存储中获取折叠状态
  const getInitialExpandedState = () => {
    const savedState = localStorage.getItem(`tabGroup_${group.id}_expanded`);
    return savedState !== null ? JSON.parse(savedState) : true; // 默认展开
  };
  
  const [isExpanded, setIsExpanded] = useState(getInitialExpandedState);
  
  // 当折叠状态改变时保存到本地存储
  useEffect(() => {
    localStorage.setItem(`tabGroup_${group.id}_expanded`, JSON.stringify(isExpanded));
  }, [isExpanded, group.id]);
  
  const toggleExpanded = () => {
    setIsExpanded(!isExpanded);
  };
  
  return (
    <div className="tab-group">
      <div className="tab-group-header" onClick={toggleExpanded}>
        {/* 标签组标题和控制按钮 */}
      </div>
      {isExpanded && (
        <div className="tab-group-content">
          {/* 标签列表 */}
        </div>
      )}
    </div>
  );
};
```

### 3. 拖拽反馈优化

增强拖拽过程中的视觉反馈，使用动画和过渡效果提升用户体验。

**实施方案**：

```jsx
// 在 DraggableTab 组件中优化拖拽反馈
const DraggableTab = ({ tab, index, groupId, moveTab }) => {
  const ref = useRef(null);
  
  const [{ isDragging }, drag] = useDrag({
    type: ItemTypes.TAB,
    item: { type: ItemTypes.TAB, id: tab.id, groupId, index },
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
  });
  
  const [{ isOver, canDrop }, drop] = useDrop({
    accept: ItemTypes.TAB,
    hover: (item, monitor) => {
      // 拖拽逻辑...
    },
    collect: (monitor) => ({
      isOver: monitor.isOver(),
      canDrop: monitor.canDrop(),
    }),
  });
  
  // 组合拖拽源和放置目标
  drag(drop(ref));
  
  // 根据拖拽状态应用不同的样式类
  const dragClass = isDragging ? 'opacity-50 scale-105 border-dashed border-primary-400' : '';
  const dropClass = isOver && canDrop ? 'bg-primary-50 dark:bg-primary-900/20' : '';
  
  return (
    <div
      ref={ref}
      className={`flex items-center py-1 px-2 bg-white dark:bg-gray-800 
                 hover:bg-gray-100 dark:hover:bg-gray-700 
                 transition-all duration-200 rounded 
                 ${dragClass} ${dropClass}`}
      style={{ cursor: 'move' }}
    >
      {/* 标签内容 */}
    </div>
  );
};
```

### 4. 搜索体验优化

改进搜索功能，添加高亮显示和更智能的搜索结果排序。

**实施方案**：

```jsx
// 搜索结果高亮组件
const HighlightText = ({ text, highlight }) => {
  if (!highlight.trim()) {
    return <span>{text}</span>;
  }
  
  const regex = new RegExp(`(${highlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  const parts = text.split(regex);
  
  return (
    <span>
      {parts.map((part, i) => 
        regex.test(part) ? (
          <span key={i} className="bg-yellow-200 dark:bg-yellow-700 font-medium">
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </span>
  );
};

// 在搜索结果中使用高亮组件
const SearchResultTab = ({ tab, searchQuery }) => {
  return (
    <div className="flex items-center py-1 px-2 bg-white dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 rounded">
      {tab.favicon && <img src={tab.favicon} alt="" className="w-4 h-4 mr-2" />}
      <a
        href="#"
        className="truncate text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 hover:underline text-sm"
        onClick={(e) => {
          e.preventDefault();
          handleOpenTab(tab);
        }}
        title={tab.title}
      >
        <HighlightText text={tab.title} highlight={searchQuery} />
      </a>
    </div>
  );
};
```

### 5. 快捷键支持扩展

增加更多快捷键支持，提高高级用户的使用效率。

**实施方案**：

```javascript
// 在 manifest.json 中添加更多快捷键
{
  "commands": {
    "_execute_action": {
      "suggested_key": {
        "default": "Ctrl+Shift+S",
        "mac": "Command+Shift+S"
      },
      "description": "打开标签管理器"
    },
    "save_all_tabs": {
      "suggested_key": {
        "default": "Alt+Shift+S",
        "mac": "Alt+Shift+S"
      },
      "description": "保存所有标签页"
    },
    "save_current_tab": {
      "suggested_key": {
        "default": "Alt+S",
        "mac": "Alt+S"
      },
      "description": "保存当前标签页"
    },
    "search_tabs": {
      "suggested_key": {
        "default": "Alt+F",
        "mac": "Alt+F"
      },
      "description": "搜索标签页"
    },
    "toggle_theme": {
      "suggested_key": {
        "default": "Alt+T",
        "mac": "Alt+T"
      },
      "description": "切换主题"
    }
  }
}

// 在 service-worker.ts 中处理快捷键
chrome.commands.onCommand.addListener((command) => {
  switch (command) {
    case 'search_tabs':
      // 打开标签管理器并聚焦搜索框
      chrome.tabs.query({ url: chrome.runtime.getURL("popup.html") }, (tabs) => {
        if (tabs.length > 0) {
          chrome.tabs.update(tabs[0].id, { active: true });
          chrome.tabs.sendMessage(tabs[0].id, { action: 'focus_search' });
        } else {
          chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?focus=search") });
        }
      });
      break;
    case 'toggle_theme':
      // 切换主题
      chrome.storage.local.get(['settings'], (result) => {
        const settings = result.settings || {};
        const newThemeMode = settings.themeMode === 'dark' ? 'light' : 'dark';
        chrome.storage.local.set({
          settings: { ...settings, themeMode: newThemeMode }
        });
      });
      break;
    // 其他快捷键处理...
  }
});
```

### 6. 标签分类系统

实现标签的自动分类或允许用户创建自定义分类，更好地组织标签。

**实施方案**：

```jsx
// 标签分类组件
const TabCategories = ({ categories, onSelectCategory, activeCategory }) => {
  return (
    <div className="flex flex-wrap gap-2 mb-4">
      <button
        className={`px-3 py-1 text-sm rounded-full ${
          activeCategory === 'all' 
            ? 'bg-primary-500 text-white' 
            : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
        }`}
        onClick={() => onSelectCategory('all')}
      >
        全部
      </button>
      {categories.map(category => (
        <button
          key={category.id}
          className={`px-3 py-1 text-sm rounded-full ${
            activeCategory === category.id 
              ? 'bg-primary-500 text-white' 
              : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
          }`}
          onClick={() => onSelectCategory(category.id)}
        >
          {category.name}
        </button>
      ))}
      <button
        className="px-3 py-1 text-sm rounded-full bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300"
        onClick={() => {/* 打开添加分类对话框 */}}
      >
        + 添加分类
      </button>
    </div>
  );
};

// 自动分类逻辑
const autoCategorizeTabs = (tabs) => {
  const categories = {
    'social': ['facebook.com', 'twitter.com', 'instagram.com', 'linkedin.com'],
    'shopping': ['amazon.com', 'ebay.com', 'taobao.com', 'jd.com'],
    'news': ['news.', '.news', 'bbc.', 'cnn.'],
    'video': ['youtube.com', 'bilibili.com', 'netflix.com', 'video'],
    'dev': ['github.com', 'stackoverflow.com', 'developer.', 'docs.'],
    // 更多分类...
  };
  
  return tabs.map(tab => {
    let tabCategory = 'other';
    
    for (const [category, patterns] of Object.entries(categories)) {
      if (patterns.some(pattern => tab.url.includes(pattern))) {
        tabCategory = category;
        break;
      }
    }
    
    return {
      ...tab,
      category: tabCategory
    };
  });
};
```

## 用户反馈机制

实现用户反馈收集机制，持续改进用户体验。

**实施方案**：

```jsx
// 简单的反馈组件
const FeedbackButton = () => {
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [rating, setRating] = useState(0);
  
  const handleSubmit = async () => {
    try {
      // 发送反馈到服务器或存储在本地
      await fetch('https://your-feedback-api.com/submit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          rating,
          feedback,
          timestamp: new Date().toISOString(),
          version: chrome.runtime.getManifest().version
        }),
      });
      
      // 重置表单
      setFeedback('');
      setRating(0);
      setShowFeedback(false);
      
      // 显示感谢消息
      alert('感谢您的反馈！');
    } catch (error) {
      console.error('提交反馈失败:', error);
      alert('提交反馈失败，请稍后再试');
    }
  };
  
  return (
    <>
      <button
        onClick={() => setShowFeedback(true)}
        className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
      >
        提供反馈
      </button>
      
      {showFeedback && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full">
            <h3 className="text-lg font-medium mb-4">您的反馈很重要</h3>
            
            <div className="mb-4">
              <div className="text-sm mb-2">您对 OneTabPlus 的评分</div>
              <div className="flex space-x-2">
                {[1, 2, 3, 4, 5].map(star => (
                  <button
                    key={star}
                    onClick={() => setRating(star)}
                    className={`text-2xl ${
                      rating >= star ? 'text-yellow-400' : 'text-gray-300'
                    }`}
                  >
                    ★
                  </button>
                ))}
              </div>
            </div>
            
            <div className="mb-4">
              <label className="block text-sm mb-2">您的建议或问题</label>
              <textarea
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                className="w-full px-3 py-2 border rounded dark:bg-gray-700 dark:border-gray-600"
                rows={4}
                placeholder="请告诉我们您的想法..."
              ></textarea>
            </div>
            
            <div className="flex justify-end space-x-2">
              <button
                onClick={() => setShowFeedback(false)}
                className="px-4 py-2 text-sm text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white"
              >
                取消
              </button>
              <button
                onClick={handleSubmit}
                className="px-4 py-2 text-sm bg-primary-500 text-white rounded hover:bg-primary-600"
                disabled={!rating || !feedback.trim()}
              >
                提交
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
```

## 成功指标

实施上述用户体验改进后，预期可以达到以下效果：

1. **用户满意度**：用户反馈满意度提升20%
2. **使用效率**：完成常见任务的时间减少30%
3. **用户留存**：活跃用户留存率提升15%
4. **功能发现**：用户使用高级功能的比例提升25%

## 持续改进建议

用户体验优化是一个持续的过程，建议：

1. 定期收集用户反馈
2. 进行用户测试，观察用户如何使用产品
3. 分析用户行为数据，找出可能的痛点
4. 关注竞品的用户体验创新，吸取有益经验

## 参考资源

- [Material Design 指南](https://material.io/design)
- [Chrome 扩展 UI 最佳实践](https://developer.chrome.com/docs/extensions/mv3/user_interface/)
- [Web 可访问性指南](https://www.w3.org/WAI/standards-guidelines/wcag/)
- [用户体验研究方法](https://www.nngroup.com/articles/which-ux-research-methods/)
