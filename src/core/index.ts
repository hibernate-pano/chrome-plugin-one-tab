/**
 * 共享 core 包入口（S1 重构第一步：src/core 过渡形态）。
 *
 * 收敛零依赖纯函数（P0）与合并/命令核心（P1），MV3/SW 安全、无新增依赖。
 * 各原位置文件保留 re-export 转发，调用方 import 路径零变化。
 * 后续可整体提升为 packages/core 独立包（需 pnpm workspace + 别名配置）。
 */
export * from '@/core/opStamp';
export * from '@/core/normalizeTabsData';
export * from '@/core/tabDataCodec';
export * from '@/core/oneTabFormatParser';
export * from '@/core/tabGroupUtils';
export * from '@/core/versionHelper';
export * from '@/core/authGuard';
export * from '@/core/hydrationDecision';
export * from '@/core/syncDecision';
export * from '@/core/opStampMerge';
export * from '@/core/mutationOps';
export * from '@/core/mutationProtocol';
// V2 影子双写（纯函数 + 动态 import，顶层无 yjs/dexie 静态依赖，主包零增长）
export * from '@/core/yShadowConfig';
export * from '@/core/yTranslate';
export * from '@/core/yMaterialize';
export * from '@/core/yShadow';
export { Y_DOC_NAME, Y_ROOT_KEYS, cryptoSlot, passthroughEncryptor } from '@/core/ydoc';
