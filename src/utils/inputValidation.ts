/**
 * 输入验证工具
 * 提供安全的输入验证和清理功能
 */

// 验证结果接口
export interface ValidationResult {
  isValid: boolean;
  error?: string;
  sanitized?: string;
}

// 密码强度等级（union type，避免 enum — --experimental-strip-types 不支持 enum）
export const PasswordStrength = {
  WEAK: 'weak',
  MEDIUM: 'medium',
  STRONG: 'strong',
} as const;
export type PasswordStrength = (typeof PasswordStrength)[keyof typeof PasswordStrength];

// 密码强度结果
export interface PasswordStrengthResult {
  strength: PasswordStrength;
  score: number;
  feedback: string[];
}

/**
 * 邮箱验证
 */
export function validateEmail(email: string): ValidationResult {
  if (!email || typeof email !== 'string') {
    return { isValid: false, error: '邮箱不能为空' };
  }

  // 清理输入
  const sanitized = email.trim().toLowerCase();

  // 长度检查
  if (sanitized.length > 254) {
    return { isValid: false, error: '邮箱地址过长' };
  }

  // 基本格式验证
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  
  if (!emailRegex.test(sanitized)) {
    return { isValid: false, error: '邮箱格式不正确' };
  }

  // 检查危险字符
  if (containsDangerousChars(sanitized)) {
    return { isValid: false, error: '邮箱包含非法字符' };
  }

  return { isValid: true, sanitized };
}

/**
 * 密码验证
 */
export function validatePassword(password: string): ValidationResult {
  if (!password || typeof password !== 'string') {
    return { isValid: false, error: '密码不能为空' };
  }

  // 长度检查
  if (password.length < 8) {
    return { isValid: false, error: '密码长度至少8位' };
  }

  if (password.length > 128) {
    return { isValid: false, error: '密码长度不能超过128位' };
  }

  // 复杂度检查
  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasNumber = /\d/.test(password);
  const hasSpecial = /[!@#$%^&*(),.?":{}|<>]/.test(password);

  const complexityCount = [hasLower, hasUpper, hasNumber, hasSpecial].filter(Boolean).length;

  if (complexityCount < 3) {
    return { 
      isValid: false, 
      error: '密码必须包含大写字母、小写字母、数字和特殊字符中的至少3种' 
    };
  }

  // 检查常见弱密码
  const commonPasswords = [
    'password', '123456', '123456789', 'qwerty', 'abc123',
    'password123', 'admin', 'letmein', 'welcome', 'monkey'
  ];

  if (commonPasswords.includes(password.toLowerCase())) {
    return { isValid: false, error: '密码过于简单，请使用更复杂的密码' };
  }

  return { isValid: true };
}

/**
 * 密码强度检查
 */
export function checkPasswordStrength(password: string): PasswordStrengthResult {
  let score = 0;
  const feedback: string[] = [];

  if (!password) {
    return {
      strength: 'weak',
      score: 0,
      feedback: ['请输入密码']
    };
  }

  // 长度评分
  if (password.length >= 8) score += 1;
  else feedback.push('密码长度至少8位');

  if (password.length >= 12) score += 1;
  else if (password.length >= 8) feedback.push('建议密码长度12位以上');

  // 字符类型评分
  if (/[a-z]/.test(password)) score += 1;
  else feedback.push('建议包含小写字母');

  if (/[A-Z]/.test(password)) score += 1;
  else feedback.push('建议包含大写字母');

  if (/\d/.test(password)) score += 1;
  else feedback.push('建议包含数字');

  if (/[!@#$%^&*(),.?":{}|<>]/.test(password)) score += 1;
  else feedback.push('建议包含特殊字符');

  // 复杂度评分
  if (!/(.)\1{2,}/.test(password)) score += 1;
  else feedback.push('避免连续重复字符');

  // 确定强度等级
  let strength: PasswordStrength;
  if (score >= 6) {
    strength = 'strong';
  } else if (score >= 4) {
    strength = 'medium';
  } else {
    strength = 'weak';
  }

  return { strength, score, feedback };
}

/**
 * 通用文本清理
 */
export function sanitizeText(text: string, maxLength: number = 1000): ValidationResult {
  if (!text || typeof text !== 'string') {
    return { isValid: false, error: '文本不能为空' };
  }

  // 移除首尾空格
  let sanitized = text.trim();

  // 长度检查
  if (sanitized.length > maxLength) {
    return { isValid: false, error: `文本长度不能超过${maxLength}字符` };
  }

  // 移除危险字符
  sanitized = sanitized.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  sanitized = sanitized.replace(/javascript:/gi, '');
  sanitized = sanitized.replace(/on\w+\s*=/gi, '');

  // 检查是否还有危险内容
  if (containsDangerousChars(sanitized)) {
    return { isValid: false, error: '文本包含非法字符' };
  }

  return { isValid: true, sanitized };
}

/**
 * 检查危险字符
 */
function containsDangerousChars(input: string): boolean {
  const dangerousPatterns = [
    /<script/i,
    /javascript:/i,
    /on\w+\s*=/i,
    /data:text\/html/i,
    /vbscript:/i,
    /file:/i,
    /\0/,  // null字符
  ];

  return dangerousPatterns.some(pattern => pattern.test(input));
}

/**
 * Tab URL 的三道判定，**刻意分成三件事**（2026-10-05 重构，见下）。
 *
 * ── 为什么拆开 ────────────────────────────────────────────────────────
 * 修复前只有 `sanitizeTabUrl` 一道门，同时回答了两个不同的问题：
 *   「这个 URL 能不能存进数据库」+「这个 URL 能不能被重新打开」。
 * 两者的答案不一样，于是产生了「存得下、回不来」的会话：
 *
 *   保存侧 domain/tabGroup/filters.isInternalUrl 只拒 chrome:// / edge:// /
 *     chrome-extension:// / about:，放行 file: / blob: / data: / devtools: …；
 *   还原侧 sanitizeTabUrl 只放行 http/https/ftp/about/loading，拒掉上面那一族。
 *
 * 两张表互不相同 ⇒ 产品保存了它自己永远还原不了的标签。对以本地 PDF、
 * blob 链接为主的用户（开发者/研究者）这是常态，不是历史个案。
 * 而还原率判据（MIN_RESTORABLE_TAB_RATIO）按**整组**生效，于是同组里
 * 完全正常的 https 标签也被一起隐藏。
 *
 * 现在拆成：
 *   isStorableTabUrl  —— 能不能**存**（只拒真正危险的 schema）
 *   isOpenableTabUrl   —— 能不能**打开**（在当前设备上导航）
 *   sanitizeTabUrl     —— 存储入口用「存 + 可打开」；渲染/点击用 isOpenable
 *
 * ── 三道门的关系 ──────────────────────────────────────────────────────
 * 危险 schema（javascript: / vbscript: / data:）**两道门都拒**——它们既不该
 * 进数据库，也不该出现在 href/src 里。
 * 不可导航但有保存价值的协议（file: / blob: / devtools: / view-source:）
 * **存储门放行、打开门拒收**。存下来的行在 UI 上标记为「此设备无法打开」，
 * 数据本身不再丢失，也不会被静默丢掉。
 *
 * ── 关于 favicon 表（utils/faviconUtils.ts），不要与本表合并 ──────────
 * 它回答的是「能不能当 <img src>」，放行 data:、拒绝 ftp:，答案天然相反。
 */

/** 危险 schema：能执行脚本或能伪造页面内容。两道门都拒。 */
const DANGEROUS_TAB_PROTOCOLS = new Set(['javascript:', 'vbscript:', 'data:']);

/** 可存储的协议：URL 解析器能认、且不含危险 schema。 */
const STORABLE_TAB_PROTOCOLS = new Set([
  'http:', 'https:', 'ftp:', 'about:', 'loading:',
  'file:', 'blob:', 'devtools:', 'view-source:', 'ws:', 'wss:',
]);

/** 可导航（能交给 chrome.tabs.create / <a href>）的协议。 */
const OPENABLE_TAB_PROTOCOLS = new Set(['http:', 'https:', 'ftp:', 'about:']);

function parseTabUrl(url: unknown): URL | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  // loading:// 是本项目自己的占位符（页面还没加载完），URL 解析器不认，单独短路。
  // 它可存储（历史数据里就有），但不是真协议——不能交给浏览器导航。
  if (trimmed.startsWith('loading://')) return null;
  try {
    return new URL(trimmed);
  } catch {
    return null;
  }
}

/**
 * 这个 URL 能不能**存进数据库**。
 *
 * 判据：URL 可解析、不含危险 schema。刻意**不**要求「当前设备能打开」——
 * 否则 file:/blob:/devtools: 这类地址会在保存前就被丢掉，用户会认为
 * 「保存这个窗口」没有保存完整（而实际上它当时确实打得开）。
 */
export function isStorableTabUrl(url: unknown): boolean {
  if (typeof url === 'string' && url.trim().startsWith('loading://')) return true;
  const u = parseTabUrl(url);
  if (!u) return false;
  if (DANGEROUS_TAB_PROTOCOLS.has(u.protocol)) return false;
  return STORABLE_TAB_PROTOCOLS.has(u.protocol);
}

/**
 * 这个 URL 能不能**在当前设备上重新打开 / 渲染为链接**。
 *
 * 判据：可存储 + 协议可导航。渲染层与点击层都必须过这一道。
 */
export function isOpenableTabUrl(url: unknown): boolean {
  if (typeof url === 'string' && url.trim().startsWith('loading://')) return false;
  const u = parseTabUrl(url);
  if (!u) return false;
  if (DANGEROUS_TAB_PROTOCOLS.has(u.protocol)) return false;
  return OPENABLE_TAB_PROTOCOLS.has(u.protocol);
}

/**
 * 存储入口用的净化：可存储即返回规范化 URL，否则 null。
 *
 * ⚠️ **语义已变**（2026-10-05）：修复前它等价于「可打开」，导致 file:/blob:
 * 这类地址存得进（保存侧放行）却还原不出（还原侧丢弃）。现在它只答「能不能存」。
 * 若你要的是「能不能点开」，请改用 {@link isOpenableTabUrl}。
 */
export function sanitizeTabUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('loading://')) return trimmed;
  if (!isStorableTabUrl(trimmed)) return null;
  return trimmed;
}

/**
 * 验证会话名称
 */
export function validateGroupName(name: string): ValidationResult {
  const result = sanitizeText(name, 100);
  
  if (!result.isValid) {
    return result;
  }

  if (result.sanitized!.length < 1) {
    return { isValid: false, error: '会话名称不能为空' };
  }

  return result;
}

/**
 * 批量验证
 */
export function validateForm(fields: Record<string, any>, validators: Record<string, (value: any) => ValidationResult>): {
  isValid: boolean;
  errors: Record<string, string>;
  sanitized: Record<string, any>;
} {
  const errors: Record<string, string> = {};
  const sanitized: Record<string, any> = {};
  let isValid = true;

  for (const [fieldName, value] of Object.entries(fields)) {
    const validator = validators[fieldName];
    if (validator) {
      const result = validator(value);
      if (!result.isValid) {
        errors[fieldName] = result.error!;
        isValid = false;
      } else {
        sanitized[fieldName] = result.sanitized || value;
      }
    } else {
      sanitized[fieldName] = value;
    }
  }

  return { isValid, errors, sanitized };
}
