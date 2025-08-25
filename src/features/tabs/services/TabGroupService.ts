import { TabGroup, Tab } from '@/shared/types/tab';
import { storage } from '@/shared/utils/storage';
import { logger } from '@/shared/utils/logger';
import { errorHandler } from '@/shared/utils/errorHandler';

/**
 * 标签组领域服务
 * 负责标签组的业务逻辑，包括CRUD操作、验证、排序等
 */
export class TabGroupService {
  /**
   * 创建新的标签组
   */
  async createTabGroup(name: string, tabs: Tab[] = []): Promise<TabGroup> {
    try {
      const newGroup: TabGroup = {
        id: this.generateId(),
        name: name.trim(),
        tabs,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isLocked: false,
        color: this.getRandomColor(),
        order: await this.getNextOrder()
      };

      // 验证标签组
      this.validateTabGroup(newGroup);

      // 保存到存储
      const groups = await storage.getGroups();
      groups.push(newGroup);
      await storage.setGroups(groups);

      logger.debug('创建标签组成功', { groupId: newGroup.id, name: newGroup.name });
      return newGroup;
    } catch (error) {
      logger.error('创建标签组失败', error);
      throw errorHandler.createError('创建标签组失败', error);
    }
  }

  /**
   * 更新标签组
   */
  async updateTabGroup(groupId: string, updates: Partial<TabGroup>): Promise<TabGroup> {
    try {
      const groups = await storage.getGroups();
      const groupIndex = groups.findIndex(g => g.id === groupId);
      
      if (groupIndex === -1) {
        throw new Error(`标签组不存在: ${groupId}`);
      }

      const updatedGroup = {
        ...groups[groupIndex],
        ...updates,
        updatedAt: new Date().toISOString()
      };

      // 验证更新后的标签组
      this.validateTabGroup(updatedGroup);

      groups[groupIndex] = updatedGroup;
      await storage.setGroups(groups);

      logger.debug('更新标签组成功', { groupId, updates });
      return updatedGroup;
    } catch (error) {
      logger.error('更新标签组失败', error);
      throw errorHandler.createError('更新标签组失败', error);
    }
  }

  /**
   * 删除标签组
   */
  async deleteTabGroup(groupId: string): Promise<void> {
    try {
      const groups = await storage.getGroups();
      const filteredGroups = groups.filter(g => g.id !== groupId);
      
      if (filteredGroups.length === groups.length) {
        throw new Error(`标签组不存在: ${groupId}`);
      }

      await storage.setGroups(filteredGroups);
      logger.debug('删除标签组成功', { groupId });
    } catch (error) {
      logger.error('删除标签组失败', error);
      throw errorHandler.createError('删除标签组失败', error);
    }
  }

  /**
   * 获取标签组
   */
  async getTabGroup(groupId: string): Promise<TabGroup | null> {
    try {
      const groups = await storage.getGroups();
      return groups.find(g => g.id === groupId) || null;
    } catch (error) {
      logger.error('获取标签组失败', error);
      throw errorHandler.createError('获取标签组失败', error);
    }
  }

  /**
   * 获取所有标签组
   */
  async getAllTabGroups(): Promise<TabGroup[]> {
    try {
      return await storage.getGroups();
    } catch (error) {
      logger.error('获取所有标签组失败', error);
      throw errorHandler.createError('获取所有标签组失败', error);
    }
  }

  /**
   * 重新排序标签组
   */
  async reorderTabGroups(groupIds: string[]): Promise<void> {
    try {
      const groups = await storage.getGroups();
      const reorderedGroups = groupIds.map((id, index) => {
        const group = groups.find(g => g.id === id);
        if (!group) {
          throw new Error(`标签组不存在: ${id}`);
        }
        return {
          ...group,
          order: index,
          updatedAt: new Date().toISOString()
        };
      });

      await storage.setGroups(reorderedGroups);
      logger.debug('重新排序标签组成功', { groupIds });
    } catch (error) {
      logger.error('重新排序标签组失败', error);
      throw errorHandler.createError('重新排序标签组失败', error);
    }
  }

  /**
   * 切换标签组锁定状态
   */
  async toggleGroupLock(groupId: string): Promise<TabGroup> {
    try {
      const group = await this.getTabGroup(groupId);
      if (!group) {
        throw new Error(`标签组不存在: ${groupId}`);
      }

      return await this.updateTabGroup(groupId, { isLocked: !group.isLocked });
    } catch (error) {
      logger.error('切换标签组锁定状态失败', error);
      throw errorHandler.createError('切换标签组锁定状态失败', error);
    }
  }

  /**
   * 验证标签组数据
   */
  private validateTabGroup(group: TabGroup): void {
    if (!group.name || group.name.trim().length === 0) {
      throw new Error('标签组名称不能为空');
    }

    if (group.name.length > 100) {
      throw new Error('标签组名称不能超过100个字符');
    }

    if (!Array.isArray(group.tabs)) {
      throw new Error('标签组必须包含标签数组');
    }

    // 验证标签
    group.tabs.forEach((tab, index) => {
      if (!tab.url || !tab.title) {
        throw new Error(`第${index + 1}个标签缺少必要信息`);
      }
    });
  }

  /**
   * 生成唯一ID
   */
  private generateId(): string {
    return `group_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 获取随机颜色
   */
  private getRandomColor(): string {
    const colors = ['blue', 'green', 'purple', 'red', 'yellow', 'indigo', 'pink'];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  /**
   * 获取下一个排序值
   */
  private async getNextOrder(): Promise<number> {
    try {
      const groups = await storage.getGroups();
      return groups.length > 0 ? Math.max(...groups.map(g => g.order || 0)) + 1 : 0;
    } catch (error) {
      return 0;
    }
  }
}

// 导出单例实例
export const tabGroupService = new TabGroupService();
