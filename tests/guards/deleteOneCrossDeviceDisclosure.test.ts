// 「删除单个会话」的跨设备披露（2026-10-24 审计 DS-3）。
//
// ── 要防的回归类别 ────────────────────────────────────────────────────────
// 删除意图**会**传到其他设备：本地物理移除后墓碑经上传队列广播到云端
// （Supabase `markCloudGroupsAsDeleted` / WebDAV `broadcastDeletes`），
// 对端合并时服从墓碑 —— 且自 2026-10-24 起**云端墓碑一律赢**
// （`core/opStampMerge.ts` / `core/remoteAdjudication.ts` /
// `utils/supabase/upload.ts` 三处同口径）⇒ 对方离线期间改过也一样会被删。
//
// 此前**单个会话**的删除确认框一个字都不提这件事 ⇒ 用户在按确认键的那一刻
// 被误导成「只删本机」。而「删除所有会话」那一句是有的 ⇒ 两个入口对同一件事
// 说了两件不同的事。
//
// 本守卫钉三件事：
//   ① 判据同源（有没有可用的同步后端，不是「有没有账号」）；
//   ② 确认框在**该说**的时候确实说了，且说的是**真实后果**（对方那份也没了）；
//   ③ 纯本地用户不该看到跨设备那句。
//
// ⚠️ 不钉整串文案 —— 只钉「有没有说」「说的是不是当前真相」。
//    措辞可以改，但「说漏了」和「说成另一个真相」必须变红。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deleteGroupConfirmMessage,
  deleteGroupConfirmTitle,
} from '@/components/tabs/lockedDeleteCopy';
import {
  crossDeviceDeleteCaveat,
  crossDeviceDeleteSentence,
  deleteReachesOtherDevices,
} from '@/components/sync/crossDeviceDeleteCopy';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

const LOGGED_IN = { isAuthenticated: true, syncBackend: 'supabase' } as const;
const WEBDAV = { isAuthenticated: false, syncBackend: 'webdav' } as const;
const LOCAL_ONLY = { isAuthenticated: false, syncBackend: 'supabase' } as const;

describe('删除单个会话：确认框必须说清跨设备后果', () => {
  it('已登录用户 ⇒ 必须出现跨设备那一句', () => {
    const msg = deleteGroupConfirmMessage({
      name: '工作',
      tabCount: 3,
      isLocked: false,
      crossDevice: LOGGED_IN,
    });
    assert.match(msg, /其他登录设备/, `跨设备那句必须出现：${msg}`);
    assert.match(msg, /同步删除/, `必须说清是「同步删除」：${msg}`);
    assert.match(msg, /。确认继续吗？$/, `确认问句必须还在：${msg}`);
  });

  it('自带存储（WebDAV）用户 ⇒ 同样必须说（他们没有账号，但删除照样广播）', () => {
    const msg = deleteGroupConfirmMessage({
      name: '工作',
      tabCount: 3,
      isLocked: false,
      crossDevice: WEBDAV,
    });
    assert.match(msg, /其他设备/, `自带存储用户也必须被告知：${msg}`);
    assert.ok(
      !msg.includes('登录设备'),
      `自带存储用户没有账号，不该说「登录设备」：${msg}`
    );
  });

  it('纯本地用户（没有同步后端）⇒ 不得出现跨设备那句', () => {
    const msg = deleteGroupConfirmMessage({
      name: '工作',
      tabCount: 3,
      isLocked: false,
      crossDevice: LOCAL_ONLY,
    });
    assert.doesNotMatch(msg, /其他设备|其他登录设备|同步删除/);
  });

  it('没传跨设备事实（旧调用方）⇒ 不得凭空承诺跨设备删除', () => {
    const msg = deleteGroupConfirmMessage({ name: '工作', tabCount: 3, isLocked: false });
    assert.doesNotMatch(msg, /其他设备|其他登录设备|同步删除/);
  });

  it('必须说出**真实后果**：对方离线期间改过的那份也一起被删', () => {
    const msg = deleteGroupConfirmMessage({
      name: '工作',
      tabCount: 3,
      isLocked: false,
      crossDevice: LOGGED_IN,
    });
    assert.match(
      msg,
      /离线期间改过.*会被删除/,
      `删除会同步过去且对方那份离线编辑也没了 —— 这一层后果必须说：${msg}`
    );
    assert.doesNotMatch(
      msg,
      /删除可能不生效/,
      `❌ 回归：云端墓碑已经一律赢了（DS-3），删除**一定**生效 —— ` +
        `再说「可能不生效」是把修好的缺陷当成还存在的：${msg}`
    );
  });

  it('锁定会话也要说跨设备那句（锁定只保护这张卡，不改变删除的传播）', () => {
    const msg = deleteGroupConfirmMessage({
      name: '重要',
      tabCount: 2,
      isLocked: true,
      crossDevice: LOGGED_IN,
    });
    assert.match(msg, /已锁定/, '锁定那句必须还在');
    assert.match(msg, /其他登录设备/, '锁定会话的删除同样会传到其他设备');
    assert.match(msg, /确认仍要删除它吗？$/, '锁定态的确认问句必须还在');
  });

  it('标题不受跨设备那句影响（标题只说删的是什么）', () => {
    assert.equal(
      deleteGroupConfirmTitle({ name: '工作', tabCount: 3, isLocked: false }),
      '删除「工作」？'
    );
  });
});

describe('两个入口（删单个 / 删全部）说的是同一件事', () => {
  it('同一份 caveat：两处必须用同一句', () => {
    // 「删除所有会话」与「删除单个会话」对跨设备后果的说明必须一致 ——
    // 两处各说一半，读者看到的就是两件不同的事。
    const one = deleteGroupConfirmMessage({
      name: '工作',
      tabCount: 3,
      isLocked: false,
      crossDevice: LOGGED_IN,
    });
    assert.ok(
      one.includes(crossDeviceDeleteCaveat),
      `删除单个会话的文案必须用共享的那句 caveat：${one}`
    );
  });

  it('判据只有一处：跨设备那句由共享模块产出', () => {
    assert.equal(deleteReachesOtherDevices(LOGGED_IN), true);
    assert.equal(deleteReachesOtherDevices(WEBDAV), true);
    assert.equal(deleteReachesOtherDevices(LOCAL_ONLY), false);
    assert.match(crossDeviceDeleteSentence(LOGGED_IN), /其他登录设备/);
    assert.match(crossDeviceDeleteSentence(WEBDAV), /其他设备/);
  });
});

describe('接线：TabGroup 必须真的把跨设备事实传进确认框', () => {
  const source = read('src/components/tabs/TabGroup.tsx');

  it('必须读「有没有账号」与「跟谁同步」两个事实', () => {
    assert.match(
      source,
      /state\.auth\.isAuthenticated/,
      '确认框必须知道有没有账号（自带存储用户没有账号但照样广播）'
    );
    assert.match(
      source,
      /state\.settings\.syncBackend/,
      '确认框必须知道跟谁同步（判据是「有没有可用的同步后端」）'
    );
  });

  it('必须把这两件事传进 deleteGroupConfirmMessage 的输入', () => {
    assert.match(
      source,
      /deleteGroupConfirmMessage\(copyInput\)/,
      '确认框正文必须由 copyInput 装配'
    );
    assert.match(
      source,
      /crossDevice:\s*\{\s*isAuthenticated,\s*syncBackend:/,
      'copyInput 必须带上跨设备的原始事实 —— 漏了就是「只删本机」的误导'
    );
  });
});
