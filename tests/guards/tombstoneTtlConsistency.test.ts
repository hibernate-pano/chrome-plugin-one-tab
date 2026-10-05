// 墓碑 TTL 的服务端/客户端一致性（2026-10-05）。
//
// 体检发现：客户端 purgeExpiredCloudTombstones 只挂在 upload 上，
// 「再也不用这个账号」的墓碑行永远没人清；而服务端兜底
// （原 supabase/manual/tombstone_expiry_cron.sql）整段被注释、未启用
// ⇒ is_deleted 行对休眠账号无限堆积（隐私政策承诺 30 天后删除）。
//
// 已改为正式迁移 20261005000000b：建 purge_expired_cloud_tombstones() 函数
// + body_tombstone_expiry_days() TTL 常量，启用步骤打进迁移日志。
//
// ⚠️ 本文件守的是那条**最危险的**约束：两边的 TTL 必须一致。
// 服务端提前删 → 客户端还没广播完 → 离线设备把已删会话复活
// （v1.22.0 起无回收站 = 永久）。反之服务端晚报几天只是多占一点存储。
// 客户端是「每次上传时顺手清」，所以**客户端是权威**：服务端跟随它。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

const CLIENT_TTL_DAYS = 30;

describe('墓碑 TTL：客户端是权威，服务端跟随', () => {
  it('客户端 purge 的 TTL 是 30 天', () => {
    const src = read('src/utils/supabase/upload.ts');
    // 找 purgeExpiredCloudTombstones 的**定义处**签名（前面还有若干调用点）
    const defIdx = src.indexOf('async purgeExpiredCloudTombstones(');
    assert.ok(defIdx !== -1, '应能找到 purgeExpiredCloudTombstones 的定义');
    const sig = src.slice(defIdx, defIdx + 160);
    // 签名写作 `maxAgeDays: number = 30`，所以正则要允许中间的 TS 类型标注
    assert.match(
      sig,
      new RegExp(`maxAgeDays\\s*:\\s*number\\s*=\\s*${CLIENT_TTL_DAYS}`),
      `客户端 TTL 应为 ${CLIENT_TTL_DAYS} 天（隐私政策与商店文案都按 30 天表述），实际：${sig.slice(0, 120)}`
    );
  });

  it('服务端迁移里的 TTL 常量与客户端一致', () => {
    const p = 'supabase/migrations/20261005000000b_purge_expired_tombstones.sql';
    assert.ok(existsSync(resolve(ROOT, p)), '服务端兜底清理迁移应存在');
    const sql = read(p);
    assert.match(
      sql,
      new RegExp(`SELECT ${CLIENT_TTL_DAYS}`),
      `body_tombstone_expiry_days() 必须返回 ${CLIENT_TTL_DAYS}，与服务端提前删会造成「离线设备复活已删会话」`
    );
  });

  it('服务端函数里用的是这个常量，不是硬编码的另一个数', () => {
    const sql = read('supabase/migrations/20261005000000b_purge_expired_tombstones.sql');
    // 函数体内必须引用常量，否则改常量时不会生效（两处数字会悄悄分叉）
    const fnBody = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.purge_expired_cloud_tombstones'));
    assert.match(
      fnBody,
      /v_ttl integer := public\.body_tombstone_expiry_days\(\)/,
      '清理函数必须调用 TTL 常量函数，不能自己再写一个数字'
    );
    assert.ok(
      !/interval '\s*\d+\s*days\s*'/.test(fnBody),
      "函数体内不得出现硬编码的 interval 'N days' —— 那会与常量分叉"
    );
  });

  it('旧的 manual 脚本已删除（它整段注释，是个从不生效的假门）', () => {
    assert.ok(
      !existsSync(resolve(ROOT, 'supabase/manual/tombstone_expiry_cron.sql')),
      'tombstone_expiry_cron.sql 整段被注释、从未启用；清理逻辑已迁到正式迁移，' +
        '留着会让人以为「服务端兜底已经在了」'
    );
  });

  it('迁移不自动挂 cron（pg_cron 未启用时会整条报错），但打印了启用步骤', () => {
    const sql = read('supabase/migrations/20261005000000b_purge_expired_tombstones.sql');
    // 直接 cron.schedule 会在未启用扩展的项目上失败
    assert.ok(
      !/^\s*SELECT cron\.schedule\(/m.test(sql),
      '迁移里不应直接 cron.schedule —— pg_cron 需人工在 Dashboard 启用，' +
        '未启用时会让整条迁移失败'
    );
    // 但必须告诉执行者最后一步是什么，否则函数建了却没人挂 = 仍然不生效
    assert.match(sql, /cron\.schedule/, '应在 RAISE NOTICE 里给出挂载命令');
    assert.match(sql, /purge_expired_cloud_tombstones/, '应告知函数名');
  });

  it('清理函数是 SECURITY DEFINER 且钉了 search_path', () => {
    const sql = read('supabase/migrations/20261005000000b_purge_expired_tombstones.sql');
    assert.match(sql, /SECURITY DEFINER/, '调度器不是表 owner，需要 DEFINER 才能删到行');
    assert.match(
      sql,
      /SET search_path = public/,
      'SECURITY DEFINER 函数不钉 search_path 会被评为高危（可被临时 schema 劫持）'
    );
  });
});
