#!/bin/bash

# 构建脚本

echo "开始构建插件..."

# 检查是否安装了Node.js
if ! command -v node &> /dev/null; then
    echo "错误: 未找到Node.js，请先安装Node.js"
    exit 1
fi

# 检查是否安装了pnpm
if ! command -v pnpm &> /dev/null; then
    echo "错误: 未找到pnpm，请先安装pnpm"
    exit 1
fi

# 安装依赖
echo "安装依赖..."
pnpm install

# 构建项目
echo "构建项目..."
pnpm run build

# 检查构建结果
if [ -d "dist" ]; then
    echo "构建成功！"
    echo "您可以通过以下步骤安装插件："
    echo "1. 打开Chrome浏览器，进入扩展程序页面 (chrome://extensions/)"
    echo "2. 开启"开发者模式""
    echo "3. 点击"加载已解压的扩展程序""
    echo "4. 选择本仓库中的dist目录"
else
    echo "构建失败，请检查错误信息"
    exit 1
fi
