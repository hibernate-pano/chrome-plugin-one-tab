import { logError, logWarn } from './log';
import { base64Decode, base64Encode, concatArrays } from './base64';
const V1_PREFIX = 'SECURE_V1:';
const V2_PREFIX = 'SECURE_V2:';
const V3_PREFIX = 'SECURE_V3:';
const PBKDF2_ITERATIONS = 100_000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const KEY_LENGTH = 256;

// V3 持久化密钥的 chrome.storage.local 键。
// V3 与 V2 的关键区别：V2 的 key 派生自 chrome.runtime.id（unpacked 开发模式
// 重新加载扩展时 ID 会变化 → 旧 blob 全部解不开 → 用户数据"消失"）。
// V3 使用首次生成的随机密钥，持久化存储，扩展 ID 变化不影响。
const LOCAL_KEY_STORAGE_KEY = 'ts_local_encryption_key_v3';

/**
 * 需要**加密存储**的键（2026-10-09 架构 P2-1 修正）。
 *
 * 【修正前的问题】清单是 `['deviceId','migration_flags','auth_cache',
 * 'user_preferences','sync_tokens']`，与实际写入路径全面漂移：
 *   · user_preferences / sync_tokens —— **零生产写入方**（python 全仓扫描，
 *     两处命中都在本文件这份清单自己里）。它们是预留名，不是既成事实。
 *   · deviceId —— 只有 **get**（encryptionUtils.ts:24 读旧值），没有 set。
 *     真正的写入方是 deviceUtils，走 KV 层。列在这里只让「读」路径走解密，
 *     而写入方压根不经过本模块。
 *   · auth_cache —— 真实且敏感（含用户 email 与登录态），但 authCache.ts 直接
 *     `chrome.storage.local.set()`，**绕过**本模块（清单里列了它也没用）。
 *
 * 【为什么只留 migration_flags】它是唯一真正经由 SecureStorage **双向**落盘的键
 * （storage.ts:1159 get / :1177 set，且值字面与本清单一致 ⇒ isSensitiveKey 生效）。
 * 其余各项要么零写入方、要么只读、要么绕过本模块。
 *
 * 【auth_cache 为什么暂不列入】让它改走 SecureStorage 需要设计迁移路径
 * （旧明文值如何过渡、失败时是否降级明文），属安全/产品边界决策，尚未拍板。
 * 在那之前**不加进清单** —— 加了会给「它已加密」一个假印象，比不列更糟。
 *
 * 【怎么防止再次漂移】tests/guards/storageKvConvergence.test.ts 有断言：
 * 清单里的每个键都必须有真实写入方（防止再塞预留名进来）。
 */
const SENSITIVE_KEYS: readonly string[] = [
  'migration_flags',
  // deviceId 只有读、没有写（写入方 deviceUtils 走 KV）。但历史数据可能已经
  // 被加密过，encryptionUtils.ts:24 仍需要走解密才能读出来 —— 所以必须留在
  // 清单里让 **get** 尝试解密。get 侧本来就有明文回退（decrypt 失败原样返回），
  // 因此「本来没加密」也不会因此出错：这条是**只读兼容**，不是加密承诺。
  // 守卫只要求「键有真实调用方」，不区分读写。
  'deviceId',
];

async function deriveKeyPBKDF2(extensionId: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(extensionId + 'storage_key_v2'),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
}

async function deriveKeySHA256(extensionId: string): Promise<CryptoKey> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(extensionId + 'storage_key_v1'));
  return crypto.subtle.importKey('raw', hashBuffer, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function encryptValue(data: any): Promise<string> {
  const key = await getOrCreateLocalKey();
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return V3_PREFIX + base64Encode(concatArrays(iv, new Uint8Array(ciphertext)));
}

async function decryptValue<T>(encryptedStr: string): Promise<T> {
  // V3：持久化密钥（首选）
  if (encryptedStr.startsWith(V3_PREFIX)) {
    try {
      const key = await getOrCreateLocalKey();
      const bytes = base64Decode(encryptedStr.substring(V3_PREFIX.length));
      const iv = bytes.slice(0, IV_LENGTH);
      const ciphertext = bytes.slice(IV_LENGTH);
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
      return JSON.parse(new TextDecoder().decode(decrypted)) as T;
    } catch {
      try {
        return JSON.parse(encryptedStr) as T;
      } catch {
        throw new Error('解密数据失败，已损坏或格式错误');
      }
    }
  }

  // V2 / V1：旧派生密钥（向后兼容；扩展 ID 未变时可解）
  if (encryptedStr.startsWith(V2_PREFIX)) {
    const v2 = await tryDecryptV2<T>(encryptedStr);
    if (v2 !== null) return v2;
  }
  if (encryptedStr.startsWith(V1_PREFIX)) {
    const v1 = await tryDecryptV1<T>(encryptedStr);
    if (v1 !== null) return v1;
  }

  // 明文（更老的未加密历史数据）
  return JSON.parse(encryptedStr) as T;
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.some(k => key === k || key.startsWith(k + '_'));
}

export class SecureStorage {
  async set(key: string, value: any): Promise<void> {
    try {
      let dataToStore = value;
      if (isSensitiveKey(key)) {
        dataToStore = await encryptValue(value);
      }
      await chrome.storage.local.set({ [key]: dataToStore });
    } catch (error) {
      logError(`存储数据失败 (${key}):`, error);
      throw error;
    }
  }

  async get<T>(key: string, defaultValue?: T): Promise<T | undefined> {
    try {
      const result = await chrome.storage.local.get(key);
      const storedValue = result[key];
      if (storedValue === undefined) return defaultValue;

      if (isSensitiveKey(key) && typeof storedValue === 'string') {
        try {
          return await decryptValue<T>(storedValue);
        } catch {
          return storedValue as T;
        }
      }

      return storedValue as T;
    } catch (error) {
      logError(`获取数据失败 (${key}):`, error);
      return defaultValue;
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await chrome.storage.local.remove(key);
    } catch (error) {
      logError(`删除数据失败 (${key}):`, error);
      throw error;
    }
  }

  async setMultiple(items: Record<string, any>): Promise<void> {
    try {
      const processedItems: Record<string, any> = {};
      for (const [key, value] of Object.entries(items)) {
        processedItems[key] = isSensitiveKey(key) ? await encryptValue(value) : value;
      }
      await chrome.storage.local.set(processedItems);
    } catch (error) {
      logError('批量存储数据失败:', error);
      throw error;
    }
  }

  async getMultiple<T extends Record<string, any>>(keys: string[]): Promise<Partial<T>> {
    try {
      const result = await chrome.storage.local.get(keys);
      const processedResult: any = {};
      for (const key of keys) {
        const storedValue = result[key];
        if (storedValue !== undefined) {
          if (isSensitiveKey(key) && typeof storedValue === 'string') {
            try {
              processedResult[key] = await decryptValue(storedValue);
            } catch {
              processedResult[key] = storedValue;
            }
          } else {
            processedResult[key] = storedValue;
          }
        }
      }
      return processedResult;
    } catch (error) {
      logError('批量获取数据失败:', error);
      return {};
    }
  }

  async clear(): Promise<void> {
    await chrome.storage.local.clear();
  }
}

export const secureStorage = new SecureStorage();

// ── V3 持久化密钥（不依赖 chrome.runtime.id）────────────────────────

let cachedLocalKey: CryptoKey | null = null;
/** single-flight：并发首次调用共享同一个初始化 Promise */
let localKeyPromise: Promise<CryptoKey> | null = null;

/**
 * 加载或生成本地加密密钥（实际执行体，由 getOrCreateLocalKey 做 single-flight）。
 *
 * 失败语义：
 * - 读取 chrome.storage.local 抛错（环境错误）→ 向上抛，绝不静默生成新密钥
 *   （否则瞬时读失败会轮换密钥、砖化全部既有 V3 数据）。
 * - 持久化写入失败 → 向上抛。用未持久化的临时密钥加密等于产出
 *   下次启动必然不可解的密文——宁可本次保存失败。
 */
async function loadOrCreateLocalKey(): Promise<CryptoKey> {
  const result = await chrome.storage.local.get(LOCAL_KEY_STORAGE_KEY);
  const stored = result[LOCAL_KEY_STORAGE_KEY];
  if (typeof stored === 'string' && stored.length > 0) {
    const raw = base64Decode(stored);
    const key = await crypto.subtle.importKey(
      'raw',
      raw,
      { name: 'AES-GCM', length: KEY_LENGTH },
      false,
      ['encrypt', 'decrypt']
    );
    cachedLocalKey = key;
    return key;
  }

  // 键不存在（已确认读到存储且无此键）→ 生成新密钥并持久化
  const raw = crypto.getRandomValues(new Uint8Array(KEY_LENGTH / 8));
  const encoded = base64Encode(raw);
  await chrome.storage.local.set({ [LOCAL_KEY_STORAGE_KEY]: encoded });

  // 写后回读校验：popup 与 service worker 是两个独立 JS context，
  // 冷启动竞态下可能各自生成密钥互相覆盖（last-write-wins）。
  // 若存储中的值不是我们刚写的，说明另一个 context 先写了——
  // 以存储为准采用对方的密钥（本份还没加密过任何数据，直接丢弃）。
  const verify = await chrome.storage.local.get(LOCAL_KEY_STORAGE_KEY);
  const verified = verify[LOCAL_KEY_STORAGE_KEY];
  if (typeof verified !== 'string' || verified.length === 0) {
    throw new Error('[secureStorage] 密钥持久化校验失败：写入后无法读回');
  }
  if (verified !== encoded) {
    logWarn('[secureStorage] 检测到并发密钥生成冲突，采用存储中已有的密钥');
    cachedLocalKey = null;
    localKeyPromise = null;
    return loadOrCreateLocalKey();
  }

  const key = await crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'AES-GCM', length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
  cachedLocalKey = key;
  return key;
}

/**
 * 获取（或首次生成）本地加密密钥。
 *
 * V3 密钥与扩展 ID 解耦：首次使用时生成随机 256-bit 密钥，
 * 以 base64 存到 chrome.storage.local。之后所有加解密复用该密钥。
 * 这样即使 unpacked 扩展重新加载后 runtime.id 变化，数据仍可解密。
 *
 * 并发安全：single-flight —— 同一 context 内的并发调用共享同一个
 * 初始化 Promise；跨 context 竞态由写后回读校验兜底。
 */
function getOrCreateLocalKey(): Promise<CryptoKey> {
  if (cachedLocalKey) return Promise.resolve(cachedLocalKey);
  localKeyPromise ??= loadOrCreateLocalKey().catch(e => {
    // 失败后清空 in-flight，允许下次调用重试
    localKeyPromise = null;
    throw e;
  });
  return localKeyPromise;
}

/**
 * 测试辅助：清空进程内密钥缓存，模拟 popup / service worker 重新启动。
 * chrome.storage.local 中的持久化密钥保留 —— 用于验证「重启后仍可解密」。
 */
export function __resetKeyCacheForTesting(): void {
  cachedLocalKey = null;
  localKeyPromise = null;
}

/**
 * 尝试用 V2 时代的派生密钥解密（extensionId + salt）。
 * 仅用于 V2 blob 的向后兼容读取；若扩展 ID 已变化则返回 null。
 */
async function tryDecryptV2<T>(stored: string): Promise<T | null> {
  const extensionId = chrome.runtime.id;
  try {
    const bytes = base64Decode(stored.substring(V2_PREFIX.length));
    const salt = bytes.slice(0, SALT_LENGTH);
    const iv = bytes.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const ciphertext = bytes.slice(SALT_LENGTH + IV_LENGTH);
    const key = await deriveKeyPBKDF2(extensionId, salt);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return JSON.parse(new TextDecoder().decode(decrypted)) as T;
  } catch {
    return null;
  }
}

/**
 * 尝试用 V1 时代的派生密钥解密（extensionId + SHA-256）。
 * 仅用于 V1 blob 的向后兼容读取。
 */
async function tryDecryptV1<T>(stored: string): Promise<T | null> {
  const extensionId = chrome.runtime.id;
  try {
    const bytes = base64Decode(stored.substring(V1_PREFIX.length));
    const iv = bytes.slice(0, IV_LENGTH);
    const ciphertext = bytes.slice(IV_LENGTH);
    const key = await deriveKeySHA256(extensionId);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return JSON.parse(new TextDecoder().decode(decrypted)) as T;
  } catch {
    return null;
  }
}

/**
 * 加密本地大数据块（V3 格式，密钥与扩展 ID 解耦）
 */
export async function encryptLocalBlob(data: unknown): Promise<string> {
  const key = await getOrCreateLocalKey();
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return V3_PREFIX + base64Encode(concatArrays(iv, new Uint8Array(ciphertext)));
}

/**
 * 解密本地大数据块
 * 自动兼容 V3/V2/V1/明文四种格式；损坏数据返回 null
 */
export async function decryptLocalBlob<T>(stored: unknown): Promise<T | null> {
  if (typeof stored !== 'string' || stored.length === 0) {
    return null;
  }

  // V3：持久化密钥（首选）
  if (stored.startsWith(V3_PREFIX)) {
    try {
      const key = await getOrCreateLocalKey();
      const bytes = base64Decode(stored.substring(V3_PREFIX.length));
      const iv = bytes.slice(0, IV_LENGTH);
      const ciphertext = bytes.slice(IV_LENGTH);
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
      return JSON.parse(new TextDecoder().decode(decrypted)) as T;
    } catch (e) {
      logError('[decryptLocalBlob] V3 解密失败:', e);
      return null;
    }
  }

  // V2：旧派生密钥（向后兼容，扩展 ID 未变时可解）
  if (stored.startsWith(V2_PREFIX)) {
    return tryDecryptV2<T>(stored);
  }

  // V1：更旧派生密钥
  if (stored.startsWith(V1_PREFIX)) {
    return tryDecryptV1<T>(stored);
  }

  // 明文（向后兼容未加密的历史数据）
  try {
    return JSON.parse(stored) as T;
  } catch {
    return null;
  }
}
