#!/bin/bash
# 等商店放行 ⇒ 自动上传并提交审核。
#
# ── 为什么这个脚本必须进仓库 ──────────────────────────────────────────────
# 之前它只活在 /tmp（上一个会话的临时脚本）⇒ 进程被杀、文件随 /tmp 清空消失，
# 而 docs/RELEASE-NOTES.md 与 CHROMEWEBSTORE.md 却写着「已挂守候进程」——
# **文档在描述一个不存在的进程**。本仓库吃过太多这种亏：
# 「本地对了 ≠ 线上对了」「文档在教不存在的规则」。
# ⇒ 脚本进仓库，文档只描述**能不能跑起来**，不再声称「已经挂着」。
#
# ⚠️ 本脚本**不会自动启动**。要守候请显式跑：
#     ZIP=chrome-extension.zip \
#     EXPECT_SHA=<打包时记下的 sha256> \
#     EXPECT_VERSION=1.27.0 \
#     bash scripts/cws-wait-publish.sh
#
# ── 成功判据（不许只信「脚本 exit 0」）──────────────────────────────────
# scripts/cws-publish.mjs 的退出码**已经是**判据（2026-10-24 改成三态明确）：
#   upload : uploadState==SUCCESS ⇒ exit 0；FAILURE/NOT_FOUND/无法自证 ⇒ exit 1
#   publish: status 里有 OK ⇒ exit 0；否则 exit 1
#   status : 查得到 ⇒ exit 0；查不到 ⇒ exit 1
# 本脚本**自己再验一遍**：publish 成功后再查一次草稿，
# crxVersion 必须等于 EXPECT_VERSION —— 三条都满足才算「已提交审核」。
#
# ⚠️ 判据必须用**退出码**，不要 grep 输出文本：
#   脚本打印的是**未格式化的原始回包**（`"uploadState":"SUCCESS"`，冒号后没空格），
#   grep `"uploadState": "SUCCESS"` **永远匹配不上** ⇒ 会永远重试。
#   （这正是上一版 /tmp 脚本的 bug：它靠 grep 判成功。）
set -u

cd "$(dirname "$0")/.." || exit 1

ZIP=${ZIP:-chrome-extension.zip}
EXPECT_SHA=${EXPECT_SHA:-}
EXPECT_VERSION=${EXPECT_VERSION:-}
ATTEMPTS=${ATTEMPTS:-60}
SLEEP=${SLEEP:-600}
CWS_ITEM_ID=${CWS_ITEM_ID:-bbbpnccbclnnphchghpfmcjjfhigepbk}
export CWS_ITEM_ID

# ── 凭证 ──────────────────────────────────────────────────────────────────
# 三种来源，优先级从高到低：
#   ① 已经在环境里（CWS_CLIENT_ID / CWS_CLIENT_SECRET / CWS_REFRESH_TOKEN）
#   ② MCP 配置文件（默认 ~/.config/mcp/mcp.json，可用 MCP_JSON 改）
# 凭证**绝不写进本文件或仓库**，也绝不打日志。
if [ -z "${CWS_CLIENT_ID:-}" ] || [ -z "${CWS_CLIENT_SECRET:-}" ] || [ -z "${CWS_REFRESH_TOKEN:-}" ]; then
  MCP_JSON=${MCP_JSON:-$HOME/.config/mcp/mcp.json}
  if [ ! -f "$MCP_JSON" ]; then
    echo "===== 找不到凭证来源 $MCP_JSON —— 请设置 CWS_CLIENT_ID / CWS_CLIENT_SECRET / CWS_REFRESH_TOKEN ====="
    exit 2
  fi
  creds="$(mktemp)"
  # 逐行 key=value，导出到环境里（**不进 argv** ⇒ 不会出现在 ps 输出里）。
  MCP_JSON="$MCP_JSON" node -e '
    const fs = require("fs");
    const j = JSON.parse(fs.readFileSync(process.env.MCP_JSON, "utf8"));
    const env = (j.mcpServers && j.mcpServers["cws-mcp"] && j.mcpServers["cws-mcp"].env) || {};
    for (const k of ["CWS_CLIENT_ID", "CWS_CLIENT_SECRET", "CWS_REFRESH_TOKEN"]) {
      if (env[k]) process.stdout.write(k + "=" + env[k] + "\n");
    }
  ' > "$creds"
  while IFS='=' read -r k v; do
    if [ -n "$k" ]; then export "$k=$v"; fi
  done < "$creds"
  rm -f "$creds"
fi

for k in CWS_CLIENT_ID CWS_CLIENT_SECRET CWS_REFRESH_TOKEN; do
  if [ -z "$(eval "echo \${$k:-}")" ]; then
    echo "===== 缺少凭证：$k ====="
    exit 2
  fi
done

# Google API 在本机需要走代理（curl 原生认 HTTPS_PROXY；Node fetch 不认）。
export HTTPS_PROXY=${HTTPS_PROXY:-http://127.0.0.1:7897}
export HTTP_PROXY=${HTTP_PROXY:-$HTTPS_PROXY}

# ── 产物新鲜度自检 ────────────────────────────────────────────────────────
# 仓库教训（见 MEMORY）：manifest 版本号对得上 **≠** 产物新鲜。
# ⇒ sha256 必须**显式给出**并逐字比对；给不出就拒绝（fail-closed），
#   绝不允许「比对失败就当过」。
if [ -z "$EXPECT_SHA" ]; then
  echo "===== 必须显式给出 EXPECT_SHA（打包时记下的 sha256）—— 产物新鲜度不能靠猜 ====="
  exit 4
fi
if [ -z "$EXPECT_VERSION" ]; then
  echo "===== 必须显式给出 EXPECT_VERSION（要发的那一版）—— 版本不能靠猜 ====="
  exit 4
fi
if [ ! -f "$ZIP" ]; then
  echo "===== 找不到产物 $ZIP ====="
  exit 4
fi
if command -v shasum >/dev/null 2>&1; then
  ACTUAL_SHA="$(shasum -a 256 "$ZIP" | awk '{print $1}')"
else
  ACTUAL_SHA="$(sha256sum "$ZIP" | awk '{print $1}')"
fi
# ⚠️ 这一道闸门不是多余的：上面那句 `if [ "$ACTUAL_SHA" != "$EXPECT_SHA" ]`
#   在**两边都是空字符串**时会「相等」⇒ 直接放行 ⇒ **完全没有新鲜度校验**就上传。
#   而 ACTUAL_SHA 为空是现实场景（sha 工具缺失 / 读文件失败）。
#   ⇒ 「算不出 sha256」必须单独判为失败（fail-closed），不能让空值互相比对蒙混过关。
if [ -z "$ACTUAL_SHA" ]; then
  echo "===== 算不出产物的 sha256（工具缺失或读失败）—— 无法做新鲜度自检，拒绝上传 ====="
  exit 4
fi
if [ "$ACTUAL_SHA" != "$EXPECT_SHA" ]; then
  echo "===== 产物对不上打包时的 sha256（${ACTUAL_SHA} ≠ ${EXPECT_SHA}）—— 拒绝上传 ====="
  exit 4
fi
echo "===== 产物 sha256 自检通过：$ACTUAL_SHA ====="

# ── 主循环 ────────────────────────────────────────────────────────────────
uploaded=0
i=0
while [ "$i" -lt "$ATTEMPTS" ]; do
  i=$((i + 1))
  echo "===== [$i/$ATTEMPTS · $(date '+%H:%M:%S')] ====="

  if [ "$uploaded" -eq 0 ]; then
    # 判据 = 退出码（见文件头）。uploadState==SUCCESS 才 exit 0。
    if node scripts/cws-publish.mjs upload "$ZIP"; then
      echo "----- 上传成功（草稿已换成 ${EXPECT_VERSION}）-----"
      uploaded=1
    else
      echo "----- 商店还没放行（上一版仍在审核队列），$SLEEP 秒后再试 -----"
      sleep "$SLEEP"
      continue
    fi
  fi

  # 期望版本给了 ⇒ 脚本会核对草稿 crxVersion，避免「草稿里还是上一版」。
  if node scripts/cws-publish.mjs publish "$EXPECT_VERSION"; then
    echo "----- publish 拿到 status:[\"OK\"] -----"
  else
    echo "----- publish 未生效（草稿还在，继续试）-----"
    sleep "$SLEEP"
    continue
  fi

  # 复核第三条：草稿版本必须就是我们要发的那一版。
  sout="$(node scripts/cws-publish.mjs status 2>&1)"
  echo "$sout" | grep -E 'crxVersion|uploadState' || true
  if echo "$sout" | grep -q "crxVersion=$EXPECT_VERSION"; then
    echo "===== ${EXPECT_VERSION} 已提交审核（草稿 crxVersion=${EXPECT_VERSION}）====="
    echo "===== 公开页何时显示 $EXPECT_VERSION 取决于审核通过，只能靠抓公开页确认 ====="
    exit 0
  fi
  echo "----- 草稿版本不是 ${EXPECT_VERSION}，再等等 -----"
  sleep "$SLEEP"
done

echo "===== 窗口内商店一直没放行（ATTEMPTS=$ATTEMPTS 用完）====="
node scripts/cws-publish.mjs status 2>&1 | grep -E 'crxVersion|uploadState' || true
exit 3
