/**
 * 加密口令的强度政策（2026-10-24 审计 SEC-1）。
 *
 * ── 为什么这道门槛必须存在 ────────────────────────────────────────────────
 *
 * 攻击一个 WebDAV 加密库的人需要的材料**全在云盘运营方手里**：
 *   · salt —— 明文写在 manifest.json 里（`layout.ts` 的 `Manifest.salt`）；
 *   · 密文分片 —— 就在他自己的目录里（拿到目录副本 = 拿到全部密文）。
 * 于是「口令强度」是这条防线上**唯一**由用户决定的变量：
 * PBKDF2-HMAC-SHA256 250k 轮把单次试错的成本抬到约 23ms（≈ 42 次/秒/核），
 * 但 4 位小写（456,976 种组合）单核两三个小时就穷举完了 ——
 * **轮数救不了弱口令**。
 *
 * 修复前这里**没有任何门槛**：`validateWebDavForm` 只查「非空」，
 * 于是 `a` 也是合法口令，一座库的会话名/标签标题/网址全部裸奔。
 *
 * ── 为什么是**长度**政策，不是「字符类别」政策 ──────────────────────────
 *
 * 「大写 + 小写 + 数字 + 特殊字符至少三类」是**为服务端账号**设计的：
 * 那套模型里服务端能在线限速、能查已泄露口令库，于是复杂度规则有意义。
 * 这里是 BYOK：密钥只由口令派生，**没有服务端、没有泄露库可查**，
 * 复杂度规则只会把用户推向 `P@ssw0rd1` 这种「看起来复杂、其实更弱」的口令。
 * ⇒ 政策只按**长度**与**形态**判：够长、不是常见口令、不是重复、不是序列。
 *
 * ── 为什么政策在这里，而**门槛**在适配器里 ──────────────────────────────
 *
 * 见 `webdav/adapter.ts` 的 `unlock()`：门槛只在**真的新建一个加密库**时
 * 才生效；已经加密过的库走 `openVault`，**永远不被拦**。
 *
 * 这个分工不是「先软后硬」，而是**唯一安全的那一种**：
 * 口令**不落盘**（只在浏览器会话内存里），所以老用户每次重开页面都要
 * **重新输入**当年那个口令。若把门槛放在「表单校验」上，一个当年用了
 * `123456` 的老用户会被自己的口令挡在门外 —— 在新设备上配同一个库、
 * 或清过配置再配回来，都会变成「再也连不上自己的云盘」。
 * 把「安全加固」做成「数据取不回来」是最坏的结果。
 *
 * ⇒ 判据：**这个口令是在「选一个」还是在「回忆一个」？**
 *   · 选（库里还没有加密）⇒ 必须够强 ⇒ 拦；
 *   · 回忆（库里已经加密）⇒ 多弱都得放行 ⇒ 不拦。
 * 适配器正好知道答案（有没有加密库），表单不知道。
 */

/** 加密口令的最少长度（按码点计，trim 后）。 */
export const PASSPHRASE_MIN_LENGTH = 12;

/** 达到这个长度即评为「很强」。 */
export const PASSPHRASE_STRONG_LENGTH = 16;

/** 强度档位。`weak` ⇔ 不可接受。 */
export type PassphraseLevel = 'weak' | 'fair' | 'strong';

/** 判定结果。 */
export interface PassphraseVerdict {
  /** 能不能当作**新**加密库的口令。 */
  acceptable: boolean;
  /** 强度档位（给 UI 的指示条用）。 */
  level: PassphraseLevel;
  /** 不可接受时的**具体原因**（可直接展示给用户）；可接受时为空串。 */
  reason: string;
  /** 参与判定的字符数（trim 后按码点计）。 */
  length: number;
}

/** 档位 → 面板上的标签。 */
export const PASSPHRASE_LEVEL_LABEL: Record<PassphraseLevel, string> = {
  weak: '太弱',
  fair: '够用',
  strong: '很强',
};

/**
 * 常见的口令**词根**（比较前会去掉结尾的非字母数字）。
 *
 * 只收「加个数字就变强」的错觉里最常见的那批 ——
 * `password123` / `admin2024` 这类**看起来**比原词长，
 * 实际强度与原词几乎一样（字典攻击的候选表里本来就有它们）。
 */
const COMMON_BASES: ReadonlySet<string> = new Set([
  'password', 'passwd', 'passphrase', 'pass', 'qwerty', 'qwertyui', 'admin',
  'administrator', 'letmein', 'welcome', 'monkey', 'dragon', 'iloveyou',
  'abc', 'abcd', 'abcde', 'secret', 'master', 'sunshine', 'princess',
  'football', 'baseball', 'superman', 'trustno1', 'hello', 'whatever',
  'azerty', 'zaq12wsx', 'qazwsx', 'login', 'starwars', 'ashley', 'michael',
]);

/**
 * 键盘上的连续一排（及其倒序）。
 *
 * 这类串长度达标（12 位以上）却几乎不含熵 —— 键盘走位是字典攻击的
 * 第一梯队候选，`qwertyuiopas` / `1qaz2wsx3edc` 都在里面。
 */
const KEYBOARD_RUNS: readonly string[] = [
  'qwertyuiopasdfghjklzxcvbnm',
  'qwertyuiop',
  'asdfghjkl',
  'zxcvbnm',
  'poiuytrewq',
  'lkjhgfdsa',
  'mnbvcxz',
  '1qaz2wsx3edc4rfv5tgb',
  '1qaz2wsx3edc',
  'qazwsxedc',
  'qazwsx',
  '1q2w3e4r5t',
  '0987654321',
  '!@#$%^&*()',
];

/** 去掉结尾的非字母，再去掉结尾的数字 —— 得到「词根」。 */
function stemOf(lower: string): string {
  return lower.replace(/[^a-z]+$/, '').replace(/\d+$/, '');
}

/** 是否是「同一个字符重复」或「同一段字符重复」。 */
function isRepeated(chars: readonly string[]): boolean {
  const n = chars.length;
  for (let period = 1; period * 3 <= n; period++) {
    if (n % period !== 0) continue;
    let all = true;
    for (let i = 0; i < n; i++) {
      if (chars[i] !== chars[i % period]) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return false;
}

/** 是否是「等差连续」（abcdefghijkl / 123456789012 / zyxwvutsrqpo）。 */
function isEvenStepSequence(chars: readonly string[]): boolean {
  if (chars.length < 3) return false;
  const codes = chars.map(c => c.codePointAt(0) ?? 0);
  const step = codes[1] - codes[0];
  if (step === 0) return false; // 纯重复 —— 交给 isRepeated 说
  for (let i = 2; i < codes.length; i++) {
    if (codes[i] - codes[i - 1] !== step) return false;
  }
  return true;
}

/** 是否含键盘走位（正序或倒序）。 */
function hasKeyboardRun(lower: string): boolean {
  return KEYBOARD_RUNS.some(run => lower.includes(run) || lower.includes([...run].reverse().join('')));
}

/**
 * 判定一个加密口令的强度。
 *
 * 判定口径（**只看长度与形态，不看字符类别**）：
 *   1. 非空；
 *   2. 长度 ≥ {@link PASSPHRASE_MIN_LENGTH}；
 *   3. 不是常见口令（含「常见词 + 数字」的变形）；
 *   4. 不是重复（同一字符 / 同一段字符的重复）；
 *   5. 不是等差连续（abcdefghijkl、123456789012…）；
 *   6. 不是键盘走位。
 *
 * @param raw 用户输入的原始口令（会 trim 后判定；首尾空格不计入长度）。
 * @returns 判定结果。`acceptable === false` 时 `reason` 说明具体原因。
 */
export function evaluatePassphrase(raw: string): PassphraseVerdict {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const chars = [...text];
  const length = chars.length;

  if (length === 0) {
    return { acceptable: false, level: 'weak', reason: '请填写加密口令', length: 0 };
  }
  if (length < PASSPHRASE_MIN_LENGTH) {
    return {
      acceptable: false,
      level: 'weak',
      reason: `加密口令至少 ${PASSPHRASE_MIN_LENGTH} 位（当前 ${length} 位）`,
      length,
    };
  }

  const lower = text.toLowerCase();
  const stem = stemOf(lower);
  if (stem.length >= 3 && COMMON_BASES.has(stem)) {
    return {
      acceptable: false,
      level: 'weak',
      reason: '这个加密口令太常见，攻击者会优先试它',
      length,
    };
  }
  if (isRepeated(chars)) {
    return {
      acceptable: false,
      level: 'weak',
      reason: '加密口令不能是同一个字符或同一段字符的重复',
      length,
    };
  }
  if (isEvenStepSequence(chars)) {
    return {
      acceptable: false,
      level: 'weak',
      reason: '加密口令不能是连续字符（如 abcdefghijkl、123456789012）',
      length,
    };
  }
  if (hasKeyboardRun(lower)) {
    return {
      acceptable: false,
      level: 'weak',
      reason: '加密口令不能是键盘上的连续一排（如 qwertyuiopas）',
      length,
    };
  }

  return {
    acceptable: true,
    level: length >= PASSPHRASE_STRONG_LENGTH ? 'strong' : 'fair',
    reason: '',
    length,
  };
}
