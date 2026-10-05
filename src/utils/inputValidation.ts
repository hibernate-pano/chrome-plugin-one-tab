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
 * Tab URL 协议白名单/黑名单。导入、解析、下载的 tab URL 都必须经过此处。
 * - ponytail v1.17.0 hotfix：上一版三分支全 return trimmed 是死代码（白名单不起作用）
 * - 现在严格按白名单生效：只有 http/https/ftp/about/loading 接受
 * - 显式黑名单（防漏检）：javascript:/data:/vbscript:/file:/blob:
 * - 返回合法 URL 字符串或 null（null 表示调用方应丢弃该 tab）
 *
 * ── 为什么这张表和 favicon 的表不一样（别合并）─────────────────────────
 * 本表回答的是「这个地址能不能被**重新打开**」，不是「能不能被渲染」。
 * - 放行 ftp:/about:/loading:：它们是合法的可导航地址，用户真的会开。
 * - 放行 http:：明文 http 不代表可被劫持（页面内已由浏览器同源策略隔离），
 *   但内网 http 站点是真实场景，收紧会把用户的内网页面全部丢掉。
 * - 拒绝 file:/blob:：恢复会话 = 让扩展替用户去读本地文件 / 造同源 blob，
 *   这是能力放大，不是 XSS。
 * - 拒绝 chrome:/edge:/chrome-extension:（不在白名单里）：浏览器自己的页面
 *   没有可复现的内容。这道门与 domain/tabGroup/filters.isInternalUrl 是**两道
 *   正交的串联门**：本表按协议拒，isInternalUrl 按前缀拒。about: 是唯一同时被
 *   两边提到、但答案相反的协议——本表放行（合法可导航），isInternalUrl 判内部
 *   （不保存）。见该文件头注释。
 * favicon 表（utils/faviconUtils.ts）答的是「能不能当 <img src>」，放行 data:、
 * 拒绝 ftp:，答案天然相反。
 */
const ALLOWED_TAB_PROTOCOLS = new Set(['http:', 'https:', 'ftp:', 'about:', 'loading:']);
const DANGEROUS_TAB_PROTOCOLS = new Set([
  'javascript:', 'data:', 'vbscript:', 'file:', 'blob:',
]);

export function sanitizeTabUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  // loading:// 占位符保留（URL 解析器不认，单独短路）
  if (trimmed.startsWith('loading://')) return trimmed;
  try {
    const u = new URL(trimmed);
    if (DANGEROUS_TAB_PROTOCOLS.has(u.protocol)) return null;
    if (!ALLOWED_TAB_PROTOCOLS.has(u.protocol)) return null;
    return trimmed;
  } catch {
    return null;
  }
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
