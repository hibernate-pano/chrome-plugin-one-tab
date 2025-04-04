# 技术上下文

## 开发环境

1. 基础环境
   - Node.js >= 16.0.0
   - npm >= 7.0.0
   - Git >= 2.0.0
   - Chrome >= 88.0.0

2. 开发工具
   - Visual Studio Code
   - Chrome DevTools
   - React Developer Tools
   - Redux DevTools

## 技术栈详情

1. 核心技术
   ```json
   {
     "dependencies": {
       "react": "^18.2.0",
       "react-dom": "^18.2.0",
       "redux": "^4.2.0",
       "react-redux": "^8.0.5",
       "@reduxjs/toolkit": "^1.9.0",
       "typescript": "^4.9.0",
       "tailwindcss": "^3.3.0"
     }
   }
   ```

2. 开发依赖
   ```json
   {
     "devDependencies": {
       "@types/chrome": "^0.0.200",
       "@types/react": "^18.0.0",
       "@types/react-dom": "^18.0.0",
       "webpack": "^5.75.0",
       "webpack-cli": "^5.0.0",
       "webpack-dev-server": "^4.11.0",
       "ts-loader": "^9.4.0",
       "postcss": "^8.4.0",
       "autoprefixer": "^10.4.0"
     }
   }
   ```

## 项目结构

```
src/
├── assets/          # 静态资源
├── components/      # React组件
├── pages/          # 页面组件
├── store/          # Redux状态管理
├── utils/          # 工具函数
├── types/          # TypeScript类型定义
├── styles/         # 样式文件
└── manifest.json   # Chrome扩展配置
```

## Chrome扩展API使用

1. 标签页管理
   - chrome.tabs
   - chrome.windows
   - chrome.commands

2. 存储管理
   - chrome.storage.local
   - chrome.storage.sync

3. 消息通信
   - chrome.runtime.sendMessage
   - chrome.runtime.onMessage

4. 权限管理
   - tabs
   - storage
   - unlimitedStorage

## 构建配置

1. webpack配置
```javascript
module.exports = {
  entry: {
    popup: './src/popup/index.tsx',
    background: './src/background/index.ts',
    content: './src/content/index.ts'
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js'
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/
      }
    ]
  }
};
```

2. TypeScript配置
```json
{
  "compilerOptions": {
    "target": "es6",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "module": "esnext",
    "moduleResolution": "node",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx"
  }
}
```

## 开发规范

1. 代码风格
   - ESLint配置
   - Prettier配置
   - TypeScript严格模式

2. 提交规范
   - Conventional Commits
   - Husky Git Hooks
   - Lint-staged

3. 测试策略
   - Jest单元测试
   - React Testing Library
   - Chrome扩展手动测试

## 部署流程

1. 开发环境
   - npm run dev
   - 加载未打包扩展

2. 生产环境
   - npm run build
   - 打包压缩
   - Chrome商店发布 