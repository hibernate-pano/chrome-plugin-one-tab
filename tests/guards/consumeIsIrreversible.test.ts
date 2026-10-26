// 「恢复即消费」现在是**不可恢复**的 —— 2026-10-26 产品定案，撤销机制整套下线。
//
// ── 这个文件守什么 ──────────────────────────────────────────────────────
//
// 2026-10-26 产品负责人定案：「撤销提示删除掉，因为恢复时已有现有标签，无需再撤销。」
// 理由很实在：恢复时那些标签**已经开在浏览器里**了 ⇒ 结果界面自明 ⇒ 那条带
// 「撤销」按钮的提示是**纯噪音**。⇒ 顺手把整条「恢复即消费可撤销」的承诺拿掉了。
//
// ⇒ 拿掉承诺不是拿掉事实：「恢复 / 点开」仍然会把那条记录**从列表移除**，
//   而本产品**没有回收站**。⇒ 后果必须**说在点开之前**（按钮的悬停提示）——
//   那是用户唯一的告知；说晚了就是骗人。
//
// 守五件事：
//   ① **撤销机制整套下线**：提示、hook、语义命令、存储撤回口都不许复活；
//   ② **后果短句**必须说「不可恢复」，且**不得**说「可撤销」（那已是假话）；
//   ③ **对外文案**（README / 隐私政策）不许再承诺撤销，必须说不可恢复 + 锁定是退路；
//   ④ **失败仍然出声**（静默的是成功，不是失败）—— 见 restoreFeedbackHonesty；
//   ⑤ **判据有判别力**：同一组模式必须能抓住「旧文案的承诺」，
//      否则 ③ 就是一句空话。
//
// ── 为什么要单独一个文件 ──────────────────────────────────────────────────
//
// 上面五件事横跨**判据层**（文案函数）、**接线层**（组件源码）、**对外文案层**
// （三个文档）。分散在别的守卫里，任何一处漏改都不会变红 —— 而这次的改动
// 恰恰是「文档、判据、接线」三处一起改的（改语义规则要连带改四处）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { restoreOutcomeSentence } from '../../src/components/tabs/restoreFeedbackCopy.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

/** 去注释后的源码：注释里提到一个符号不等于生产在用它。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** 递归列出 src/ 下的所有 .ts/.tsx 文件。 */
const srcFiles = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name)) out.push(rel);
    }
  };
  walk('src');
  return out;
};

// ─────────────────────────────────────────────────────────────────────────
// ① 撤销机制整套下线
// ─────────────────────────────────────────────────────────────────────────

describe('① 撤销机制整套下线（不许复活）', () => {
  it('三个撤销专用文件不许存在', () => {
    for (const rel of [
      'src/core/consumeUndo.ts',
      'src/components/tabs/useConsumeUndo.ts',
      'src/components/tabs/consumeUndoCopy.ts',
    ]) {
      assert.ok(
        !existsSync(resolve(ROOT, rel)),
        `${rel} 又回来了 —— 撤销机制已经下线（2026-10-26），留着它就是留着一条` +
          '产品已经不做的承诺（用户会去找那个按钮）'
      );
    }
  });

  it('src/ 里不许再出现任何撤销机制的标识符', () => {
    // ⚠️ 判的是**标识符**，不是「撤销」两个字：中文文案里说「不可恢复」时
    //   出现「撤销」是正常的（否认句）。
    const forbidden = [
      'showConsumeToast',
      'useConsumeUndo',
      'applyRestoreConsumed',
      'restoreConsumed',
      'consumedTabId',
      'consumedIndex',
      'consumeUndoDurationMs',
      'retractPendingDeleteIds',
    ];
    for (const rel of srcFiles()) {
      const src = stripComments(read(rel));
      for (const token of forbidden) {
        assert.ok(
          !src.includes(token),
          `${rel} 里又出现了 ${token} —— 撤销机制已下线（2026-10-26）`
        );
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ② 后果短句：必须说「不可恢复」，不许说「可撤销」
// ─────────────────────────────────────────────────────────────────────────

describe('② 后果短句必须与真实行为一致', () => {
  it('未锁定：说「不可恢复」', () => {
    const sentence = restoreOutcomeSentence(false);
    assert.match(
      sentence,
      /不可恢复/,
      `未锁定的后果必须说「不可恢复」（实得：${sentence}）`
    );
  });

  it('未锁定：不许说「可撤销」（撤销已下线 ⇒ 那是假话）', () => {
    const sentence = restoreOutcomeSentence(false);
    assert.doesNotMatch(
      sentence,
      /可撤销|可以撤销|撤销按钮|能撤/,
      `后果短句还在承诺撤销（实得：${sentence}）—— 用户会去找那个按钮，而它已经没了`
    );
  });

  it('已锁定：仍然说「仍保留在列表中」（锁定是唯一的退路，这句不能改）', () => {
    assert.equal(
      restoreOutcomeSentence(true),
      '恢复后该会话仍保留在列表中',
      '锁定的后果是「保留」—— 产品的唯一退路就是它，措辞必须留着'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ③ 对外文案：README / 隐私政策不许再承诺撤销
// ─────────────────────────────────────────────────────────────────────────

/**
 * 「承诺撤销」的说法集合。
 *
 * 【为什么不直接认「撤销」两个字】否认句是**必须保留**的：
 * 「没有撤销入口」「也没有『撤销』按钮」告诉用户的正是**真相**。
 * ⇒ 这里只认**承诺**的说法（留了退路 / 可撤销 / 撤销按钮）。
 */
const UNDO_PROMISE = [
  /留了退路/,
  /(?<![没无不][^。\n]{0,6})有退路/,
  /(?<![没无不][^。\n]{0,6})有「?撤销」?按钮/,
  /(?<!不)可(?:以)?撤销/,
];

describe('③ 对外文案不许再承诺撤销', () => {
  const OUTWARD = ['README.md', 'src/legal/privacy.html'];

  it('README 与隐私政策里不许出现「承诺撤销」的说法', () => {
    for (const rel of OUTWARD) {
      const src = read(rel);
      for (const p of UNDO_PROMISE) {
        assert.ok(
          !p.test(src),
          `${rel} 里出现了「承诺撤销」的说法（${p.source}）—— ` +
            '撤销机制已下线（2026-10-26），继续承诺就是在骗人'
        );
      }
    }
  });

  it('README 与隐私政策必须说清「不可恢复」', () => {
    for (const rel of OUTWARD) {
      const src = read(rel);
      assert.match(
        src,
        /不可恢复/,
        `${rel} 必须说「移除不可恢复」—— 不说 ⇒ 用户以为那条记录只是看不见了`
      );
    }
  });

  it('README 与隐私政策必须指出「先锁定」是唯一的退路', () => {
    for (const rel of OUTWARD) {
      const src = read(rel);
      assert.match(
        src,
        /锁定/,
        `${rel} 必须提到「锁定」—— 撤销没了以后，用户唯一的退路就是事先锁定`
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ⑤ 这组模式必须有判别力（否则 ③ 是空话）
// ─────────────────────────────────────────────────────────────────────────

describe('⑤ 判据自证：同一组模式必须能抓住旧文案的承诺', () => {
  it('「留了退路」「可撤销」必须被抓住', () => {
    for (const sample of ['这两种移除都留了退路', '这条移除可以撤销']) {
      assert.ok(
        UNDO_PROMISE.some(p => p.test(sample)),
        `模式集没抓住「${sample}」—— 守卫对旧文案零检测力 ⇒ ③ 形同虚设`
      );
    }
  });

  it('否认句（「没有撤销入口」）必须被放过', () => {
    for (const sample of [
      '这类移除没有撤销入口，也没有回收站',
      'TapStack 不提供回收站，也没有撤销入口',
    ]) {
      assert.ok(
        !UNDO_PROMISE.some(p => p.test(sample)),
        `模式集把否认句「${sample}」当成了承诺 —— 守卫太宽，没人敢照它写文案`
      );
    }
  });
});
