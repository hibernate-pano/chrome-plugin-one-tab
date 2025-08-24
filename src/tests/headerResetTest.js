/**
 * 测试 Header 组件的重置到默认视图功能
 */

// 模拟 Redux store 和 dispatch
const mockDispatch = jest.fn();
const mockSettings = {
  layoutMode: 'triple',
  reorderMode: true,
  showFavicons: true,
  showTabCount: true,
  confirmBeforeDelete: true,
  allowDuplicateTabs: false,
  syncEnabled: true,
  showNotifications: false,
  syncStrategy: 'newest',
  deleteStrategy: 'everywhere',
  themeMode: 'auto',
};

// 模拟 useAppSelector 和 useAppDispatch
jest.mock('@/store/hooks', () => ({
  useAppDispatch: () => mockDispatch,
  useAppSelector: (selector) => selector({ settings: mockSettings }),
}));

// 模拟 Toast Context
jest.mock('@/contexts/ToastContext', () => ({
  useToast: () => ({
    showConfirm: jest.fn(),
    showAlert: jest.fn(),
  }),
}));

// 模拟其他组件
jest.mock('./HeaderDropdown', () => ({
  HeaderDropdown: () => null,
}));

jest.mock('./TabCounter', () => ({
  TabCounter: () => null,
}));

jest.mock('@/components/sync/SyncButton', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('./SimpleThemeToggle', () => ({
  SimpleThemeToggle: () => null,
}));

import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react';
import { Header } from '../components/layout/Header';

describe('Header 重置到默认视图功能', () => {
  let mockOnSearch;

  beforeEach(() => {
    mockOnSearch = jest.fn();
    mockDispatch.mockClear();
  });

  test('点击插件图标应该重置到默认视图', () => {
    render(<Header onSearch={mockOnSearch} />);
    
    // 找到插件图标按钮
    const iconButton = screen.getByRole('button', { name: '回到默认视图' });
    expect(iconButton).toBeInTheDocument();
    
    // 点击图标
    fireEvent.click(iconButton);
    
    // 验证搜索被清空
    expect(mockOnSearch).toHaveBeenCalledWith('');
    
    // 验证 dispatch 被调用来重置状态
    expect(mockDispatch).toHaveBeenCalled();
  });

  test('当设置已经是默认状态时，点击图标仍然清空搜索', () => {
    // 模拟已经是默认状态的设置
    const defaultSettings = {
      ...mockSettings,
      layoutMode: 'double',
      reorderMode: false,
    };
    
    jest.mocked(require('@/store/hooks').useAppSelector).mockImplementation(
      (selector) => selector({ settings: defaultSettings })
    );
    
    render(<Header onSearch={mockOnSearch} />);
    
    const iconButton = screen.getByRole('button', { name: '回到默认视图' });
    fireEvent.click(iconButton);
    
    // 验证搜索仍然被清空
    expect(mockOnSearch).toHaveBeenCalledWith('');
  });

  test('插件图标应该有正确的样式和属性', () => {
    render(<Header onSearch={mockOnSearch} />);
    
    const iconButton = screen.getByRole('button', { name: '回到默认视图' });
    
    // 验证按钮有正确的类名
    expect(iconButton).toHaveClass('p-1', 'rounded', 'hover:bg-gray-100');
    
    // 验证有正确的 title 属性
    expect(iconButton).toHaveAttribute('title', '回到默认视图');
    
    // 验证包含 SVG 图标
    const svgIcon = iconButton.querySelector('svg');
    expect(svgIcon).toBeInTheDocument();
    expect(svgIcon).toHaveClass('h-6', 'w-6', 'text-primary-600');
  });
});

console.log('✅ Header 重置功能测试定义完成');
