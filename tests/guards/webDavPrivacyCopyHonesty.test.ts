// 自带存储（WebDAV）的隐私说明必须**等于真实行为**（2026-10-23 审计 WC-5）。
//
// ── 这个文件防的具体事故 ──────────────────────────────────────────────────
//
// 设置页的「自带存储（WebDAV）」面板里，同屏有两个单选：
// 「加密（推荐）」与「不加密」。而隐私说明那段是**无条件渲染**的
// 一句「会话内容加密后存放」——
//
//   ① 用户显式选了「不加密」之后，这句话**仍在**说「加密后存放」
//      ⇒ 界面在骗人（而且骗的是隐私承诺，性质比一般文案错更重）；
//   ② 即便在加密模式下，它把明文面说得**比实际小**：
//      manifest 明文里还有会话 id、是否已删除、操作印记（含设备编号）、
//      加密 salt，而每个会话分片还带一段**明文头部**
//      （`sync-backend/webdav/layout.ts` 的 `ShardHeader`）。
//      把范围说小，同样是不诚实。
//
// ── 判据钉什么 ────────────────────────────────────────────────────────────
//
// 钉**语义**（谁能看到什么），不钉整段中文：
//   · 加密关闭 ⇒ 必须出现「名称」与「网址」，且必须在同一句里说清它们是明文；
//   · 加密开启 ⇒ 必须逐项说出 manifest 的明文字段；
//   · 两边都**不许**声称对方那套（明文模式不许说「加密后存放」，
//     加密模式不许说「名称与网址是明文」）。
//
// ── 为什么还要盯 `privacy.html` ───────────────────────────────────────────
//
// 隐私政策里那节「自带存储（WebDAV）」是**同一批事实的另一个出口**
// （仓库 → 线上那段接缝另有守卫）。两处说的字段清单必须一致 ——
// 否则用户拿政策对照界面、或审核员按政策核对面板，总有一边是错的。
// ⇒ 这里把字段清单钉成**一份**，两边都必须提到它。
//
// ── 变异自证（每条都实测过：改坏实现 ⇒ 对应用例变红）────────────────────
//
//   M1 把「不加密」那版换回原来那句「会话内容加密后存放」 ⇒ 明文模式那两条变红
//   M2 从加密那版里删掉 salt 那一项                          ⇒ 字段清单那���变红
//   M3 让面板不再调用 webDavPrivacyNotice（自己写死一句）    ⇒ 接线那一条变红

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { webDavPrivacyNotice } from '@/components/sync/webDavPrivacyCopy';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const PANEL = read('src/components/sync/WebDavSettings.tsx');
const PRIVACY = read('src/legal/privacy.html');
const LAYOUT = read('src/sync-backend/webdav/layout.ts');

/**
 * 去掉注释 —— 只看**会被渲染出来**的东西。
 *
 * 必须剥：面板里那段说明「为什么要有两套说法」的注释里就写着「隐私说明」，
 * 不剥的话这条断言会把自己判成违规（等于写一份会骗自己的测试）。
 * 同一坑见 tests/webdavSettingsUi.test.ts 的 stripComments。
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

const PANEL_CODE = stripComments(PANEL);

/**
 * manifest 里那些**明文**字段 —— 一份清单，两处（面板 / 隐私政策）都要说到。
 *
 * 为什么用正则而不是纯子串：`会话 id` 在隐私政策里写的是「会话 id」，
 * 在面板里写的是「每个会话的 id」—— 措辞可以不同，**字段本身不能少**。
 */
const PLAINTEXT_FIELDS: ReadonlyArray<{ label: string; needle: RegExp }> = [
  { label: '会话 id', needle: /会话.{0,6}id/i },
  { label: '最后修改时间', needle: /最后修改时间/ },
  { label: '是否已删除（删除标记）', needle: /是否已删除/ },
  { label: '操作印记', needle: /操作印记/ },
  { label: '设备编号（操作印记里的那部分）', needle: /设备编号/ },
  { label: '加密 salt', needle: /salt/i },
];

/** 把一段话按句号/分号切成句子。 */
const sentences = (text: string): string[] =>
  text
    .split(/[。；;]/)
    .map(s => s.trim())
    .filter(Boolean);

describe('WC-5 ① 明文模式：那套说法必须说清「名称与网址是明文」', () => {
  const plain = webDavPrivacyNotice('plain');

  it('必须出现「名称」与「网址」', () => {
    assert.match(plain, /名称/, '明文模式下必须提到会话名称');
    assert.match(plain, /网址/, '明文模式下必须提到网址');
  });

  it('「名称」与「网址」必须在同一句里被说成明文', () => {
    const sentence = sentences(plain).find(s => /名称/.test(s) && /网址/.test(s));
    assert.ok(
      sentence,
      `明文模式的说明里找不到同时提到「名称」与「网址」的句子：${plain}`
    );
    assert.match(
      sentence!,
      /明文|直接看到|直接可见/,
      `这一句必须说清它们是明文（云盘服务商直接可读）：${sentence}`
    );
  });

  it('不许声称「加密后存放」（用户明明选了不加密）', () => {
    assert.doesNotMatch(
      plain,
      /加密后存放|云盘上只有密文/,
      '明文模式下说「加密后存放」就是在骗人 —— 用户显式选了「不加密」'
    );
  });
});

describe('WC-5 ② 加密模式：必须说清 manifest 的明文字段', () => {
  const encrypted = webDavPrivacyNotice('required');

  it('必须逐项说到 manifest 的明文字段', () => {
    for (const field of PLAINTEXT_FIELDS) {
      assert.match(
        encrypted,
        field.needle,
        `加密模式的隐私说明漏了「${field.label}」—— ` +
          'manifest 是明文的，这些字段云盘服务商看得到'
      );
    }
  });

  it('必须点明存在一个明文的清单文件', () => {
    assert.match(encrypted, /清单/, '必须点明存在清单文件（manifest）');
    assert.match(encrypted, /明文/, '必须说清单是明文的');
  });

  it('必须说清「云盘服务商能看到什么」', () => {
    assert.match(
      encrypted,
      /云盘(服务商)?能看到/,
      '必须说清「云盘服务商能看到什么」——这是实质信息，不是措辞'
    );
  });

  it('必须说清「名称与网址看不到」', () => {
    assert.match(encrypted, /名称/, '必须提到会话名称');
    assert.match(encrypted, /网址/, '必须提到网址');
    const sentence = sentences(encrypted).find(
      s => /名称/.test(s) && /网址/.test(s) && /看不到|不含|不会看到/.test(s)
    );
    assert.ok(
      sentence,
      `加密模式下必须说清「名称与网址」云盘服务商看不到：${encrypted}`
    );
  });

  it('不许说「名称与网址是明文」（那是明文模式才成立的话）', () => {
    assert.doesNotMatch(
      encrypted,
      /名称与网址以明文/,
      '加密模式下说「名称与网址是明文」就是假话 —— 它们在密文里'
    );
  });
});

describe('WC-5 ③ 两处出口（面板 / 隐私政策）必须是同一份字段清单', () => {
  it('隐私政策（口径基准）也得说到这些字段', () => {
    for (const field of PLAINTEXT_FIELDS) {
      assert.match(
        PRIVACY,
        field.needle,
        `隐私政策漏了「${field.label}」—— ` +
          '面板与政策说的必须是同一份清单（否则总有一边是错的）'
      );
    }
  });

  it('隐私政策必须仍然披露 WebDAV 那一节（口径的来源没被删掉）', () => {
    assert.match(PRIVACY, /自带存储（WebDAV）/, '隐私政策的 WebDAV 那一节不见了');
    assert.match(PRIVACY, /明文头部/, '隐私政策不再提每个会话文件的明文头部');
  });
});

describe('WC-5 ④ 面板必须真的渲染那个纯函数（接线，不是文案孤儿）', () => {
  it('面板调用了 webDavPrivacyNotice', () => {
    assert.match(
      PANEL,
      /webDavPrivacyNotice\(/,
      '面板必须真的调用 webDavPrivacyNotice —— ' +
        '纯函数写了不接上，等于没修'
    );
  });

  it('面板里不得自己再写一份隐私说明（否则会出现第二种说法）', () => {
    const hardcoded = PANEL_CODE.split('\n').filter(l => l.includes('隐私说明'));
    assert.deepEqual(
      hardcoded,
      [],
      '面板里还留着写死的隐私说明 —— 说法必须只有纯函数那一个出处'
    );
  });
});

describe('WC-5 ⑤ 事实来源：实现里真的有这些明文字段', () => {
  it('manifest 的分片指纹与明文头部都真的存在', () => {
    assert.match(LAYOUT, /isDeleted/, 'manifest 里的删除标记不见了');
    assert.match(LAYOUT, /lastOp/, 'manifest 里的操作印记不见了');
    assert.match(LAYOUT, /salt/, 'manifest 里的 salt 不见了');
    assert.match(LAYOUT, /ShardHeader/, '每个会话分片的明文头部不见了');
  });

  it('salt 只在加密开启时才有（明文模式不该说有 salt）', () => {
    assert.match(
      LAYOUT,
      /encrypted:\s*true[\s\S]{0,80}有值|仅\s*`?encrypted:\s*true`?\s*时有值/,
      'layout.ts 里 salt 的条件说明变了 —— 明文模式的措辞需要重新核对'
    );
  });
});
