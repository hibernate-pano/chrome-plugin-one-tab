/**
 * 组件导出入口
 * 统一导出所有共享UI组件
 */
export { Button } from './Button/Button';
export type { ButtonProps } from './Button/Button';

export { IconButton } from './IconButton/IconButton';
export type { IconButtonProps } from './IconButton/IconButton';

export { FloatingActionButton } from './FloatingActionButton/FloatingActionButton';
export type { FloatingActionButtonProps } from './FloatingActionButton/FloatingActionButton';

export { ButtonGroup } from './ButtonGroup/ButtonGroup';
export type { ButtonGroupProps } from './ButtonGroup/ButtonGroup';

export { Input } from './Input/Input';
export type { InputProps } from './Input/Input';

export { Dialog } from './Dialog/Dialog';
export type { DialogProps } from './Dialog/Dialog';

export { Loading } from './Loading/Loading';
export type { LoadingProps } from './Loading/Loading';

export { Tooltip } from './Tooltip/Tooltip';
export type { TooltipProps } from './Tooltip/Tooltip';

export { Badge } from './Badge/Badge';
export type { BadgeProps } from './Badge/Badge';

export { Divider } from './Divider/Divider';
export type { DividerProps } from './Divider/Divider';

export { VirtualizedList, VirtualizedGrid } from './VirtualizedList';
export type { VirtualizedListProps, VirtualizedGridProps, VirtualizedListItem } from './VirtualizedList';

export { RenderPerformanceMonitor, PerformanceIndicator } from './RenderPerformanceMonitor';

export { ConfirmDialog, useConfirmDialog, quickConfirm, ConfirmDialogPresets } from './ConfirmDialog/ConfirmDialog';
export { LoadingState, useLoadingState, LoadingPresets, LoadingType, LoadingSize } from './LoadingState/LoadingState';

// 新增统一设计系统组件
export { Card, CardHeader, CardContent, CardFooter } from './Card/Card';
export type { CardProps } from './Card/Card';

export { Icon } from './Icon/Icon';
export type { IconProps } from './Icon/Icon';

export { StatusCard } from './StatusCard/StatusCard';
export type { StatusCardProps } from './StatusCard/StatusCard';

export { StatsCard, StatsGrid } from './StatsCard/StatsCard';
export type { StatsCardProps } from './StatsCard/StatsCard';

export { AnimatedContainer, StaggeredContainer } from './AnimatedContainer/AnimatedContainer';
export type { AnimatedContainerProps } from './AnimatedContainer/AnimatedContainer';

// 布局组件
export { ResponsiveContainer, ResponsiveGrid } from './ResponsiveContainer/ResponsiveContainer';
export type { ResponsiveContainerProps, ResponsiveGridProps } from './ResponsiveContainer/ResponsiveContainer';

// 现有空状态组件
export { EmptyState } from './EmptyState/EmptyState';
export type { EmptyStateProps } from './EmptyState/EmptyState';

export { GuidedActions } from './GuidedActions/GuidedActions';
export type { GuidedActionsProps } from './GuidedActions/GuidedActions';

// 现代化设计系统组件
export { ModernCard, ModernCardHeader, ModernCardContent, ModernCardFooter, ModernCardSpotlight, ModernCardHolographic, ModernCardFloating } from './ModernCard/ModernCard';
export type { ModernCardProps } from './ModernCard/ModernCard';

export { ModernIcon } from './ModernIcon/ModernIcon';
export type { ModernIconProps } from './ModernIcon/ModernIcon';

export { ModernIllustration, DecorativeElement } from './ModernIllustration/ModernIllustration';
export type { ModernIllustrationProps, DecorativeElementProps } from './ModernIllustration/ModernIllustration';