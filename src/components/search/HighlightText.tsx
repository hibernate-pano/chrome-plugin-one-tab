import React, { useMemo } from 'react';

interface HighlightTextProps {
  text: string;
  highlight: string;
}

/**
 * 高亮文本组件
 * 将文本中匹配搜索关键词的部分高亮显示
 * 
 * @param text 原始文本
 * @param highlight 需要高亮的关键词
 */
export const HighlightText: React.FC<HighlightTextProps> = ({ text, highlight }) => {
  const normalizedHighlight = highlight.trim();

  // 使用useMemo缓存计算结果，避免不必要的重新计算
  const parts = useMemo(() => {
    if (!normalizedHighlight) {
      return [text];
    }

    // 转义正则表达式中的特殊字符
    const escapedHighlight = normalizedHighlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 创建不区分大小写的正则表达式
    const regex = new RegExp(`(${escapedHighlight})`, 'gi');
    // 分割文本
    return text.split(regex);
  }, [normalizedHighlight, text]);

  // 渲染高亮文本
  return (
    <span>
      {parts.map((part, i) => {
        // 检查当前部分是否匹配高亮关键词（不区分大小写）
        const isHighlight = part.toLowerCase() === normalizedHighlight.toLowerCase();
        return isHighlight ? (
          <span key={i} className="search-highlight">
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        );
      })}
    </span>
  );
};

export default HighlightText;
