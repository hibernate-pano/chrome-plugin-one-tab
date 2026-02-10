import { TabGroup, Tab } from '@/types/tab';
import { nanoid } from '@reduxjs/toolkit';

/**
 * 解析 OneTab 格式的导出文本
 * OneTab 格式示例:
 * https://example.com/page1 | Example Page 1
 * https://example.com/page2 | Example Page 2
 * 
 * https://anotherexample.com/page1 | Another Example Page 1
 * https://anotherexample.com/page2 | Another Example Page 2
 * 
 * 空行分隔不同的标签组
 * 
 * @param text OneTab 格式的导出文本
 * @returns 解析后的标签组数组
 */
export function parseOneTabFormat(text: string): TabGroup[] {
  // 移除可能的 BOM 和其他不可见字符
  const cleanText = text.replace(/^\uFEFF/, '').trim();
  
  // 按空行分割不同的标签组
  const groupTexts = cleanText.split(/\n\s*\n/);
  
  // 当前时间戳，用于创建时间
  const now = new Date().toISOString();
  
  // 解析每个标签组
  const groups: TabGroup[] = groupTexts.map((groupText, index) => {
    // 分割每一行，解析 URL 和标题
    const lines = groupText.split('\n').filter(line => line.trim() !== '');
    
    // 解析每一行为标签
    const tabs: Tab[] = lines.map(line => {
      // 使用管道符号(|)分割 URL 和标题
      const parts = line.split('|');
      const url = parts[0].trim();
      // 如果没有标题部分，使用 URL 作为标题
      const title = parts.length > 1 ? parts[1].trim() : url;
      
      return {
        id: nanoid(),
        url,
        title,
        favicon: '', // OneTab 导出不包含 favicon
        createdAt: now,
        lastAccessed: now,
        pinned: false, // OneTab 导出不包含固定标签页信息
      };
    });
    
    // 创建标签组
    return {
      id: nanoid(),
      name: `导入的标签组 ${index + 1}`,
      tabs,
      createdAt: now,
      updatedAt: now,
      isLocked: false
    };
  });
  
  return groups;
}

/**
 * 将标签组数组转换为 OneTab 格式的导出文本
 * 
 * @param groups 标签组数组
 * @returns OneTab 格式的导出文本
 */
export function formatToOneTabFormat(groups: TabGroup[]): string {
  return groups.map(group => {
    // 将每个标签格式化为 "URL | 标题"
    const tabLines = group.tabs.map(tab => `${tab.url} | ${tab.title}`);
    return tabLines.join('\n');
  }).join('\n\n');
}
