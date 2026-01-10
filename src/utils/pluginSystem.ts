/**
 * 插件架构系统
 * 提供可扩展的插件机制，支持功能模块的动态加载和卸载
 */

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  dependencies?: string[];
  permissions?: string[];
  entry: string;
  config?: Record<string, any>;
}

export interface PluginContext {
  registerHook: (hookName: string, handler: Function) => void;
  unregisterHook: (hookName: string, handler: Function) => void;
  emitHook: (hookName: string, ...args: any[]) => Promise<any[]>;
  getService: <T>(serviceName: string) => T | null;
  registerService: <T>(serviceName: string, service: T) => void;
  getConfig: () => Record<string, any>;
  updateConfig: (config: Record<string, any>) => void;
}

export interface Plugin {
  manifest: PluginManifest;
  context: PluginContext;

  // 生命周期方法
  onLoad?: () => Promise<void> | void;
  onUnload?: () => Promise<void> | void;
  onConfigChange?: (config: Record<string, any>) => void;

  // 插件提供的功能
  getHooks?: () => Record<string, Function>;
  getServices?: () => Record<string, any>;
}

/**
 * 插件管理器
 */
export class PluginManager {
  private plugins = new Map<string, Plugin>();
  private hooks = new Map<string, Set<Function>>();
  private services = new Map<string, any>();
  private pluginConfigs = new Map<string, Record<string, any>>();

  /**
   * 注册插件
   */
  async registerPlugin(plugin: Plugin): Promise<void> {
    const { id } = plugin.manifest;

    if (this.plugins.has(id)) {
      throw new Error(`Plugin ${id} is already registered`);
    }

    // 检查依赖
    if (plugin.manifest.dependencies) {
      for (const depId of plugin.manifest.dependencies) {
        if (!this.plugins.has(depId)) {
          throw new Error(`Plugin ${id} depends on ${depId}, which is not loaded`);
        }
      }
    }

    // 创建插件上下文
    const context: PluginContext = {
      registerHook: (hookName: string, handler: Function) => {
        this.registerHook(hookName, handler);
      },
      unregisterHook: (hookName: string, handler: Function) => {
        this.unregisterHook(hookName, handler);
      },
      emitHook: (hookName: string, ...args: any[]) => {
        return this.emitHook(hookName, ...args);
      },
      getService: <T>(serviceName: string): T | null => {
        return this.getService<T>(serviceName);
      },
      registerService: <T>(serviceName: string, service: T) => {
        this.registerService(serviceName, service);
      },
      getConfig: () => {
        return pluginManager.getPluginConfig(id);
      },
      updateConfig: (config: Record<string, any>) => {
        const currentConfig = pluginManager.getPluginConfig(id);
        pluginManager.pluginConfigs.set(id, { ...currentConfig, ...config });
        plugin.onConfigChange?.(pluginManager.getPluginConfig(id));
      },
    };

    plugin.context = context;
    this.plugins.set(id, plugin);

    // 加载插件提供的钩子和服务
    if (plugin.getHooks) {
      const hooks = plugin.getHooks();
      Object.entries(hooks).forEach(([hookName, handler]) => {
        this.registerHook(hookName, handler);
      });
    }

    if (plugin.getServices) {
      const services = plugin.getServices();
      Object.entries(services).forEach(([serviceName, service]) => {
        this.registerService(serviceName, service);
      });
    }

    // 调用插件的onLoad生命周期方法
    if (plugin.onLoad) {
      await plugin.onLoad();
    }

    console.log(`Plugin ${id} loaded successfully`);
  }

  /**
   * 卸载插件
   */
  async unregisterPlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} is not registered`);
    }

    // 调用插件的onUnload生命周期方法
    if (plugin.onUnload) {
      await plugin.onUnload();
    }

    // 移除插件提供的钩子和服务
    if (plugin.getHooks) {
      const hooks = plugin.getHooks();
      Object.entries(hooks).forEach(([hookName, handler]) => {
        this.unregisterHook(hookName, handler);
      });
    }

    if (plugin.getServices) {
      const services = plugin.getServices();
      Object.entries(services).forEach(([serviceName]) => {
        this.services.delete(serviceName);
      });
    }

    // 移除插件
    this.plugins.delete(pluginId);
    this.pluginConfigs.delete(pluginId);

    console.log(`Plugin ${pluginId} unloaded successfully`);
  }

  /**
   * 获取插件
   */
  getPlugin(pluginId: string): Plugin | null {
    return this.plugins.get(pluginId) || null;
  }

  /**
   * 获取所有插件
   */
  getAllPlugins(): Plugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * 检查插件是否已加载
   */
  isPluginLoaded(pluginId: string): boolean {
    return this.plugins.has(pluginId);
  }

  /**
   * 获取插件配置
   */
  getPluginConfig(pluginId: string): Record<string, any> {
    return this.pluginConfigs.get(pluginId) || {};
  }

  /**
   * 触发钩子（公共方法）
   */
  public emitHookPublic(hookName: string, ...args: any[]): Promise<any[]> {
    return this.emitHook(hookName, ...args);
  }

  /**
   * 获取服务（公共方法）
   */
  public getServicePublic<T>(serviceName: string): T | null {
    return this.getService(serviceName);
  }

  /**
   * 注册钩子
   */
  private registerHook(hookName: string, handler: Function): void {
    if (!this.hooks.has(hookName)) {
      this.hooks.set(hookName, new Set());
    }
    this.hooks.get(hookName)!.add(handler);
  }

  /**
   * 注销钩子
   */
  private unregisterHook(hookName: string, handler: Function): void {
    const hookSet = this.hooks.get(hookName);
    if (hookSet) {
      hookSet.delete(handler);
      if (hookSet.size === 0) {
        this.hooks.delete(hookName);
      }
    }
  }

  /**
   * 触发钩子
   */
  private async emitHook(hookName: string, ...args: any[]): Promise<any[]> {
    const hookSet = this.hooks.get(hookName);
    if (!hookSet || hookSet.size === 0) {
      return [];
    }

    const results: any[] = [];
    const promises: Promise<any>[] = [];

    for (const handler of hookSet) {
      try {
        const result = handler(...args);
        if (result instanceof Promise) {
          promises.push(result);
        } else {
          results.push(result);
        }
      } catch (error) {
        console.error(`Hook ${hookName} handler error:`, error);
      }
    }

    // 等待所有异步结果
    if (promises.length > 0) {
      try {
        const asyncResults = await Promise.all(promises);
        results.push(...asyncResults);
      } catch (error) {
        console.error(`Async hook ${hookName} error:`, error);
      }
    }

    return results;
  }

  /**
   * 获取服务
   */
  private getService<T>(serviceName: string): T | null {
    return (this.services.get(serviceName) as T) || null;
  }

  /**
   * 注册服务
   */
  private registerService<T>(serviceName: string, service: T): void {
    this.services.set(serviceName, service);
  }

  /**
   * 清理所有插件
   */
  async cleanup(): Promise<void> {
    const pluginIds = Array.from(this.plugins.keys());
    for (const pluginId of pluginIds) {
      await this.unregisterPlugin(pluginId);
    }
  }
}

// 创建全局插件管理器实例
export const pluginManager = new PluginManager();

/**
 * 插件加载器
 */
export class PluginLoader {
  /**
   * 从URL加载插件
   */
  static async loadFromUrl(url: string): Promise<Plugin> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to load plugin from ${url}: ${response.statusText}`);
      }

      const pluginCode = await response.text();
      return this.loadFromCode(pluginCode);
    } catch (error) {
      console.error(`Failed to load plugin from ${url}:`, error);
      throw error;
    }
  }

  /**
   * 从代码字符串加载插件
   */
  static async loadFromCode(code: string): Promise<Plugin> {
    try {
      // 创建沙箱环境执行插件代码
      const pluginFunction = new Function(
        'PluginAPI',
        `
        ${code}
        return typeof createPlugin === 'function' ? createPlugin(PluginAPI) : null;
      `
      );

      const PluginAPI = {
        PluginManager,
        registerHook: pluginManager.emitHookPublic.bind(pluginManager),
        getService: pluginManager.getServicePublic.bind(pluginManager),
        // 其他API...
      };

      const plugin = pluginFunction(PluginAPI);

      if (!plugin) {
        throw new Error('Plugin did not export a createPlugin function');
      }

      return plugin;
    } catch (error) {
      console.error(`Failed to load plugin from code:`, error);
      throw error;
    }
  }

  /**
   * 从清单文件加载插件
   */
  static async loadFromManifest(manifest: PluginManifest): Promise<Plugin> {
    try {
      // 加载插件入口文件
      const response = await fetch(manifest.entry);
      if (!response.ok) {
        throw new Error(`Failed to load plugin entry: ${manifest.entry}`);
      }

      const pluginCode = await response.text();
      const plugin = await this.loadFromCode(pluginCode);

      // 验证插件清单
      if (plugin.manifest.id !== manifest.id) {
        throw new Error(`Plugin ID mismatch: expected ${manifest.id}, got ${plugin.manifest.id}`);
      }

      return plugin;
    } catch (error) {
      console.error(`Failed to load plugin from manifest:`, error);
      throw error;
    }
  }
}

/**
 * 预定义钩子名称常量
 */
export const HOOKS = {
  // UI钩子
  UI_RENDER_HEADER: 'ui:render:header',
  UI_RENDER_SIDEBAR: 'ui:render:sidebar',
  UI_RENDER_FOOTER: 'ui:render:footer',

  // 数据钩子
  DATA_LOAD: 'data:load',
  DATA_SAVE: 'data:save',
  DATA_SYNC: 'data:sync',

  // 事件钩子
  EVENT_TAB_CREATED: 'event:tab:created',
  EVENT_TAB_DELETED: 'event:tab:deleted',
  EVENT_GROUP_CREATED: 'event:group:created',
  EVENT_GROUP_DELETED: 'event:group:deleted',

  // 命令钩子
  COMMAND_EXECUTE: 'command:execute',
  COMMAND_REGISTER: 'command:register',

  // 扩展钩子
  EXTENSION_ACTIVATE: 'extension:activate',
  EXTENSION_DEACTIVATE: 'extension:deactivate',
} as const;

/**
 * 预定义服务名称常量
 */
export const SERVICES = {
  STORAGE: 'storage',
  SYNC: 'sync',
  THEME: 'theme',
  PERFORMANCE: 'performance',
  NOTIFICATION: 'notification',
} as const;

/**
 * 插件模板创建器
 */
export class PluginTemplate {
  static createBasicPlugin(manifest: PluginManifest): string {
    return `
      export function createPlugin(PluginAPI) {
        return {
          manifest: ${JSON.stringify(manifest, null, 2)},

          onLoad() {
            console.log('Plugin ${manifest.id} loaded');
          },

          onUnload() {
            console.log('Plugin ${manifest.id} unloaded');
          },

          getHooks() {
            return {
              // 在这里注册钩子处理函数
            };
          },

          getServices() {
            return {
              // 在这里注册服务
            };
          },
        };
      }
    `;
  }

  static createUIPlugin(manifest: PluginManifest): string {
    return `
      export function createPlugin(PluginAPI) {
        return {
          manifest: ${JSON.stringify(manifest, null, 2)},

          onLoad() {
            console.log('UI Plugin ${manifest.id} loaded');
          },

          getHooks() {
            return {
              '${HOOKS.UI_RENDER_HEADER}': this.renderHeader.bind(this),
              '${HOOKS.UI_RENDER_SIDEBAR}': this.renderSidebar.bind(this),
            };
          },

          renderHeader() {
            // 返回要渲染的React组件
            return null;
          },

          renderSidebar() {
            // 返回要渲染的React组件
            return null;
          },
        };
      }
    `;
  }

  static createDataPlugin(manifest: PluginManifest): string {
    return `
      export function createPlugin(PluginAPI) {
        return {
          manifest: ${JSON.stringify(manifest, null, 2)},

          onLoad() {
            console.log('Data Plugin ${manifest.id} loaded');
          },

          getHooks() {
            return {
              '${HOOKS.DATA_LOAD}': this.onDataLoad.bind(this),
              '${HOOKS.DATA_SAVE}': this.onDataSave.bind(this),
            };
          },

          onDataLoad(data) {
            // 处理数据加载
            return data;
          },

          onDataSave(data) {
            // 处理数据保存
            return data;
          },
        };
      }
    `;
  }
}
