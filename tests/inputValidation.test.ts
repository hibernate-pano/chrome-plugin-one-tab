import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateEmail, validatePassword, checkPasswordStrength, PasswordStrength, validateGroupName, sanitizeText, escapeHtml, validateForm } from '../src/utils/inputValidation.ts';

describe('validateEmail', () => {
  it('accepts valid email addresses', () => {
    assert.equal(validateEmail('test@example.com').isValid, true);
    assert.equal(validateEmail('user.name+tag@domain.co.uk').isValid, true);
    assert.equal(validateEmail('user@sub.domain.com').isValid, true);
  });

  it('rejects invalid email addresses', () => {
    assert.equal(validateEmail('').isValid, false);
    assert.equal(validateEmail('not-an-email').isValid, false);
    assert.equal(validateEmail('@domain.com').isValid, false);
  });

  it('rejects emails with dangerous characters', () => {
    assert.equal(validateEmail('<script>@test.com').isValid, false);
  });

  it('lowercases the email', () => {
    const result = validateEmail('TEST@EXAMPLE.COM');
    assert.equal(result.sanitized, 'test@example.com');
  });
});

describe('validatePassword', () => {
  it('accepts passwords with 3 of 4 character types', () => {
    assert.equal(validatePassword('MyPass123').isValid, true);
    assert.equal(validatePassword('MyPass!@#').isValid, true);
  });

  it('rejects passwords shorter than 8 characters', () => {
    assert.equal(validatePassword('Ab1!').isValid, false);
  });

  it('rejects common passwords', () => {
    assert.equal(validatePassword('12345678').isValid, false);
  });
});

describe('checkPasswordStrength', () => {
  it('rates empty password as weak', () => {
    assert.equal(checkPasswordStrength('').strength, PasswordStrength.WEAK);
  });

  it('rates "password123" as weak or medium', () => {
    const result = checkPasswordStrength('password123');
    assert.ok(result.score <= 5);
  });

  it('rates "C0mpl3x!P@ssw0rd#2024" as strong', () => {
    assert.equal(checkPasswordStrength('C0mpl3x!P@ssw0rd#2024').strength, PasswordStrength.STRONG);
  });
});

describe('validateGroupName', () => {
  it('accepts valid group names', () => {
    assert.equal(validateGroupName('My Session').isValid, true);
    assert.equal(validateGroupName('Work Research 2024').isValid, true);
  });

  it('rejects empty names', () => {
    assert.equal(validateGroupName('').isValid, false);
  });

  it('rejects names with script tags', () => {
    assert.equal(validateGroupName('<script>alert(1)</script>').isValid, false);
  });
});

describe('sanitizeText', () => {
  it('removes script tags', () => {
    const result = sanitizeText('Hello <script>alert(1)</script> World');
    assert.ok(!result.sanitized!.includes('<script'));
  });

  it('trims whitespace', () => {
    const result = sanitizeText('  hello  ');
    assert.equal(result.sanitized, 'hello');
  });
});

describe('escapeHtml (browser-only, skipped in Node)', () => {
  it('is defined', () => {
    assert.equal(typeof escapeHtml, 'function');
  });
});

describe('validateForm', () => {
  it('validates multiple fields', () => {
    const result = validateForm(
      { email: 'test@example.com', name: 'Test' },
      {
        email: validateEmail,
        name: (v: string) => validateGroupName(v),
      }
    );
    assert.equal(result.isValid, true);
  });

  it('returns errors for invalid fields', () => {
    const result = validateForm(
      { email: 'invalid', name: '' },
      {
        email: validateEmail,
        name: (v: string) => validateGroupName(v),
      }
    );
    assert.equal(result.isValid, false);
    assert.ok(result.errors.email);
    assert.ok(result.errors.name);
  });
});
