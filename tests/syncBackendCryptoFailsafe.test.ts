// 客户端加密与删除熔断的测试（2026-10-13，阶段 2）。
//
// 这两块是 WebDAV 自带存储里唯二「错了会静默毁数据」的地方：
//   · 加密错 → 云盘上出现明文（端到端承诺失效），或密文解不开（用户丢会话）
//   · 熔断错 → 误删拦不住（无回收站，不可逆），或误报把正常同步挡死
// 所以断言全部打在行为上：两次加密必须不同（salt/IV 随机）、错口令与篡改
// 必须抛可读错误、阈值必须精确（恰好等于阈值不熔断）。
//
// 变异验证口径（改坏实现必须变红，2026-10-13 实测）：
//   · 去掉 hashPlaintext 的递归 key 排序 ⇒ 「key 顺序无关」红
//   · 删掉 vault.decrypt 的 v !== 1 分支 ⇒ 「拒绝未来格式版本」红
//   · IV 改成常量（每次加密同一 IV）⇒ 「两次加密密文不同」红
//   · openVault 忽略传入的 salt（改用随机）⇒ 「salt 往返」红
//   · 比例判断 > 改成 >= ⇒ 「恰好等于阈值允许」红
//   · 删掉 maxChanged 绝对上限 ⇒ 「占比很低但绝对量超限」红
//   · totalBefore > minTotal 改成 >= ⇒ 「总数恰好等于 minTotal 时豁免」红
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createVault, openVault, hashPlaintext } from '@/sync-backend/crypto';
import type { EncryptedPayload } from '@/sync-backend/crypto';
import { checkDeleteFailsafe, DEFAULT_FAILSAFE_LIMITS } from '@/sync-backend/failsafe';

/** 与实现里的文案保持一致：口令错 / 数据坏统一是这一句。 */
const DECRYPT_FAILURE = '口令错误或数据已损坏（无法解密）';

/** 断言 promise 一定抛错，并把它取出来 —— 便于对 message 做精确断言。 */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  assert.fail('预期抛错，但调用成功返回了');
}

describe('客户端加密（口令派生）', () => {
  it('往返：嵌套对象 / 数组 / 中文 / emoji 原样回来', async () => {
    const value = {
      标题: '工作 😀📌',
      nested: { list: [1, '二', { deep: true, n: null }], empty: [] },
      tabs: [{ url: 'https://例子.com/a?x=1', pinned: false }],
    };
    const vault = await createVault('correct horse');
    const payload = await vault.encrypt(value);
    assert.equal(payload.v, 1);
    assert.deepEqual(await vault.decrypt<typeof value>(payload), value);
  });

  it('同一明文两次加密：密文不同（IV 每次随机）——所以判变化只能用明文哈希', async () => {
    const vault = await createVault('口令-123');
    const first = await vault.encrypt({ 组: '工作' });
    const second = await vault.encrypt({ 组: '工作' });
    // IV 必须每次随机，这是 AES-GCM 的安全前提（IV 重用会泄露明文异或值）。
    // 因此密文**不是**内容的稳定指纹，「要不要上传」只能靠 hashPlaintext。
    assert.notEqual(first.data, second.data);
  });

  it('一个库一个 salt：同一 vault 下所有分片共用 salt（这是「一次派生」的机制）', async () => {
    // 分片存储下一次全量上传有 N 个文件。若每个文件各自随机 salt，
    // 就需要 N 次 250k 轮 PBKDF2 —— 300 个会话会撞上 MV3 单事件 5 分钟上限。
    // 所以 salt 的作用域是「整个库」，见 crypto.ts 里 Vault 的完整论证。
    const vault = await createVault('pw');
    const a = await vault.encrypt({ id: 'a' });
    const b = await vault.encrypt({ id: 'b' });
    assert.equal(a.salt, b.salt);
    assert.equal(a.salt, vault.salt);
  });

  it('salt 往返：用同一 salt 重新打开即可解开旧密文（manifest 持久化 salt 的依据）', async () => {
    const vault = await createVault('pw');
    const payload = await vault.encrypt({ id: 'g1', name: '工作' });

    const reopened = await openVault('pw', vault.salt);
    assert.equal(reopened.salt, vault.salt);
    assert.deepEqual(await reopened.decrypt(payload), { id: 'g1', name: '工作' });
  });

  it('口令错误 → 抛出可读的中文错误，不泄露内容', async () => {
    const vault = await createVault('right');
    const payload = await vault.encrypt({ secret: '标签页列表' });
    const wrong = await openVault('wrong', vault.salt);
    const err = await rejectionOf(wrong.decrypt(payload));
    assert.equal(err.message, DECRYPT_FAILURE);
  });

  it('salt 不一致（文件来自另一个库）→ 明确报错，不静默跳过', async () => {
    const vault = await createVault('pw');
    const payload = await vault.encrypt({ x: 1 });
    const other = await createVault('pw'); // 同口令、不同 salt = 另一个库
    const err = await rejectionOf(other.decrypt(payload));
    assert.match(err.message, /不属于当前同步库/);
  });

  it('hashPlaintext：同一内容稳定，且对象 key 顺序（含嵌套）不影响结果', async () => {
    const a = await hashPlaintext({ z: 1, nested: { b: 2, a: [1, { q: 3, p: 4 }] } });
    const b = await hashPlaintext({ nested: { a: [1, { p: 4, q: 3 }], b: 2 }, z: 1 });
    assert.equal(a, b);
    assert.equal(a, await hashPlaintext({ z: 1, nested: { b: 2, a: [1, { q: 3, p: 4 }] } }));
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  it('hashPlaintext：不同内容得到不同哈希（含数组顺序）', async () => {
    const base = await hashPlaintext({ a: 1, list: [1, 2] });
    assert.notEqual(base, await hashPlaintext({ a: 2, list: [1, 2] }));
    assert.notEqual(base, await hashPlaintext({ a: 1, list: [2, 1] }));
  });

  it('密文被篡改（翻转 data 里一个 base64 字符）→ AES-GCM 认证失败', async () => {
    const vault = await createVault('pw');
    const payload = await vault.encrypt({ x: '数据' });
    const index = 5;
    const flipped = payload.data[index] === 'A' ? 'B' : 'A';
    const tampered: EncryptedPayload = {
      ...payload,
      data: payload.data.slice(0, index) + flipped + payload.data.slice(index + 1),
    };
    const err = await rejectionOf(vault.decrypt(tampered));
    assert.equal(err.message, DECRYPT_FAILURE);
  });

  it('payload.v 不是 1 → 拒绝（将来换算法时的保护，不做尽力而为解析）', async () => {
    const vault = await createVault('pw');
    const payload = await vault.encrypt({ x: 1 });
    const future = { ...payload, v: 2 } as unknown as EncryptedPayload;
    const err = await rejectionOf(vault.decrypt(future));
    assert.match(err.message, /不支持的密文格式版本/);
  });
});

describe('删除熔断', () => {
  it('默认值与 Floccus 常规书签档一致', () => {
    assert.deepEqual(DEFAULT_FAILSAFE_LIMITS, { minTotal: 5, ratio: 0.2, maxChanged: 1000 });
  });

  it('大比例删除被拦（10 条要删 5 条）', () => {
    assert.equal(checkDeleteFailsafe(10, 5).allowed, false);
  });

  it('小库豁免比例判断，但 maxChanged 仍然成立', () => {
    assert.equal(checkDeleteFailsafe(3, 3).allowed, true);
    // 总数恰好等于 minTotal：严格大于才进入比例判断，仍然豁免
    assert.equal(checkDeleteFailsafe(5, 5).allowed, true);
    // 一旦超过 minTotal，比例判断立即生效
    assert.equal(checkDeleteFailsafe(6, 6).allowed, false);
  });

  it('绝对上限：删 1001 条拦，哪怕占比很小', () => {
    assert.equal(checkDeleteFailsafe(5000, 1001).allowed, false);
    // 占比仅 5%，只有绝对上限能拦住它
    assert.equal(checkDeleteFailsafe(20000, 1001).allowed, false);
  });

  it('恰好等于比例阈值 → 允许（严格大于才熔断）', () => {
    assert.equal(checkDeleteFailsafe(10, 2).allowed, true);
  });

  it('没有删除（0 或负数）永远允许', () => {
    assert.equal(checkDeleteFailsafe(10, 0).allowed, true);
    assert.equal(checkDeleteFailsafe(0, 0).allowed, true);
    assert.equal(checkDeleteFailsafe(10, -3).allowed, true);
  });

  it('拒绝原因含具体数字、全中文（用户要据此判断下一步动作）', () => {
    const ratioVerdict = checkDeleteFailsafe(10, 5);
    const ratioReason = ratioVerdict.reason ?? '';
    assert.match(ratioReason, /5/);
    assert.match(ratioReason, /10/);
    assert.doesNotMatch(ratioReason, /[A-Za-z]/);

    const absoluteVerdict = checkDeleteFailsafe(20000, 1001);
    const absoluteReason = absoluteVerdict.reason ?? '';
    assert.match(absoluteReason, /1001/);
    assert.match(absoluteReason, /1000/);
    assert.doesNotMatch(absoluteReason, /[A-Za-z]/);
  });

  it('自定义 limits 覆盖默认值', () => {
    assert.equal(checkDeleteFailsafe(100, 6, { maxChanged: 5 }).allowed, false);
    assert.equal(checkDeleteFailsafe(100, 5, { maxChanged: 5 }).allowed, true);
    assert.equal(checkDeleteFailsafe(10, 4, { ratio: 0.5 }).allowed, true);
    assert.equal(checkDeleteFailsafe(10, 6, { ratio: 0.5 }).allowed, false);
    // 覆盖只作用于本次调用，不改动默认值对象
    assert.equal(DEFAULT_FAILSAFE_LIMITS.maxChanged, 1000);
  });
});
