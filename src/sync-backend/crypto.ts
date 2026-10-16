/**
 * 客户端加密（2026-10-13，WebDAV 自带存储改造 · 阶段 2）。
 *
 * ── 为什么密钥必须来自用户口令（这是 BYOK 后端的核心承诺）───────────────
 * WebDAV 的鉴权只证明「我能写进这个云盘」，不提供任何机密性：云盘运营方
 * （坚果云 / Nextcloud 管理员）和任何拿到账号的人都看得到文件。
 * 所以标签页数据必须在**离开浏览器之前**就完成加密，密钥只来自用户口令、
 * 只存在于内存里 —— 服务器与云盘拿不到口令，也就拿不到明文。
 * 这与任何「密钥由服务端派生」的做法都相反：那边密钥绑定了账号体系，
 * 这边必须完全自持 —— 用户不登录任何东西，口令是唯一的秘密。
 *
 * ── 参数选择（对齐 Floccus / xBrowserSync 的业界事实值）────────────────
 * PBKDF2-HMAC-SHA256 250_000 轮、AES-256-GCM、12 字节随机 IV。
 * 不用 Argon2id 不是取舍而是能力问题：WebCrypto 至今不提供它（见调研报告），
 * 手写 KDF 等于自研密码学，不可接受。250k 轮是对抗口令离线爆破与
 * MV3 service worker（含移动端）可用算力的折中。
 *
 * ── 一个必须记住的后果（见 `hashPlaintext` 的说明）─────────────────────
 * IV 每次加密都随机 ⇒ 同一明文两次加密得到**不同密文**。
 * 所以「内容变没变、要不要上传」的判定只能用 `hashPlaintext` 比明文哈希，
 * **永远不要**用密文比较 —— 那会把「每次 IV 不同」误判成「每次都要上传」。
 */
import { base64Decode, base64Encode, concatArrays } from '@/utils/base64';

/** 加密后的载荷（自描述格式，便于将来换算法） */
export interface EncryptedPayload {
  /** 格式版本号，当前为 1 */
  v: 1;
  /** PBKDF2 的 salt，base64（每次加密都重新随机生成） */
  salt: string;
  /** base64( iv(12B) || ciphertext ) */
  data: string;
}

/**
 * 当前格式版本。解密侧遇到未知版本必须硬失败（见 `Vault.decrypt`）：
 * 这个字段存在的意义就是让将来换算法（v2）时，旧代码能明确说「不认识」，
 * 而不是尽力而为地把新格式当旧格式解析出垃圾。
 */
const FORMAT_VERSION = 1 as const;

/** PBKDF2 轮数，对齐 Floccus / xBrowserSync。改动它 = 换格式（两端必须同时改），不是调优。 */
const PBKDF2_ITERATIONS = 250_000;
/** salt 16 字节（口令派生所需的最短随机量，NIST SP 800-132 建议值）。 */
const SALT_LENGTH = 16;
/** AES-GCM 的推荐 IV 长度是 12 字节：其他长度会被规范要求先做 GHASH 派生，慢且无收益。 */
const IV_LENGTH = 12;
const KEY_LENGTH = 256;

/** 口令错 / 密文坏 / base64 坏统一用这一句：对用户可读，且不泄露任何内容或失败细节。 */
const DECRYPT_FAILURE_MESSAGE = '口令错误或数据已损坏（无法解密）';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * 从用户口令派生 AES-GCM 密钥。
 *
 * salt 以 base64 传入，与 EncryptedPayload 里的存储形态一致（调用方不用自己转）。
 * 派生出的密钥不可导出（extractable=false）：它只在 WebCrypto 内部流转，
 * 不给「顺手打印出来调试」留入口。
 */
export async function deriveKey(passphrase: string, saltB64: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: base64Decode(saltB64), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * 一次派生、多次使用的密钥会话。
 *
 * ── 为什么必须有这一层（2026-10-13 性能修正，这是本模块最重要的一次设计）──
 * 初版 API 是 `encryptJson(value, passphrase)`：每次加密随机生成 salt、
 * 每次都跑一遍 250k 轮 PBKDF2。单文件场景没问题，但 TapStack 是**分片**存储
 * （每个会话一个文件），于是一次全量上传 = N 次 PBKDF2：
 *
 *   300 个会话 × 250k 轮 ≈ 数分钟的纯 CPU 时间
 *
 * 这直接撞上 MV3 service worker 的**单事件 5 分钟硬上限**（超时 SW 被直接杀掉，
 * `finally` 都不执行），而且这段时间全在单写者队列里 —— 用户此刻点删除、点开标签
 * 都得排在后面。「每组一次 PBKDF2-100k（约 9ms 纯 CPU）……300 组串行约 2.8s、
 * 并发 8 约 0.8s」这类实测记录，正是同一类问题的证据。
 *
 * ── 所以 salt 的作用域从「每个文件」改成「整个库」──────────────────────
 * salt 与 IV 是两件不同的事，初版把它们的生命周期混在了一起：
 *   · **salt**（给 PBKDF2 用）：作用是让「同一口令」在不同库上派生出不同密钥，
 *     防彩虹表与跨库预计算。**一个库一个 salt 就已经达成这个目的**。
 *   · **IV**（给 AES-GCM 用）：**必须每次加密都随机**，这是 GCM 的安全前提
 *     （IV 重用会灾难性地泄露明文异或值）。这一条**没有妥协**，见下面 encrypt。
 *
 * salt 从「每文件」放宽到「每库」的代价要说清：攻击者爆破时，
 * 每文件独立 salt 需要跑 N 次 PBKDF2 才能试完所有文件；每库一个 salt 只需 1 次。
 * 换句话说**攻击者成本从 N 次降到 1 次**。
 *
 * 为什么这个取舍仍然是对的：
 *   1. PBKDF2 轮数（250k）才是口令爆破的主要成本，salt 只负责「不能预计算」；
 *   2. 真正的防线是口令强度 —— 而这条限制对两种方案完全一样；
 *   3. 反过来说，每文件 salt 会让**我们自己的成本也是 N 次**，
 *      而我们的预算是「5 分钟内跑完一轮同步」——这个约束是硬的。
 * 一句话：**用一个我们付不起的方案去把攻击者成本乘以 N，不划算。**
 *
 * salt 存在 manifest.json 里（明文，它不是秘密）。
 */
export interface Vault {
  /** 本库的 PBKDF2 salt（base64）。需要持久化到 manifest，下次才能重新派生。 */
  readonly salt: string;
  encrypt(value: unknown): Promise<EncryptedPayload>;
  decrypt<T = unknown>(payload: EncryptedPayload): Promise<T>;
}

/** 新建一个库的密钥会话（随机 salt）。首次配置同步时调用一次。 */
export async function createVault(passphrase: string): Promise<Vault> {
  return openVault(passphrase, base64Encode(crypto.getRandomValues(new Uint8Array(SALT_LENGTH))));
}

/**
 * 用已有的 salt 打开库的密钥会话。
 *
 * **一次同步只调一次**：拿到 Vault 后，同一轮里所有分片的加解密都用它，
 * 不再重复派生。这是上面那段性能论证的落地方式。
 */
export async function openVault(passphrase: string, saltB64: string): Promise<Vault> {
  const key = await deriveKey(passphrase, saltB64);
  return {
    salt: saltB64,
    async encrypt(value: unknown) {
      const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
      const plaintext = textEncoder.encode(stableStringify(value));
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
      );
      // IV 与密文拼在同一个字段（data）里：IV 不是秘密，但它必须与本次密文
      // 一一对应，拆成两个字段只是多一处「可能漏存/存错」的地方。
      return {
        v: FORMAT_VERSION,
        salt: saltB64,
        data: base64Encode(concatArrays(iv, ciphertext)),
      };
    },
    async decrypt<T = unknown>(payload: EncryptedPayload) {
      if (payload.v !== FORMAT_VERSION) {
        throw new Error(
          `不支持的密文格式版本：${String(payload.v)}（当前版本只认识 v${FORMAT_VERSION}）`
        );
      }
      if (payload.salt !== saltB64) {
        // 分片自带的 salt 与本库 salt 不一致：说明这个文件来自另一个库
        // （用户换过口令库 / 手动拷了别人的文件）。用**它自带的** salt 解密
        // 会让「文件来自别处」这件事被无声吞掉，所以明确报错。
        throw new Error('这个文件不属于当前同步库（salt 不一致），已跳过');
      }
      try {
        const raw = base64Decode(payload.data);
        const plaintext = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: raw.slice(0, IV_LENGTH) },
          key,
          raw.slice(IV_LENGTH)
        );
        return JSON.parse(textDecoder.decode(plaintext)) as T;
      } catch {
        throw new Error(DECRYPT_FAILURE_MESSAGE);
      }
    },
  };
}

/**
 * 明文内容的稳定哈希（SHA-256, hex）—— 「内容变没变」的唯一判据。
 *
 * ── 为什么不能用密文代替（这条结论很容易被违反）────────────────────────
 * AES-GCM 的 **IV 每次加密都随机**（见 `Vault.encrypt`），因此同一份明文
 * 两次加密得到的密文**必然不同**。拿密文比较会把「IV 不同」误读成
 * 「内容变了」，于是「有变化」恒为真 —— 每次同步都做无意义的全量上传。
 * salt 作用域同理（每库一个，不是每文件，见上）。
 *
 * 必须稳定的理由：同步合并会重建对象，属性插入顺序取决于合并路径；
 * 直接 JSON.stringify 会让两个内容完全相同的对象得到不同哈希，
 * 于是「有变化」恒为真，哈希判定彻底失效。所以序列化前先递归排序 key
 * （数组顺序有语义，保留原样）。
 */
export async function hashPlaintext(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(stableStringify(value)));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/** 递归排序对象 key 后序列化；数组顺序原样保留。 */
function stableStringify(value: unknown): string {
  // 顶层是 undefined / 函数等非 JSON 值时 JSON.stringify 返回 undefined；
  // 同步载荷恒为对象，这里退回 'null' 保住「哈希总是返回字符串」的契约。
  return JSON.stringify(sortKeysDeep(value)) ?? 'null';
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = sortKeysDeep(source[key]);
    return sorted;
  }
  return value;
}
