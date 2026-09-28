# TapStack 图标重设计 · 2026-09-28

> **决策：Jasper 已拍板选 A「收拢的现场」并落地（2026-09-28）。B 方案仅作存档保留。**

## 为什么重做

旧图标（浏览器 + 云上传箭头 + 手绘描边 + 米黄底）有三个根本问题：

1. **讲错了故事**。云箭头讲的是"同步"——实现手段，不是用户价值。TapStack 的价值是 *Save the session / Find it later / Restore it*：把工作现场收起来，随时找回。图标应该讲这个。
2. **16px 失明**。工具栏是每天高频触点，细描边手绘风在 16px 下糊成噪点。
3. **品牌脱节**。米黄底 + 褐线与产品 UI 的品牌蓝 `#2563eb` 是两个世界。

## 设计哲学（四条）

1. **讲结果，不讲机制**——不画云、不画箭头、不画同步。画"散落的页面被收拢成一叠"。
2. **名字即图形**——TapStack 的 Stack（堆叠）就是最直接的视觉锚点；Tap（一按）是收拢的动作。
3. **16px 第一性**——每个方向都先过 16px 关，细节分级：16px 只保骨架，折角/内容条只出现在 48/128。
4. **与产品一体**——底色即品牌蓝渐变（#3B82F6 → #1D4ED8，锚定 #2563EB），用户从工具栏到 popup 看到同一个品牌。

## 三个方向的构想

| 方向 | 隐喻 | 结论 |
|------|------|------|
| **A 收拢的现场** `a-stack-*` | 散落的标签页收成一叠会话；折角 = "刚放进去的那一页"；内容条 = 页面内容的抽象 | ✅ **已落地**。产品叙事最完整，16px 可辨 |
| **B 阶梯 T 印记** `b-tmark-*` | TapStack 的 T，横杠本身就是三张错位收拢的卡片 | ✅ 备选保留。字母印记独特性最强，16px 最稳，但叙事间接 |
| C 保险箱抽屉 `c-vault-*` | 工作现场存进抽屉，拉开即恢复 | ❌ 淘汰。概念成立但视觉松散、重心偏下 |

## 最终方案 A 的几何（viewBox 128）

- 底板：`rx 28`，品牌蓝纵向微渐变
- 三层卡片 `60×42 rx9`：沿"左上→右下"错位，透明度 `.30 / .55 / 1.0`
- 前卡右上折角：翻折面浅蓝 `#93C5FD`（128/48 专属，16px 去除）
- 前卡内容条：品牌蓝两条 `op .85 / .45`（16px 缩为一条加粗）
- 响应式细节：16px 用独立 SVG（`a-stack-16.svg`：两层卡 + 一条内容条），不是简单缩放

## 落地清单（已执行）

| 文件 | 来源 |
|------|------|
| `icons/icon16.png` | `a-stack-16.png`（Chrome headless 栅格化） |
| `icons/icon48.png` | 128 版缩放 |
| `icons/icon128.png` | `a-stack-128.png` |
| `public/icon16.png` `icon48.png` `favicon.ico` | 同源（favicon 含 16/32/48 三帧） |
| `src/web/public/favicon.ico` | 同上 |
| `src/components/common/TapStackIcon.tsx` | 同构型单色版（currentColor 三层卡，主题自适应） |

Chrome 商店素材（`CHROMEWEBSTORE.md` 引用 `icons/icon128.png`）自动生效，无需改动。

## 重新生成

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
cd store-assets/logo-redesign
"$CHROME" --headless --disable-gpu --screenshot=a-stack-128.png --window-size=128,128 --default-background-color=00000000 "file://$PWD/a-stack-128.svg"
"$CHROME" --headless --disable-gpu --screenshot=a-stack-16.png --window-size=16,16 --default-background-color=00000000 "file://$PWD/a-stack-16.svg"
```

> 不要用 ImageMagick 直接栅格化 SVG——其内置渲染器不支持 `linearGradient`（渐变会渲染成黑底）。

## 若要切换 B 方案

`b-tmark-128/16.svg` → 按上文命令重新渲染 → 覆盖 `icons/` 三件套即可。
