import { createSelector } from '@reduxjs/toolkit';
import type { RootState } from '@/store';

export const selectGroups = (s: RootState) => s.tabs.groups;
export const selectIsLoading = (s: RootState) => s.tabs.isLoading;
export const selectLastLoadedAt = (s: RootState) => s.tabs.lastLoadedAt;
export const selectSearchQuery = (s: RootState) => s.tabs.searchQuery;
export const selectError = (s: RootState) => s.tabs.error;
export const selectLayoutMode = (s: RootState) => s.settings.layoutMode;
export const selectReorderMode = (s: RootState) => s.settings.reorderMode;
export const selectSettings = (s: RootState) => s.settings;

/**
 * Sorted by: isFavorite desc, createdAt desc. New array reference only when
 * groups slice changes (createSelector memo). searchQuery is a separate concern
 * — SearchResultList filters on top of this.
 */
export const selectSortedGroups = createSelector(
  [selectGroups],
  (groups) =>
    [...groups].sort((l, r) => {
      const favL = !!l.isFavorite;
      const favR = !!r.isFavorite;
      if (favL !== favR) return favL ? -1 : 1;
      return new Date(r.createdAt).getTime() - new Date(l.createdAt).getTime();
    })
);
