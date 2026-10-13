/**
 * 「自带存储（WebDAV）」配置面板（2026-10-13，阶段 3）。
 *
 * ── 为什么单独一个组件而不是塞进 HeaderDropdown ──────────────────────────
 * HeaderDropdown 已经 958 行、混着布局/主题/通知/同步四组逻辑。往里再塞
 * 一个「填地址 + 账号 + 口令 + 测试连接」的多段表单，等于把两种形态完全
 * 不同的东西（一个开关行 vs 一个表单）混进同一层级。
 *
 * ── 这个面板要解决的核心问题：让「为什么没生效」看得见 ─────────────────
 * WebDAV 模式下有四种「配了但没生效」，每种的用户下一步都不同：
 *
 * | 状态 | 用户看到的 | 他该做什么 |
 * |---|---|---|
 * | 没填地址 | 明确提示「还没配置」 | 去填 |
 * | 填了但没解锁 | 「需要重新输入应用密码」 | 输入密码 |
 * | 服务端不支持条件写 | 「两台设备同时编辑同一会话可能互相覆盖」 | 知悉即可 |
 * | 一切正常 | 「连接正常，已找到 N 个会话」 | 无 |
 *
 * 这四条都是**静默失败**的变体：不显示它们，用户只会看到「同步没反应」，
 * 而他真正需要的动作（输密码 / 填地址）完全无从推断。
 *
 * ── 诚实度纪律 ──────────────────────────────────────────────────────────
 * 面板里的每一句话都必须等于真实行为：
 *   · 不写「数据加密存储」而写「离开浏览器前加密」——后者才是真的；
 *   · 口令**无法找回**（没有找回入口，就必须提前说）；
 *   · 「应用密码」是各服务商第三方应用专用密码，不是账号登录密码；
 *   · manifest 明文 ⇒ 会话数量与修改时间对云盘可见，必须告知。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { dispatchSaveSettings, updateSettings } from '@/store/slices/settingsSlice';
import { sendSyncCommand } from '@/shared/mutationProtocol';
import { useToast } from '@/contexts/ToastContext';
import {
  clearWebDavConfig,
  loadWebDavConfig,
  saveWebDavConfig,
  setSessionSecrets,
} from '@/sync-backend/webdav/config';
import { WebDavClient } from '@/sync-backend/webdav/client';
import { WebDavBackendAdapter } from '@/sync-backend/webdav/adapter';
import { chromeKvAdapter } from '@/sync-backend/webdav/config';
import { primeSyncBackend } from '@/sync-backend';
import { ensureHostPermission, PERMISSION_DENIED_MESSAGE } from '@/sync-backend/webdav/permission';
import { logWarn } from '@/utils/log';

type CheckState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | {
      kind: 'done';
      ok: boolean;
      groups: number;
      conditionalWrites: boolean;
      message?: string;
    };

const inputCls =
  'w-full rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-800 ' +
  'placeholder-gray-400 focus:border-blue-500 focus:outline-none ' +
  'dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100';
const labelCls = 'mb-1 block text-xs text-gray-600 dark:text-gray-300';
const btnPrimary =
  'rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50';
const btnGhost =
  'rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 ' +
  'dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700';

export const WebDavSettings: React.FC = () => {
  const dispatch = useAppDispatch();
  const settings = useAppSelector(s => s.settings);
  // useToast() 返回的是**对象**（{ showToast, showConfirm, showAlert }），
  // 不是函数本身。写成 `const showToast = useToast()` 会得到
  // 「This expression is not callable」—— 类型系统当场抓住的错。
  const { showToast } = useToast();

  const [baseUrl, setBaseUrl] = useState('');
  const [username, setUsername] = useState('');
  const [rootPath, setRootPath] = useState('TapStack');
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [encryption, setEncryption] = useState<'required' | 'plain'>('required');
  const [loaded, setLoaded] = useState(false);
  const [check, setCheck] = useState<CheckState>({ kind: 'idle' });
  const [saving, setSaving] = useState(false);

  // 首屏读一次已保存的配置（只读地址/账号/目录；口令从不落盘，读不到是正常的）。
  useEffect(() => {
    let alive = true;
    loadWebDavConfig()
      .then(cfg => {
        if (!alive || !cfg) return;
        setBaseUrl(cfg.baseUrl);
        setUsername(cfg.username);
        setRootPath(cfg.rootPath);
        setEncryption(cfg.encryption);
      })
      .catch(() => undefined)
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, []);

  /**
   * 测试连接。
   *
   * 刻意**不做**「静默探活」：每次打开面板就打云盘既费流量也可能触发
   * 服务端的频率限制（坚果云 600 次/30 分钟）。用户点了才测，测了给结论。
   */
  const handleTest = useCallback(async () => {
    if (!baseUrl || !username || !password) {
      setCheck({
        kind: 'done',
        ok: false,
        groups: 0,
        conditionalWrites: false,
        message: '请先填写地址、账号与密码。',
      });
      return;
    }
    setCheck({ kind: 'checking' });
    try {
      // ⚠️ 必须先拿到主机权限，否则 fetch 会被浏览器**在本地拦下**，
      // 表现成「连接失败」——而用户完全看不出原因是「没给权限」。
      // request 必须发生在用户手势里，这里正是按钮点击的回调。
      const permitted = await ensureHostPermission(baseUrl, { request: true });
      if (!permitted) {
        setCheck({
          kind: 'done',
          ok: false,
          groups: 0,
          conditionalWrites: false,
          message: PERMISSION_DENIED_MESSAGE,
        });
        return;
      }
      const client = new WebDavClient({ baseUrl, username, password });
      const adapter = new WebDavBackendAdapter({
        client,
        config: {
          baseUrl,
          username,
          password,
          rootPath,
          passphrase: encryption === 'required' ? passphrase || null : null,
          requireEncryption: encryption === 'required',
        },
        kv: chromeKvAdapter,
      });
      const info = await adapter.checkConnection();
      setCheck({
        kind: 'done',
        ok: true,
        groups: info.groups,
        conditionalWrites: info.conditionalWrites,
      });
    } catch (err) {
      setCheck({
        kind: 'done',
        ok: false,
        groups: 0,
        conditionalWrites: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [baseUrl, username, password, rootPath, passphrase, encryption]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      if (!baseUrl || !username) {
        showToast('地址与账号不能为空', 'error');
        return;
      }
      await saveWebDavConfig({ baseUrl, username, rootPath, encryption });
      // 口令只在内存里给本次会话用：SW 被回收后需要重新输入。
      setSessionSecrets(username, password, encryption === 'required' ? passphrase || null : null);

      dispatch(updateSettings({ syncBackend: 'webdav' }));
      const saveError = await dispatchSaveSettings(dispatch);
      if (saveError) {
        showToast(`${saveError}（同步方式未保存）`, 'error');
        return;
      }

      // 立刻重建 alarm + 重解析后端，否则「保存了却要等 SW 重启才生效」。
      try {
        await sendSyncCommand('resyncAlarm');
        await primeSyncBackend();
      } catch (err) {
        logWarn('[WebDavSettings] 重建 alarm / 重解析后端失败（下次启动自愈）:', err);
      }
      showToast('已保存，同步方式已切换为「自带存储」', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '保存失败', 'error');
    } finally {
      setSaving(false);
    }
  }, [
    baseUrl,
    username,
    rootPath,
    encryption,
    password,
    passphrase,
    dispatch,
    showToast,
  ]);

  const handleSwitchBack = useCallback(async () => {
    try {
      dispatch(updateSettings({ syncBackend: 'supabase', syncEnabled: false }));
      const saveError = await dispatchSaveSettings(dispatch);
      if (saveError) {
        showToast(`${saveError}（同步方式未保存）`, 'error');
        return;
      }
      try {
        await sendSyncCommand('resyncAlarm');
        await primeSyncBackend();
      } catch (err) {
        logWarn('[WebDavSettings] 重建 alarm 失败（下次启动自愈）:', err);
      }
      showToast('已切回 TapStack 云端。云盘上的文件不会被删除。', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '切换失败', 'error');
    }
  }, [dispatch, showToast]);

  const handleForget = useCallback(async () => {
    try {
      await clearWebDavConfig();
      setBaseUrl('');
      setUsername('');
      setPassword('');
      setPassphrase('');
      setCheck({ kind: 'idle' });
      showToast('已清除本机保存的云服务信息', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '清除失败', 'error');
    }
  }, [showToast]);

  return (
    <div className="px-3 py-2" data-testid="webdav-settings">
      <div className="mb-2 text-xs text-gray-500 dark:text-gray-400">
        数据存在你自己的云盘上，不经过 TapStack 服务器。
      </div>

      <label className={labelCls} htmlFor="webdav-url">
        WebDAV 地址
      </label>
      <input
        id="webdav-url"
        className={`${inputCls} mb-2`}
        placeholder="https://dav.jianguoyun.com/dav/"
        value={baseUrl}
        onChange={e => setBaseUrl(e.target.value)}
        disabled={!loaded}
      />
      <div className="mb-2 text-[11px] leading-relaxed text-gray-400 dark:text-gray-500">
        坚果云：账户信息 → 安全选项 → 第三方应用管理 → 添加应用密码，地址如上。
        自建 Nextcloud 填到你的 WebDAV 根目录，必须以 <code>/</code> 结尾。
      </div>

      <div className="mb-2 flex gap-2">
        <div className="flex-1">
          <label className={labelCls} htmlFor="webdav-user">
            账号
          </label>
          <input
            id="webdav-user"
            className={inputCls}
            value={username}
            onChange={e => setUsername(e.target.value)}
            disabled={!loaded}
          />
        </div>
        <div className="flex-1">
          <label className={labelCls} htmlFor="webdav-root">
            子目录
          </label>
          <input
            id="webdav-root"
            className={inputCls}
            value={rootPath}
            onChange={e => setRootPath(e.target.value)}
            disabled={!loaded}
          />
        </div>
      </div>

      <label className={labelCls} htmlFor="webdav-pass">
        应用密码
      </label>
      <input
        id="webdav-pass"
        type="password"
        className={`${inputCls} mb-1`}
        placeholder="仅本次使用，不会保存在本机"
        value={password}
        onChange={e => setPassword(e.target.value)}
        disabled={!loaded}
      />
      <div className="mb-2 text-[11px] text-gray-400 dark:text-gray-500">
        仅保存在内存中，关闭浏览器后需要重新输入。这是刻意的：磁盘上不留任何能解开数据的密钥。
      </div>

      <fieldset className="mb-2">
        <legend className={labelCls}>数据加密</legend>
        <label className="flex items-start gap-1.5 text-xs text-gray-600 dark:text-gray-300">
          <input
            type="radio"
            name="webdav-encryption"
            checked={encryption === 'required'}
            onChange={() => setEncryption('required')}
          />
          <span>加密（推荐）：离开浏览器前用口令加密，云盘上只有密文</span>
        </label>
        <label className="mt-1 flex items-start gap-1.5 text-xs text-gray-600 dark:text-gray-300">
          <input
            type="radio"
            name="webdav-encryption"
            checked={encryption === 'plain'}
            onChange={() => setEncryption('plain')}
          />
          <span>不加密：云盘服务商能看到会话名称与网址</span>
        </label>
        {encryption === 'required' ? (
          <>
            <input
              type="password"
              className={`${inputCls} mt-1.5`}
              placeholder="加密口令（无法找回，忘记将无法解密）"
              value={passphrase}
              onChange={e => setPassphrase(e.target.value)}
              disabled={!loaded}
            />
            <div className="mt-1 text-[11px] leading-relaxed text-amber-600 dark:text-amber-500">
              口令没有找回入口。请务必自己记牢 —— 忘记后云盘上的数据将无法解密，也没有我们能做的补救。
            </div>
          </>
        ) : null}
      </fieldset>

      <div className="mb-2 text-[11px] leading-relaxed text-gray-400 dark:text-gray-500">
        隐私说明：会话内容加密后存放，但目录清单文件（manifest）以明文记录「有多少个会话、
        各自在何时被修改」，云盘服务商能看到这些信息，但不包含会话名称与网址。
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" className={btnPrimary} onClick={handleTest} disabled={check.kind === 'checking'}>
          {check.kind === 'checking' ? '测试中…' : '测试连接'}
        </button>
        <button type="button" className={btnPrimary} onClick={handleSave} disabled={saving}>
          {saving ? '保存中…' : '保存并启用'}
        </button>
        <button type="button" className={btnGhost} onClick={handleSwitchBack}>
          切回 TapStack 云端
        </button>
        <button type="button" className={btnGhost} onClick={handleForget}>
          清除配置
        </button>
      </div>

      {settings.syncBackend === 'webdav' ? (
        <div className="mt-2 rounded-md bg-blue-50 px-2 py-1.5 text-xs text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
          已启用：数据同步到你自己的云盘。
        </div>
      ) : (
        <div className="mt-2 rounded-md bg-gray-100 px-2 py-1.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300">
          当前仍在使用 TapStack 云端。点「保存并启用」后切换。
        </div>
      )}

      {check.kind === 'done' ? (
        <div
          className={`mt-2 rounded-md px-2 py-1.5 text-xs ${
            check.ok
              ? 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300'
              : 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300'
          }`}
        >
          {check.ok ? (
            <>
              连接正常，云端已有 {check.groups} 个会话。
              {!check.conditionalWrites ? (
                <div className="mt-1 leading-relaxed">
                  注意：这个云盘不支持「写入前校验」，并发保护较弱。
                  两台设备在**同一瞬间**编辑同一个会话时可能互相覆盖；错峰使用不受影响。
                </div>
              ) : null}
            </>
          ) : (
            <>连接失败：{check.message ?? '未知原因'}</>
          )}
        </div>
      ) : null}
    </div>
  );
};

