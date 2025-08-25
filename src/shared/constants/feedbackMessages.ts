/**
 * 标准反馈消息常量
 * 统一管理应用中的所有反馈消息
 */

export const FEEDBACK_MESSAGES = {
  // 通用消息
  COMMON: {
    SUCCESS: '操作成功',
    ERROR: '操作失败，请重试',
    LOADING: '正在处理...',
    NETWORK_ERROR: '网络连接不稳定，请检查网络设置',
    PERMISSION_DENIED: '您没有执行此操作的权限',
    UNKNOWN_ERROR: '发生未知错误，请重试',
  },

  // 认证相关
  AUTH: {
    LOGIN_SUCCESS: '登录成功',
    LOGIN_ERROR: '登录失败，请检查用户名和密码',
    LOGIN_LOADING: '正在登录...',
    LOGOUT_SUCCESS: '已安全退出登录',
    REGISTER_SUCCESS: '注册成功，正在自动登录...',
    REGISTER_ERROR: '注册失败，请重试',
    REGISTER_LOADING: '正在注册...',
    SESSION_EXPIRED: '登录状态已过期，请重新登录',
    EMAIL_INVALID: '邮箱格式不正确，请输入有效的邮箱地址',
    PASSWORD_MISMATCH: '两次输入的密码不一致',
    PASSWORD_TOO_SHORT: '密码长度至少为8位',
    EMAIL_ALREADY_EXISTS: '该邮箱已被注册，请使用其他邮箱',
  },

  // 同步相关
  SYNC: {
    START: '正在同步数据...',
    SUCCESS: '数据同步完成',
    ERROR: '同步失败，请重试',
    UPLOAD_SUCCESS: '数据上传成功',
    UPLOAD_ERROR: '数据上传失败，请重试',
    UPLOAD_LOADING: '正在上传数据...',
    DOWNLOAD_SUCCESS: '数据下载成功',
    DOWNLOAD_ERROR: '数据下载失败，请重试',
    DOWNLOAD_LOADING: '正在下载数据...',
    CONFLICT_DETECTED: '检测到数据冲突，需要手动解决',
    AUTO_SYNC_ENABLED: '自动同步已启用',
    AUTO_SYNC_DISABLED: '自动同步已禁用',
    MERGE_SUCCESS: '数据合并完成',
    OVERWRITE_WARNING: '此操作将覆盖现有数据，是否继续？',
  },

  // 标签页操作
  TABS: {
    SAVE_SUCCESS: '标签页保存成功',
    SAVE_ERROR: '标签页保存失败',
    RESTORE_SUCCESS: '标签页恢复成功',
    RESTORE_ERROR: '标签页恢复失败',
    DELETE_SUCCESS: '标签页删除成功',
    DELETE_ERROR: '标签页删除失败',
    DELETE_CONFIRM: '确定要删除这个标签页吗？',
    MOVE_SUCCESS: '标签页移动成功',
    MOVE_ERROR: '标签页移动失败',
    DUPLICATE_REMOVED: '已移除重复的标签页',
    NO_TABS_TO_SAVE: '没有可保存的标签页',
    INVALID_URL: '无效的网址格式',
  },

  // 标签组操作
  GROUPS: {
    CREATE_SUCCESS: '标签组创建成功',
    CREATE_ERROR: '标签组创建失败',
    UPDATE_SUCCESS: '标签组更新成功',
    UPDATE_ERROR: '标签组更新失败',
    DELETE_SUCCESS: '标签组删除成功',
    DELETE_ERROR: '标签组删除失败',
    DELETE_CONFIRM: '确定要删除这个标签组吗？此操作不可撤销',
    RENAME_SUCCESS: '标签组重命名成功',
    RENAME_ERROR: '标签组重命名失败',
    EMPTY_NAME: '标签组名称不能为空',
    NAME_TOO_LONG: '标签组名称过长，请控制在50字符以内',
    RESTORE_ALL_SUCCESS: '所有标签页恢复成功',
    RESTORE_ALL_ERROR: '部分标签页恢复失败',
  },

  // 搜索相关
  SEARCH: {
    NO_RESULTS: '没有找到匹配的结果',
    SEARCHING: '正在搜索...',
    SEARCH_ERROR: '搜索失败，请重试',
    INVALID_QUERY: '搜索关键词不能为空',
    TOO_MANY_RESULTS: '搜索结果过多，请使用更具体的关键词',
  },

  // 文件操作
  FILE: {
    IMPORT_SUCCESS: '文件导入成功',
    IMPORT_ERROR: '文件导入失败，请检查文件格式',
    IMPORT_LOADING: '正在导入文件...',
    EXPORT_SUCCESS: '文件导出成功',
    EXPORT_ERROR: '文件导出失败，请重试',
    EXPORT_LOADING: '正在导出文件...',
    INVALID_FORMAT: '不支持的文件格式',
    FILE_TOO_LARGE: '文件大小超出限制',
    UPLOAD_SUCCESS: '文件上传成功',
    UPLOAD_ERROR: '文件上传失败',
    DOWNLOAD_SUCCESS: '文件下载完成',
    DOWNLOAD_ERROR: '文件下载失败',
  },

  // 设置相关
  SETTINGS: {
    SAVE_SUCCESS: '设置保存成功',
    SAVE_ERROR: '设置保存失败',
    RESET_SUCCESS: '设置已重置为默认值',
    RESET_CONFIRM: '确定要重置所有设置吗？',
    INVALID_VALUE: '设置值无效，请重新输入',
    THEME_CHANGED: '主题已切换',
    LANGUAGE_CHANGED: '语言已切换',
  },

  // 数据验证
  VALIDATION: {
    REQUIRED_FIELD: '此字段为必填项',
    INVALID_EMAIL: '请输入有效的邮箱地址',
    INVALID_URL: '请输入有效的网址',
    INVALID_NUMBER: '请输入有效的数字',
    MIN_LENGTH: (min: number) => `最少需要${min}个字符`,
    MAX_LENGTH: (max: number) => `最多允许${max}个字符`,
    INVALID_FORMAT: '格式不正确',
  },

  // 网络状态
  NETWORK: {
    ONLINE: '网络连接已恢复',
    OFFLINE: '网络连接已断开，数据将保存到本地',
    SLOW_CONNECTION: '网络连接较慢，请耐心等待',
    CONNECTION_ERROR: '网络连接错误，请检查网络设置',
    TIMEOUT: '请求超时，请重试',
    SERVER_ERROR: '服务器错误，请稍后重试',
  },

  // 权限相关
  PERMISSION: {
    DENIED: '权限被拒绝',
    INSUFFICIENT: '权限不足，无法执行此操作',
    EXPIRED: '权限已过期，请重新授权',
    REQUIRED: '此操作需要特殊权限',
  },

  // 数据状态
  DATA: {
    LOADING: '正在加载数据...',
    EMPTY: '暂无数据',
    CORRUPTED: '数据已损坏，请重新同步',
    OUTDATED: '数据已过期，建议重新同步',
    SAVED_LOCALLY: '数据已保存到本地',
    BACKUP_CREATED: '数据备份已创建',
    RESTORE_SUCCESS: '数据恢复成功',
    RESTORE_ERROR: '数据恢复失败',
  },

  // 批量操作
  BATCH: {
    SELECT_ITEMS: '请选择要操作的项目',
    OPERATION_SUCCESS: (count: number) => `成功处理${count}项`,
    OPERATION_ERROR: (count: number) => `${count}项操作失败`,
    PARTIAL_SUCCESS: (success: number, failed: number) => 
      `${success}项成功，${failed}项失败`,
    CONFIRM_DELETE: (count: number) => `确定要删除选中的${count}项吗？`,
    PROCESSING: (current: number, total: number) => 
      `正在处理 ${current}/${total}`,
  },

  // 快捷键
  SHORTCUTS: {
    ENABLED: '快捷键已启用',
    DISABLED: '快捷键已禁用',
    CONFLICT: '快捷键冲突，请重新设置',
    INVALID: '无效的快捷键组合',
  },

  // 更新相关
  UPDATE: {
    AVAILABLE: '发现新版本，是否立即更新？',
    DOWNLOADING: '正在下载更新...',
    INSTALLING: '正在安装更新...',
    SUCCESS: '更新完成，请重启应用',
    ERROR: '更新失败，请手动下载',
    NO_UPDATE: '当前已是最新版本',
  },

  // 帮助和支持
  HELP: {
    CONTACT_SUPPORT: '如需帮助，请联系技术支持',
    DOCUMENTATION: '查看帮助文档了解更多信息',
    FEEDBACK_SENT: '反馈已发送，感谢您的建议',
    FEEDBACK_ERROR: '反馈发送失败，请重试',
  },
} as const;

// 导出类型
export type FeedbackMessageKey = keyof typeof FEEDBACK_MESSAGES;
export type CommonMessageKey = keyof typeof FEEDBACK_MESSAGES.COMMON;
export type AuthMessageKey = keyof typeof FEEDBACK_MESSAGES.AUTH;
export type SyncMessageKey = keyof typeof FEEDBACK_MESSAGES.SYNC;

// 辅助函数：获取消息
export function getMessage(category: FeedbackMessageKey, key: string): string {
  const categoryMessages = FEEDBACK_MESSAGES[category] as Record<string, any>;
  return categoryMessages[key] || FEEDBACK_MESSAGES.COMMON.UNKNOWN_ERROR;
}

// 辅助函数：格式化消息
export function formatMessage(template: string, ...args: any[]): string {
  return template.replace(/\{(\d+)\}/g, (match, index) => {
    return args[parseInt(index)] || match;
  });
}
