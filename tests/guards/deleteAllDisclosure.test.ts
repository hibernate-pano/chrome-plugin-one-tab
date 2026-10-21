// 「删除所有会话」的跨设备删除披露必须同源（2026-10-18 round 25）。
//
// 【要防的回归类别】删除意图会传到其他设备：本地物理移除后墓碑经上传队列广播到云端
// （Supabase `markCloudGroupsAsDeleted` / WebDAV `broadcastDeletes`），对端合并时服从墓碑。
// 但两处声明曾各写一份判据：
//   · 菜单行（HeaderDropdown 危险区）**无条件**写「（其他登录设备同步删除）」——
//     对没有同步后端的纯本地用户是假话；
//   · 确认框（真正按下「全部删除」的那一步）只看 `isAuthenticated`，
//     而自带存储（WebDAV）用户没有 TapStack 账号 ⇒ 一个字都不提跨设备删除。
// 于是最该看清的那一步反而最不诚实，用户以为「只删本机」，其他设备上的会话已经没了。
//
// 本守卫钉三件事：① 判据本身（登录 / 自带存储 / 纯本地三种边界）；
// ② 两处文案都由同一个纯函数产出（同一份声明只有一个版本）；
// ③ 仓里不再有各写一份的内联判据。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deleteAllConfirmMessage,
  deleteAllMenuWarning,
  deleteReachesOtherDevices,
} from '@/components/layout/deleteAllMessages';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');
const DROPDOWN = 'src/components/layout/HeaderDropdown.tsx';

describe('deleteReachesOtherDevices：判据是「有没有可用的同步后端」，不是「有没有账号」', () => {
  it('TapStack 云端已登录 → true', () => {
    assert.equal(deleteReachesOtherDevices({ isAuthenticated: true, syncBackend: 'supabase' }), true);
  });

  it('自带存储（WebDAV）未登录 → true（墓碑广播不看账号）', () => {
    assert.equal(deleteReachesOtherDevices({ isAuthenticated: false, syncBackend: 'webdav' }), true);
  });

  it('纯本地（未登录 + 云端后端）→ false（此时不该承诺跨设备删除）', () => {
    assert.equal(deleteReachesOtherDevices({ isAuthenticated: false, syncBackend: 'supabase' }), false);
  });
});

describe('确认框文案：破坏性操作的最后一道说明', () => {
  it('自带存储用户也会被告知其他设备会同步删除（改前完全没提）', () => {
    const message = deleteAllConfirmMessage({
      groupCount: 3,
      lockedCount: 0,
      isAuthenticated: false,
      syncBackend: 'webdav',
    });
    assert.equal(message, '将删除本地全部 3 个会话，删除后无法恢复，其他设备将同步删除。确认继续吗？');
    assert.ok(!message.includes('登录设备'), '自带存储用户没有账号，不该说「登录设备」');
  });

  it('已登录用户保持原文案（口径不变）', () => {
    assert.equal(
      deleteAllConfirmMessage({
        groupCount: 7,
        lockedCount: 0,
        isAuthenticated: true,
        syncBackend: 'supabase',
      }),
      '将删除本地全部 7 个会话，删除后无法恢复，其他登录设备将同步删除。确认继续吗？'
    );
  });

  it('纯本地用户不出现跨设备那句（无后端可广播）', () => {
    const message = deleteAllConfirmMessage({
      groupCount: 2,
      lockedCount: 0,
      isAuthenticated: false,
      syncBackend: 'supabase',
    });
    assert.equal(message, '将删除本地全部 2 个会话，删除后无法恢复。确认继续吗？');
  });

  it('数量就是传入的会话数（不写死、不吞 0）', () => {
    assert.ok(
      deleteAllConfirmMessage({
        groupCount: 0,
        lockedCount: 0,
        isAuthenticated: true,
        syncBackend: 'supabase',
      }).includes('全部 0 个会话')
    );
  });
});

describe('菜单行文案：与确认框同一份判据', () => {
  it('自带存储用户 → 其他设备同步删除', () => {
    assert.equal(
      deleteAllMenuWarning({ lockedCount: 0, isAuthenticated: false, syncBackend: 'webdav' }),
      '将清空本地全部会话，删除后无法恢复（其他设备同步删除）。'
    );
  });

  it('已登录用户 → 与改前逐字一致', () => {
    assert.equal(
      deleteAllMenuWarning({ lockedCount: 0, isAuthenticated: true, syncBackend: 'supabase' }),
      '将清空本地全部会话，删除后无法恢复（其他登录设备同步删除）。'
    );
  });

  it('纯本地用户 → 不再无条件承诺跨设备删除', () => {
    assert.equal(
      deleteAllMenuWarning({ lockedCount: 0, isAuthenticated: false, syncBackend: 'supabase' }),
      '将清空本地全部会话，删除后无法恢复。'
    );
  });
});

describe('两处入口都走同一个纯函数（同一份声明只有一个版本）', () => {
  const source = read(DROPDOWN);

  it('确认框正文由 deleteAllConfirmMessage 装配，且读的是真实后端', () => {
    const call = source.slice(source.indexOf('deleteAllConfirmMessage({'));
    assert.ok(call.length > 0, '确认框正文必须由 deleteAllConfirmMessage 产出');
    const args = call.slice(0, call.indexOf('})'));
    assert.ok(/groupCount: groups\.length/.test(args), '数量必须是当前会话数');
    assert.ok(
      /syncBackend: settings\.syncBackend/.test(args),
      '后端必须是设置里的真值 —— 写死 supabase 会让自带存储用户又看不到那句'
    );
  });

  it('菜单行用 deleteAllMenuWarning 装配副标题', () => {
    assert.ok(
      /deleteAllMenuWarning\(\{[\s\S]{0,120}?lockedCount: lockedGroupCount,[\s\S]{0,120}?isAuthenticated,[\s\S]{0,120}?syncBackend: settings\.syncBackend,?[\s\S]{0,40}?\}\)/.test(
        source
      ),
      '菜单行副标题必须由 deleteAllMenuWarning 产出，且必须带上锁定会话数'
    );
  });

  it('仓里不再有各写一份的跨设备内联判据', () => {
    assert.ok(
      !/isAuthenticated \? '，其他登录设备将同步删除'/.test(source),
      '确认框不该再自己内联判据'
    );
    assert.ok(
      !/将清空本地全部会话，删除后无法恢复（其他登录设备同步删除）。/.test(source),
      '菜单行不该再无条件写死「其他登录设备同步删除」'
    );
  });
});
