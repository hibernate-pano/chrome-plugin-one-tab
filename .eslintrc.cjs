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
      // 日志收口点自身允许 console；测试目录不参与日志收口。
      files: ['src/utils/log.ts', 'src/utils/errorHandler.ts', 'tests/**/*.ts'],
      rules: { 'no-console': 'off' },
    },
    {
      // 测试目录的参数未使用很常见，但分两种，处理方式不同：
      // (a) 依赖桩为了和被依赖接口同签名而写出的参数（tests/journal.test.ts 的
      //     `kvGet: async <T>(k: string) => null`）——按仓库既有惯例改名加下划线
      //     前缀即可豁免，规则本身保持有效；
      // (b) catch 绑定的错误对象——测试里 catch 后不检查是常态（Node 强制要求
      //     绑定名），豁免。
      // 用 argsIgnorePattern 而不是把 args 整体关掉：args:'none' 会连带放过那些
      // **本该被抓住**的非下划线前缀未用参数。规则变严后如出现真实违规，在具体
      // 位置显式加下划线前缀处理，不要把规则再放宽。
      // 顶层常量/导入未使用仍然报错（比如忘了删的旧常量）——本项配置不影响那条。
      files: ['tests/**/*.ts'],
      rules: {
        '@typescript-eslint/no-unused-vars': ['error', {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        }],
      },
    },
  ],
};
