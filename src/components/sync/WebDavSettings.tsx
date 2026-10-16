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
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAppDispatch } from '@/store/hooks';
import { dispatchSaveSettings, updateSettings } from '@/store/slices/settingsSlice';
import { sendSyncCommand } from '@/shared/mutationProtocol';
import { useToast } from '@/contexts/ToastContext';
import {
  clearSessionSecrets,
  clearWebDavConfig,
  loadWebDavConfig,
  saveWebDavConfig,
  setSessionSecrets,
} from '@/sync-backend/webdav/config';
import { WebDavClient } from '@/sync-backend/webdav/client';
import { WebDavBackendAdapter } from '@/sync-backend/webdav/adapter';
import { chromeKvAdapter } from '@/sync-backend/webdav/config';
import { invalidateActiveSyncBackend, primeSyncBackend } from '@/sync-backend';
import { ensureHostPermission, PERMISSION_DENIED_MESSAGE } from '@/sync-backend/webdav/permission';
import {
  countActive,
  decideFirstSync,
  previewOutcome,
  projectedCloudCount,
  isFirstPushBusy,
  type OwnershipChoice,
} from '@/sync-backend/webdav/firstSyncDecision';
import { storage } from '@/utils/storage';
import type { TabGroup } from '@/types/tab';
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
  'w-full theme-radius-input-sm theme-bg-elevated border theme-border-default px-2.5 py-2 text-sm ' +
  'theme-focus text-gray-800 placeholder-gray-400 ' +
  'dark:text-gray-100 min-h-[2.5rem]';
const labelCls = 'mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300';
const btnPrimary =
  'btn btn-primary theme-radius-input-sm px-3 py-2 text-xs font-medium disabled:opacity-50 min-h-[2.5rem]';
const btnGhost =
  'rounded-md border theme-border-default px-3 py-2 text-xs font-medium text-gray-700 theme-btn-hover min-h-[2.5rem] ' +
  'dark:text-gray-200';

/**
 * 坚果云模板地址（2026-10-16）。
 *
 * 为什么做成**首屏值**而不只是 placeholder：placeholder 在 focus 时就消失，
 * 用户得先去别处查地址再回来抄；实值则是「填好即对」—— 坚果云是内置
 * 自带存储适配器（permission.ts）最先支持、文档里唯一举例的服务商，
 * 绝大多数用户点进这一页就是要用它。
 *
 * ⚠️ 它**只对从未配过的用户**生效：已存过配置的 loadWebDavConfig() 返回真值
 * 时会覆写 baseUrl，绝不覆盖用户自己的地址（否则每次开页都把自建
 * Nextcloud 的地址刷成坚果云 —— 那是一次静默改用户配置）。
 */
const JIANGUOYUN_TEMPLATE_URL = 'https://dav.jianguoyun.com/dav/';

export const WebDavSettings: React.FC = () => {
  const dispatch = useAppDispatch();
  // 2026-10-16：删掉了 `const settings = useAppSelector(s => s.settings)`。
  //   它只被两处 syncBackend === 'webdav' 的分支用到，那两个分支已随
  //   「切回 TapStack 云端」一同删除。现在这个面板**不再读** settings——
  //   这是一个刻意的取舍：真值在 sync-backend/解析层，不在 UI 的副本里。
  // useToast() 返回的是**对象**（{ showToast, showConfirm, showAlert }），
  // 不是函数本身。写成 `const showToast = useToast()` 会得到
  // 「This expression is not callable」—— 类型系统当场抓住的错。
  const { showToast } = useToast();

  const [baseUrl, setBaseUrl] = useState(JIANGUOYUN_TEMPLATE_URL);
  const [username, setUsername] = useState('');
  const [rootPath, setRootPath] = useState('TapStack');
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [encryption, setEncryption] = useState<'required' | 'plain'>('required');
  const [loaded, setLoaded] = useState(false);
  const [check, setCheck] = useState<CheckState>({ kind: 'idle' });
  const [saving, setSaving] = useState(false);
  /**
   * 首次推送状态（2026-10-15）。
   *
   * ⚠️ 为什么必须有这个入口：切换到自带存储时，本地通常已有数据，
   * 而上传由 `pending_upload` 驱动 —— 那个标志只在**数据变更**时置位，
   * 「配好 WebDAV」本身不是变更，于是**永远不触发上传**。
   * 实测后果：配完直接走人 ⇒ 数据出不了本机，换设备即全部丢失；
   * 而「配完顺手保存了一个会话」会因保存动作 scheduleUpload 而碰巧推上去
   *（TabManager.ts:157），把这个缺陷完全掩盖住。
   */
  const [firstPush, setFirstPush] = useState<
    | { kind: 'idle' }
    | { kind: 'probing' }
    | { kind: 'pushing' }
    /** 从云端下载中（Wave 2A：新设备取回数据的唯一面板入口）。 */
    | { kind: 'pulling' }
    | { kind: 'done'; message: string }
    /** 本机 0 个会话：不能再推送，但要告诉用户云端有多少、怎么下载。 */
    | { kind: 'nothing-local'; remoteCount: number }
    /** 需要用户显式选择归属方式（远端已有数据）。 */
    | { kind: 'choose'; localCount: number; remoteCount: number; localGroups: TabGroup[]; remoteGroups: TabGroup[] }
    | { kind: 'blocked'; reason: string }
  >({ kind: 'idle' });

  /**
   * 推送在途的**同步**闸门（2026-10-16 审查 L5）。
   *
   * 为什么不能只靠 `firstPush.kind === 'pushing'` 禁用按钮：choose 态下
   * 三个选择按钮都是可点的，连点两个选择时第二个点击发生在 React 刷新
   * 禁用态之前，state 还是 'choose' —— 两次 runPush 都会放行，发两次
   * upload，第二次拿到 already_syncing，用户看到一条与事实不符的
   * 「推送失败」而第一次其实已经成功。ref 的读写是同步的，连点窗口内
   * 第二次调用直接返回。
   */
  const pushInFlightRef = useRef(false);

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
      // 口令只给本次浏览器会话用（内存 + chrome.storage.session，不写磁盘）：
      // 关闭浏览器后需要重新输入。session 存储三端共享，SW 的定时同步也能用。
      await setSessionSecrets(username, password, encryption === 'required' ? passphrase || null : null);

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

  /**
   * 探测远端状态并决定下一步（2026-10-15）。
   *
   * 刻意**不自动上传**：远端可能有用户以前的数据或别的设备的数据。
   * 先探测、再让用户选，是唯一不丢数据的顺序。
   */
  const probeRemote = useCallback(async (): Promise<
    | { ok: true; decision: ReturnType<typeof decideFirstSync>; localGroups: TabGroup[]; remoteGroups: TabGroup[] | null }
    | { ok: false; reason: string }
  > => {
    if (!baseUrl || !username || !password) {
      return { ok: false, reason: '请先填写地址、账号与密码。' };
    }
    // 探测也要在权限就绪之后，否则 fetch 会被浏览器本地拦掉，
    // 表现出来的是「读不到云端」而不是「没授权」。
    const permitted = await ensureHostPermission(baseUrl, { request: true });
    if (!permitted) return { ok: false, reason: PERMISSION_DENIED_MESSAGE };

    // 读真值：这里要做「把本地推上去还是合并」的决策，
    // 30s 缓存里的旧快照会让数字与实际不符（syncPreview.ts 同一纪律）。
    const localGroups = await storage.getGroupsForWrite();

    try {
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
      const remoteGroups = await adapter.downloadGroups();
      return { ok: true, decision: decideFirstSync({ localGroups, remoteGroups }), localGroups, remoteGroups };
    } catch (err) {
      // 探测失败一律 blocked：绝不把「不知道」当成「空」。
      return {
        ok: false,
        reason:
          (err instanceof Error ? err.message : String(err)) ||
          '无法读取云端状态，已中止以免覆盖云端上已有的数据。',
      };
    }
  }, [baseUrl, username, password, rootPath, passphrase, encryption]);

  /** 「检查并推送」的入口按钮。 */
  const handleFirstPush = useCallback(async () => {
    setFirstPush({ kind: 'probing' });
    const probed = await probeRemote();
    if (!probed.ok) {
      setFirstPush({ kind: 'blocked', reason: probed.reason });
      return;
    }
    const { decision, localGroups, remoteGroups } = probed;
    switch (decision.action) {
      case 'upload-all':
        setFirstPush({ kind: 'pushing' });
        await runPush('merge', localGroups, remoteGroups ?? []);
        return;
      case 'ask-user':
        setFirstPush({
          kind: 'choose',
          localCount: decision.localCount,
          remoteCount: decision.remoteCount,
          localGroups,
          remoteGroups: remoteGroups ?? [],
        });
        return;
      case 'nothing-to-do':
        // 2026-10-16（Wave 2A）：原先这里只有一句「本机还没有任何会话，无需推送。」
        // ——新设备配完云盘后到此就是死路，而工具栏的下载按钮是唯一能取回
        // 云端数据的入口（README：「下载默认手动」），面板里没有任何指向。
        // 现在把 remoteCount 带进状态，渲染时给出「从云端下载到本机」。
        setFirstPush({ kind: 'nothing-local', remoteCount: countActive(remoteGroups ?? []) });
        return;
      case 'blocked':
        setFirstPush({ kind: 'blocked', reason: decision.reason });
        return;
    }
  }, [probeRemote]);

  /**
   * 执行推送。
   *
   * ⚠️ 「以云端为准」的实现方式：先上传（把云端推上去或合并），
   *    再用 forceRemote 下载覆盖本地 —— 顺序不能反。
   *    反过来做（先下载覆盖）会在上传前就把本地数据冲掉，不可逆。
   */
  const runPush = useCallback(
    async (choice: OwnershipChoice, localGroups: TabGroup[], remoteGroups: TabGroup[]) => {
      // 同步闸门（2026-10-16 审查 L5）：choose 态连点两个选择时，第二个
      // 点击早于 React 刷新禁用态，靠 kind==='pushing' 拦不住。ref 同步
      // 读取，在途时直接返回，不发第二次 upload（那次只会拿到
      // already_syncing，报一条与事实不符的失败）。
      if (pushInFlightRef.current) return;
      pushInFlightRef.current = true;
      setFirstPush({ kind: 'pushing' });
      try {
        // 合并与「以本地为准」都走上传；后者加 overwriteCloud 清掉云端多余会话。
        const isLocalWins = choice === 'local-wins';
        const res = await sendSyncCommand('upload', {
          overwriteCloud: isLocalWins,
          syncSettings: true,
          forcePending: true,
        });
        if (!res.ok) {
          setFirstPush({
            kind: 'blocked',
            reason: `推送失败：${res.error ?? '未知原因'}。本地数据未受影响。`,
          });
          return;
        }

        if (choice === 'cloud-wins') {
          const dl = await sendSyncCommand('download', { forceRemote: true, syncSettings: true });
          if (!dl.ok) {
            setFirstPush({
              kind: 'blocked',
              reason: `已保留云端数据，但把云端拉回本机失败：${dl.error ?? '未知原因'}。`,
            });
            return;
          }
        }

        const localActive = localGroups.filter(g => !g.isDeleted).length;
        // 事后计数必须用真实执行的算法（upsert 并集），不能用 previewOutcome
        // 的预览口径字段 —— 那是「选择本身」的规模，不是执行后的云端/本机数。
        // 旧文案用 p.localCount 报「已用云端数据替换本机 N 个」：当本机有新增
        // 会话时 N 会偏小（少了并集里本机独有的那部分）。
        const afterCloud = projectedCloudCount(localGroups, remoteGroups);
        setFirstPush({
          kind: 'done',
          message:
            choice === 'merge'
              ? `已把本机 ${localActive} 个会话推送到云端，云端现在共 ${afterCloud} 个会话（云端独有会话保留在云端，本机可用「从云端下载到本机」拉取）。`
              : choice === 'local-wins'
                ? `已用本机 ${localActive} 个会话覆盖云端同 id 的旧版本；云端现在共 ${afterCloud} 个会话，云端独有会话未被删除。`
                : `已把本机 ${localActive} 个会话并入云端，并从云端拉回 ${afterCloud} 个会话到本机。`,
        });
        showToast('推送完成', 'success');
      } catch (err) {
        setFirstPush({
          kind: 'blocked',
          reason: `推送失败：${err instanceof Error ? err.message : String(err)}。本地数据未受影响。`,
        });
      } finally {
        // 在途标志随本次推送终结释放（失败/ blocked 也释放：用户修正后可以重试）。
        pushInFlightRef.current = false;
      }
    },
    [showToast]
  );

  /**
   * 「从云端下载到本机」（Wave 2A）。
   *
   * ── 为什么面板必须自己有一条下载入口 ────────────────────────────
   * 新设备（本机 0 个会话）上，「检查并推送到云端」的答案是「无需推送」，
   * 而数据在云端。工具栏的下载按钮是唯一取回通道，但面板全程不指向它；
   * 用户配好后无处可去。这个入口复用同一套「先探测（拿真实数字）再确认」
   * 的流程，命令走 merge 下载（forceRemote:false）——非破坏性，不会删任何一端。
   */
  /**
   * 下载保护性跳过（reason 是机器码）的用户文案。
   * 与 SyncButton 的同名表有一小段重复；本次 Wave 中 SyncButton 属另一条 lane，
   * 不从这里去改它。重复的只有 4 条保护性原因码（锁定/网络错误都是人话直传）。
   */
  const downloadReasonCopy = useCallback((reason: string | undefined): string => {
    if (!reason) return '未知原因';
    const map: Record<string, string> = {
      already_syncing: '同步正在进行中，请稍候',
      recent_upload_guard: '刚完成上传，云端已是最新状态，无需下载',
      pending_upload_failed: '还有未上传的本地改动，已中止下载以免覆盖它们，请先完成上传',
      precheck_unknown: '本地存储读取失败，已中止同步以保护你的未上传内容，请稍后重试',
      snapshot_failed: '本地快照创建失败，已中止同步以保护现有数据',
    };
    return map[reason] ?? reason;
  }, []);

  const handlePullFromCloud = useCallback(async () => {
    const probed = await probeRemote();
    if (!probed.ok) {
      setFirstPush({ kind: 'blocked', reason: `无法读取云端状态：${probed.reason}` });
      return;
    }
    const remoteCount = countActive(probed.remoteGroups ?? []);
    const localCount = countActive(probed.localGroups);
    if (
      !window.confirm(
        `云端有 ${remoteCount} 个会话，本机有 ${localCount} 个。\n\n` +
          `下载会与本地合并（不会删除本机或云端的会话）。\n\n确定继续吗？`
      )
    ) {
      return;
    }
    setFirstPush({ kind: 'pulling' });
    const dl = await sendSyncCommand('download', { forceRemote: false, syncSettings: false });
    if (!dl.ok) {
      setFirstPush({
        kind: 'blocked',
        reason: `从云端下载失败：${downloadReasonCopy(dl.error)}。本机数据未受影响。`,
      });
      return;
    }
    setFirstPush({ kind: 'done', message: `已从云端下载并合并（云端 ${remoteCount} 个会话）。` });
    showToast('已从云端下载到本机', 'success');
  }, [probeRemote, showToast, downloadReasonCopy]);

  // 2026-10-16：原先这里有 handleSwitchBack（「切回 TapStack 云端」按钮）
  //   与 settings.syncBackend === 'webdav' 二分 banner。两者同批删除：
  //   云端后端已不存在，「切回去」无对象；而 syncBackend 只有 'webdav'
  //   一个合法值，那个条件恒为真，写成条件表达式只会让人误以为还有分支。

  const handleForget = useCallback(async () => {
    try {
      await clearWebDavConfig();
      // 配置清了，内存/会话里的口令必须一起清 —— 否则旧口令配新地址，
      // 下次同步报 401，用户完全看不出是配串了（见 config.ts 的注释）。
      // 不切后端：syncBackend 恒为 'webdav'，清除配置后解析会进入「锁定」态
      // 并明确提示去配置，绝不静默落到任何别的地方（那是 P0 修掉的失败模式）。
      await clearSessionSecrets();
      invalidateActiveSyncBackend();
      try {
        await primeSyncBackend();
      } catch (err) {
        logWarn('[WebDavSettings] 清除后重解析后端失败（下次启动自愈）:', err);
      }
      setBaseUrl(JIANGUOYUN_TEMPLATE_URL);
      setUsername('');
      setPassword('');
      setPassphrase('');
      setCheck({ kind: 'idle' });
      showToast('已清除本机保存的云服务信息与本次会话口令', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '清除失败', 'error');
    }
  }, [showToast]);

  // ── 锁定（2026-10-14 修 P0 时加）────────────────────────────────────────
  // 只清口令、不清地址：用户离开电脑前点一下，后台同步即停并明确提示未解锁，
  // 而不是拿旧口令继续传。invalidate 是关键 —— 不清 activeBackend 缓存的话，
  // 旧适配器里的 Vault（已派生的密钥）还会继续生效，「锁定」等于没锁。
  const handleLock = useCallback(async () => {
    try {
      await clearSessionSecrets();
      invalidateActiveSyncBackend();
      try {
        await primeSyncBackend();
      } catch (err) {
        logWarn('[WebDavSettings] 锁定后重解析后端失败（下次启动自愈）:', err);
      }
      setPassword('');
      setPassphrase('');
      showToast('已锁定：后台同步已停止，需要重新输入应用密码与加密口令才能继续', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '锁定失败', 'error');
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
        placeholder={JIANGUOYUN_TEMPLATE_URL}
        value={baseUrl}
        onChange={e => setBaseUrl(e.target.value)}
        disabled={!loaded}
      />
      <div className="mb-2 text-[11px] leading-relaxed text-gray-400 dark:text-gray-500">
        已预填坚果云地址，直接用即可。坚果云：账户信息 → 安全选项 → 第三方应用管理 → 添加应用密码。
        自建 Nextcloud 请把地址改成你的 WebDAV 根目录，必须以 <code>/</code> 结尾。
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
        <button type="button" className={btnGhost} onClick={handleForget}>
          清除配置
        </button>
        <button type="button" className={btnGhost} onClick={handleLock}>
          锁定
        </button>
      </div>

      {/* 2026-10-16：原先这里是
          `settings.syncBackend === 'webdav' ? 「已启用」 : 「当前仍在使用 TapStack 云端」`
          的二分 banner，以及下方首次推送区块同款条件。
          syncBackend 现在只有 'webdav' 一个合法值 ⇒ 两个分支恒相等 ⇒ 删除。
          「已启用」这句话没有对应分支可挂了：未配置/未解锁的真实状态由
          sync-backend 的锁定占位后端在**同步时报出来**（文案会原样进 toast），
          面板不再自己推测一个可能与实际不符的状态显示。 */}

      {/* ── 首次推送（2026-10-15）─────────────────────────────────────────
          为什么常驻而不是只在保存后弹一次：本地数据是持续产生的
          （新保存的会话），而「是否已把全部数据推上云」是一个会随时间
          变化的事实。用一个常驻入口 + 用户点了才探测，
          既不制造打扰，也不会出现「提示过了就以为再也不用管」。
          真正的自动推送由「保存会话 → scheduleUpload」负责（既有机制）。 */}
      <div className="mt-2 rounded-md border theme-border-default px-2 py-2">
          <div className="mb-1.5 text-xs font-medium text-gray-700 dark:text-gray-200">
            首次配置后需把本机会话推送到云端
          </div>
          <p className="mb-2 text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
            切换到自带存储不会自动上传已有会话。若不推送，这些会话只存在于这台设备上，
            换设备或换浏览器将无法找回。
          </p>
          <button
            type="button"
            className={btnPrimary}
            onClick={handleFirstPush}
            disabled={isFirstPushBusy(firstPush.kind)}
          >
            {firstPush.kind === 'probing'
              ? '检查中…'
              : firstPush.kind === 'pushing'
                ? '推送中…'
                : '检查并推送到云端'}
          </button>
          {/* Wave 2A：新设备的取数入口。与工具栏下载按钮同一命令（merge 下载，
              非破坏性），但放在面板里，否则「本机 0 个会话」的用户看不到任何
              取回云端数据的路径。 */}
          <button
            type="button"
            className={`mt-1.5 ${btnGhost}`}
            onClick={() => void handlePullFromCloud()}
            disabled={isFirstPushBusy(firstPush.kind)}
          >
            {firstPush.kind === 'pulling' ? '下载中…' : '从云端下载到本机'}
          </button>

          {firstPush.kind === 'done' ? (
            <div className="mt-2 rounded-md bg-emerald-50 px-2 py-1.5 text-xs text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
              {firstPush.message}
            </div>
          ) : null}

          {firstPush.kind === 'nothing-local' ? (
            <div className="mt-2 rounded-md bg-sky-50 px-2 py-1.5 text-xs text-sky-800 dark:bg-sky-900/30 dark:text-sky-200">
              {firstPush.remoteCount > 0
                ? `本机还没有任何会话，无需推送。云端已有 ${firstPush.remoteCount} 个会话，` +
                  '可点上方「从云端下载到本机」把它们取回本机。'
                : '本机与云端都还没有会话。保存一个会话后再回来推送即可。'}
            </div>
          ) : null}

          {firstPush.kind === 'blocked' ? (
            <div className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
              {firstPush.reason}
            </div>
          ) : null}

          {firstPush.kind === 'choose' ? (
            <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-2 dark:border-amber-700 dark:bg-amber-900/20">
              <div className="mb-1.5 text-xs font-medium text-amber-900 dark:text-amber-100">
                云端已经有 {firstPush.remoteCount} 个会话，本机有 {firstPush.localCount} 个
              </div>
              <p className="mb-2 text-[11px] leading-relaxed text-amber-800 dark:text-amber-200">
                请选择数据归属方式。三种方式都不会删除另一方的会话；
                只有「以本机为准」会用本机版本覆盖云端同 id 的旧版本，那一刻的旧内容无法恢复。
              </p>
              <div className="flex flex-col gap-1.5">
                {(
                  [
                    ['merge', '合并（推荐）', previewOutcome(firstPush.localGroups, firstPush.remoteGroups, 'merge').hint],
                    ['local-wins', '以本机为准', previewOutcome(firstPush.localGroups, firstPush.remoteGroups, 'local-wins').hint],
                    ['cloud-wins', '以云端为准', previewOutcome(firstPush.localGroups, firstPush.remoteGroups, 'cloud-wins').hint],
                  ] as const
                ).map(([choice, label, hint]) => (
                  <button
                    key={choice}
                    type="button"
                    className={btnGhost}
                    onClick={() => {
                      const d = previewOutcome(firstPush.localGroups, firstPush.remoteGroups, choice);
                      // 只有真的存在不可恢复后果（warning）才二次确认；
                      // 「以云端为准」的 warning 现在说明的是「不会丢数据」，
                      // 但同 id 的旧版本仍不可恢复，所以保留确认。
                      if (choice !== 'merge' && d.warning) {
                        if (!window.confirm(`${label}\n\n${d.warning}\n\n确定继续吗？`)) return;
                      }
                      void runPush(choice, firstPush.localGroups, firstPush.remoteGroups);
                    }}
                  >
                    <span className="block text-left">
                      <span className="block font-medium">{label}</span>
                      <span className="block text-[11px] opacity-75">{hint}</span>
                    </span>
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="mt-2 text-[11px] underline opacity-70"
                onClick={() => setFirstPush({ kind: 'idle' })}
              >
                暂不处理
              </button>
            </div>
          ) : null}
        </div>

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

