#!/bin/bash

# 确保所有更改已保存
echo "确保所有更改已保存..."

# 添加所有更改到暂存区
git add .

# 提交更改
git commit -m "chore: 更新到 v1.1.0"

# 创建标签
git tag -a v1.1.0 -m "OneTab Plus v1.1.0 发布"

# 推送提交
git push origin main

# 推送标签
git push origin v1.1.0

echo "v1.1.0 版本已成功提交和推送！"
