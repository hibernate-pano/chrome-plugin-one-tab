/**
 * DS-43-11：拖走会话里**最后一条**标签 = 搬空这个会话 = 整张会话卡消失 —— 必须出声。
 *
 * ── 缺陷本体（2026-10-23 审计 DS-43-11）──────────────────────────────────
 * 「拖走最后一条标签会整组删掉这个会话」是**产品钦定**的交互
 * （`tests/dragLastTabRefused.test.ts` 钉住「直接生效，不多问」；
 * 2026-10-19 明确回退过 round 29 那道拦截）。交互本身**不动**。
 *
 * 但搬完之后屏幕上发生的事是：那张卡**静默消失**，全程零文案 ⇒
 * 用户看到的现象是「我拖了一下，一张卡不见了」，而产品什么都没说。
 *
 * ── 本文件钉住的三条 ──────────────────────────────────────────────────────
 * ① 文案层（纯函数 `moveEmptiesSessionMessage`）：
 *    必须点名**哪个会话没了**、它的最后一条标签**去哪了**、
 *    以及这个会话**从列表里消失了**（只说「移走了」会让人以为卡还在）。
 * ② 接线层（.tsx 源码断言）：
 *    `handleMoveTab` 必须在**源组被搬空时**说这句话，且**只在**这时说
 *    （普通换位不该冒噪音 —— 每一次拖拽都弹一句 = 没人看）。
 * ③ 数据层接线：`moveTabAndSync` 必须把**源会话的名字**带回来 ——
 *    说这句话的是**目标会话**那个组件，它手里没有源会话的名字。
 *
 * ── 为什么用源码断言 ─────────────────────────────────────────────────────
 * 本仓没有 DOM 测试环境（无 jsdom / @testing-library），node 单测加载不了 JSX。
 * 沿用本仓既有惯例（见 lockedDelete.test.ts、guards/removeTabEntryDisclosure.test.ts）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moveEmptiesSessionMessage } from '../../src/components/tabs/moveFeedbackCopy.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');
/** 剥掉注释：源码断言必须判「代码结构」而不是「注释里提到的话」。 */
const code = (rel: string) =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

const TAB_GROUP = 'src/components/tabs/TabGroup.tsx';
const TAB_SLICE = 'src/store/slices/tabSlice.ts';

// ══════════════════════════════════════════════════════════════════════════
// 1. 文案层：说清「哪个没了 / 标签去哪了 / 会话从列表消失」
// ══════════════════════════════════════════════════════════════════════════

describe('DS-43-11：搬空一个会话时的提示必须说清三件事', () => {
  it('点名被搬空的那个会话', () => {
    const message = moveEmptiesSessionMessage({
      sourceName: '工作资料',
      targetName: '临时',
    });
    assert.match(message, /工作资料/, '必须点名是哪个会话没了');
  });

  it('说清最后一条标签去哪了', () => {
    const message = moveEmptiesSessionMessage({
      sourceName: '工作资料',
      targetName: '临时',
    });
    assert.match(message, /临时/, '必须说清标签落到了哪里');
  });

  it('说清这个会话从列表里消失了', () => {
    const message = moveEmptiesSessionMessage({
      sourceName: '工作资料',
      targetName: '临时',
    });
    assert.match(
      message,
      /从列表/,
      '用户真正的疑问是「那张卡去哪了」—— 只说标签移走了会让人以为卡还在'
    );
  });

  it('拿不到源会话的名字时，句子仍然完整（不许出现「undefined」）', () => {
    const message = moveEmptiesSessionMessage({ sourceName: null, targetName: null });
    assert.doesNotMatch(message, /undefined|null/, '不能把空值印给用户看');
    assert.match(message, /从列表/, '核心那半句不能因为缺名字就丢');
  });

  it('只有源名、没有目标名时，句子仍然完整', () => {
    const message = moveEmptiesSessionMessage({ sourceName: '工作资料', targetName: null });
    assert.match(message, /工作资料/);
    assert.match(message, /从列表/);
    assert.doesNotMatch(message, /undefined|null/);
  });

  it('只有目标名、没有源名时，句子仍然完整', () => {
    const message = moveEmptiesSessionMessage({ sourceName: null, targetName: '临时' });
    assert.match(message, /临时/);
    assert.match(message, /从列表/);
    assert.doesNotMatch(message, /undefined|null/);
  });

  it('界面文案里不出现英文机器串（全中文界面）', () => {
    for (const sourceName of ['会话', null]) {
      for (const targetName of ['另一个会话', null]) {
        const message = moveEmptiesSessionMessage({ sourceName, targetName });
        assert.doesNotMatch(message, /[A-Za-z]{4,}/, `文案里出现了英文串：${message}`);
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 2. 接线层：源组被搬空时才说这句话
// ══════════════════════════════════════════════════════════════════════════

describe('DS-43-11：handleMoveTab 必须在「源组被搬空」时出声', () => {
  const src = code(TAB_GROUP);

  /** 取出 handleMoveTab 的函数体。 */
  const handlerBody = (): string => {
    const at = src.indexOf('const handleMoveTab = useCallback(');
    assert.ok(at !== -1, '找不到 handleMoveTab —— 守卫前提变了');
    return src.slice(at, src.indexOf('\n  };', at));
  };

  it('处理函数里确实有「源组被搬空」这个判据', () => {
    assert.match(
      handlerBody(),
      /removedGroupId/,
      '搬空与否的真值是 moveTab 的回执里的 removedGroupId —— 必须读它'
    );
  });

  it('搬空时把那句话交给 toast（不是只 logError）', () => {
    assert.match(
      handlerBody(),
      /moveEmptiesSessionMessage\(/,
      '必须用共享文案层产出这句话'
    );
    assert.match(
      handlerBody(),
      /show[A-Za-z]*Toast|show[A-Za-z]*SuccessMessage|showRestoreSuccessMessage/,
      '必须真的弹给用户看 —— 只写日志等于没说'
    );
  });

  it('这句话只出现在「搬空」这一支里（普通换位不许冒噪音）', () => {
    const body = handlerBody();
    const copyAt = body.indexOf('moveEmptiesSessionMessage(');
    assert.ok(copyAt !== -1);
    // 找出**包住这句调用的那个 if 条件**，判它的判据是不是「源组被搬空」。
    // （不钉写法：`if (moved?.removedGroupId)` / `if (x && y)` 都认，
    //   但判据里必须有 removedGroupId —— 否则每次换位都弹一句。）
    const before = body.slice(0, copyAt);
    const ifAt = before.lastIndexOf('if (');
    assert.ok(ifAt !== -1, '文案调用必须在条件分支内 —— 无条件调用 = 每次换位都弹一句');
    const condEnd = body.indexOf(')', ifAt);
    const cond = body.slice(ifAt, condEnd === -1 ? ifAt + 200 : condEnd);
    assert.match(
      cond,
      /removedGroupId/,
      '分支的判据必须是「源组被搬空」—— 判据是别的东西 = 普通换位也会弹'
    );
  });

  it('源会话的名字与目标会话的名字都传给了文案层', () => {
    const body = handlerBody();
    assert.match(
      body,
      /sourceName:\s*[^,}]+/,
      '必须把源会话的名字传进去（说这句话的是目标组件，它没有源名字）'
    );
    assert.match(
      body,
      /targetName:\s*[^,}]+/,
      '必须把目标会话的名字传进去（用户要知道标签去哪了）'
    );
  });
});

describe('DS-43-11：moveTabAndSync 必须把源会话的名字带回来', () => {
  const src = code(TAB_SLICE);

  /** 只取 moveTabAndSync 这个 thunk 的函数体（整个文件里的 .find( 太多，会误判）。 */
  const thunkBody = (): string => {
    const at = src.indexOf('export const moveTabAndSync');
    assert.ok(at !== -1, '找不到 moveTabAndSync —— 守卫前提变了');
    const end = src.indexOf('\nexport const ', at + 1);
    return src.slice(at, end === -1 ? src.length : end);
  };

  it('回执里有 sourceGroupName', () => {
    assert.match(thunkBody(), /sourceGroupName/, '回执必须带源会话的名字');
  });

  it('名字取自写入前抓的那份快照（乐观 dispatch 之后源组可能已经不在列表里）', () => {
    assert.match(
      thunkBody(),
      /snapshot\.find\(/,
      '必须从**写入前抓的快照**里取源组的名字 —— 移动之后源组可能已经被移出列表，' +
        '那时候就取不到了'
    );
  });

  it('按 sourceGroupId 找那个源组', () => {
    assert.match(
      thunkBody(),
      /snapshot\.find\([^)]*sourceGroupId[^)]*\)/,
      '必须按 sourceGroupId 找源组 —— 找错组 = 点名了另一个会话'
    );
  });

  it('取不到时给 null（不许给 undefined，形状要稳）', () => {
    assert.match(
      thunkBody(),
      /\?\? null/,
      '取不到名字时给 null —— undefined 会让下游分不清「没有」和「漏了」'
    );
  });
});
