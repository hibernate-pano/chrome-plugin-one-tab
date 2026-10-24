// 仓库里所有 shell 脚本的「变量引用后紧跟非 ASCII 字符」扫描。
//
// ── 为什么这是个真 bug（不是洁癖）────────────────────────────────────────
// bash 在 UTF-8 locale 下会把 `$VAR` 后面**紧邻**的非 ASCII 字符并进变量名：
//
//   $ EXPECT_VERSION=1.27.0 bash -c 'set -u; echo "值是 $EXPECT_VERSION）尾"'
//   bash: EXPECT_VERSION）: unbound variable      ← 退出码 127
//
// 症状（比一般的 typo 难查得多）：
// ① `set -u` 下脚本**静默死在那一行**，之前 print 过的输出全丢；
// ② 退出码是 1/127，**不是**脚本自己约定的那些码（4=产物对不上、3=商店没放行）
//    ⇒ 下游分不清「是哪一步失败」；
// ③ 错误信息里那个变量名带一个全角括号，第一眼完全看不出是哪写的。
//
// 本仓库 scripts/cws-wait-publish.sh 就踩过（2026-10-24，审计 REL-02 那一轮）。
//
// ── 规则 ──────────────────────────────────────────────────────────────────
// 变量引用一律写成 `${VAR}`。单引号里的 `$VAR` 是字面量，安全 ⇒ 不算。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.next']);

/** 递归收集 shell 脚本。 */
function collectShellScripts(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectShellScripts(join(dir, entry.name), out);
    } else if (/\.(sh|bash|zsh)$/.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/**
 * 找出「$VAR 后面紧跟非 ASCII 字符」的位置。
 *
 * 单引号内的内容是字面量（`echo '$VAR）'` 不会展开）⇒ 跳过。
 * 双引号内要展开 ⇒ 算命中。
 */
function findRiskyRefs(line: string): { index: number; text: string }[] {
  const hits: { index: number; text: string }[] = [];
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') {
      i++; // 跳过被转义的下一个字符
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle) continue;
    if (ch !== '$') continue;
    const m = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(line.slice(i));
    if (!m) continue;
    const after = line[i + m[0].length];
    if (after && after.codePointAt(0)! > 127) {
      hits.push({ index: i, text: m[0] + after });
    }
  }
  return hits;
}

describe('shell 脚本：变量引用后不许紧跟非 ASCII 字符', () => {
  it('全仓扫描，没有「$VAR）」「$VAR，」这类写法', () => {
    const scripts = collectShellScripts(ROOT);
    assert.ok(scripts.length > 0, '至少要扫到 shell 脚本（否则这条守卫是空转）');

    const problems: string[] = [];
    for (const file of scripts) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        for (const hit of findRiskyRefs(line)) {
          problems.push(
            `${relative(ROOT, file)}:${i + 1}  ${JSON.stringify(hit.text)}  →  写成 \${...} 形式`,
          );
        }
      });
    }
    assert.equal(
      problems.length,
      0,
      'bash 会把 $VAR 后面紧邻的全角字符并进变量名（set -u 下脚本会静默死在那一行、' +
        '退出码也不再是约定的那些码）：\n' + problems.join('\n'),
    );
  });
});
