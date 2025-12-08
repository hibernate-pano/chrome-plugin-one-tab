import type { StorageDriver } from './types';

function isLocalStorageAvailable(): boolean {
  try {
    const testKey = '__tv_test__';
    window.localStorage.setItem(testKey, '1');
    window.localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

export const localStorageDriver: StorageDriver = {
  async getItem<T>(key: string): Promise<T | null> {
    if (!isLocalStorageAvailable()) return null;
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // 非 JSON 内容直接返回字符串
      return raw as unknown as T;
    }
  },

  async setItem<T>(key: string, value: T): Promise<void> {
    if (!isLocalStorageAvailable()) return;
    window.localStorage.setItem(key, JSON.stringify(value));
  },

  async removeItem(key: string): Promise<void> {
    if (!isLocalStorageAvailable()) return;
    window.localStorage.removeItem(key);
  }
};

export { isLocalStorageAvailable };

