import { storage } from './storage';

/**
 * 显示通知，但仅当用户设置允许显示通知时
 * @param options 通知选项
 * @returns 通知ID或null（如果通知被禁用）
 */
export async function showNotification(
  options: chrome.notifications.NotificationOptions
): Promise<string | null> {
  // 获取用户设置
  const settings = await storage.getSettings();

  // 如果用户禁用了通知，则不显示
  if (!settings.showNotifications) {
    return null;
  }

  // 确保必要的字段存在
  const notificationOptions: chrome.notifications.NotificationOptions = {
    type: options.type || 'basic',
    iconUrl: options.iconUrl || chrome.runtime.getURL('icons/icon128.png'),
    title: options.title || '',
    message: options.message || '',
    ...options
  };

  // 创建通知并返回通知ID
  return new Promise((resolve) => {
    chrome.notifications.create(notificationOptions as any, (notificationId) => {
      resolve(notificationId);
    });
  });
}

/**
 * 显示带有ID的通知，但仅当用户设置允许显示通知时
 * @param id 通知ID
 * @param options 通知选项
 * @returns 通知ID或null（如果通知被禁用）
 */
export async function showNotificationWithId(
  id: string,
  options: chrome.notifications.NotificationOptions
): Promise<string | null> {
  // 获取用户设置
  const settings = await storage.getSettings();

  // 如果用户禁用了通知，则不显示
  if (!settings.showNotifications) {
    return null;
  }

  // 确保必要的字段存在
  const notificationOptions: chrome.notifications.NotificationOptions = {
    type: options.type || 'basic',
    iconUrl: options.iconUrl || chrome.runtime.getURL('icons/icon128.png'),
    title: options.title || '',
    message: options.message || '',
    ...options
  };

  // 创建通知并返回通知ID
  return new Promise((resolve) => {
    chrome.notifications.create(id, notificationOptions as any, (notificationId) => {
      resolve(notificationId);
    });
  });
}
