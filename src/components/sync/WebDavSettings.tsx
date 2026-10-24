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
 *   · manifest 明文 ⇒ 会话数量、会话 id、是否已删除、操作印记（含设备编号）、
 *     加密 salt 对云盘可见，每个会话分片还有一段明文头部，必须告知；
 *   · 隐私说明必须**跟着加密开关走**（用户可以显式选「不加密」）——
 *     无条件说「加密后存放」就是在骗人。两套说法见 `webDavPrivacyCopy.ts`。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { dispatchReloadSettings, dispatchSaveSettings, updateSettings } from '@/store/slices/settingsSlice';
import { sendSyncCommand } from '@/shared/mutationProtocol';
import { useToast } from '@/contexts/ToastContext';
import {
  checkResultFromLastCheck,
  clearSessionSecrets,
  clearWebDavConfig,
  DEFAULT_ROOT,
  loadWebDavConfig,
  notifyWebDavConfigChanged,
  saveLastCheck,
  saveWebDavConfig,
  setSessionSecrets,
  validateWebDavForm,
  webdavFormMatchesSavedConfig,
  WEBDAV_CONFIG_CHANGED_EVENT,
  type StoredWebDavConfig,
} from '@/sync-backend/webdav/config';
import {
  clearFirstSyncPendingBestEffort,
  completeFirstSyncSuccess,
  countActive,
  countTombstones,
  decideFirstSync,
  isFirstPushBusy,
  ownershipPendingNotice,
  ownershipStatusUnreadableNotice,
  previewOutcome,
  projectedCloudCount,
  releaseFirstSyncPendingOnSaveFailure,
  runPullCommand,
  shouldEnterOwnershipPending,
  type OwnershipChoice,
} from '@/sync-backend/webdav/firstSyncDecision';
import { invalidateActiveSyncBackend, getLastBackendResolution, primeSyncBackend, readConfiguredBackendId } from '@/sync-backend';
import { ensureHostPermission, PERMISSION_DENIED_MESSAGE } from '@/sync-backend/webdav/permission';
import {
  buildProbeAdapterDeps,
  type WebDavProbe,
} from '@/sync-backend/webdav/factory';
import { loadWebDavTransport } from '@/sync-backend/webdavRuntime';
import {
  libraryScopeKey,
  NO_LIBRARY_SCOPE,
  sameLibrary,
} from '@/sync-backend/webdav/libraryIdentity';
import { storage } from '@/utils/storage';
import type { TabGroup } from '@/types/tab';
import { logWarn } from '@/utils/log';
import { classifyBackendResolution, type BackendStatusKind } from '@/components/layout/backendStatus';
import { webDavBannerKindOf, WEB_DAV_BANNER_COPY, WEB_DAV_BANNER_TONE, resolveSyncFailureCopy } from './syncPreviewView';
import { webDavEncryptionBoundaryNotice, webDavPrivacyNotice } from './webDavPrivacyCopy';
// 2026-10-24 审计 SEC-1：口令强度提示（只提示、不拦截 —— 门槛在适配器建库那一刻）。
import { PassphraseStrengthHint } from './PassphraseStrengthHint';

type CheckState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | {
      kind: 'done';
      ok: boolean;
      groups: number;
      conditionalWrites: boolean;
      message?: string;
      /**
       * 这条结论来自**上次**（已落盘的 lastCheck）而不是刚刚那一次点击。
       *
       * 为什么要区分（2026-10-18 A6）：不区分的话，重开页面看到绿灯的用户
       * 会以为「刚才已经验证过这个地址」。实际它可能是几天前另一个地址的结果，
       * 而面板全程不提 —— 那是又一个假绿灯。
       */
      fromStorage?: boolean;
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
/** 次级按钮（2026-10-19 审计 V-4）：描边 + 中性色。
 *  与主按钮的差别必须在**视觉层级**上看得出来，而不只是少一个实心底。 */
const btnSecondary =
  'rounded-md border theme-border-default theme-bg-elevated px-3 py-2 text-xs font-medium theme-text-secondary ' +
  'theme-btn-hover min-h-[2.5rem] disabled:opacity-50';

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

/**
 * 把纯函数的「写令牌」契约接到真实存储上（2026-10-18 A3/A4）。
 *
 * 判定与错误处理都在 `firstSyncDecision` 的三个纯函数里（可做行为断言）；
 * 这里只负责注入真实写入器与日志出口 —— 组件里不留第二份规则。
 *
 * ⚠️ 2026-10-20：写入**按库寻址**（scope = 目标库的身份串）。
 * 待决位的语义是「这些会话归**这个库**吗」—— 换云盘就是另一个库、
 * 另一个决定，所以标志必须跟着库走（见 `libraryIdentity.ts`）。
 *
 * ⚠️ 作用域是**显式传进来的**，不是隐式读全局：写方（设置页）知道自己
 * 正在处理**哪个库**（表单里的目标 / 磁盘上的当前），而读方（后台引擎）
 * 读的是「本机当前指向的库」。两边在**同一次保存**之后必须指向同一个库，
 * 而「保存」这件事会**改变**磁盘上的当前库 —— 所以写方必须显式说清
 * 「我写的是哪个库」，否则会出现「写到了旧库、读的是新库」的分叉。
 */
type FirstSyncPendingWriter = (pending: boolean) => Promise<void>;

/** 「本次置的位」在保存失败时的回滚（见 releaseFirstSyncPendingOnSaveFailure）。 */
async function releaseFirstSyncPendingIfSetHere(
  setHere: boolean,
  context: string,
  write: FirstSyncPendingWriter
): Promise<void> {
  await releaseFirstSyncPendingOnSaveFailure({
    setHere,
    write,
    onError: err =>
      logWarn(
        `[WebDavSettings] ${context}：清除待决标志失败。待决标志（webdav 首次归属决策未完成）` +
          '留着会把此后每一次自动上传降级为增量，历史会话将不再上传，请重新保存一次以重试:',
        err
      ),
  });
}

/** 归属已完成 / 后端已变时的无条件解除（见 clearFirstSyncPendingBestEffort 纯函数）。 */
async function clearPendingToken(context: string, write: FirstSyncPendingWriter): Promise<void> {
  await clearFirstSyncPendingBestEffort({
    write,
    onError: err =>
      logWarn(
        `[WebDavSettings] ${context}：解除归属待决标志失败（不影响本次结果）。` +
          '下次自动上传仍会按增量进行，重新推送或下载一次即可恢复:',
        err
      ),
  });
}

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
  // 2026-10-19 审计 V-4：清除配置是不可逆且影响后台行为的动作，需要 showConfirm。
  const { showToast, showConfirm } = useToast();

  const [baseUrl, setBaseUrl] = useState(JIANGUOYUN_TEMPLATE_URL);
  const [username, setUsername] = useState('');
  const [rootPath, setRootPath] = useState('TapStack');
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [encryption, setEncryption] = useState<'required' | 'plain'>('required');
  const [loaded, setLoaded] = useState(false);
  const [check, setCheck] = useState<CheckState>({ kind: 'idle' });
  /**
   * 磁盘上的那份配置（2026-10-18 A6）。
   *
   * 与四个表单字段分开存：表单是「用户正在输入的」，这份是「已落盘的」。
   * validateWebDavForm 用它选措辞（已按加密配置过的用户看到的是
   * 「云端库按加密配置，但本次没给口令」），而判定本身不依赖它。
   */
  const [savedCfg, setSavedCfg] = useState<StoredWebDavConfig | null>(null);
  /**
   * 磁盘上那份配置的**同步镜像**（2026-10-20）。
   *
   * 为什么需要 ref 而不是直接用 `savedCfg` state：作用域键要在**渲染期**
   * 同步算出来（`libraryScopeKey` 是纯函数），而 state 在渲染期读到的是
   * 上一次提交的值。ref 的写法保证读到的是**最新一次提交**的那份。
   *
   * 它与 `savedCfg` 永远是同一份内容（每次 setSavedCfg 都同步更新它），
   * 区别只在读的时候不触发 React 的重渲染。
   */
  const lastSavedConfigRef = useRef<StoredWebDavConfig | null>(null);
  // 同步写 ref（不只靠 useEffect）：保存配置后必须**立刻**让 ref 跟上 ——
  // 否则「归属决策完成」那条清除路径会写到**上一个库**的作用域上
  // （saveWebDavConfig 已经把磁盘上的当前库换掉了，而 ref 还指着旧的）。
  useEffect(() => {
    lastSavedConfigRef.current = savedCfg;
  }, [savedCfg]);

  /**
   * 「本机当前指向的库」的作用域键（**同步**，可在渲染期算）。
   *
   * 读的是**磁盘上已保存的配置**（`savedCfg` 就是它的镜像），不是表单里
   * 正在编辑的内容 —— 待决位的读取方（后台的 syncEngine）也在读磁盘，
   * 两边必须用同一份真值。拿表单值去比会得出「同一个库」的假结论
   * （表单被改成新地址时，表单 ≠ 磁盘 ⇒ 恰恰是**不同**的库）。
   */
  const currentScope = useCallback((): string => {
    const cfg = lastSavedConfigRef.current;
    return cfg ? libraryScopeKey(cfg) : NO_LIBRARY_SCOPE;
  }, []);

  /**
   * 待决位的写入器（绑定到**当前库**）。
   *
   * 「归属决策完成」与「后端/配置已变」这两条清除路径写的是**当前库**的
   * 作用域 —— 它们都在「本机还指着这个库」的时刻发生。
   * 「保存配置」那条置位路径写的是**目标库**的作用域（显式传入，
   * 见 handleSave）—— 因为保存动作本身会改变磁盘上的当前库。
   */
  const writeCurrentScope = useCallback(
    (pending: boolean): Promise<void> => storage.setFirstSyncPending(pending, currentScope()),
    [currentScope]
  );

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
  /**
   * 2026-10-18 C 组：banner 需要的是**完整**分类结果（含 lockedKind），
   * 仅 resolvedId 不够用 —— 后端对象造出来了不等于「已解锁」。
   * 复用 backendStatus.classifyBackendResolution，不在这里重写一份判定。
   * `null` = 尚未解析，banner 按「读不到」出口（不说「已启用」）。
   */
  const [backendKind, setBackendKind] = useState<BackendStatusKind | null>(null);
  useEffect(() => {
    let alive = true;
    const reprime = async () => {
      try {
        await primeSyncBackend();
        if (!alive) return;
        setResolvedBackend(getLastBackendResolution()?.resolvedId ?? null);
        setBackendKind(classifyBackendResolution(getLastBackendResolution()).kind);
      } catch {
        if (alive) {
          setResolvedBackend(null);
          setBackendKind('error');
        }
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
   * banner 的形态与色档（2026-10-18 C 组）。
   *
   * 尚未解析（backendKind === null）按 `unreadable` 出口：在拿到真实解析结果之前
   * 说「已启用」就是猜，而猜错的代价是用户以为数据正在上云。
   */
  const webdavBannerKind = webDavBannerKindOf(backendKind ?? 'unknown');

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

  /**
   * 「归属待决」状态（2026-10-20）。
   *
   * ── 为什么面板必须显示它 ────────────────────────────────────────────────
   * 待决期里，自动上传**只传本次改动过的会话**，历史会话被排除在外。
   * 于是用户会看到「本机有 N 个会话，云端只有刚改的那几个」——
   * 若面板对此**只字不提**，用户只会得出「同步坏了」的结论，
   * 而真正缺的是**一个决定**（这些会话归不归这个云盘）。
   *
   * 本仓的诚实度纪律是「界面说的每一句都必须等于真实行为」，
   * 所以这里必须说清三件事：**发生了什么**、**为什么**、**下一步做什么**
   * （见 `ownershipPendingNotice`）。
   */
  /**
   * 归属待决状态：**三态**。
   *
   * `true` = 待决；`false` = 不待决；**`null` = 读不到**。
   *
   * ⚠️ 为什么要有第三态（2026-10-23 审计 DS-4）：存储层对读失败**抛错**
   * （fail-closed：读不到 ≠ 没有待决 ⇒ 那一轮上传中止 ⇒ 历史会话不会被
   * 整批推上云）。界面若把读失败当成「不待决」，就会**沉默**：用户看到
   * 「一切正常」，而实际上传已停摆、且「为什么停」被藏起来 ——
   * 那正是本仓最恨的「界面不说的谎」。
   * ⇒ 读不到时显示**另一句**（说清「读不到 / 已暂停自动上传 / 刷新重试」）。
   */
  const [ownershipPending, setOwnershipPending] = useState<boolean | null>(false);
  /**
   * 本机**活跃**会话数（横幅里要如实报出「多少个会话被按住了」）。
   *
   * 为什么必须报真数：横幅若说「本机还有 0 个会话没传上去」，那是**谎话**
   * （而谎话正是本仓要消灭的那类缺陷）。读不到就报 `null`，
   * 横幅便**不报数字**（只说清机制与下一步），而不是编一个。
   */
  const [localActiveCount, setLocalActiveCount] = useState<number | null>(null);
  /** 读一次「本机当前指向的库」的待决状态（首屏 + 每次配置变化后刷新）。 */
  const refreshOwnershipPending = useCallback(async () => {
    try {
      setOwnershipPending(await storage.getFirstSyncPending());
    } catch (err) {
      // 读不到 ⇒ **第三态**（不是「没有待决」）。见上面那句注释。
      logWarn('[WebDavSettings] 读取归属待决状态失败（显示「读不到」提示）:', err);
      setOwnershipPending(null);
    }
    try {
      const groups = await storage.getGroups();
      setLocalActiveCount(groups.filter(g => !g.isDeleted).length);
    } catch (err) {
      // 读不到会话数 ⇒ 不报数字（横幅会省掉那句「N 个会话」）。
      logWarn('[WebDavSettings] 读取本机会话数失败（提示里不报数字）:', err);
      setLocalActiveCount(null);
    }
  }, []);
  useEffect(() => {
    void refreshOwnershipPending();
  }, [refreshOwnershipPending, savedCfg]);

  // 首屏读一次已保存的配置（只读地址/账号/目录；口令从不落盘，读不到是正常的）。
  //
  // 2026-10-18 A6：同时把上次「测试连接」的结果播种到 check —— 否则一次绿灯
  // 在每次重开页面时都会丢（`lastCheck` 存了却没人读，是死代码），用户只能
  // 反复重新测。播种仍受 `checkResultFromLastCheck` 的有效期约束：旧结果不播。
  useEffect(() => {
    let alive = true;
    loadWebDavConfig()
      .then(cfg => {
        if (!alive || !cfg) return;
        setSavedCfg(cfg);
        setBaseUrl(cfg.baseUrl);
        setUsername(cfg.username);
        setRootPath(cfg.rootPath);
        setEncryption(cfg.encryption);
        const seeded = checkResultFromLastCheck(cfg.lastCheck);
        if (seeded) {
          setCheck({
            kind: 'done',
            ok: seeded.ok,
            groups: seeded.groups,
            conditionalWrites: seeded.conditionalWrites,
            ...(seeded.message ? { message: seeded.message } : {}),
            fromStorage: true,
          });
        }
      })
      .catch(err => logWarn('[WebDavSettings] 读取已保存配置失败（表单停在模板值，不播种上次测试）:', err))
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, []);

  /**
   * 持久化一次「测试连接」的结果（fire-and-forget，2026-10-18 A6）。
   *
   * 失败只打日志：本次测试的结论已经真实发生了，存储写不进去不该把它报成
   * 「测试失败」—— 那会把一个成功的验证变成一条误导消息。
   */
  const persistLastCheck = useCallback(
    async (result: { ok: boolean; groups: number; conditionalWrites: boolean; message?: string }) => {
      await saveLastCheck({
        at: new Date().toISOString(),
        ok: result.ok,
        groups: result.groups,
        conditionalWrites: result.conditionalWrites,
        ...(result.message ? { message: result.message } : {}),
      });
      // 本组件手上的 savedCfg 也要跟上：validateWebDavForm 用它选措辞。
      const fresh = await loadWebDavConfig();
      if (fresh) setSavedCfg(fresh);
    },
    []
  );

  /**
   * 测试连接。
   *
   * 刻意**不做**「静默探活」：每次打开面板就打云盘既费流量也可能触发
   * 服务端的频率限制（坚果云 600 次/30 分钟）。用户点了才测，测了给结论。
   */
  const handleTest = useCallback(async () => {
    // 2026-10-18 A1：与 handleSave 共用同一份校验（见 validateWebDavForm 的注释）。
    // 原先这里只查「地址/账号/密码非空」，缺的正是**加密口令** —— 而 adapter 的
    // checkConnection 在远端还没有 manifest 时会提前返回，unlock() 一次都不会被调用，
    // 于是缺失的口令在「测试连接」这一步根本无从暴露，用户拿到一个假绿灯。
    const formCheck = validateWebDavForm({ baseUrl, username, password, encryption, passphrase }, savedCfg);
    if (!formCheck.ok) {
      setCheck({
        kind: 'done',
        ok: false,
        groups: 0,
        conditionalWrites: false,
        message: formCheck.message,
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
        // 2026-10-18 A6：这条也是「测试的结论」（没测成也是结论）。不写回的话，
        // 重开页面会把上一次的绿灯播种回来 —— 而用户刚刚才被拒过权限。
        persistLastCheck({
          ok: false,
          groups: 0,
          conditionalWrites: false,
          message: PERMISSION_DENIED_MESSAGE,
        }).catch(err => logWarn('[WebDavSettings] 记录测试连接结果失败（不影响本次结论）:', err));
        return;
      }
      // ⚠️ 2026-10-23 第 50 轮：适配器不再在这里现造 ——
      // 「测试连接」与「探测远端」共用同一个 `buildProbeAdapter`（见下），
      // 依赖（client / config / kv / 三项 seq 能力）由 webdav/factory.ts 装配。
      // 原来这两处各自抄了一份配置块，**且一份 seq 依赖都没给** ⇒ 适配器退回
      // 自带的兜底号位（与写作路径的计数器不共享）。今天只读所以没出事，
      // 一旦有人在这里加一次写操作，就落回 D-7 的缺陷形态。
      const adapter = await buildProbeAdapter({ baseUrl, username, password, rootPath, passphrase, encryption });
      const info = await adapter.checkConnection();
      setCheck({
        kind: 'done',
        ok: true,
        groups: info.groups,
        conditionalWrites: info.conditionalWrites,
      });
      // 2026-10-18 A6：绿灯要**活过重开页面**，否则本面板的诚实度纪律
      //（每句话都必须等于真实行为）在跨会话时就断了：用户上次看到「连接正常」，
      // 重开面板却什么都看不到，只能重新点一次测试。
      // fire-and-forget：这次测试本身已经成功了，落盘失败只影响下次开页的
      // 「上次结果」展示，不该把它报成「测试失败」（那是另一种谎）。
      persistLastCheck({ ok: true, groups: info.groups, conditionalWrites: info.conditionalWrites }).catch(err =>
        logWarn('[WebDavSettings] 记录测试连接结果失败（不影响本次结论）:', err)
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setCheck({
        kind: 'done',
        ok: false,
        groups: 0,
        conditionalWrites: false,
        message,
      });
      // 失败结论同样要持久化：否则「上次还是绿灯」会在重开后误导用户。
      persistLastCheck({ ok: false, groups: 0, conditionalWrites: false, message }).catch(logErr =>
        logWarn('[WebDavSettings] 记录测试连接结果失败（不影响本次结论）:', logErr)
      );
    }
  }, [baseUrl, username, password, rootPath, passphrase, encryption, savedCfg, persistLastCheck]);

  /**
   * 造一个**只读探针**适配器（设置页的两处入口共用：「测试连接」与「探测远端」）。
   *
   * ── 为什么是「只读」 ────────────────────────────────────────────────────
   * 这两处只做 `checkConnection()` 与 `downloadGroups()`，都是读。
   * 而它们过去是**靠调用方自觉**只读 —— 一旦有人在这里加一次写操作，
   * 就落回 D-7 的缺陷形态（墓碑号退化成「云端 seq + 1」⇒ 跨设备删除被静默撤销）。
   *
   * 现在有三道防线：
   *   1. **类型**：返回类型是 `WebDavProbe`（只有读方法）⇒ 编译期就调不到写方法；
   *   2. **运行时**：依赖里的 `readOnly: true` ⇒ 适配器的写方法直接抛错；
   *   3. **号位**：三项 seq 能力由 webdav/factory.ts 注入 ⇒ 即便将来有人
   *      在这条路径上加写操作，墓碑号也来自**本机 Lamport 时钟**，不是兜底号位。
   *
   * ── 为什么取法走注册表 ──────────────────────────────────────────────────
   * `loadWebDavTransport()` 是全仓取 WebDAV 传输栈的**唯一**入口
   * （页面动态 import / service worker 静态注册，见 sync-backend/webdavRuntime.ts）。
   * 这里原先是**直接静态 import** 实现 —— 于是全仓有第三条取法，
   * 维护者读 webdavRuntime.ts 会以为只有一条路。
   *
   * ⚠️ 代价：首次点「测试连接」时才下 ~149KB（adapter + client 源码）。
   * 这与「页面按需加载」的约定一致，可接受。
   */
  async function buildProbeAdapter(params: {
    baseUrl: string;
    username: string;
    password: string;
    rootPath: string;
    passphrase: string;
    encryption: 'required' | 'plain';
  }): Promise<WebDavProbe> {
    const { WebDavBackendAdapter } = await loadWebDavTransport();
    const adapter = new WebDavBackendAdapter(
      await buildProbeAdapterDeps({
        baseUrl: params.baseUrl,
        username: params.username,
        password: params.password,
        rootPath: params.rootPath,
        passphrase: params.passphrase || null,
        encryption: params.encryption,
      })
    );
    return adapter;
  }

  const handleSave = useCallback(async () => {
    setSaving(true);
    // 2026-10-18 A3：本次有没有**新置**待决位。失败回滚只看它 ——
    // 用户上轮就处于待决态时那个位是「真实未完成的归属决策」，退掉它会让
    // 历史会话在下一次自动上传时被整批推上云（比泄漏更糟）。
    let firstSyncPendingSetHere = false;
    // 待决位的写入器（绑定到**目标库**的作用域）。
    //
    // ⚠️ 声明在 try **外面**：catch 分支要拿它回滚本次置的位。
    // 作用域取**表单里的目标库**（这次保存要往哪儿传），而不是「写完之后
    // 磁盘上是谁」—— 保存动作本身会改变磁盘上的当前库，读-改-写的时序
    // 必须与「这一次保存的目标」一致，否则会出现「写到了旧库、读的是新库」。
    let writePending: FirstSyncPendingWriter = pending => storage.setFirstSyncPending(pending);
    try {
      // 2026-10-18 A1：校验抽成 validateWebDavForm，与 handleTest 共用一份。
      // ⚠️ 顺序逐字保留（round 32 修的「先校验后落盘」）：这一步仍然排在任何
      // 写入之前，只是判定与措辞搬到了纯函数里。三条判据（地址/账号、应用密码、
      // 加密口令）与它们的先后顺序都没变。
      const formCheck = validateWebDavForm({ baseUrl, username, password, encryption, passphrase }, savedCfg);
      if (!formCheck.ok) {
        showToast(formCheck.message, 'error');
        return;
      }
      // ⚠️ 2026-10-18 P2-3：**先校验、后落盘**。
      // 原序是「先 saveWebDavConfig → 再 setSessionSecrets（口令为空则抛）」，
      // 于是口令校验失败时配置**已经写进磁盘**，而 toast 说「保存失败」——
      // 用户以为没保存，下次打开面板却看到旧地址已经填好了。
      // 校验必须在任何写入之前做完。
      //
      // 2026-10-18 round 32：当初这段只覆盖了「加密口令」，漏了**应用密码**——
      // 它同样是 `setSessionSecrets` 抛错的来源（`webdav/config.ts` 的
      // `if (!password) throw new Error('应用密码不能为空')`）。于是「填了地址和账号、
      // 忘了填密码」这条最常见的漏填，仍然先落盘再报错：toast 说「应用密码不能为空」，
      // 用户重开面板却发现地址已经填好了，自相矛盾。密码只进浏览器会话内存、不进磁盘，
      // 所以它没有「先写后校验」的余地。
      //
      // 上述三条判据现在位于 validateWebDavForm（与 handleTest 共用一份），
      // 上面那次调用就是它们的落地点 —— 删那段旧代码没有放松任何一条。

      // 2026-10-18 P2-3：读旧值必须在 dispatch **之前**。
      // 原先在 dispatch 之后读 settings.syncBackend，读到的已是新值 ⇒
      // 「是不是首次切换」永远算错。
      const wasWebdav = settings.syncBackend === 'webdav';
      // 「本机此前配过哪个库」必须在 dispatch **之前**读：dispatch 之后读到的
      // 已是新值 ⇒ 「是不是首次切换」永远算错。
      //
      // 判据取**磁盘上已保存的配置**（库的身份），而不是「当前后端是不是 webdav」：
      // 用户在「同步方式」里先点一下「自带存储（WebDAV）」就会把 syncBackend
      // 置成 webdav（OptionsPage.handleSelectBackend 立即落盘），之后再点
      // 「保存并启用」时看后端就永远是「已经切过了」⇒ 待决标志一次都不会置位，
      // 整条「归属待决」保护形同虚设（round 30 真机实测：历史会话照样被自动推上云）。
      const savedBefore = await loadWebDavConfig();

      // ── 2026-10-20：判据从「配没配过」升级为「**库的身份变了没有**」──────
      // 旧判据（`!wasConfigured`）让「**换云盘**」与「**同一个云盘重设密码**」
      // 长得一模一样 —— 两者都是 `wasConfigured === true` ⇒ 两者都不置位。
      // 但它们的**后果完全不同**：重设密码还是同一个库，换云盘是**另一个库**
      // （那里存的是另一批会话，归属是**另一个决定**）。
      //
      // 后果（实测过的缺陷形态）：换到云盘 B 时，本机的历史会话被**全量推上 B**
      // （适配器见远端为空 ⇒ `firstSync = true` ⇒ 全量），而用户从来没有被
      // 问过「这些会话归 B 吗」—— 2026-10-18 P1#4 明令禁止的「多传」，不可回滚。
      //
      // 新的判据（三条都覆盖，且每条都有测试钉住）：
      //   · 从没配过 ⇒ 首次配置 ⇒ 置位（2026-10-18 真机实测的那条，别动）；
      //   · 配过、库的身份变了（地址/账号/目录任一变化）⇒ 换云盘 ⇒ **重新置位**；
      //   · 配过、库的身份没变 ⇒ 重设密码/改加密口令 ⇒ **不**重新置位
      //     （拦了会让同步莫名停摆且零提示 —— 那是老用户重设密码的既有行为）。
      //
      // 口径与同步水位线一致（`baseUrl | username | rootPath` 三者任一变化都
      // 意味着「另一个库」，见 `webdav/adapter.ts` 的 `watermarkKey`）。
      const targetLibrary = { baseUrl, username, rootPath };
      const savedLibrary = savedBefore
        ? { baseUrl: savedBefore.baseUrl, username: savedBefore.username, rootPath: savedBefore.rootPath }
        : null;
      /** 本机此前配过自带存储（用于区分「首次配置」与「换云盘」的措辞）。 */
      const wasConfigured = !!savedBefore?.baseUrl;
      /** 库的身份变了没有（换云盘）—— 决定置位与提示措辞。 */
      const libraryChanged = !sameLibrary(savedLibrary, targetLibrary);
      // 写入的作用域 = **目标库**（这次保存之后要往哪儿传）。
      // 显式传，不依赖「写完之后磁盘上是谁」—— 保存动作本身会改变磁盘上的
      // 当前库，读-改-写的时序必须与「这一次保存的目标」一致。
      const targetScope = libraryScopeKey(targetLibrary);
      writePending = (pending: boolean): Promise<void> =>
        storage.setFirstSyncPending(pending, targetScope);

      // ── 2026-10-18 P1#4：进入「归属待决」状态 ────────────────────────────
      // 自带存储切过去这一刻，本地通常已有会话，而「它们归谁」是用户的决定。
      // 在他点「检查并推送」之前，自动上传必须被降级为增量（syncEngine 读本标志）。
      //
      // 为什么只在「首次配置 / 换云盘」时置位：已经在用**同一个**自带存储库的
      // 老用户重设密码时不该被重新拦住（那会让他们的同步莫名停摆，且没有任何提示）。
      //
      // ⚠️ 必须排在本方法**最前面**（round 30 真机抓到的顺序缺陷）：本机此前攒下的
      // pending_upload 还是 true（没配同步后端时的保存都会置位），而**保存设置这个动作
      // 本身**就会让 autoSyncMiddleware 排一次上传（防抖 3s）。标志若晚一步落盘，
      // 那次上传就是**无抑制**的全量 ⇒ 刚切到自带存储、历史会话已经上了云盘，
      // 「归属待决」形同虚设。放最前面还有一层好处：置位同时会清掉此前攒下的
      // 「改动过的会话 id」（那时它们全属于历史会话），这正是待决期该有的白名单起点。
      // 若下面保存失败：本次置的位要退回去（见 saveError 分支与 catch 的注释）。
      if (shouldEnterOwnershipPending({ saved: savedLibrary, target: targetLibrary })) {
        await writePending(true);
        firstSyncPendingSetHere = true;
      }

      await saveWebDavConfig({ baseUrl, username, rootPath, encryption });
      // ⚠️ 2026-10-20：磁盘上的「当前库」刚刚变了（保存动作换掉了它）。
      // 本组件手里的 `savedCfg` 镜像必须**立刻**跟上 ——
      // 否则「归属决策完成」那条清除路径会写到**上一个库**的作用域上
      // （用户刚做完三选一，决定却记在别的库的名下 ⇒ 下次又被重新拦住）。
      // 这里写的是**刚保存成功**的那份（磁盘真值），不是表单的原样回显。
      setSavedCfg(prev => {
        const next: StoredWebDavConfig = {
          baseUrl,
          username,
          rootPath: rootPath || DEFAULT_ROOT,
          encryption,
          ...(prev?.lastCheck ? { lastCheck: prev.lastCheck } : {}),
        };
        lastSavedConfigRef.current = next;
        return next;
      });
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
        // 2026-10-18 A3：本次置的待决位必须退回。
        // 保留它的后果：此后每一次自动上传都命中 syncEngine 的 suppressFullUpload
        //（历史会话被永久排除在上传之外），而界面零提示 —— 用户只看到「新会话
        // 同步了」，不知道旧会话早就不传了。方向上是 fail-closed，但没有**任何
        // 路径**能让他发现它。
        //
        // ⚠️ 两个方向上的边界都不能让：
        //   · 只退**本次**置的位（firstSyncPendingSetHere）—— 用户上轮就已经处于
        //     待决态、这次重设密码又保存失败时，那个位是真实未完成的归属决策（见上面 wasConfigured 的论证）。
        //   · 成功保存时**绝不清**（那是 round 30 记录的竞态：设置一旦保存成功，
        //     3 秒后 autoSyncMiddleware 就会排一次上传，清掉之后那次就是无抑制全量）。
        await releaseFirstSyncPendingIfSetHere(firstSyncPendingSetHere, 'save-error', writePending);
        return;
      }

      // 立刻重建 alarm + 重解析后端，否则「保存了却要等 SW 重启才生效」。
      try {
        await sendSyncCommand('resyncAlarm');
        await primeSyncBackend();
      } catch (err) {
        logWarn('[WebDavSettings] 重建 alarm / 重解析后端失败（下次启动自愈）:', err);
      }

      // P2-4：保存后父页面（自动同步提示）与本组件（推送区块可用性）都要刷新
      notifyWebDavConfigChanged();

      // 2026-10-20：保存可能**新置**了待决位（首次配置 / 换云盘）⇒
      // 横幅必须立刻出现，否则用户看不到「为什么历史会话没上去」。
      await refreshOwnershipPending();

      // 2026-10-20：**换云盘**时要说清「历史会话没有自动上传」——
      // 这正是本缺陷的用户可见形态（用户以为「已保存」= 「已经传上去了」）。
      // 换云盘时那句「别忘了点检查并推送」还不够：它没说明**为什么**现在
      // 需要做这个决定、以及**不做**会怎样（历史会话会一直留在这台设备上）。
      const switchedLibrary = wasConfigured && libraryChanged;
      showToast(
        switchedLibrary
          ? '已保存，已切换到新的云盘。为避免把本机历史会话未经你同意就传上去，' +
            '这些会话暂未上传；请点下方「检查并推送到云端」选择归属方式。'
          : wasWebdav
            ? '已保存'
            : '已保存，同步方式已切换为「自带存储」。别忘了点下方「检查并推送」把本机已有会话推上去。',
        'success'
      );
    } catch (err) {
      // 同 saveError 分支：抛出（落盘失败 / 会话凭据写失败）也不能把待决位留在盘上。
      await releaseFirstSyncPendingIfSetHere(firstSyncPendingSetHere, 'save-throw', writePending);
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
    savedCfg,
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
    // ── 2026-10-18 round 39 P0：探测与执行必须指向同一个库 ──────────────
    // 本函数用**表单**现造 adapter，而执行侧（sendSyncCommand）在 service
    // worker 里读的是**已保存配置**。两者不一致时，用户看到的数字属于表单
    // 那个库，实际写入的却是已保存那个库 —— 拿 A 库的界面换来对 B 库的
    // 同意，再把数据落进 B 库之外的地方。
    //
    // 这里直读磁盘（而不是用组件里的 savedCfg 状态）：执行侧读的就是磁盘，
    // 两边必须用同一份真值比对，state 的时序差异会让闸门形同虚设。
    // 拉取路径同样经过本函数，所以 push 与 pull 一次拦住。
    const onDisk = await loadWebDavConfig();
    if (!webdavFormMatchesSavedConfig({ baseUrl, username, encryption }, onDisk)) {
      const reason = onDisk
        ? '已中止：你正在编辑的地址/账号与「保存并启用」里的配置不是同一个云端库。' +
          '探测显示的数字属于你填的地址，但推送/下载会作用在**已保存的那个库**上。' +
          '请先点「保存并启用」让它生效，再做推送或下载。（本次未读写任何数据。）'
        : '已中止：还没有「保存并启用」过任何云端库配置，推送/下载无法确定要作用在哪个库上。' +
          '请先点「保存并启用」。（本次未读写任何数据。）';
      return { ok: false, reason };
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

      // 与「测试连接」共用同一个探针工厂（见 buildProbeAdapter 的注释）。
      const adapter = await buildProbeAdapter({ baseUrl, username, password, rootPath, passphrase, encryption });
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
        // null = 读不到本机设置，本轮无法判断生效后端（2026-10-18 B 组）。
        // 与「读到了但不是自带存储」分开说：前者是存储故障（重试就好），
        // 后者是用户没保存设置（要去点保存）。混成一句会让用户做无用功。
        if (effective === null) {
          setFirstPush({
            kind: 'blocked',
            reason:
              '已中止：读不到同步设置，无法判断当前生效的后端。' +
              '（本次未推送，本地与云端数据均未改动。）请稍后重试。',
          });
          return;
        }
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
          // settings 成了旧值。不重读的话，本页显示的是旧设置，而上传路径读的
          // 也是那份旧值（无条件 upsert）⇒ 刚拉下来的设置被旧值顶回云端。
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
        // 2026-10-18 A4：解除待决必须排在成功 toast **之前**，且自带 try/catch。
        // 排在后面时，一次 KV 写失败会被下面的 catch 报成「推送失败…本地数据未
        // 受影响」——而合并其实已经成功了（见 completeFirstSyncSuccess 的注释）。
        await completeFirstSyncSuccess({
          write: writeCurrentScope,
          notifySuccess: () => showToast('推送完成', 'success'),
          onError: err =>
            logWarn('[WebDavSettings] 推送完成：解除归属待决标志失败（不影响本次结果）:', err),
        });
        // 归属决策做完了 ⇒ 横幅必须立刻消失（否则界面还在说「等你决定」，
        // 而决定已经做完了 —— 那又是一句不成立的话）。
        await refreshOwnershipPending();
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
  /**
   * 下载保护性跳过（reason 是机器码）的用户文案。
   *
   * 2026-10-18 A8：不再自己维护一份表，改为委托 `resolveSyncFailureCopy`
   * （`syncPreviewView.ts` 的 SYNC_REASON_COPY 是同一批 reason 的唯一真源）。
   * 【为什么必须共用】本面板与 SyncButton 各自一张表时，B 组新增的 `backend_unknown`
   * 只登记了一边 —— 面板这边就退化成**裸枚举**（用户看到 `backend_unknown` 这几个
   * 字母），而两张表只有在“有人同时改两处”时才能保持一致（那个人不会总在）。
   * 另：未登记的**纯 snake_case** reason 现在会回退到一句人话，而不是把枚举原文
   * 弹给用户。
   */
  const downloadReasonCopy = useCallback(
    (reason: string | undefined): string =>
      resolveSyncFailureCopy({ reason, fallbackMessage: '同步未成功，原因未如实报出；请稍后重试' }),
    []
  );

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
    // 2026-10-18 A2：`sendSyncCommand` 会 **reject**（SW 被回收时 message channel
    // closed），而这条路径原先一行 try/catch 都没有 —— 见 runPullCommand 的注释。
    // 现在三种结果（抛出 / {ok:false} / 成功）都收敛成一个可渲染状态。
    const outcome = await runPullCommand({
      run: () => sendSyncCommand('download', { forceRemote: false, syncSettings: false }),
      // 2026-10-18 A4：解除待决排在成功 toast **之前**，且自带 try/catch ——
      // 否则一次 KV 写失败就会被报成「下载失败」，而合并其实已经成功了。
      complete: () =>
        completeFirstSyncSuccess({
          write: writeCurrentScope,
          notifySuccess: () => showToast('已从云端下载到本机', 'success'),
          onError: err => logWarn('[WebDavSettings] 下载完成：解除归属待决标志失败（不影响本次结果）:', err),
        }),
      copyOf: downloadReasonCopy,
      onError: err => logWarn('[WebDavSettings] 下载命令未返回结果（后台进程可能已中断）:', err),
    });
    if (outcome.kind === 'blocked') {
      setFirstPush({ kind: 'blocked', reason: outcome.reason });
      return;
    }
    setFirstPush({
      kind: 'done',
      message:
        `已从云端下载并合并（云端 ${remoteActive} 个会话` +
        `${remoteTombstones > 0 ? `，并服从了 ${remoteTombstones} 条删除记录` : ''}）。`,
    });
    // 归属决策做完了 ⇒ 横幅必须立刻消失（理由同推送那条）。
    await refreshOwnershipPending();
  }, [probeRemote, showToast, downloadReasonCopy, refreshOwnershipPending]);

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
      // 2026-10-18 round 38：这次 dispatch 同时改两个字段，回滚必须**成对**。
      // 只回滚 syncBackend 会留下「界面说还留在自带存储、磁盘上 syncEnabled 已变 false」
      // 的分叉：用户下一次改任何设置都会把 false 一起写回去，静默关掉自动同步
      // （写路径按字段落盘，但**回滚过的字段同样算用户的改动**）。
      // 口径对齐 OptionsPage.handleSelectBackend（round 33）。
      const prevBackend = settings.syncBackend;
      const prevEnabled = settings.syncEnabled;
      dispatch(updateSettings({ syncBackend: 'supabase', syncEnabled: false }));
      const saveError = await dispatchSaveSettings(dispatch);
      if (saveError) {
        dispatch(updateSettings({ syncBackend: prevBackend, syncEnabled: prevEnabled }));
        showToast(
          `${saveError}（同步方式已恢复为「${prevBackend === 'webdav' ? '自带存储' : 'TapStack 云端'}」，` +
            `自动同步开关已恢复为${prevEnabled ? '开启' : '关闭'}）`,
          'error'
        );
        return;
      }
      // 2026-10-18（后置-2）：切走时一并清掉本次会话的 WebDAV 口令。
      // 不清的后果：用户过几天又切回自带存储，旧的（可能已轮换的）应用密码
      // 仍留在 chrome.storage.session 里，被自动当成有效凭据使用 ——
      // 而他可能已经在服务商那边改过密码，届时报的是 401，
      // 与「密码填错」完全不同的现象，极难自查。
      // 口令本就不落盘（只在 session），所以这是唯一的清理时机。
      await clearSessionSecrets();
      // 2026-10-18 A5：唯独这一处漏了 invalidate（handleForget / handleLock 都有）。
      // 不清的后果：`resyncAlarm` 那条消息超时（core/mutationProtocol.ts 的
      // withTimeout **不会取消**已发出的请求）时，SW 里那个活着的 WebDAV adapter
      // 不会被清；而 ensureBackendPrimed（sync-backend/index.ts）对非空缓存直接早退，
      // 于是下一次手动同步仍然写向 WebDAV —— 而 banner 说「当前仍在使用 TapStack 云端」。
      // 清口令不够：旧 adapter 里缓存的 Vault（已派生的密钥）跟着活下来。
      invalidateActiveSyncBackend();
      try {
        await sendSyncCommand('resyncAlarm');
        await primeSyncBackend();
      } catch (err) {
        logWarn('[WebDavSettings] 重建 alarm 失败（下次启动自愈）:', err);
      }
      // 2026-10-18 A3：后端已切到云端，待决标志描述的「webdav 首次归属决策」
      // 已无对象。留着它的后果：syncEngine 的 suppressFullUpload 虽然后端侧
      // 判了 `!== 'supabase'`，但用户之后又切回 webdav 时那个**陈旧**的待决位
      // 会直接生效 —— 没人在这中间清过它，历史会话就再也上传不了。
      // 清它是安全的：切回云端是用户显式选择，不再存在「本地已有数据归谁」的问题。
      await clearPendingToken('切回 TapStack 云端', writeCurrentScope);
      // P2-4：通知父页面刷新自动同步提示（切回云端后「已配置并解锁」不再成立）
      notifyWebDavConfigChanged();
      showToast('已切回 TapStack 云端。云盘上的文件不会被删除。', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '切换失败', 'error');
    }
  }, [dispatch, showToast, settings.syncBackend, settings.syncEnabled]);

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

  /**
   * 清除配置的真实执行体（handleForget 确认通过后调用）。
   */
  const runForget = useCallback(async () => {
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
      // 2026-10-18 round 38：保存结果以前被丢弃，末尾无条件报「自动同步已关闭」。
      // 写盘失败时那就是假的 —— 开关仍是 true，后台会继续按间隔醒来。
      // 失败就把 Redux 回滚成磁盘上的真值，并在 toast 里如实说明。
      let autoSyncOffFailed = false;
      if (settings.syncEnabled) {
        dispatch(updateSettings({ syncEnabled: false }));
        const saveError = await dispatchSaveSettings(dispatch);
        if (saveError) {
          autoSyncOffFailed = true;
          dispatch(updateSettings({ syncEnabled: true }));
          showToast(
            `云服务信息与本次会话口令已清除，但${saveError}：自动同步开关未能关闭（仍为开启），` +
              '后台会继续按间隔尝试并停在「未解锁」。请回设置页手动关闭',
            'error'
          );
        }
      }
      // 2026-10-18 A3：配置已被清空，待决标志所描述的「首次归属决策」已无对象 ——
      // 留着它只会在用户重新配好后直接生效，把历史会话静默排除在上传之外。
      // 与 handleSwitchBack 同理：这是一条「后端/配置已变」的路径，清它是安全的。
      await clearPendingToken('清除配置', writeCurrentScope);
      // 2026-10-18 A6：配置没了，上次测试结果也必须一起失效（否则重开面板
      // 会把一个不属于任何现有配置的绿灯播种回来 —— 本缺陷修法自己造的新假绿灯）。
      setSavedCfg(null);
      setCheck({ kind: 'idle' });
      // P2-4：清除配置后父页面的「已配置并解锁」必须失效
      notifyWebDavConfigChanged();
      // 失败路径已经报过一条更准确的 error toast，不能再覆盖成「已关闭」。
      if (!autoSyncOffFailed) {
        showToast('已清除本机保存的云服务信息与本次会话口令，自动同步已关闭', 'success');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : '清除失败', 'error');
    }
  }, [dispatch, showToast, settings.syncEnabled]);

  /**
   * 「清除配置」入口（2026-10-19 审计 V-4）。
   *
   * 【为什么要确认】这一颗按钮会：
   *   · 清掉地址 / 账号 / 应用密码
   *   · 清掉本次会话的加密口令
   *   · **关掉自动同步**（影响后台行为）
   * 而它此前和「锁定」长得一模一样（都是同款描边按钮），且**一次点击就生效**。
   * 同产品的「删除会话」永远弹确认 —— 安全契约不一致。
   *
   * 确认框必须写清后果，否则用户是在盲点。
   */
  const handleForget = useCallback(() => {
    showConfirm({
      title: '清除云服务信息？',
      message:
        '将清空本机保存的地址、账号与应用密码，并清除本次会话的加密口令。' +
        '同时会关闭自动同步（后台不再定时同步）。' +
        '云盘上的文件不会被删除，之后需要重新填写才能继续同步。',
      type: 'danger',
      confirmText: '清除',
      cancelText: '取消',
      onConfirm: () => {
        void runForget();
      },
      onCancel: () => { },
    });
  }, [showConfirm, runForget]);

  // ── 锁定（2026-10-14 修 P0 时加）────────────────────────────────────────
  // 只清口令、不清地址：用户离开电脑前点一下，后台同步即停并明确提示未解锁，
  // 而不是拿旧口令继续传。invalidate 是关键 —— 不清 activeBackend 缓存的话，
  // 旧适配器里的 Vault（已派生的密钥）还会继续生效，「锁定」等于没锁。
  //
  // 2026-10-18 A3：**刻意不在这里清待决标志**（其他三处都清，这一处例外）。
  // 锁定是临时的：配置、后端都没变，用户重新输口令就接着用。若锁定时把待决位
  // 退掉，重新解锁后他保存一个标签页就会触发**无抑制的全量上传** —— 历史会话
  // 在归属还没决定的情况下整批上云，那正是 P1#4 要防的事。
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
      {/* 2026-10-20 审计 D-2：这段说明原先写死 text-gray-500 / dark:text-gray-400，
          不跟主题走（legacy 浅色实测仅 2.54:1）。改用主题令牌 theme-text-muted
          （6 套主题实测均 ≥4.5:1）。下面的几处 11px 小字同理。 */}
      <div className="mb-2 text-xs theme-text-muted">
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
      <div className="mb-2 text-[11px] leading-relaxed theme-text-muted">
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
      <div className="mb-2 text-[11px] theme-text-muted">
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
          {/* 2026-10-23 审计 WC-5：原文「云盘上只有密文」与下方那段隐私说明
              **互相矛盾** —— 每个会话文件还带一段明文头部（id / 是否已删除 /
              操作印记 / 最后修改时间），且清单文件整体就是明文。
              ⇒ 改成只承诺「会话内容是密文」，那句承诺才是真的。 */}
          <span>加密（推荐）：离开浏览器前用口令加密，会话内容在云盘上是密文</span>
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
              id="webdav-encryption-pass"
              type="password"
              className={`${inputCls} mt-1.5`}
              placeholder="加密口令（无法找回，忘记将无法解密）"
              value={passphrase}
              onChange={e => setPassphrase(e.target.value)}
              disabled={!loaded}
              aria-describedby="webdav-encryption-pass-hint"
            />
            {/* 2026-10-24 审计 SEC-1：口令强度的**实时**提示。
                抽成组件是为了能被 react-dom/server 真渲染一遍来验
                （源码里有 ≠ 界面上有）。它**只提示、不拦截** ——
                拦截在适配器建库那一刻，见 passphrasePolicy 的文件头。 */}
            <PassphraseStrengthHint passphrase={passphrase} />
            {/* 2026-10-20 审计 D-2：写死的 text-amber-600 / dark:text-amber-500
                在浅底上只有 3.19:1 —— 而这句恰恰是最需要看清的一句（安全告警）。
                改用主题令牌 theme-text-warning（各主题实测 ≥4.5:1）。 */}
            <div className="mt-1 text-[11px] leading-relaxed theme-text-warning">
              口令没有找回入口。请务必自己记牢 —— 忘记后云盘上的数据将无法解密，也没有我们能做的补救。
            </div>
            {/* 2026-10-24 审计 SEC-1：计划书 §5.2 要求 UI 说明「这是防离线明文，
                不是防运行时」—— 那句话至今没落到界面上。弱口令门槛要成立，
                用户必须知道自己在防谁、以及防不了谁。 */}
            <div className="mt-1 text-[11px] leading-relaxed theme-text-muted">
              {webDavEncryptionBoundaryNotice()}
            </div>
          </>
        ) : null}
      </fieldset>

      {/* ── 2026-10-23 审计 WC-5：隐私说明必须**跟着加密开关走** ──────────
       * 修复前这是一段无条件渲染的「会话内容加密后存放」—— 可同屏上方就有
       * 「不加密」选项，用户显式选了明文之后，这句话仍在说「加密后存放」。
       * 而且它把明文面说得比实际小（manifest 里还有 id / 是否已删除 /
       * 操作印记（含设备编号）/ salt，每个会话分片还有一段明文头部）。
       *
       * ⇒ 两套说法抽成纯函数（`webDavPrivacyCopy.ts`），这里只负责渲染。
       *   为什么必须抽：两版各有半句独有内容（明文版要写清「名称与网址是
       *   明文」，加密版要写清 manifest 的明文字段），内联写两遍必然漂移。
       *   守卫见 tests/guards/webDavPrivacyCopyHonesty.test.ts。 */}
      <div className="mb-2 text-[11px] leading-relaxed theme-text-muted">
        {webDavPrivacyNotice(encryption)}
      </div>

      {/* ── 2026-10-19 审计 V-4：按钮层级 ────────────────────────────────
       * 修复前这里平铺 5 颗按钮，其中「测试连接」和「保存并启用」**都是实心
       * 主按钮** —— 用户无法判断该先点哪个。而这两个的顺序恰恰是反的：
       * 「测试连接」是**可选的预检**（不写盘），「保存并启用」才是让配置
       * 真正生效的那一步。
       *
       * 现在：主色唯一给「保存并启用」（唯一让配置生效的动作），
       * 「测试连接」降为次级描边，其余三颗收进「更多操作」里 ——
       * 它们是低频且有副作用的动作，不该和「保存」平级。
       */}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btnPrimary} onClick={handleSave} disabled={saving}>
          {saving ? '保存中…' : '保存并启用'}
        </button>
        <button type="button" className={btnSecondary} onClick={handleTest} disabled={check.kind === 'checking'}>
          {check.kind === 'checking' ? '测试中…' : '测试连接'}
        </button>

        {/* 更多操作：低频 + 有副作用的三颗 */}
        <details className="relative">
          <summary
            className={`${btnGhost} list-none cursor-pointer inline-flex items-center`}
            aria-label="更多自带存储操作"
          >
            更多操作
            <svg
              className="ml-1 h-3 w-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </summary>
          {/* ── 2026-10-19 审计 P2-7：靠右对齐 + 视口内收边 ──────────────
           * 原先是 `left-0 top-full w-52`：设置页窗口宽 400px 时，菜单右缘
           * 超出视口 40px，页面出现横向滚动条（实测 docW 440 vs winW 400）。
           * 改为靠右对齐（right-0）+ max-w 跟着视口走。
           */}
          <div className="absolute right-0 top-full z-30 mt-1 w-52 max-w-[calc(100vw-2rem)] rounded-lg border theme-border-default theme-bg-elevated theme-shadow-panel py-1">
            <button
              type="button"
              className="w-full px-3 py-2 text-left text-sm theme-text-secondary theme-btn-hover"
              onClick={handleSwitchBack}
            >
              切回 TapStack 云端
            </button>
            <button
              type="button"
              className="w-full px-3 py-2 text-left text-sm theme-text-secondary theme-btn-hover"
              onClick={handleLock}
            >
              锁定（停用同步并清除本次会话口令）
            </button>
            <button
              type="button"
              className="w-full px-3 py-2 text-left text-sm theme-text-danger theme-btn-hover"
              onClick={handleForget}
            >
              清除配置
            </button>
          </div>
        </details>
      </div>

      {/* 2026-10-17（双模式适配）：恢复 slim 分支删掉的二分 banner。
          slim 的理由是「syncBackend 只有 'webdav' 一个合法值 ⇒ 两个分支恒相等」，
          但本项目是**双模式**：syncBackend 仍有 'supabase'，两个分支真实存在，
          而且这条提示是用户判断「我的数据现在到底传到哪」的唯一入口 ——
          它不显示，「静默回落」类 P0 就没有用户可见的对应面了。

          ⚠️ 2026-10-18 C 组修正：原判据只有 `settings.syncBackend === 'webdav'`
          —— 那只回答「用户选了哪个后端」，却输出「已启用：数据同步到你自己
          的云盘」。于是「已配好但本次会话未解锁」（重开浏览器 / 刚点过下方
          「锁定」）的用户看到「已启用」，而同步实际一次都不会跑（同一页上方
          的 hint 还在说自动同步不会运行，两句互相矛盾）。

          现判据来自**真实解析结果**（backendKind ←
          classifyBackendResolution(getLastBackendResolution())），只有
          `ready` 才允许说「已启用」。未解析完成同样不说「已启用」。 */}
      {settings.syncBackend === 'webdav' ? (
        <div className={`mt-2 rounded-md px-2 py-1.5 text-xs ${WEB_DAV_BANNER_TONE[webdavBannerKind]}`} data-banner-kind={webdavBannerKind}>
          {WEB_DAV_BANNER_COPY[webdavBannerKind]}
        </div>
      ) : (
        <div className="mt-2 rounded-md bg-gray-100 px-2 py-1.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300">
          当前仍在使用 TapStack 云端。点「保存并启用」后切换。
        </div>
      )}

      {/* 2026-10-18 C 组：下面这段 slim 遗留注释描述的「未配置/未解锁的真实状态
          只由同步时的 toast 报出，面板不显示」已不再成立 —— banner 现在直接用
          classifyBackendResolution 的完整结果，四种形态各自有话说。
          保留这句是为了防止有人按旧注释把 banner 退回二分判断。 */}

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
          <p className="text-[11px] leading-relaxed theme-text-warning">
            {firstPushBlockedReason}
          </p>
        </div>
      ) : (
      <div className="mt-2 rounded-md border theme-border-default px-2 py-2">
          <div className="mb-1.5 text-xs font-medium text-gray-700 dark:text-gray-200">
            首次配置后需把本机会话推送到云端
          </div>
          <p className="mb-2 text-[11px] leading-relaxed theme-text-muted">
            切换到自带存储不会自动上传已有会话。若不推送，这些会话只存在于这台设备上，
            换设备或换浏览器将无法找回。
          </p>
          {/* ── 2026-10-20：归属待决的**如实说明** ───────────────────────────
           * 待决期里自动上传只传「本次改动过的会话」，历史会话被排除在外。
           * 界面若对此只字不提，用户只会看到「本机有 N 个会话、云端只有几个」
           * ⇒ 只能得出「同步坏了」的结论，而真正缺的是**一个决定**。
           * 这条横幅说清三件事：发生了什么 / 为什么 / 下一步做什么。 */}
          {ownershipPending === null ? (
            // ── 2026-10-23 审计 DS-4：读不到是**第三种**状态 ──────────────
            // 不许把它塞进「不待决」（= 沉默）或「待决」（= 编一个事实）。
            <div className="mb-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] leading-relaxed text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
              {ownershipStatusUnreadableNotice(savedCfg ? `${savedCfg.baseUrl}` : '当前云盘')}
            </div>
          ) : ownershipPending ? (
            <div className="mb-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] leading-relaxed text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
              {ownershipPendingNotice({
                localCount: localActiveCount,
                scopeLabel: savedCfg ? `${savedCfg.baseUrl}` : '当前云盘',
              })}
            </div>
          ) : null}
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
                      // 什么时候弹二次确认：**这一步真有不可逆后果**。
                      // 墓碑态下三个选项都会让已删会话复活（previewOutcome 会给
                      // merge 也带上 warning），原先「choice !== 'merge'」那个
                      // 例外正好把标着「推荐」的那一个排除在确认之外 ——
                      // 2026-10-19 修：判据统一成「有 warning 就确认」。
                      // 「以云端为准」的 warning 说明的是「不会丢数据」，但同 id 的
                      // 旧版本仍不可恢复，所以保留确认。
                      if (d.warning) {
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
              {/* 2026-10-18 A6：来自已落盘的 lastCheck 时必须标明「上次」，
                  否则重开页面的用户会把几天前（甚至是另一个地址）的绿灯
                  当成「刚刚验证过这个地址」。 */}
              {check.fromStorage ? '上次测试通过：' : ''}连接正常，云端已有 {check.groups} 个会话。
              {!check.conditionalWrites ? (
                <div className="mt-1 leading-relaxed">
                  注意：这个云盘不支持「写入前校验」，并发保护较弱。
                  两台设备在**同一瞬间**编辑同一个会话时可能互相覆盖；错峰使用不受影响。
                </div>
              ) : null}
            </>
          ) : (
            <>
              {check.fromStorage ? '上次测试失败：' : '连接失败：'}
              {check.message ?? '未知原因'}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
};

