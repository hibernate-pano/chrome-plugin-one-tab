// 清理重复标签的结果文案：把服务端已算好的两个计数转成用户可见的反馈。
// 纯函数，直接 import（无用别名）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanDuplicatesResultMessage } from '../src/components/layout/cleanDuplicatesMessage.ts';

const HEADER = readFileSync(new URL('../src/components/layout/Header.tsx', import.meta.url), 'utf8');

describe('cleanDuplicatesResultMessage：清理结果文案', () => {
  it('无重复无空组 → 明确告诉用户无事可做（而非静默）', () => {
    const msg = cleanDuplicatesResultMessage(0, 0);
    assert.match(msg, /没有|无需/);
  });

  it('只清掉重复标签 → 报出标签数，不出现「空会话」', () => {
    const msg = cleanDuplicatesResultMessage(123, 0);
    assert.match(msg, /123 个重复标签页/);
    assert.ok(!msg.includes('空会话'), '没有空组时不该提空会话');
  });

  it('只清掉空会话 → 报出会话数，不出现「重复标签」', () => {
    const msg = cleanDuplicatesResultMessage(0, 7);
    assert.match(msg, /7 个空会话/);
    assert.ok(!msg.includes('重复标签页'), '没有重复标签时不该提重复标签');
  });

  it('两者都有 → 两个计数都在', () => {
    const msg = cleanDuplicatesResultMessage(40, 3);
    assert.match(msg, /40 个重复标签页/);
    assert.match(msg, /3 个空会话/);
  });

  it('负数 / 小数 / 脏输入按 0 处理，文案不出现负号', () => {
    assert.ok(!cleanDuplicatesResultMessage(-5, -1).includes('-'));
    assert.match(cleanDuplicatesResultMessage(2.9, 0), /2 个重复标签页/);
  });
});

// 结构防线：清理成功后必须给用户反馈（此前是「成功静默」，用户分不清
// 「没反应」和「没东西可清」）。任何把成功提示删掉、只留失败提示的改动都会红。
describe('Header：清理重复标签的成功反馈不得被静默', () => {
  it('成功分支把两个计数转成文案并用 toast 展示', () => {
    assert.match(
      HEADER,
      // v1.22.9 契约变更：计数改从 SW 回传的**权威计划**里取（result.plan.*），
      // 不再是 mutation 结果的顶层字段。原意不变——成功分支必须用真实计数生成文案。
      // 2026-10-06 再变一次：载荷包成 { value, broadcastWarn }（删除类统一形状，
      // 见 DeleteOpResult），计数改从 result.value.plan.* 取。
      /cleanDuplicatesResultMessage\(\s*result\.value\.plan\.removedTabsCount,\s*result\.value\.plan\.removedGroupsCount,?\s*\)/,
      '成功分支必须用清理结果计数生成文案',
    );
    assert.match(HEADER, /showToast\(\s*cleanDuplicatesResultMessage/, '文案必须经 showToast 展示给用户');
  });

  it('清理会物理移除整组：广播登记失败必须 surface（不得被成功提示盖掉）', () => {
    // 无墓碑模型下清理重复标签会整组移除空会话。若把 id 登记进云端删除广播队列
    // 失败，这些会话会在其它设备上复活——用户必须知道，而不只是看到「清理成功」。
    assert.match(
      HEADER,
      /deleteBroadcastWarn\(result\)/,
      '清理成功分支必须检查广播警告',
    );
    assert.match(
      HEADER,
      /if \(warn\)[\s\S]{0,200}showAlert\(/,
      '广播警告必须以警示弹窗呈现（toast 会被下一次提示顶掉）',
    );
  });

  it('清理期间按钮禁用并显示进行中（不当场卡住，但可感知）', () => {
    assert.match(HEADER, /disabled=\{isCleaningDuplicates\}/, '清理中应禁用按钮防重复触发');
    assert.match(HEADER, /aria-busy=\{isCleaningDuplicates\}/, '清理中应有 aria-busy 供读屏感知');
  });
});
