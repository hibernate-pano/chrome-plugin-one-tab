// 载荷压缩（gzip 后加密，V3 格式）的格式级守卫（2026-10-23，第 54 轮）。
//
// ── 这个文件在防什么 ─────────────────────────────────────────────────────
//
// 云端出网（egress）按**发出去的字节**计费，而 Supabase 的 Free 档
// 超配额是**项目级封禁**（连 /auth/v1/health 都返回 402 ⇒ 整个项目不可用）。
// 第 53 轮把「下多少行」变成 ∝ 变更量；本轮解决「**每行多大**」。
//
// 旧顺序是「JSON → AES-GCM」：JSON 里全是重复（每条标签各重复一遍 key 名、
// 同格式的 ISO 时间、同域名的 favicon URL），而 AES-GCM 会把明文**打散成
// 高熵密文** ⇒ 这份重复在加密之后就**再也压不动了** —— 服务器端再 gzip
// 也只能回收 base64 自身的 25%。
//
// 把 gzip 挪到加密**之前** ⇒ 实测 10 标签/组 4291 B → 635 B（-85%），
// 整表下载 457.9 KB → 100.9 KB（-81%）。
//
// ⚠️ 但「把 gzip 挪到加密之前」改的是**载荷的编码** ⇒ 读端必须按前缀路由，
// 而**旧版扩展读不了新写的行**（那一组会显示成「读不出来」，数据不丢）。
// ⇒ 本文件钉住四件事：
//   ① 新旧格式**都能读**（V1 / V2 / V3 一条都不能回归）；
//   ② 写出去的载荷**解回来必须与原文逐字相同**（否则是在丢用户数据）；
//   ③ 典型载荷必须**真的变小**（不然这轮改动等于白做）；
//   ④ 小载荷**不许**用 V3（压了反而大 ⇒ 固定开销白付）。
//
// ⚠️ 断言钉的是**行为**（解回来一样吗 / 字节少了吗 / 坏数据会不会被
//   悄悄当成空数组），不是「源码里出现了 gzip 这个词」—— 那种断言把数据
//   换成空数组照样绿，**零检测力**。
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOADER_PATH = pathToFileURL(resolve(ROOT, 'tests/_alias-loader.mjs')).href;

const USER_ID = 'user-compressed-payload';
const V3_PREFIX = 'ENCRYPTED_V3_Z:';
const NOW = '2026-10-23T08:00:00.000Z';

type CryptoModule = typeof import('../src/utils/encryptionUtils.ts');

let crypto: CryptoModule;

before(async () => {
  register(LOADER_PATH, import.meta.url);
  crypto = await import('../src/utils/encryptionUtils.ts');
});

/** 造一条「典型」的云端标签（形状与 serializeTab 的输出一致）。 */
function tab(i: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `V1StGXR8_Z5jdHi6B-my${i}`,
    url: `https://www.example${i}.com/some/article/path?ref=nav`,
    title: `示例站点 ${i} 的页面标题 — 一个比较长的标题`,
    favicon: `https://www.google.com/s2/favicons?domain=example${i}.com&sz=32`,
    created_at: NOW,
    last_accessed: NOW,
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 一、往返：写出去的必须能原样读回来
// ══════════════════════════════════════════════════════════════════════════

describe('压缩载荷：写出去的必须能原样读回来', () => {
  it('典型载荷（10 条标签）往返后逐字相同', async () => {
    const tabs = Array.from({ length: 10 }, (_, i) => tab(i));
    const encrypted = await crypto.encryptCompressedData(tabs, USER_ID);
    assert.ok(encrypted.startsWith(V3_PREFIX), '典型载荷应当用 V3 压缩格式');
    const back = await crypto.decryptData<unknown>(encrypted, USER_ID);
    assert.deepEqual(back, tabs);
  });

  it('空数组也能往返（但不该用 V3 —— 压了反而大）', async () => {
    const encrypted = await crypto.encryptCompressedData([], USER_ID);
    const back = await crypto.decryptData<unknown>(encrypted, USER_ID);
    assert.deepEqual(back, []);
    assert.ok(
      !encrypted.startsWith(V3_PREFIX),
      '空载荷压完更大（gzip 头 + salt/iv/tag 的固定开销）⇒ 必须退回旧格式'
    );
  });

  it('含中文 / emoji / 引号 / 反斜杠的标题往返后逐字相同', async () => {
    const tabs = [
      tab(0, { title: '中文标题 —— 带破折号' }),
      tab(1, { title: 'emoji 🎉🔒 与引号 " \' 与反斜杠 \\ 与换行\n' }),
      tab(2, { title: '' }),
    ];
    const encrypted = await crypto.encryptCompressedData(tabs, USER_ID);
    const back = await crypto.decryptData<unknown>(encrypted, USER_ID);
    assert.deepEqual(back, tabs);
  });

  it('含 tab 级印记的标签往返后印记还在', async () => {
    const tabs = [
      tab(0, { last_op_device: 'dev-A', last_op_seq: 42 }),
      tab(1, { last_op_device: null, last_op_seq: null }),
    ];
    const encrypted = await crypto.encryptCompressedData(tabs, USER_ID);
    const back = await crypto.decryptData<unknown>(encrypted, USER_ID);
    assert.deepEqual(back, tabs);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 二、格式兼容：旧格式必须还能读（这决定「能不能发版」）
// ══════════════════════════════════════════════════════════════════════════

describe('格式兼容：旧格式一行都不能回归', () => {
  it('V2 标准格式（旧版写的）仍然解得开', async () => {
    const tabs = [tab(0)];
    const legacy = await crypto.encryptData(tabs, USER_ID);
    assert.ok(legacy.startsWith('ENCRYPTED_V2_S:'));
    const back = await crypto.decryptData<unknown>(legacy, USER_ID);
    assert.deepEqual(back, tabs);
  });

  it('V2 设备绑定格式（旧设备写的）仍然解得开', async () => {
    const tabs = [tab(0)];
    const legacy = await crypto.encryptData(tabs, USER_ID, true);
    assert.ok(legacy.startsWith('ENCRYPTED_V2_D:'));
    const back = await crypto.decryptData<unknown>(legacy, USER_ID);
    assert.deepEqual(back, tabs);
  });

  it('「旧版 serializeTab 写出的载荷」（带 null 字段）新读端解出来一模一样', async () => {
    // 旧版 serializeTab 每条标签都写 last_op_device:null / last_op_seq:null /
    // pinned:false —— 第 54 轮改了写侧，**存量云端行**仍然是那个形状。
    const legacyTabs = [
      { ...tab(0), pinned: false, last_op_device: null, last_op_seq: null },
      { ...tab(1), pinned: false, last_op_device: null, last_op_seq: null },
    ];
    const legacy = await crypto.encryptData(legacyTabs, USER_ID);
    const back = await crypto.decryptData<unknown>(legacy, USER_ID);
    assert.deepEqual(back, legacyTabs);
  });

  it('明文行（迁移前的历史数据）仍然解得开', async () => {
    const tabs = [tab(0)];
    const back = await crypto.decryptData<unknown>(JSON.stringify(tabs), USER_ID);
    assert.deepEqual(back, tabs);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 三、字节：压缩必须真的省下字节，小载荷必须不压
// ══════════════════════════════════════════════════════════════════════════

describe('字节账：压了必须真的变小', () => {
  it('10 标签的组：V3 比 V2 至少小 30%', async () => {
    const tabs = Array.from({ length: 10 }, (_, i) => tab(i));
    const v2 = await crypto.encryptData(tabs, USER_ID);
    const v3 = await crypto.encryptCompressedData(tabs, USER_ID);
    assert.ok(v3.startsWith(V3_PREFIX));
    assert.ok(
      v3.length <= v2.length * 0.7,
      `V3 应比 V2 至少小 30%（实测 V2=${v2.length} B，V3=${v3.length} B）—— ` +
        '省不下来就等于白改一遍载荷格式'
    );
  });

  it('凡是用了 V3 的载荷，必须比同内容的 V2 更短（自适应规则本身）', async () => {
    // ⚠️ 这里钉的是**规则**（「压了不划算就不压」），不是「几条标签会退回 V2」——
    //   那条分界线取决于载荷形状（URL 长度、标题、重复度），钉死它等于把
    //   「换个数据形状」也变成失败。
    for (const n of [0, 1, 2, 3, 10]) {
      const tabs = Array.from({ length: n }, (_, i) => tab(i));
      const v2 = await crypto.encryptData(tabs, USER_ID);
      const v3 = await crypto.encryptCompressedData(tabs, USER_ID);
      if (v3.startsWith(V3_PREFIX)) {
        assert.ok(
          v3.length < v2.length,
          `${n} 条标签用了 V3，就必须比 V2 短（V2=${v2.length} B，V3=${v3.length} B）—— ` +
            '否则固定开销（gzip 头 + salt/iv/tag）白付了'
        );
      }
      const back = await crypto.decryptData<unknown>(v3, USER_ID);
      assert.deepEqual(back, tabs, `${n} 条标签的载荷必须能原样读回来`);
    }
  });

  it('空组不用 V3（压完更大：gzip 头 + salt/iv/tag 的固定开销）', async () => {
    const encrypted = await crypto.encryptCompressedData([], USER_ID);
    assert.ok(
      !encrypted.startsWith(V3_PREFIX),
      '空载荷压完更大 ⇒ 必须退回旧格式'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 四、坏数据必须 fail-closed（绝不能被悄悄当成「空数组」）
// ══════════════════════════════════════════════════════════════════════════

describe('坏载荷：必须报错，不许悄悄变成空数据', () => {
  it('密文被篡改 ⇒ 解密抛错（而不是返回半个数组）', async () => {
    const tabs = Array.from({ length: 10 }, (_, i) => tab(i));
    const encrypted = await crypto.encryptCompressedData(tabs, USER_ID);
    const body = encrypted.slice(V3_PREFIX.length);
    // 翻转密文中间的一个字符 ⇒ AES-GCM 认证失败
    const mid = Math.floor(body.length / 2);
    const flipped = body[mid] === 'A' ? 'B' : 'A';
    const broken = V3_PREFIX + body.slice(0, mid) + flipped + body.slice(mid + 1);

    await assert.rejects(
      () => crypto.decryptData<unknown>(broken, USER_ID),
      /解密数据失败/,
      '密文坏了必须抛错 —— 静默返回空数组会被下游当成「这组本来就没标签」而硬删云端行'
    );
  });

  it('前缀是 V3 但内容不是合法 gzip ⇒ 抛错', async () => {
    const broken = V3_PREFIX + Buffer.from('这不是 gzip').toString('base64');
    await assert.rejects(
      () => crypto.decryptData<unknown>(broken, USER_ID),
      /解密数据失败/
    );
  });

  it('isEncrypted 认识 V3 ⇒ 读侧不会把 V3 密文当明文 JSON 去 parse', async () => {
    assert.equal(crypto.isEncrypted(V3_PREFIX + 'whatever'), true);
    assert.equal(crypto.isEncrypted('ENCRYPTED_V2_S:whatever'), true);
    assert.equal(crypto.isEncrypted('[{"id":"t1"}]'), false);
    // 这一条是「解压失败 ⇒ 走『读不出来』的 fail-closed 路径」的前提：
    // 若 isEncrypted 不认 V3，读侧会在解压失败后改去 JSON.parse 一段密文。
    assert.equal(
      crypto.isEncrypted(V3_PREFIX + 'whatever'),
      true,
      'V3 必须被认成「密文」—— 否则解压失败后会被当成明文行去 JSON.parse'
    );
  });
});
