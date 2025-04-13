#!/bin/bash

# 确保所有更改已保存
echo "确保所有更改已保存..."

# 添加所有更改到暂存区
git add .

# 提交更改
git commit -m "chore: 更新到 v1.4.7，修复未完全加载的标签页保存问题"

# 创建标签
git tag -a v1.4.7 -m "OneTab Plus v1.4.7 发布"

# 推送提交
git push origin main

# 推送标签
git push origin v1.4.7

echo "v1.4.7 版本已成功提交和推送！"
