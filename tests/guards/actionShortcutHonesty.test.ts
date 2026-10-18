// 快捷键语义诚实性守卫（2026-10-18）。
//
// 【要防的回归】`_execute_action` 是 Chrome 的 action 命令：按下时触发
// chrome.action.onClicked（本扩展 = 保存整窗并关闭，随后打开管理器），
// **不会**派发 commands.onCommand（Chrome 官方文档明文，实测
// chrome.commands.getAll() 也可确认）。所以任何把 Ctrl+Shift+S 描述成
// 「打开管理器」的文案都是错的，而且后果不可逆：用户以为要看列表，
// 结果整窗被存掉并关闭。曾经三处同时出错——manifest 描述、service-worker
// 里的死分支、商店/推广页文案——本文件把「三处不许再漂回去」钉住。
//
// 判据不硬编码文案：manifest 侧断言「描述不得声称打开管理器」，
// sw 侧断言「不得存在 _execute_action 分支」，文案侧断言
// 「Ctrl+Shift+S 不得与『打开管理器 / open the manager』出现在同一句」。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const MANAGER_WORDS = /管理器|tab manager/i;

describe('Ctrl+Shift+S（_execute_action）的语义声明必须与真实行为一致', () => {
  it('manifest: _execute_action 的描述不得声称打开管理器', () => {
    const manifest = JSON.parse(read('manifest.json')) as {
      commands: Record<string, { description?: string }>;
    };
    const cmd = manifest.commands['_execute_action'];
    assert.ok(cmd, 'manifest 必须声明 _execute_action（Ctrl+Shift+S 的载体）');
    assert.equal(
      MANAGER_WORDS.test(cmd.description ?? ''),
      false,
      `_execute_action 描述 "${cmd.description}" 声称打开管理器，但按下它走的是 action.onClicked（保存整窗并关闭）`
    );
  });

  it('service-worker: commands.onCommand 不得处理 _execute_action（Chrome 从不派发它）', () => {
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
