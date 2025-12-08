import { indexedDbDriver, isIndexedDbAvailable } from './indexedDbClient';
import { localStorageDriver, isLocalStorageAvailable } from './localStorageFallback';
import type { StorageBackend, StorageDriver } from './types';

const MIGRATION_KEYS = {
  deviceId: 'tabvaultpro_device_id',
  legacyDeviceId: 'deviceId', // 早期版本存放在 chrome.storage.local 的键
  syncPrompt: 'tabvaultpro_sync_prompt_shown',
  tabGroupPrefix: 'tabGroup_',
  tabGroups: 'tab_groups',
  legacyTabGroups: 'tabGroups', // 早期 service worker 使用的键
  userSettings: 'user_settings',
  deletedGroups: 'deleted_tab_groups',
  deletedTabs: 'deleted_tabs',
  lastSyncTime: 'last_sync_time',
  migrationFlags: 'migration_flags'
};

let backend: StorageBackend | null = null;
let driver: StorageDriver | null = null;
let initialized = false;

function pickBackend(): StorageBackend {
  if (isIndexedDbAvailable()) return 'indexeddb';
  return 'localStorage';
}

async function migrateFromLocalStorage(target: StorageDriver) {
  // Service Worker 环境没有 window，跳过迁移以避免报错
  if (typeof window === 'undefined') return;
  if (!isLocalStorageAvailable()) return;
  const ls = window.localStorage;
  const candidates: Array<{ key: string; value: unknown }> = [];

  for (let i = 0; i < ls.length; i += 1) {
    const key = ls.key(i);
    if (!key) continue;
    const interested =
      key === MIGRATION_KEYS.deviceId ||
      key === MIGRATION_KEYS.syncPrompt ||
      key === MIGRATION_KEYS.tabGroups ||
      key === MIGRATION_KEYS.legacyTabGroups ||
      key === MIGRATION_KEYS.userSettings ||
      key === MIGRATION_KEYS.deletedGroups ||
      key === MIGRATION_KEYS.deletedTabs ||
      key === MIGRATION_KEYS.lastSyncTime ||
      key === MIGRATION_KEYS.migrationFlags ||
      key.startsWith(MIGRATION_KEYS.tabGroupPrefix);

    if (interested) {
      const raw = ls.getItem(key);
      if (raw !== null) {
        try {
          candidates.push({ key, value: JSON.parse(raw) });
        } catch {
          candidates.push({ key, value: raw });
        }
      }
    }
  }

  if (!candidates.length) return;

  await Promise.all(candidates.map(entry => target.setItem(entry.key, entry.value)));
}

// 将 chrome.storage.local 中的旧数据迁移到统一的 kv 存储
async function migrateFromChromeStorage(target: StorageDriver) {
  const hasChromeStorage = typeof chrome !== 'undefined' && !!chrome.storage?.local;
  if (!hasChromeStorage) return;

  // 迁移只执行一次，避免刷新后旧数据反复覆盖
  const flags = (await target.getItem<Record<string, boolean>>(MIGRATION_KEYS.migrationFlags)) || {};
  if (flags.chromeStorageMigrated) return;

  const keys = [
    MIGRATION_KEYS.deviceId,
    MIGRATION_KEYS.legacyDeviceId,
    MIGRATION_KEYS.syncPrompt,
    MIGRATION_KEYS.tabGroups,
    MIGRATION_KEYS.legacyTabGroups,
    MIGRATION_KEYS.userSettings,
    MIGRATION_KEYS.deletedGroups,
    MIGRATION_KEYS.deletedTabs,
    MIGRATION_KEYS.lastSyncTime,
    MIGRATION_KEYS.migrationFlags
  ];

  try {
    const result = await chrome.storage.local.get(keys);
    const entries = Object.entries(result).filter(([, value]) => value !== undefined);
    if (!entries.length) return;

    await Promise.all(entries.map(([key, value]) => target.setItem(key, value)));

    // 标记已迁移，并清理旧键，避免后续刷新重新写回旧数据
    flags.chromeStorageMigrated = true;
    await target.setItem(MIGRATION_KEYS.migrationFlags, flags);
    await chrome.storage.local.remove(keys);
  } catch (error) {
    console.warn('[storage] migrateFromChromeStorage failed, skip migration', error);
  }
}

async function ensureInitialized() {
  if (initialized) return;

  backend = pickBackend();
  driver = backend === 'indexeddb' ? indexedDbDriver : localStorageDriver;

  if (backend === 'indexeddb') {
    // 尝试迁移已有 chrome.storage/localStorage 数据
    await migrateFromChromeStorage(driver);
    await migrateFromLocalStorage(driver);
  }

  initialized = true;
}

// 显式初始化，供入口处预热与日志上报
export async function initStorage(): Promise<StorageBackend | null> {
  await ensureInitialized();
  return backend;
}

export async function kvGet<T = unknown>(key: string): Promise<T | null> {
  await ensureInitialized();
  if (!driver) return null;
  return driver.getItem<T>(key);
}

export async function kvSet<T = unknown>(key: string, value: T): Promise<void> {
  await ensureInitialized();
  if (!driver) return;
  await driver.setItem<T>(key, value);
}

export async function kvRemove(key: string): Promise<void> {
  await ensureInitialized();
  if (!driver) return;
  await driver.removeItem(key);
}

export function getActiveBackend(): StorageBackend | null {
  return backend;
}

