# 产品定位与减法决策审查（只读）

- 时间：2026-10-09 12:00 (Asia/Shanghai)
- 范围：`/Users/panbo/Code/Demos/chrome-plugin-one-tab`，HEAD = cdcad40，版本 1.22.15
- 性质：只读审查，未修改任何产品代码或文档

## 对话出发点

Jasper 要求以「产品定位与减法决策专家」视角审查 TapStack，回答四个问题：
定位词与承诺是否被代码兑现、功能该不该存在、复杂度值不值、文档与代码是否脱节。
硬规矩：grep 零命中必须二次复核、竞品结论标注未核实、禁止把推测写成已确认缺陷。

## 执行过程

1. 读 `.codex/agents/_shared.md`（陷阱 1-5、诚实度纪律、发布纪律）
2. 读定位载体：README / CHROMEWEBSTORE.md / manifest.json / src/legal/privacy.html / .env.example / .env
3. 复核「30 天自动清理」是否真有调度器：python 全仓扫描 `purgeExpiredCloudTombstones` → 追到 `syncEngine.ts:630` 挂在 upload 内 → 隐私政策措辞已如实说明「随同步上传执行」→ 判定**已兑现**，非历史事故重演
4. 复核「网页版仪表盘」是否真删除：python 扫描 dashboard/仪表盘 → 确认 `src/web/`、`vite.web.config.ts` 已删 → **但 curl 实测 https://tapstack-two.vercel.app 仍在线且仍在读写 tab_groups**（这是本次最大发现）
5. 实测线上商店页：`https://chromewebstore.google.com/detail/tapstack/bbbpnccbclnnphchghpfmcjjfhigepbk` → Version 1.22.12，Updated October 6, 2026 → 1.22.13/14/15 三个版本**一个用户都还没拿到**
6. 死代码扫描：自写 import 图（处理 `@/` 别名 + 目录 index 两种解析）→ 6 个文件零引用；再对每个候选做 python 全仓二次扫描复核
7. 复杂度分桶统计（按目录/文件集合计行）
8. 跑 `tests/docsAlignment.test.ts`（22 pass）与 `tests/p0DataSafetyGuards.test.ts`（11 pass）确认文档守卫本身是绿的

## 遇到的问题

- 第一版 import 图脚本**漏了 `@/` 别名**，导致 76 个文件被误报为「零引用」。发现后重写并用 python 全仓扫描二次复核，撤回该批误报。
- 首次 grep `拖拽排序` 在 src/ 下零命中，但 `src/components/dnd/` 仍有 486 行在用 —— 若只看 grep 关键词会得出「拖拽已完全删除」的错误结论。实际是**组间排序已删、组内标签拖拽仍在**，两者不同。
- curl 商店页需要代理（`socks5://` 不被 curl 直接支持，须 `-x http://127.0.0.1:7897`）。

## 最终结果

产出只读审查报告，主要结论：

- **P0 级**：线上网页版仪表盘仍在运行且直写云端 `tab_groups`，而隐私政策第 2 节把它列为「本政策的另一个入口」；用户数据现在有第二个写入方，且该版本代码已删、无人维护。
- **P0 级**：线上商店版本 = 1.22.12，仓库 = 1.22.15。1.22.13 的「点开标签只标记不删除」、1.22.14 的分批/分页、1.22.15 的排序唯一键全部未送达。
- **P1 级**：`docs/rebuild-plan.md` 顶部仍写「影子双写上线，灰度 100%」，而 yjs/dexie 已从 package.json 与 src 零残留 —— 说谎的规划文档。
- **P1 级**：`.env`（未跟踪）仍是 `VITE_APP_NAME=OneTab Plus` / `VITE_APP_VERSION=1.9.3`。
- 减法空间：4 个零引用文件 + 2 个已删功能的僵尸事件名 + 1 个僵尸 type 取值，约 300 行。
- 未发现「承诺了但没实现」的新实例：30 天清理、删除即物理清除、无 E2E 加密的表述均与代码一致。
