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
 * URL验证
 */
export function validateUrl(url: string): ValidationResult {
  if (!url || typeof url !== 'string') {
    return { isValid: false, error: 'URL不能为空' };
  }

  const sanitized = url.trim();

  try {
    const urlObj = new URL(sanitized);
    
    // 只允许HTTP和HTTPS协议
    if (!['http:', 'https:'].includes(urlObj.protocol)) {
      return { isValid: false, error: '只支持HTTP和HTTPS协议' };
    }

    // 检查危险字符
    if (containsDangerousChars(sanitized)) {
      return { isValid: false, error: 'URL包含非法字符' };
    }

    return { isValid: true, sanitized };
  } catch {
    return { isValid: false, error: 'URL格式不正确' };
  }
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
 * - 接受 http/https/ftp/about/loading（loading 是未加载占位）
 * - 拒绝 javascript:/data:/vbscript:/file:/blob: 等危险协议
 * - 接受其他未知协议（保持现状，最严格仅 http/https 会误杀历史 about:blank 等）
 *
 * 返回合法 URL 字符串或 null（null 表示调用方应丢弃该 tab）。
 */
const ALLOWED_TAB_PROTOCOLS = new Set(['http:', 'https:', 'ftp:', 'about:']);

export function sanitizeTabUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  // loading:// 占位符保留
  if (trimmed.startsWith('loading://')) return trimmed;
  try {
    const u = new URL(trimmed);
    if (u.protocol === 'javascript:' || u.protocol === 'data:' ||
        u.protocol === 'vbscript:' || u.protocol === 'file:' ||
        u.protocol === 'blob:') {
      return null;
    }
    // 已知协议直接接受；其他 unknown 也接受（保守）
    if (ALLOWED_TAB_PROTOCOLS.has(u.protocol) || u.protocol === 'loading:') return trimmed;
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * 防止XSS的HTML编码
 */
export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
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
