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
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { dispatchReloadSettings, dispatchSaveSettings, updateSettings } from '@/store/slices/settingsSlice';
import { sendSyncCommand } from '@/shared/mutationProtocol';
import { useToast } from '@/contexts/ToastContext';
import {
  clearSessionSecrets,
  clearWebDavConfig,
  loadWebDavConfig,
  notifyWebDavConfigChanged,
  saveWebDavConfig,
  setSessionSecrets,
  WEBDAV_CONFIG_CHANGED_EVENT,
} from '@/sync-backend/webdav/config';
import { WebDavClient } from '@/sync-backend/webdav/client';
import { WebDavBackendAdapter } from '@/sync-backend/webdav/adapter';
import { chromeKvAdapter } from '@/sync-backend/webdav/config';
import { invalidateActiveSyncBackend, getLastBackendResolution, primeSyncBackend, readConfiguredBackendId } from '@/sync-backend';
import { ensureHostPermission, PERMISSION_DENIED_MESSAGE } from '@/sync-backend/webdav/permission';
import {
  countActive,
  countTombstones,
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
  // 2026-10-17（双模式适配）：恢复 `const settings = useAppSelector(s => s.settings)`。
  //
  // slim 删掉它的理由是「只被两处 syncBackend === 'webdav' 的分支用到，
  // 那两个分支已随『切回云端』一同删除，面板不再读 settings」—— 那在
  // WebDAV-only 分支上自洽。但本项目是双模式：syncBackend 仍有 'supabase'，
  // 那个 banner 是用户判断「数据现在传到哪」的唯一入口，必须读。
  //
  // 需要区分的是「读 UI 用的当前选择」和「权威后端状态」：
  //   · 本选择器读的是用户**选**了哪个后端 —— 用于显示，一致性要求低；
  //   · 真实的「配没配好 / 解锁没有」由 sync-backend 解析层在同步时报出。
  // 两者分工不变，slim 那条判断在它自己的边界内仍然成立。
  const settings = useAppSelector(s => s.settings);
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
    /** 需要用户显式选择归属方式（远端已有数据，或远端只有删除记录）。 */
    | {
        kind: 'choose';
        localCount: number;
        remoteCount: number;
        /**
         * 远端墓碑数（2026-10-18 P1#3）。
         * >0 表示「远端没有活跃会话，但有别的设备留下的删除记录」——
         * 这是必须让用户知情的一态，不能被 `remoteCount: 0` 掩盖成「云端是空的」。
         */
        tombstoneCount?: number;
        localGroups: TabGroup[];
        remoteGroups: TabGroup[];
      }
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

  // ─────────────────────────────────────────────────────────────────────
  // 首次推送的后端前提（2026-10-18 P0#1）
  //
  // 【为什么这是 P0】本区块原先**无条件渲染**，而 `sendSyncCommand('upload')`
  // 执行时用的是**已持久化的后端**（service-worker → syncEngine 解析后端），
  // 与「你在表单里刚填了什么」无关。runPush 只带 overwriteCloud，不带地址。
  //
  // 于是有一条真实的删数据路径：
  //   填好 WebDAV 地址 → 忘了点「保存并启用」→ 点「以本机为准」
  //   → 生效后端仍是默认的 supabase → upload.ts 的 overwriteCloud 分支
  //     先 `delete().eq('user_id', userId)` 删光该账号全部行，再插入本机数据。
  // 无回收站，不可逆。而同一区块的文案还承诺「三种方式都不会删除另一方的会话」。
  //
  // 【为什么做两层】UI 条件会被未来的重构绕过（条件一多就有人漏看），
  // 执行侧才是最后一道闸。P0 级缺陷不允许只有一层。
  //
  // 【判据为什么是 resolvedId】`settings.syncBackend` 只是用户**选**了哪个，
  // 而「真正会写到哪里」由解析层决定。两者的差集正是这条 P0 的窗口。
  // ─────────────────────────────────────────────────────────────────────
  const [resolvedBackend, setResolvedBackend] = useState<'supabase' | 'webdav' | null>(null);
  useEffect(() => {
    let alive = true;
    const reprime = async () => {
      try {
        await primeSyncBackend();
        if (!alive) return;
        setResolvedBackend(getLastBackendResolution()?.resolvedId ?? null);
      } catch {
        if (alive) setResolvedBackend(null);
      }
    };
    void reprime();
    // P2-4：保存 / 锁定 / 清除配置后，本组件的推送区块可用性也必须跟着变。
    // 事件由本组件自己的 handler 派发，这里只订阅（同一窗口内的往返）。
    window.addEventListener(WEBDAV_CONFIG_CHANGED_EVENT, reprime);
    return () => {
      alive = false;
      window.removeEventListener(WEBDAV_CONFIG_CHANGED_EVENT, reprime);
    };
  }, [settings.syncBackend]);

  /**
   * 首次推送不可以发起时的原因；`null` 表示**可以**发起。
   *
   * 两条都要满足：
   *   1. 用户选择的同步方式是自带存储（否则那个区块在讲一个不生效的动作）；
   *   2. **真正生效的后端**已解析为 webdav（表单填了 ≠ 已保存生效）。
   *
   * 为什么第 2 条不能用「已保存配置」判断：配置保存了但
   * settings.syncBackend 仍是 supabase 时，同样会走错后端。判据必须是
   * 「解析结果」，那是 syncEngine 真正会用的那一个。
   *
   * 单一判据、单一出口：不给「能不能点」和「为什么不能点」各留一份真值，
   * 否则将来改一处就会让提示与实际按钮状态对不上（这正是 P0-3 的成因）。
   */
  const firstPushBlockedReason =
    settings.syncBackend !== 'webdav'
      ? '当前生效的同步方式不是「自带存储」。请先点上方「保存并启用」，让它真正生效后再推送已有会话。'
      : resolvedBackend !== 'webdav'
        ? '自带存储尚未生效（可能配置未保存，或本次会话还没解锁）。请先完成「保存并启用」再推送。'
        : null;

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
      // ⚠️ 2026-10-18 P2-3：**先校验、后落盘**。
      // 原序是「先 saveWebDavConfig → 再 setSessionSecrets（口令为空则抛）」，
      // 于是口令校验失败时配置**已经写进磁盘**，而 toast 说「保存失败」——
      // 用户以为没保存，下次打开面板却看到旧地址已经填好了。
      // 校验必须在任何写入之前做完。
      if (encryption === 'required' && !passphrase.trim()) {
        showToast('选择了加密但没有填写加密口令，未保存任何改动。', 'error');
        return;
      }

      // 2026-10-18 P2-3：读旧值必须在 dispatch **之前**。
      // 原先在 dispatch 之后读 settings.syncBackend，读到的已是新值 ⇒
      // 「是不是首次切换」永远算错。
      const wasWebdav = settings.syncBackend === 'webdav';

      await saveWebDavConfig({ baseUrl, username, rootPath, encryption });
      // 口令只给本次浏览器会话用（内存 + chrome.storage.session，不写磁盘）：
      // 关闭浏览器后需要重新输入。session 存储三端共享，SW 的定时同步也能用。
      await setSessionSecrets(username, password, encryption === 'required' ? passphrase || null : null);

      dispatch(updateSettings({ syncBackend: 'webdav' }));
      const saveError = await dispatchSaveSettings(dispatch);
      if (saveError) {
        // P2-3：必须把 Redux 收回磁盘真值。对照 OptionsPage.handleSelectBackend
        // 的既有写法（记 prevBackend → 失败时回滚）。不回滚的话界面显示
        // 「已切到自带存储」而磁盘仍是云端，数据会流向用户以为没在用的后端。
        dispatch(updateSettings({ syncBackend: wasWebdav ? 'webdav' : 'supabase' }));
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

      // ── 2026-10-18 P1#4：进入「归属待决」状态 ────────────────────────────
      // 自带存储切过去这一刻，本地通常已有会话，而「它们归谁」是用户的决定。
      // 在他点「检查并推送」之前，自动上传必须被降级为增量（syncEngine 读本标志）。
      //
      // 为什么只在**切到 webdav** 时置位：已经在用自带存储的老用户重设密码
      // 时不该被重新拦住（那会让他们的同步莫名停摆，且没有任何提示）。
      if (!wasWebdav) {
        await storage.setFirstSyncPending(true);
      }

      // P2-4：保存后父页面（自动同步提示）与本组件（推送区块可用性）都要刷新
      notifyWebDavConfigChanged();

      showToast(
        wasWebdav
          ? '已保存'
          : '已保存，同步方式已切换为「自带存储」。别忘了点下方「检查并推送」把本机已有会话推上去。',
        'success'
      );
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
    settings.syncBackend,
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

    // ⚠️ 2026-10-18 P2-2：本地读取必须与网络读取**在同一个 try 内**。
    // 原先 `storage.getGroupsForWrite()` 写在 try 上面，于是它在存储读失败时
    // （配额满、无痕窗口、IndexedDB 被回收）直接 reject：
    //   · probeRemote 返回的是一个 rejected Promise，**不是** { ok:false }；
    //   · 调用方 await 时抛出 ⇒ handleFirstPush / handlePullFromCloud 没有
    //     catch ⇒ firstPush 永远停在 'probing' / 'pulling'，按钮永久禁用，
    //     用户只能刷新页面。
    // 「读不到本地」和「读不到云端」是同一类失败：都必须变成一句可读的话，
    // 而不是把 UI 卡在忙状态。
    try {
      // 读真值：这里要做「把本地推上去还是合并」的决策，
      // 30s 缓存里的旧快照会让数字与实际不符（syncPreview.ts 同一纪律）。
      const localGroups = await storage.getGroupsForWrite();

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
    // P2-2：任何抛出都必须落回一个可读状态，绝不能让 UI 停在 'probing'。
    // 判据用 try/catch 而非依赖 probeRemote 内部全包：未来有人往里加一段
    // 未包住的 await，这里就是最后一道兜底。
    let probed: Awaited<ReturnType<typeof probeRemote>>;
    try {
      probed = await probeRemote();
    } catch (err) {
      setFirstPush({
        kind: 'blocked',
        reason: `检查失败：${err instanceof Error ? err.message : String(err)}。请重试。`,
      });
      return;
    }
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
      case 'tombstones-only':
        // 2026-10-18 P1#3：远端只有墓碑 ≠ 远端为空。墓碑是别的设备发出的
        // 删除意图，直接 upload-all 会把那些会话重新推上去、撤销删除。
        // 这里复用 choose 态：把墓碑数与活跃数都摆给用户，由他决定。
        setFirstPush({
          kind: 'choose',
          localCount: decision.localCount,
          remoteCount: 0,
          tombstoneCount: decision.tombstoneCount,
          localGroups,
          remoteGroups: remoteGroups ?? [],
        });
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
        // ── 执行侧第二道闸（2026-10-18 P0#1）────────────────────────────
        // UI 的渲染前提只是提示，真正的闸门在这里：`upload` 走的是**已解析的**
        // 后端，若它不是 webdav，「以本机为准」的 overwriteCloud 会作用在
        // **别的后端**上（supabase 路径是先删光该账号全部行再插入）。
        //
        // 为什么必须在这里再查一遍：UI 条件会被重构绕过、也可能因时序而
        // 与执行瞬间不一致（用户点了「保存」但 Redux/settings 尚未落盘）。
        // 凡是「不可逆删除」的执行点，都要有自己的后端校验。
        const effective = await readConfiguredBackendId();
        if (effective !== 'webdav') {
          setFirstPush({
            kind: 'blocked',
            reason:
              '已中止：当前生效的同步方式不是「自带存储」，推送会作用在' +
              `${effective === 'supabase' ? ' TapStack 云端' : '未知后端'}` +
              '上而不是你的云盘。请先点「保存并启用」让它真正生效。' +
              '（本次未推送，本地与云端数据均未改动。）',
          });
          return;
        }

        // 合并与「以本地为准」都走上传；后者加 overwriteCloud 清掉云端多余会话。
        const isLocalWins = choice === 'local-wins';
        const res = await sendSyncCommand('upload', {
          overwriteCloud: isLocalWins,
          syncSettings: true,
          forcePending: true,
          // 2026-10-18 P1#4：这是**唯一**一处有资格声明「用户已确认归属」的
          // 上传。自动上传（scheduleUpload / 后台 alarm）不传，syncEngine 会
          // 据此把首次全量降级为增量。
          explicitFirstSync: true,
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
          // 本次下载带 syncSettings ⇒ SW 已把云端设置合并进存储，本页手里的
          // settings 成了旧值。不重读的话，用户接着在**这一页**改任一开关都会把
          // 旧设置整份写回（saveSettings 是盲写）并上传，刚拉下来的设置被回滚。
          // 与 popup 同步按钮同一口径（见 dispatchReloadSettings 注释）。
          const reloadError = await dispatchReloadSettings(dispatch);
          if (reloadError) {
            logWarn('以云端为准后重读设置失败:', reloadError);
            showToast('云端设置已生效，但本页没能重新读取；请重新打开设置页，期间先别改设置', 'warning');
          }
        }

        const localActive = localGroups.filter(g => !g.isDeleted).length;
        // 事后计数必须用真实执行的算法（upsert 并集），不能用 previewOutcome
        // 的预览口径字段 —— 那是「选择本身」的规模，不是执行后的云端/本机数。
        // 旧文案用 p.localCount 报「已用云端数据替换本机 N 个」：当本机有新增
        // 会话时 N 会偏小（少了并集里本机独有的那部分）。
        const afterCloud = projectedCloudCount(localGroups, remoteGroups);
        // 2026-10-18（后置-3）：**不报「已推送 N 个」**。
        // 原先报的是本地活跃数，而适配器在「同 id 且云端版本更新」时会认输跳过
        // （compareStamps），那部分并没有真的被推送 —— 于是「已推送 12 个」里
        // 可能有 3 个其实没动。用户拿这个数字对不上时会怀疑同步坏了。
        //
        // 为什么不去取真实的 writtenIds：那是 tombstone 维度（墓碑 id），
        // 与「活跃会话写了几个」不是同一口径，要报准得改 SyncBackendPort →
        // tabGroupSyncService → syncEngine → SW 协议四处签名。
        // 报一个说不准的数字，比多改四个签名更糟。改成只报可确证的事实：
        // 云端现在共多少个（本机持有云端全量视图，算得准）。
        setFirstPush({
          kind: 'done',
          message:
            choice === 'merge'
              ? `已把本机 ${localActive} 个会话合并到云端，云端现在共 ${afterCloud} 个会话（云端独有会话保留在云端，本机可用「从云端下载到本机」拉取）。`
              : choice === 'local-wins'
                ? `已用本机 ${localActive} 个会话覆盖云端同 id 的旧版本；云端现在共 ${afterCloud} 个会话，云端独有会话未被删除。`
                : `已把本机 ${localActive} 个会话并入云端，并从云端拉回 ${afterCloud} 个会话到本机。`,
        });
        showToast('推送完成', 'success');
        // 归属决策已完成（2026-10-18 P1#4）：解除自动上传的全量降级，
        // 此后保存会话恢复正常的增量同步。
        await storage.setFirstSyncPending(false);
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
    // P2-2：与 handleFirstPush 同理，probe 抛出会把 UI 卡在忙状态。
    let probed: Awaited<ReturnType<typeof probeRemote>>;
    try {
      probed = await probeRemote();
    } catch (err) {
      setFirstPush({
        kind: 'blocked',
        reason: `检查失败：${err instanceof Error ? err.message : String(err)}。请重试。`,
      });
      return;
    }
    if (!probed.ok) {
      setFirstPush({ kind: 'blocked', reason: `无法读取云端状态：${probed.reason}` });
      return;
    }
    const remoteActive = countActive(probed.remoteGroups ?? []);
    const remoteTombstones = countTombstones(probed.remoteGroups ?? []);
    const localCount = countActive(probed.localGroups);
    // 2026-10-18 P1#2：确认框原先只报活跃数并承诺「不会删除本机或云端的会话」，
    // 但 downloadAndMerge 会**服从云端墓碑** —— 云端只有墓碑时，确认框显示
    // 「云端有 0 个会话」，点下去本机对应会话却会消失。那不是文案瑕疵，
    // 是让用户在一个他不知道自己同意的删除操作上点了「确定」。
    // 现在把墓碑数一并摆出来，并只对「不删云端」这一半保留承诺。
    const remoteDesc =
      remoteTombstones > 0
        ? `云端有 ${remoteActive} 个会话，另有 ${remoteTombstones} 条删除记录`
        : `云端有 ${remoteActive} 个会话`;
    const tombstoneWarning =
      remoteTombstones > 0
        ? `\n\n注意：云端有 ${remoteTombstones} 条删除记录，被其它设备删掉的会话，下载后本机也会移除。`
        : '';
    if (
      !window.confirm(
        `${remoteDesc}，本机有 ${localCount} 个。\n\n` +
          `下载会与本地合并，不会删除云端的会话。${tombstoneWarning}\n\n确定继续吗？`
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
    setFirstPush({
      kind: 'done',
      message:
        `已从云端下载并合并（云端 ${remoteActive} 个会话` +
        `${remoteTombstones > 0 ? `，并服从了 ${remoteTombstones} 条删除记录` : ''}）。`,
    });

    showToast('已从云端下载到本机', 'success');
    // 归属决策已完成：用户已把云端数据取回本机，此后自动上传恢复全量能力。
    await storage.setFirstSyncPending(false);
  }, [probeRemote, showToast, downloadReasonCopy]);

  // 2026-10-17（双模式适配）：恢复 slim 分支删掉的「切回 TapStack 云端」。
  //
  // slim 删它的理由是「云端后端已不存在，切回去无对象」—— 那在 WebDAV-only
  // 分支上成立，但本项目**同时保留** TapStack 云端后端，所以它有真实对象。
  // 少了它，用户清空 WebDAV 配置后会被锁在 webdav 锁定态、以为同步整个坏了，
  // 而实际只差一步：切回云端。
  //
  // ⚠️ 顺带说清这条与 handleForget 的方向差别（别把两者混为一谈）：
  //   · handleSwitchBack 是**用户显式点击**要求切换 —— 显式意图，照做。
  //   · handleForget 只清配置，**不**动 syncBackend：清完若仍是 webdav 就进
  //     锁定态并明确提示去配置，绝不静默切回云端 —— 那正是 P0 修掉的失败
  //     模式（用户以为数据只在自己盘上，实际被传到 TapStack 云端）。
  // 「显式切换」与「隐式回落」是两件事，纪律就在这条线上。
  const handleSwitchBack = useCallback(async () => {
    try {
      dispatch(updateSettings({ syncBackend: 'supabase', syncEnabled: false }));
      const saveError = await dispatchSaveSettings(dispatch);
      if (saveError) {
        showToast(`${saveError}（同步方式未保存）`, 'error');
        return;
      }
      // 2026-10-18（后置-2）：切走时一并清掉本次会话的 WebDAV 口令。
      // 不清的后果：用户过几天又切回自带存储，旧的（可能已轮换的）应用密码
      // 仍留在 chrome.storage.session 里，被自动当成有效凭据使用 ——
      // 而他可能已经在服务商那边改过密码，届时报的是 401，
      // 与「密码填错」完全不同的现象，极难自查。
      // 口令本就不落盘（只在 session），所以这是唯一的清理时机。
      await clearSessionSecrets();
      try {
        await sendSyncCommand('resyncAlarm');
        await primeSyncBackend();
      } catch (err) {
        logWarn('[WebDavSettings] 重建 alarm 失败（下次启动自愈）:', err);
      }
      // P2-4：通知父页面刷新自动同步提示（切回云端后「已配置并解锁」不再成立）
      notifyWebDavConfigChanged();
      showToast('已切回 TapStack 云端。云盘上的文件不会被删除。', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '切换失败', 'error');
    }
  }, [dispatch, showToast]);

  // 2026-10-17（双模式适配）：保留 slim 分支删掉的 handleSwitchBack
  //   ——「切回 TapStack 云端」按钮在 WebDAV-only 分支上确实无对象，
  //   但本项目同时保留 TapStack 云端后端（syncBackend 仍有 'supabase'），
  //   那个按钮有真实的切换对象。用户清空 WebDAV 配置后若仍被锁在
  //   webdav 上，会以为整个同步功能坏了；给一条回云端的路是必要的。
  //
  //   下面是 handleForget 的双模式语义（与 main 原版一致，slim 版把它
  //   改成了 WebDAV-only 措辞）：
  //   · syncBackend 仍是 webdav ⇒ 解析进入「锁定」态并明确提示去配置，
  //     **绝不静默切回 Supabase**（那正是 P0 修掉的失败模式：用户以为数据
  //     只在自己盘上，实际被传到 TapStack 云端）；
  //   · syncBackend 已是 supabase ⇒ 清除 WebDAV 配置本就不该影响它，
  //     解析会自然落回云端。

  const handleForget = useCallback(async () => {
    try {
      await clearWebDavConfig();
      // 配置清了，内存/会话里的口令必须一起清 —— 否则旧口令配新地址，
      // 下次同步报 401，用户完全看不出是配串了（见 config.ts 的注释）。
      // 不主动切后端：syncBackend 仍是 webdav 时解析会进入「锁定」态并明确
      // 提示去配置，绝不静默切回 Supabase（那是 P0 修掉的失败模式）；
      // 本来就是 supabase 的话，清 WebDAV 配置不影响它。
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
      // 2026-10-18（后置-2）：配置已清空，自动同步就没有可同步的对象了 ——
      // 留着它只会让 alarm 按档位反复醒来、每轮都撞上锁定占位后端。
      // B1 修好之后这不再表现为「静默停摆」（有一次性提醒、alarm 保持活着），
      // 但它仍是无意义的唤醒，且设置页会一直显示「已开启」。
      // 「关掉自动同步」是 fail-closed 方向的选择：宁可少同步，不可假装在同步。
      if (settings.syncEnabled) {
        dispatch(updateSettings({ syncEnabled: false }));
        await dispatchSaveSettings(dispatch);
      }
      // P2-4：清除配置后父页面的「已配置并解锁」必须失效
      notifyWebDavConfigChanged();
      showToast('已清除本机保存的云服务信息与本次会话口令，自动同步已关闭', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '清除失败', 'error');
    }
  }, [dispatch, showToast, settings.syncEnabled]);

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
      // P2-4：锁定后父页面的「已配置并解锁」必须失效
      notifyWebDavConfigChanged();
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
        <button type="button" className={btnGhost} onClick={handleSwitchBack}>
          切回 TapStack 云端
        </button>
        <button type="button" className={btnGhost} onClick={handleForget}>
          清除配置
        </button>
        <button type="button" className={btnGhost} onClick={handleLock}>
          锁定
        </button>
      </div>

      {/* 2026-10-17（双模式适配）：恢复 slim 分支删掉的二分 banner。
          slim 的理由是「syncBackend 只有 'webdav' 一个合法值 ⇒ 两个分支恒相等」，
          但本项目是**双模式**：syncBackend 仍有 'supabase'，两个分支真实存在，
          而且这条提示是用户判断「我的数据现在到底传到哪」的唯一入口 ——
          它不显示，「静默回落」类 P0 就没有用户可见的对应面了。

          ⚠️ 与后端解析的真实状态保持一致：这里只回答「选了哪个后端」，
          「配没配好 / 解锁没有」由 sync-backend 的锁定占位后端在同步时报出来
          （文案原样进 toast）—— 面板不自己推测一个可能与实际不符的状态。 */}
      {settings.syncBackend === 'webdav' ? (
        <div className="mt-2 rounded-md bg-blue-50 px-2 py-1.5 text-xs text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
          已启用：数据同步到你自己的云盘。
        </div>
      ) : (
        <div className="mt-2 rounded-md bg-gray-100 px-2 py-1.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300">
          当前仍在使用 TapStack 云端。点「保存并启用」后切换。
        </div>
      )}

      {/* slim 原注释（保留其对「谁负责报状态」的判断，措辞已按双模式更正）：
          slim 版注释——原先这里是
          `settings.syncBackend === 'webdav' ? 「已启用」 : 「当前仍在使用 TapStack 云端」`
          的二分 banner，以及下方首次推送区块同款条件。
          slim 版注释——syncBackend 现在只有 'webdav' 一个合法值 ⇒ 两个分支恒相等 ⇒ 删除。
          「已启用」这句话没有对应分支可挂了：未配置/未解锁的真实状态由
          sync-backend 的锁定占位后端在**同步时报出来**（文案会原样进 toast），
          面板不再自己推测一个可能与实际不符的状态显示。 */}

      {/* ── 首次推送（2026-10-15）─────────────────────────────────────────
          为什么常驻而不是只在保存后弹一次：本地数据是持续产生的
          （新保存的会话），而「是否已把全部数据推上云」是一个会随时间
          变化的事实。用一个常驻入口 + 用户点了才探测，
          既不制造打扰，也不会出现「提示过了就以为再也不用管」。
          真正的自动推送由「保存会话 → scheduleUpload」负责（既有机制）。

          ⚠️ 2026-10-18 P0#1：整个区块现在以「自带存储真正生效」为前提。
          原先无条件渲染，而上传走的是**已持久化的**后端 —— 用户填完表单
          没点「保存并启用」就点「以本机为准」，删除会作用在 TapStack 云端上
          （overwriteCloud 会先删光该账号全部行）。现在不满足前提时只显示
          一条可操作提示，不给可点的推送入口。
          runPush 内部还有第二道执行侧校验（纵深防御：UI 条件会被重构绕过）。 */}
      {firstPushBlockedReason ? (
        <div className="mt-2 rounded-md border theme-border-default px-2 py-2">
          <div className="mb-1.5 text-xs font-medium text-gray-700 dark:text-gray-200">
            推送已有会话
          </div>
          <p className="text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
            {firstPushBlockedReason}
          </p>
        </div>
      ) : (
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
                {firstPush.tombstoneCount ? (
                  // 2026-10-18 P1#3：这一态原先被显示成「云端已经有 0 个会话」，
                  // 用户完全看不出云端其实有删除记录。墓碑是别的设备的删除意图，
                  // 继续推送会撤销那些删除 —— 必须说出来。
                  <>
                    云端没有活跃会话，但有 {firstPush.tombstoneCount} 条删除记录；本机有{' '}
                    {firstPush.localCount} 个
                  </>
                ) : (
                  <>
                    云端已经有 {firstPush.remoteCount} 个会话，本机有 {firstPush.localCount} 个
                  </>
                )}
              </div>
              <p className="mb-2 text-[11px] leading-relaxed text-amber-800 dark:text-amber-200">
                {firstPush.tombstoneCount ? (
                  <>
                    云端这些会话已被其它设备删除。若继续推送本机版本，
                    <strong>会撤销那些删除、让已删的会话重新出现</strong>。
                    只上传新增会话、或先确认那些删除记录是否还需要，都由你决定。
                  </>
                ) : (
                  <>
                    请选择数据归属方式。三种方式都不会删除另一方的会话；
                    只有「以本机为准」会用本机版本覆盖云端同 id 的旧版本，那一刻的旧内容无法恢复。
                  </>
                )}
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

