import { indexedDbDriver, isIndexedDbAvailable } from './indexedDbClient';
import { localStorageDriver, isLocalStorageAvailable } from './localStorageFallback';
import type { StorageBackend, StorageDriver } from './types';

const MIGRATION_KEYS = {
  deviceId: 'tabvaultpro_device_id',
  syncPrompt: 'tabvaultpro_sync_prompt_shown',
  tabGroupPrefix: 'tabGroup_'
};

let backend: StorageBackend | null = null;
let driver: StorageDriver | null = null;
let initialized = false;

function pickBackend(): StorageBackend {
  if (isIndexedDbAvailable()) return 'indexeddb';
  return 'localStorage';
}

async function migrateFromLocalStorage(target: StorageDriver) {
  if (!isLocalStorageAvailable()) return;
  const ls = window.localStorage;
  const candidates: Array<{ key: string; value: unknown }> = [];

  for (let i = 0; i < ls.length; i += 1) {
    const key = ls.key(i);
    if (!key) continue;
    if (
      key === MIGRATION_KEYS.deviceId ||
      key === MIGRATION_KEYS.syncPrompt ||
      key.startsWith(MIGRATION_KEYS.tabGroupPrefix)
    ) {
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

async function ensureInitialized() {
  if (initialized) return;

  backend = pickBackend();
  driver = backend === 'indexeddb' ? indexedDbDriver : localStorageDriver;

  if (backend === 'indexeddb') {
    // 尝试迁移已有 localStorage 数据
    await migrateFromLocalStorage(driver);
  }

  initialized = true;
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

