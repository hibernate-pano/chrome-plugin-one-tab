export interface Tab {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  createdAt: string;
  lastAccessed: string;
}

export interface TabGroup {
  id: string;
  name: string;
  tabs: Tab[];
  createdAt: string;
  updatedAt: string;
  isLocked: boolean;
}

export interface TabState {
  groups: TabGroup[];
  activeGroupId: string | null;
  isLoading: boolean;
  error: string | null;
  searchQuery: string;
}

export interface UserSettings {
  theme: 'light' | 'dark' | 'system';
  autoCloseTabsAfterSaving: boolean;
  autoSave: boolean;
  autoSaveInterval: number;
  groupNameTemplate: string;
  showFavicons: boolean;
  showTabCount: boolean;
  confirmBeforeDelete: boolean;
}

export interface RootState {
  tabs: TabState;
  settings: UserSettings;
} 