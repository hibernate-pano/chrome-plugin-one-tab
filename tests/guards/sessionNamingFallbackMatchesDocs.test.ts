// 「本机 / 内网 / IP 字面量」这一族在**文案**里必须被提到（2026-10-20 L-17；
// 2026-10-25 产品定案后随命名链改写）。
//
// ── 这个文件要防的具体事故 ────────────────────────────────────────────────
//
// 最初的版本：商店页承诺「取不到域名时（本地地址、内网地址等）退回时间戳」，
// 而实现只判了 **IPv4 正则**：
//
//   if (!host || host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
//
// ⇒ `127.0.0.1` 退回时间戳（兑现承诺），**`[::1]` 却当域名用上了**
// （会话名显示成 `[::1]`）。**同一个意思、两种结果** —— 承诺只在 IPv4 上兑现。
//
// 修复方向有一个**必须避开的坑**：不能为了让文案好看而把判据做成
// 「凡是带点就算域名」或「凡是公网 IP 就算域名」—— 那会让
// `192.168.1.5`（典型内网地址）重新变成会话名，而文案说的是「内网地址」。
//
// ── 2026-10-25 之后：这一族出现在**哪里** ─────────────────────────────────
//
// 默认会话名**一律**是保存时刻 ⇒ host **不再**出现在新会话的名字里。
// ⇒ 唯一还会露出 host 的会话名是 **OneTab 文本导入**的那个
// （`deriveImportedGroupName` ⇒ 主导域名）：导入一份全是指向
// `http://localhost:3000/…` 的 OneTab 文件，得到的会话名就是
// `localhost:3000`。
//
// ⇒ 本文件现在守的是：**凡是文案提到「会话名会含域名」的地方，
//   就必须同时点到本机 / 内网这一族**（用户看到 `localhost:3000`
//   这样的名字，得知道那是本机地址的正常表现），
//   且**不得**被说成「公网域名」。
//
// 【为什么第 ② 条同样重要】2026-10-20 修之前，文案写「内网地址」，
// 而 `wiki.corp`（真正的内网**域名**）在实现里是**会**当域名显示的。
// 文案比实现多承诺 ⇒ 与「实现比文案多」是同一类病，方向相反。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isLocalOrIpHost } from '@/core/hostName';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const STORE = read('CHROMEWEBSTORE.md');
const README = read('README.md');

/** 商店文档的「正文」：排除版本历史表（历史条目描述的是**当时**的行为）。 */
const storeBody = (): string =>
  STORE.split('## Version History')[0].split('## Review Notes')[0];

/**
 * 找到「导入导出」那一条（中文版/英文版）。
 *
 * 【为什么锚在这里而不是「智能命名」那条】2026-10-25 起，默认会话名
 * **一律**是保存时刻 ⇒ host 只出现在**导入**的会话名里
 * （OneTab 文本 ⇒ 按主导域名命名）⇒ 「凡是说『会话名会含域名』的地方」
 * 现在就是这一条。
 */
const storeImportLine = (zh: boolean): string => {
  const line = storeBody()
    .split('\n')
    .find(l =>
      zh
        ? l.trimStart().startsWith('· 导入导出：')
        : l.trimStart().startsWith('· Import/export:')
    );
  assert.ok(line, `商店文档里找不到「${zh ? '导入导出' : 'Import/export'}」那一条 —— 判据锚点丢了`);
  return line;
};

/**
 * ── 事实来源：代码判成「本机 / 内网 / IP 字面量」的形态，分族 ─────────────
 *
 * 每一族用**语义**描述（不是 URL 字面量），文案必须能对上其中之一。
 * 分族是必要的：文案说的是「本地地址」「内网 IP」这类**人话**，
 * 而代码面对的是「IPv4 字面量」「IPv6 字面量」这些**实现语言**。
 */
const HOSTNAME_FAMILIES: Array<{
  /** 这一族在代码里的判据锚点（host 形态） */
  hosts: string[];
  /** 文案里可以用的说法（任一命中即认为这一族被覆盖） */
  phrases: RegExp;
  /** 这一族在文案里应该被怎么称呼（用于错误信息） */
  label: string;
}> = [
  {
    label: '本机地址（localhost / 127.0.0.1）',
    hosts: ['localhost', '127.0.0.1', 'foo.localhost'],
    // 「本地地址」「本机地址」「localhost」「127.0.0.1」都算
    phrases: /本地地址|本机地址|localhost|127\.0\.0\.1|local address|loopback/i,
  },
  {
    label: 'IP 字面量（IPv4 / IPv6）',
    hosts: ['192.168.1.5', '::1', 'fe80::1', '2001:db8::1'],
    phrases: /IP\b|IP 地址|IP地址|内网 IP|intranet IP|IP literal/i,
  },
];

/**
 * 代码会**当主机名显示**的形态 —— 文案**不得**把这些说成公网域名。
 *
 * 【为什么这族要单列】`wiki.corp` 是**内网域名**：它有点，是合法的
 * 公网形态。代码会把它显示成会话名（这是对的 —— 用户在内网工作时
 * 「wiki.corp」正是他要记的东西）。文案若说「内网地址都是本机地址」，
 * 那就比实现多承诺了。
 */
const DOMAIN_LIKE_HOSTS = ['wiki.corp', 'intranet.example.com', 'github.com'];

describe('L-17 ① 文案必须提到「本机 / 内网 / IP 字面量」这一族', () => {
  for (const family of HOSTNAME_FAMILIES) {
    it(`（事实来源）${family.label}：代码确实判成本机地址`, () => {
      for (const host of family.hosts) {
        assert.ok(
          isLocalOrIpHost(host),
          `${host} 没有被判成本机地址 —— 判据漏了这一族，文案已经承诺了它`
        );
      }
    });

    it(`商店中文版的「导入导出」提到「${family.label}」`, () => {
      const line = storeImportLine(true);
      assert.match(
        line,
        family.phrases,
        `商店中文版的「导入导出」那一条没有提到「${family.label}」 —— ` +
          '而代码在这一族上产出的是**主机名**（localhost:3000 / 192.168.1.5）。' +
          '文案没提 ⇒ 用户看到 `localhost:3000` ' +
          '这种导入出来的会话名时不知道那是「本机地址」的正常表现。'
      );
    });

    it(`商店英文版的「Import/export」提到「${family.label}」`, () => {
      const line = storeImportLine(false);
      assert.match(
        line,
        family.phrases,
        `商店英文版的 "Import/export" 那一条没有提到「${family.label}」`
      );
    });

    it(`README 提到「${family.label}」`, () => {
      assert.match(
        README,
        family.phrases,
        `README 的会话命名那节没有提到「${family.label}」`
      );
    });
  }
});

describe('L-17 ② 文案不得把「会显示成域名的」说成本机地址', () => {
  it('（事实来源）带点的内网域名在代码里是**会**当域名显示的', () => {
    for (const host of DOMAIN_LIKE_HOSTS) {
      assert.ok(
        !isLocalOrIpHost(host),
        `${host} 被判成本机地址 —— 若这是有意的产品改动，文案要一起改`
      );
    }
  });

  it('商店中文版不得把「内网域名」说成本机地址', () => {
    const line = storeImportLine(true);
    /**
     * 判据：**「内网」后面紧跟「地址」** ⇒ 说的是「内网地址」这一族，
     * 而它含「内网 IP」这一族（文案必须提它）与「内网域名」（是域名）。
     *
     * ⇒ 文案若写「内网地址」，就必须**同时**提到 IP —— 否则它被读成
     * 「一切内网的东西都是本机地址」，比实现多承诺。
     */
    const mentionsIntranetAddress = /内网\s*地址/.test(line);
    if (mentionsIntranetAddress) {
      assert.match(
        line,
        /内网\s*IP|内网\s*IP\s*地址/,
        '商店中文版说「内网地址」但没点明是「内网 IP」 —— ' +
          '代码里内网**域名**（wiki.corp）是会显示成会话名的，' +
          '文案不能把「内网域名」也承诺成本机地址。'
      );
    }
  });
});
