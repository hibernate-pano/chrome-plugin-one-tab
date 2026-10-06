import { TabGroup, Tab } from '../types/tab';
import { nanoid } from '@reduxjs/toolkit';
import { sanitizeTabUrl } from '../utils/inputValidation';

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
    const tabs: Tab[] = lines.flatMap(line => {
      // 用**第一个**管道符号切分 URL 与标题（2026-10-06 修）。
      //
      // 原实现 `line.split('|')` 会把标题里的 `|` 也切开：标题 "A | B" 被解析成
      // 标题 "A"，后半截 "B" 直接丢弃。而 `formatToOneTabFormat` 导出时不做任何
      // 转义 ⇒ 标题含 | 的标签在「导出 → 重新导入」往返里被静默改写。
      // 真实的页面标题带 | 并不罕见（正则表达式、搜索查询串、面包屑分隔）。
      //
      // 只切第一个：URL 一定不含裸 | （会被编码），第一个 | 之后全部是标题。
      const sep = line.indexOf('|');
      const rawUrl = (sep === -1 ? line : line.slice(0, sep)).trim();
      // 拒绝危险协议（javascript:/data:/file: 等），整行丢弃而不是污染 storage
      const url = sanitizeTabUrl(rawUrl);
      if (!url) return [];
      // 如果没有标题部分，使用 URL 作为标题
      const title = sep === -1 ? url : line.slice(sep + 1).trim();

      return [{
        id: nanoid(),
        url,
        title,
        favicon: '', // OneTab 导出不包含 favicon
        createdAt: now,
        lastAccessed: now,
        pinned: false, // OneTab 导出不包含固定标签页信息
      }];
    });
    
    // 创建会话
    return {
      id: nanoid(),
      name: `导入的会话 ${index + 1}`,
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
