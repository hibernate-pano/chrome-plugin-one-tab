import React from 'react';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import {
  toggleAutoSave,
  toggleShowFavicons,
  toggleConfirmBeforeDelete,
  toggleAllowDuplicateTabs,
  setAutoSaveInterval,
  setGroupNameTemplate,
} from '@/store/slices/settingsSlice';

export const SettingsPanel: React.FC = () => {
  const dispatch = useAppDispatch();
  const settings = useAppSelector(state => state.settings);

  return (
    <div className="space-y-6">
      {/* 自动保存设置 */}
      <div className="space-y-2">
        <h3 className="text-lg font-medium">自动保存设置</h3>
        <div className="space-y-4">
          <label className="flex items-center space-x-2">
            <input
              type="checkbox"
              checked={settings.autoSave}
              onChange={() => dispatch(toggleAutoSave())}
              className="
                w-4 h-4 rounded
                text-primary-500
                border-gray-300
                focus:ring-primary-500
              "
            />
            <span>启用自动保存</span>
          </label>
          {settings.autoSave && (
            <div className="flex items-center space-x-4">
              <span>保存间隔：</span>
              <select
                value={settings.autoSaveInterval}
                onChange={(e) => dispatch(setAutoSaveInterval(Number(e.target.value)))}
                className="
                  px-3 py-1 rounded-md
                  bg-surface
                  border border-gray-300
                  focus:outline-none focus:ring-2 focus:ring-primary-500
                "
              >
                <option value={5}>5分钟</option>
                <option value={10}>10分钟</option>
                <option value={15}>15分钟</option>
                <option value={30}>30分钟</option>
                <option value={60}>1小时</option>
              </select>
            </div>
          )}
        </div>
      </div>

      {/* 标签组设置 */}
      <div className="space-y-2">
        <h3 className="text-lg font-medium">标签组设置</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">标签组名称模板</label>
            <input
              type="text"
              value={settings.groupNameTemplate}
              onChange={(e) => dispatch(setGroupNameTemplate(e.target.value))}
              placeholder="例如：标签组 %Y-%m-%d %H:%M"
              className="
                w-full px-3 py-2 rounded
                bg-white
                border border-gray-300
                focus:outline-none focus:ring-2 focus:ring-blue-500
              "
            />
            <p className="mt-1 text-sm text-gray-500">
              支持的变量：%Y (年), %m (月), %d (日), %H (时), %M (分)
            </p>
          </div>
          <label className="flex items-center space-x-2">
            <input
              type="checkbox"
              checked={settings.allowDuplicateTabs}
              onChange={() => dispatch(toggleAllowDuplicateTabs())}
              className="
                w-4 h-4 rounded
                text-blue-600
                border-gray-300
                focus:ring-blue-500
              "
            />
            <span>允许保存重复的标签页</span>
          </label>
        </div>
      </div>

      {/* 显示设置 */}
      <div className="space-y-2">
        <h3 className="text-lg font-medium">显示设置</h3>
        <div className="space-y-2">
          <label className="flex items-center space-x-2">
            <input
              type="checkbox"
              checked={settings.showFavicons}
              onChange={() => dispatch(toggleShowFavicons())}
              className="
                w-4 h-4 rounded
                text-blue-600
                border-gray-300
                focus:ring-blue-500
              "
            />
            <span>显示网站图标</span>
          </label>
        </div>
      </div>

      {/* 操作确认设置 */}
      <div className="space-y-2">
        <h3 className="text-lg font-medium">操作确认设置</h3>
        <div className="space-y-2">
          <label className="flex items-center space-x-2">
            <input
              type="checkbox"
              checked={settings.confirmBeforeDelete}
              onChange={() => dispatch(toggleConfirmBeforeDelete())}
              className="
                w-4 h-4 rounded
                text-blue-600
                border-gray-300
                focus:ring-blue-500
              "
            />
            <span>删除前确认</span>
          </label>
        </div>
      </div>
    </div>
  );
};

export default SettingsPanel;