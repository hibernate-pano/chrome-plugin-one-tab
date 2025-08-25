import { TabGroup, Tab } from '@/shared/types/tab';
import { storage } from '@/shared/utils/storage';
import { logger } from '@/shared/utils/logger';
import { errorHandler } from '@/shared/utils/errorHandler';
import { compressData, decompressData } from '@/shared/utils/compressionUtils';

/**
 * 支持的导出格式
 */
export enum ExportFormat {
  JSON = 'json',           // 标准JSON格式
  COMPRESSED_JSON = 'cjson', // 压缩JSON格式
  ONETAB = 'onetab',       // OneTab格式
  CSV = 'csv',             // CSV格式
  HTML = 'html',           // HTML书签格式
  MARKDOWN = 'markdown',   // Markdown格式
  XML = 'xml'              // XML格式
}

/**
 * 导出选项接口
 */
export interface ExportOptions {
  format: ExportFormat;
  includeSettings?: boolean;
  includeMetadata?: boolean;
  selectedGroupIds?: string[];
  compression?: boolean;
  password?: string;
}

/**
 * 导入选项接口
 */
export interface ImportOptions {
  mergeMode: 'replace' | 'merge' | 'append';
  includeSettings?: boolean;
  password?: string;
  validateData?: boolean;
}

/**
 * 导入导出结果接口
 */
export interface ImportExportResult {
  success: boolean;
  message: string;
  data?: {
    groupsCount?: number;
    tabsCount?: number;
    fileSize?: number;
    compressionRatio?: number;
  };
  error?: string;
}

/**
 * 导入导出服务
 * 负责处理多种格式的数据导入导出功能
 */
export class ImportExportService {
  
  /**
   * 导出数据
   */
  async exportData(options: ExportOptions): Promise<ImportExportResult> {
    try {
      logger.debug('开始导出数据', options);
      
      // 获取要导出的数据
      const groups = await this.getGroupsToExport(options.selectedGroupIds);
      const settings = options.includeSettings ? await storage.getSettings() : undefined;
      
      // 根据格式生成导出内容
      let content: string;
      let filename: string;
      let mimeType: string;
      
      switch (options.format) {
        case ExportFormat.JSON:
          ({ content, filename, mimeType } = await this.exportToJSON(groups, settings, options));
          break;
        case ExportFormat.COMPRESSED_JSON:
          ({ content, filename, mimeType } = await this.exportToCompressedJSON(groups, settings, options));
          break;
        case ExportFormat.ONETAB:
          ({ content, filename, mimeType } = await this.exportToOneTab(groups));
          break;
        case ExportFormat.CSV:
          ({ content, filename, mimeType } = await this.exportToCSV(groups));
          break;
        case ExportFormat.HTML:
          ({ content, filename, mimeType } = await this.exportToHTML(groups));
          break;
        case ExportFormat.MARKDOWN:
          ({ content, filename, mimeType } = await this.exportToMarkdown(groups));
          break;
        case ExportFormat.XML:
          ({ content, filename, mimeType } = await this.exportToXML(groups, settings));
          break;
        default:
          throw new Error(`不支持的导出格式: ${options.format}`);
      }
      
      // 创建并下载文件
      await this.downloadFile(content, filename, mimeType);
      
      const result: ImportExportResult = {
        success: true,
        message: '数据导出成功',
        data: {
          groupsCount: groups.length,
          tabsCount: groups.reduce((sum, group) => sum + group.tabs.length, 0),
          fileSize: new Blob([content]).size
        }
      };
      
      logger.success('数据导出完成', result);
      return result;
      
    } catch (error) {
      const friendlyError = errorHandler.handleAsyncError(error as Error, { component: 'ImportExportService' });
      const message = friendlyError.message;
      logger.error('数据导出失败', error);
      return {
        success: false,
        message: '数据导出失败',
        error: message
      };
    }
  }
  
  /**
   * 导入数据
   */
  async importData(file: File, options: ImportOptions): Promise<ImportExportResult> {
    try {
      logger.debug('开始导入数据', { filename: file.name, size: file.size, options });
      
      // 读取文件内容
      const content = await this.readFile(file);
      
      // 根据文件扩展名或内容检测格式
      const format = this.detectFormat(file.name, content);
      
      // 解析数据
      let groups: TabGroup[];
      let settings: any = undefined;
      
      switch (format) {
        case ExportFormat.JSON:
        case ExportFormat.COMPRESSED_JSON:
          ({ groups, settings } = await this.parseJSON(content, format === ExportFormat.COMPRESSED_JSON));
          break;
        case ExportFormat.ONETAB:
          groups = await this.parseOneTab(content);
          break;
        case ExportFormat.CSV:
          groups = await this.parseCSV(content);
          break;
        case ExportFormat.HTML:
          groups = await this.parseHTML(content);
          break;
        case ExportFormat.MARKDOWN:
          groups = await this.parseMarkdown(content);
          break;
        case ExportFormat.XML:
          ({ groups, settings } = await this.parseXML(content));
          break;
        default:
          throw new Error(`不支持的导入格式: ${format}`);
      }
      
      // 验证数据
      if (options.validateData) {
        this.validateImportData(groups);
      }
      
      // 导入数据
      await this.importGroups(groups, options.mergeMode);
      
      if (settings && options.includeSettings) {
        await this.importSettings(settings, options.mergeMode);
      }
      
      const result: ImportExportResult = {
        success: true,
        message: '数据导入成功',
        data: {
          groupsCount: groups.length,
          tabsCount: groups.reduce((sum, group) => sum + group.tabs.length, 0),
          fileSize: file.size
        }
      };
      
      logger.success('数据导入完成', result);
      return result;
      
    } catch (error) {
      const friendlyError = errorHandler.handleAsyncError(error as Error, { component: 'ImportExportService' });
      const message = friendlyError.message;
      logger.error('数据导入失败', error);
      return {
        success: false,
        message: '数据导入失败',
        error: message
      };
    }
  }
  
  /**
   * 获取要导出的标签组
   */
  private async getGroupsToExport(selectedGroupIds?: string[]): Promise<TabGroup[]> {
    const allGroups = await storage.getGroups();
    
    if (selectedGroupIds && selectedGroupIds.length > 0) {
      return allGroups.filter(group => selectedGroupIds.includes(group.id));
    }
    
    return allGroups;
  }
  
  /**
   * 导出为JSON格式
   */
  private async exportToJSON(groups: TabGroup[], settings?: any, options?: ExportOptions): Promise<{
    content: string;
    filename: string;
    mimeType: string;
  }> {
    const exportData = {
      version: '2.0.0',
      timestamp: new Date().toISOString(),
      metadata: options?.includeMetadata ? {
        exportedBy: 'OneTab Plus',
        groupsCount: groups.length,
        tabsCount: groups.reduce((sum, group) => sum + group.tabs.length, 0),
        exportOptions: options
      } : undefined,
      data: {
        groups,
        settings
      }
    };
    
    const content = JSON.stringify(exportData, null, 2);
    const date = new Date().toISOString().split('T')[0];
    const filename = `onetab-plus-export-${date}.json`;
    
    return {
      content,
      filename,
      mimeType: 'application/json'
    };
  }
  
  /**
   * 导出为压缩JSON格式
   */
  private async exportToCompressedJSON(groups: TabGroup[], settings?: any, options?: ExportOptions): Promise<{
    content: string;
    filename: string;
    mimeType: string;
  }> {
    const { content: jsonContent } = await this.exportToJSON(groups, settings, options);
    const { compressed, stats } = compressData(jsonContent);
    
    const date = new Date().toISOString().split('T')[0];
    const filename = `onetab-plus-export-compressed-${date}.cjson`;
    
    logger.debug('压缩统计', stats);
    
    return {
      content: compressed,
      filename,
      mimeType: 'application/json'
    };
  }
  
  /**
   * 导出为OneTab格式
   */
  private async exportToOneTab(groups: TabGroup[]): Promise<{
    content: string;
    filename: string;
    mimeType: string;
  }> {
    const content = groups.map(group => {
      const tabLines = group.tabs.map(tab => `${tab.url} | ${tab.title}`);
      return tabLines.join('\n');
    }).join('\n\n');
    
    const date = new Date().toISOString().split('T')[0];
    const filename = `onetab-export-${date}.txt`;
    
    return {
      content,
      filename,
      mimeType: 'text/plain'
    };
  }
  
  /**
   * 导出为CSV格式
   */
  private async exportToCSV(groups: TabGroup[]): Promise<{
    content: string;
    filename: string;
    mimeType: string;
  }> {
    const headers = ['Group Name', 'Tab Title', 'URL', 'Created At', 'Is Locked'];
    const rows = [headers.join(',')];
    
    groups.forEach(group => {
      group.tabs.forEach(tab => {
        const row = [
          `"${group.name.replace(/"/g, '""')}"`,
          `"${tab.title.replace(/"/g, '""')}"`,
          `"${tab.url}"`,
          `"${group.createdAt}"`,
          `"${group.isLocked}"`
        ];
        rows.push(row.join(','));
      });
    });
    
    const content = rows.join('\n');
    const date = new Date().toISOString().split('T')[0];
    const filename = `onetab-export-${date}.csv`;
    
    return {
      content,
      filename,
      mimeType: 'text/csv'
    };
  }
  
  /**
   * 导出为HTML书签格式
   */
  private async exportToHTML(groups: TabGroup[]): Promise<{
    content: string;
    filename: string;
    mimeType: string;
  }> {
    const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>OneTab Plus Bookmarks</TITLE>
<H1>OneTab Plus Bookmarks</H1>
<DL><p>
${groups.map(group => `
    <DT><H3>${this.escapeHtml(group.name)}</H3>
    <DL><p>
${group.tabs.map(tab => `        <DT><A HREF="${tab.url}">${this.escapeHtml(tab.title)}</A>`).join('\n')}
    </DL><p>
`).join('')}
</DL><p>`;
    
    const date = new Date().toISOString().split('T')[0];
    const filename = `onetab-bookmarks-${date}.html`;
    
    return {
      content: html,
      filename,
      mimeType: 'text/html'
    };
  }
  
  /**
   * 导出为Markdown格式
   */
  private async exportToMarkdown(groups: TabGroup[]): Promise<{
    content: string;
    filename: string;
    mimeType: string;
  }> {
    const content = `# OneTab Plus Export

Generated on: ${new Date().toLocaleString()}

${groups.map(group => `
## ${group.name}

${group.tabs.map(tab => `- [${tab.title}](${tab.url})`).join('\n')}
`).join('\n')}`;
    
    const date = new Date().toISOString().split('T')[0];
    const filename = `onetab-export-${date}.md`;
    
    return {
      content,
      filename,
      mimeType: 'text/markdown'
    };
  }
  
  /**
   * 导出为XML格式
   */
  private async exportToXML(groups: TabGroup[], settings?: any): Promise<{
    content: string;
    filename: string;
    mimeType: string;
  }> {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<onetab-export version="2.0.0" timestamp="${new Date().toISOString()}">
  <groups>
${groups.map(group => `    <group id="${group.id}" name="${this.escapeXml(group.name)}" created="${group.createdAt}" locked="${group.isLocked}">
${group.tabs.map(tab => `      <tab id="${tab.id}" title="${this.escapeXml(tab.title)}" url="${this.escapeXml(tab.url)}" />`).join('\n')}
    </group>`).join('\n')}
  </groups>
  ${settings ? `<settings>${JSON.stringify(settings)}</settings>` : ''}
</onetab-export>`;
    
    const date = new Date().toISOString().split('T')[0];
    const filename = `onetab-export-${date}.xml`;
    
    return {
      content: xml,
      filename,
      mimeType: 'application/xml'
    };
  }
  
  /**
   * 下载文件
   */
  private async downloadFile(content: string, filename: string, mimeType: string): Promise<void> {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    URL.revokeObjectURL(url);
  }
  
  /**
   * 读取文件内容
   */
  private async readFile(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target?.result as string);
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.readAsText(file);
    });
  }
  
  /**
   * 检测文件格式
   */
  private detectFormat(filename: string, content: string): ExportFormat {
    const extension = filename.split('.').pop()?.toLowerCase();
    
    switch (extension) {
      case 'json':
        return ExportFormat.JSON;
      case 'cjson':
        return ExportFormat.COMPRESSED_JSON;
      case 'txt':
        return ExportFormat.ONETAB;
      case 'csv':
        return ExportFormat.CSV;
      case 'html':
      case 'htm':
        return ExportFormat.HTML;
      case 'md':
      case 'markdown':
        return ExportFormat.MARKDOWN;
      case 'xml':
        return ExportFormat.XML;
      default:
        // 尝试根据内容检测
        if (content.trim().startsWith('{') || content.trim().startsWith('[')) {
          return ExportFormat.JSON;
        } else if (content.includes('<!DOCTYPE') || content.includes('<html')) {
          return ExportFormat.HTML;
        } else if (content.includes('<?xml')) {
          return ExportFormat.XML;
        } else {
          return ExportFormat.ONETAB; // 默认为OneTab格式
        }
    }
  }
  
  /**
   * 解析JSON数据
   */
  private async parseJSON(content: string, isCompressed: boolean = false): Promise<{
    groups: TabGroup[];
    settings?: any;
  }> {
    let jsonContent = content;
    
    if (isCompressed) {
      jsonContent = decompressData(content);
    }
    
    const data = JSON.parse(jsonContent);
    
    if (data.data && data.data.groups) {
      return {
        groups: data.data.groups,
        settings: data.data.settings
      };
    } else if (Array.isArray(data)) {
      return { groups: data };
    } else {
      throw new Error('无效的JSON数据格式');
    }
  }
  
  /**
   * 解析OneTab格式数据
   */
  private async parseOneTab(content: string): Promise<TabGroup[]> {
    const groups: TabGroup[] = [];
    const sections = content.split('\n\n').filter(section => section.trim());
    
    sections.forEach((section, index) => {
      const lines = section.split('\n').filter(line => line.trim());
      const tabs: Tab[] = [];
      
      lines.forEach(line => {
        const match = line.match(/^(.+?)\s*\|\s*(.+)$/);
        if (match) {
          const [, url, title] = match;
          tabs.push({
            id: `imported-tab-${Date.now()}-${Math.random()}`,
            url: url.trim(),
            title: title.trim(),
            createdAt: new Date().toISOString(),
            lastAccessed: new Date().toISOString()
          });
        }
      });
      
      if (tabs.length > 0) {
        groups.push({
          id: `imported-group-${Date.now()}-${index}`,
          name: `导入的标签组 ${index + 1}`,
          tabs,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          isLocked: false,
          order: index
        });
      }
    });
    
    return groups;
  }
  
  /**
   * 解析CSV数据
   */
  private async parseCSV(content: string): Promise<TabGroup[]> {
    const lines = content.split('\n').filter(line => line.trim());
    // const headers = lines[0].split(',').map(h => h.replace(/"/g, ''));
    
    const groupsMap = new Map<string, TabGroup>();
    
    for (let i = 1; i < lines.length; i++) {
      const values = this.parseCSVLine(lines[i]);
      if (values.length >= 3) {
        const [groupName, tabTitle, url] = values;
        
        if (!groupsMap.has(groupName)) {
          groupsMap.set(groupName, {
            id: `imported-group-${Date.now()}-${groupsMap.size}`,
            name: groupName,
            tabs: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            isLocked: false,
            order: groupsMap.size
          });
        }
        
        const group = groupsMap.get(groupName)!;
        group.tabs.push({
          id: `imported-tab-${Date.now()}-${Math.random()}`,
          title: tabTitle,
          url: url,
          createdAt: new Date().toISOString(),
          lastAccessed: new Date().toISOString()
        });
      }
    }
    
    return Array.from(groupsMap.values());
  }
  
  /**
   * 解析HTML书签数据
   */
  private async parseHTML(content: string): Promise<TabGroup[]> {
    // 简单的HTML解析，实际项目中可能需要更强大的解析器
    const groups: TabGroup[] = [];
    const folderRegex = /<H3[^>]*>([^<]+)<\/H3>/gi;
    const linkRegex = /<A[^>]+HREF="([^"]+)"[^>]*>([^<]+)<\/A>/gi;
    
    let folderMatch;
    let currentGroupIndex = 0;
    
    while ((folderMatch = folderRegex.exec(content)) !== null) {
      const groupName = folderMatch[1];
      const group: TabGroup = {
        id: `imported-group-${Date.now()}-${currentGroupIndex}`,
        name: groupName,
        tabs: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isLocked: false,
        order: currentGroupIndex
      };
      
      // 查找该文件夹后的链接
      const folderEnd = content.indexOf('</DL>', folderMatch.index);
      const folderContent = content.substring(folderMatch.index, folderEnd);
      
      let linkMatch;
      while ((linkMatch = linkRegex.exec(folderContent)) !== null) {
        const [, url, title] = linkMatch;
        group.tabs.push({
          id: `imported-tab-${Date.now()}-${Math.random()}`,
          url: url,
          title: title,
          createdAt: new Date().toISOString(),
          lastAccessed: new Date().toISOString()
        });
      }
      
      if (group.tabs.length > 0) {
        groups.push(group);
        currentGroupIndex++;
      }
    }
    
    return groups;
  }
  
  /**
   * 解析Markdown数据
   */
  private async parseMarkdown(content: string): Promise<TabGroup[]> {
    const groups: TabGroup[] = [];
    const lines = content.split('\n');
    let currentGroup: TabGroup | null = null;
    let groupIndex = 0;
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      
      // 检测标题（标签组）
      if (trimmedLine.startsWith('## ')) {
        if (currentGroup && currentGroup.tabs.length > 0) {
          groups.push(currentGroup);
        }
        
        currentGroup = {
          id: `imported-group-${Date.now()}-${groupIndex}`,
          name: trimmedLine.substring(3).trim(),
          tabs: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          isLocked: false,
          order: groupIndex
        };
        groupIndex++;
      }
      
      // 检测链接（标签）
      else if (trimmedLine.startsWith('- [') && currentGroup) {
        const linkMatch = trimmedLine.match(/- \[([^\]]+)\]\(([^)]+)\)/);
        if (linkMatch) {
          const [, title, url] = linkMatch;
          currentGroup.tabs.push({
            id: `imported-tab-${Date.now()}-${Math.random()}`,
            title: title,
            url: url,
            createdAt: new Date().toISOString(),
            lastAccessed: new Date().toISOString()
          });
        }
      }
    }
    
    if (currentGroup && currentGroup.tabs.length > 0) {
      groups.push(currentGroup);
    }
    
    return groups;
  }
  
  /**
   * 解析XML数据
   */
  private async parseXML(content: string): Promise<{
    groups: TabGroup[];
    settings?: any;
  }> {
    // 简单的XML解析，实际项目中可能需要更强大的解析器
    const parser = new DOMParser();
    const doc = parser.parseFromString(content, 'application/xml');
    
    const groups: TabGroup[] = [];
    const groupElements = doc.querySelectorAll('group');
    
    groupElements.forEach((groupEl, index) => {
      const group: TabGroup = {
        id: groupEl.getAttribute('id') || `imported-group-${Date.now()}-${index}`,
        name: groupEl.getAttribute('name') || `导入的标签组 ${index + 1}`,
        tabs: [],
        createdAt: groupEl.getAttribute('created') || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isLocked: groupEl.getAttribute('locked') === 'true',
        order: index
      };
      
      const tabElements = groupEl.querySelectorAll('tab');
      tabElements.forEach(tabEl => {
        group.tabs.push({
          id: tabEl.getAttribute('id') || `imported-tab-${Date.now()}-${Math.random()}`,
          title: tabEl.getAttribute('title') || '',
          url: tabEl.getAttribute('url') || '',
          createdAt: new Date().toISOString(),
          lastAccessed: new Date().toISOString()
        });
      });
      
      groups.push(group);
    });
    
    // 尝试解析设置
    let settings;
    const settingsEl = doc.querySelector('settings');
    if (settingsEl && settingsEl.textContent) {
      try {
        settings = JSON.parse(settingsEl.textContent);
      } catch (error) {
        logger.warn('解析XML设置失败', error as any);
      }
    }
    
    return { groups, settings };
  }
  
  /**
   * 验证导入数据
   */
  private validateImportData(groups: TabGroup[]): void {
    if (!Array.isArray(groups)) {
      throw new Error('导入数据必须是标签组数组');
    }
    
    groups.forEach((group, index) => {
      if (!group.name || typeof group.name !== 'string') {
        throw new Error(`第${index + 1}个标签组缺少有效名称`);
      }
      
      if (!Array.isArray(group.tabs)) {
        throw new Error(`第${index + 1}个标签组的标签数据无效`);
      }
      
      group.tabs.forEach((tab, tabIndex) => {
        if (!tab.url || !tab.title) {
          throw new Error(`第${index + 1}个标签组的第${tabIndex + 1}个标签缺少必要信息`);
        }
      });
    });
  }
  
  /**
   * 导入标签组
   */
  private async importGroups(groups: TabGroup[], mergeMode: 'replace' | 'merge' | 'append'): Promise<void> {
    const existingGroups = await storage.getGroups();
    
    let finalGroups: TabGroup[];
    
    switch (mergeMode) {
      case 'replace':
        finalGroups = groups;
        break;
      case 'merge':
        // 合并：相同名称的组合并，其他的追加
        const mergedGroups = [...existingGroups];
        groups.forEach(newGroup => {
          const existingIndex = mergedGroups.findIndex(g => g.name === newGroup.name);
          if (existingIndex !== -1) {
            // 合并标签
            const existingGroup = mergedGroups[existingIndex];
            const combinedTabs = [...existingGroup.tabs, ...newGroup.tabs];
            // 去重
            const uniqueTabs = combinedTabs.filter((tab, index, arr) => 
              arr.findIndex(t => t.url === tab.url) === index
            );
            mergedGroups[existingIndex] = {
              ...existingGroup,
              tabs: uniqueTabs,
              updatedAt: new Date().toISOString()
            };
          } else {
            mergedGroups.push(newGroup);
          }
        });
        finalGroups = mergedGroups;
        break;
      case 'append':
      default:
        finalGroups = [...groups, ...existingGroups];
        break;
    }
    
    await storage.setGroups(finalGroups);
  }
  
  /**
   * 导入设置
   */
  private async importSettings(settings: any, mergeMode: 'replace' | 'merge' | 'append'): Promise<void> {
    if (mergeMode === 'replace') {
      await storage.setSettings(settings);
    } else {
      const existingSettings = await storage.getSettings();
      const mergedSettings = { ...existingSettings, ...settings };
      await storage.setSettings(mergedSettings);
    }
  }
  
  /**
   * 解析CSV行
   */
  private parseCSVLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++; // 跳过下一个引号
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    
    result.push(current);
    return result;
  }
  
  /**
   * 转义HTML字符
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
  
  /**
   * 转义XML字符
   */
  private escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}

// 导出单例实例
export const importExportService = new ImportExportService();
