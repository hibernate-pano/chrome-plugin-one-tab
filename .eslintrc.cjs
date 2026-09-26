module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: {
      jsx: true,
    },
  },
  plugins: ['@typescript-eslint', 'react', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
    'prettier',
  ],
  env: {
    browser: true,
    es2021: true,
    node: true,
  },
  settings: {
    react: {
      version: 'detect',
    },
  },
  rules: {
    // P0 门禁：生产代码禁止直接 console.*，唯一收口 src/utils/log.ts。
    'no-console': 'error',
    // P0 门禁：syncUtils.legacy 禁止接回生产，仅 tests/** 可引用做回归对比。
    'no-restricted-imports': ['error', {
      patterns: [{
        group: ['**/syncUtils.legacy'],
        message: 'legacy 合并语义已冻结（P3 删除），生产代码禁止引用。合并真相源见 @/core/opStampMerge。',
      }],
    }],
    'react/react-in-jsx-scope': 'off',
    'react/prop-types': 'off',
    'react/display-name': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'off',
  },
  overrides: [
    {
      // 日志收口点自身允许 console；测试允许引用 legacy 做回归对比。
      files: ['src/utils/log.ts', 'src/utils/errorHandler.ts', 'tests/**/*.ts'],
      rules: { 'no-console': 'off', 'no-restricted-imports': 'off' },
    },
  ],
};
