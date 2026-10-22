// 快捷键语义诚实性守卫（2026-10-18 建立，2026-10-22 因 P0-1 重写）。
//
// ── 2026-10-22 之前的那一版 ────────────────────────────────────────────
//
// `_execute_action` 是 Chrome 的 action 命令：按下时触发
// chrome.action.onClicked，**不会**派发 commands.onCommand。
// 当时点图标 = 保存整窗并关闭，于是「Ctrl+Shift+S」的真实语义是
// 「保存整窗并关闭」—— 文案必须这么说，任何说成「打开管理器」的文案都是错的。
// 本文件就是钉那件事的。
//
// ── 为什么现在要重写 ────────────────────────────────────────────────────
//
// 审计 P0-1（`docs/audit-2026-10-22-product-director.md`）：
// **点扩展图标不再保存并关闭当前窗口**，只打开会话管理器。
// 破坏性动作改由「明确的意图」触发（页面按钮 / 右键菜单 / 快捷键）。
//
// 于是旧契约整体翻转：
//   · `_execute_action` 必须**删掉** —— 它会触发图标点击，而图标已经不存了；
//     留着它，Ctrl+Shift+S 就会变成「打开管理器」，而所有文案都写着
//     「Ctrl+Shift+S 保存整窗并关闭」⇒ 一句彻头彻尾的假话。
//   · Ctrl+Shift+S 必须绑到一个**真的保存命令**上（`save_*`），
//     键位和语义都不变 —— 用户的肌肉记忆不该为这次修复买单。
//
// 本文件现在钉的是这条**新**契约。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const manifest = () =>
  JSON.parse(read('manifest.json')) as {
    commands: Record<string, { description?: string; suggested_key?: { default?: string; mac?: string } }>;
  };

describe('Ctrl+Shift+S 的语义声明必须与真实行为一致（2026-10-22 P0-1 后）', () => {
  it('manifest 不得再声明 _execute_action', () => {
    assert.equal(
      manifest().commands['_execute_action'],
      undefined,
      '_execute_action 会触发图标点击 —— 而图标现在只打开管理器。' +
        '留着它，Ctrl+Shift+S 就会与所有文案里「保存整窗并关闭」那句话对不上'
    );
  });

  it('Ctrl+Shift+S 必须绑在一个真的保存命令上（不是 _execute_action）', () => {
    const commands = manifest().commands;
    const binding = Object.entries(commands).find(
      ([, cmd]) =>
        cmd.suggested_key?.default === 'Ctrl+Shift+S' ||
        cmd.suggested_key?.mac === 'Command+Shift+S'
    );
    assert.ok(binding, 'manifest 必须给 Ctrl+Shift+S 绑一个命令');
    const [id, cmd] = binding;
    assert.match(
      id,
      /^save_/,
      `Ctrl+Shift+S 绑到了「${id}」上 —— 它必须是保存命令：` +
        '文案里写着「Ctrl+Shift+S 保存整窗并关闭」，行为必须对得上'
    );
    assert.match(
      cmd.description ?? '',
      /save/i,
      `命令 ${id} 的描述必须说清它会保存`
    );
    assert.match(
      cmd.description ?? '',
      /close/i,
      `命令 ${id} 的描述必须说清它会关闭标签`
    );
  });

  it('service-worker: 该命令必须真的被处理', () => {
    const commands = manifest().commands;
    const binding = Object.entries(commands).find(
      ([, cmd]) =>
        cmd.suggested_key?.default === 'Ctrl+Shift+S' ||
        cmd.suggested_key?.mac === 'Command+Shift+S'
    );
    assert.ok(binding, 'manifest 必须给 Ctrl+Shift+S 绑一个命令');
    const src = read('src/service-worker.ts');
    assert.match(
      src,
      new RegExp(`case\\s+['"]${binding[0]}['"]`),
      `service-worker 必须处理 ${binding[0]} —— 否则按下快捷键什么都不会发生`
    );
  });

  it('service-worker: 不得处理 _execute_action（Chrome 从不派发它）', () => {
    const src = read('src/service-worker.ts');
    assert.equal(
      /case\s+['"]_execute_action['"]/.test(src),
      false,
      '存在 case \'_execute_action\' 分支——该分支永不执行，并把「快捷键打开管理器」的错说法留在代码里'
    );
  });

  it('商店文案与推广页: Ctrl+Shift+S 必须被描述成「保存并关闭」', () => {
    // 正向判据而非黑名单：真实行为是保存整窗 + 关闭这些标签，所以与
    // Ctrl+Shift+S 同一句的说明必须同时说出这两件事。曾经三处文案只写
    // 「打开管理器」，读者按下去就整窗被关——正向要求保存+关闭，正是
    // 那句话缺失的内容（写「保存整窗并关闭，随后打开管理器」照样通过）。
    for (const rel of [
      'CHROMEWEBSTORE.md',
      'promo-site/index.html',
      'outputs/tapstack-promo/index.html',
    ]) {
      for (const [i, line] of read(rel).split('\n').entries()) {
        // 两种写法都要认：`Ctrl+Shift+S` 纯文本，与 <kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>S</kbd> 拆分标记。
        if (!/Ctrl\+Shift\+S|<kbd>Ctrl<\/kbd>.*<kbd>Shift<\/kbd>.*<kbd>S<\/kbd>/.test(line)) continue;
        assert.match(
          line,
          /保存|save/i,
          `${rel}:${i + 1} 提到 Ctrl+Shift+S 却没说它会保存：${line.trim().slice(0, 120)}`
        );
        assert.match(
          line,
          /关闭|close/i,
          `${rel}:${i + 1} 提到 Ctrl+Shift+S 却没说它会关闭标签：${line.trim().slice(0, 120)}`
        );
      }
    }
  });
});

/**
 * 快捷键的**平台差异**必须说清楚（2026-10-20 复核补测）。
 *
 * ── 为什么要有这一条 ────────────────────────────────────────────────────
 * manifest.json 的 `commands` 允许给同一个命令配**不同的平台键位**：
 *   `_execute_action`: default = Ctrl+Shift+S，**mac = Command+Shift+S**
 *
 * 也就是说：「Ctrl+Shift+S」这句话在 **Windows / Linux 上是真的，
 * 在 macOS 上是错的**（那里是 ⌘⇧S）。
 *
 * 而文案原本只写「Ctrl+Shift+S」。对 macOS 用户来说这不是「不够详细」，
 * 是**一句假话** —— 按 ⌘⇧S 的人会在浏览器里什么都不会发生（那个键位
 * 在 macOS 上没有绑定），而想去按 Ctrl+Shift+S 的人会按出别的组合。
 * 用户视角的后果：快捷键「不灵」，且看不出原因。
 *
 * 商店文案是**用户唯一会读到的版本说明**，平台差异漏写 = 事实缺失。
 *
 * ── 判据 ────────────────────────────────────────────────────────────────
 * 盯**关系**而不是字面量：manifest 给某个命令配了 mac 键位，而文案提到了
 * 该命令的 default 键位时，文案**必须**也提到那个 mac 键位
 * （要么写 ⌘⇧S，要么写 Cmd+Shift+S —— 两种写法都认）。
 * 将来若把 mac 键位改成别的，守卫会跟着要求文案写新的那个。
 */
describe('快捷键的平台差异：mac 上是 ⌘⇧S，文案不能只写 Ctrl+Shift+S', () => {
  const manifest = JSON.parse(read('manifest.json')) as {
    commands: Record<string, { suggested_key?: { default?: string; mac?: string } }>;
  };

  /** manifest 里所有「mac 上与 default 不同」的命令 → 它的 mac 键位。 */
  const macSpecific = Object.entries(manifest.commands).filter(
    ([, cmd]) =>
      cmd.suggested_key?.mac && cmd.suggested_key.mac !== cmd.suggested_key.default
  );

  it('manifest 里确实存在平台差异（否则本文件是空断言，要改判据）', () => {
    assert.ok(
      macSpecific.length > 0,
      'manifest.commands 里没有任何「mac 键位 ≠ default 键位」的命令 —— ' +
        '若将来统一了平台键位，请把本文件改成「文案里不得再出现平台差异说明」的反向断言'
    );
  });

  it('提到 default 键位的文案，必须同时说明 mac 上按哪个键', () => {
    for (const [command, cmd] of macSpecific) {
      const def = cmd.suggested_key!.default!;
      const mac = cmd.suggested_key!.mac!;
      // mac 键位写成「Command+Shift+S」或「⌘⇧S」都认 —— 只要求「提过它」。
      const macForms = [
        mac,
        mac.replace('Command', 'Cmd'),
        mac.replace('Command', '⌘').replace('Shift', '⇧').replace('+', ''),
        '⌘⇧S',
        'Cmd+Shift+S',
        'Command+Shift+S',
      ];
      for (const rel of ['CHROMEWEBSTORE.md', 'README.md']) {
        for (const [i, line] of read(rel).split('\n').entries()) {
          if (!line.includes(def)) continue;
          // 该行提到了 default 键位 ⇒ 必须也提到 mac 键位（或明确说「mac 上不一样」）。
          const mentionsMac = macForms.some(f => line.includes(f));
          const hedges = /mac|Mac|MAC|苹果|不同平台|各平台/.test(line);
          assert.ok(
            mentionsMac || hedges,
            `${rel}:${i + 1} 提到了 ${def} 却没有说明 macOS 上按 ${mac} —— ` +
              `命令 ${command} 在 mac 上的键位与其它平台不同（manifest: ` +
              `default=${def}, mac=${mac}）。只写 default 键位 ⇒ mac 用户按了没反应，`
            );
        }
      }
    }
  });
});
