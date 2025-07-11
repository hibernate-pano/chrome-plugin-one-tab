# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OneTab Plus is a Chrome extension for tab management built with React, TypeScript, and Redux Toolkit. It allows users to save, organize, and sync tabs across devices with cloud storage via Supabase.

## Development Commands

**Package Manager**: Use `pnpm` (required by packageManager setting)

```bash
# Development
pnpm dev              # Start development server with hot reload
pnpm build            # Build for production (runs TypeScript check + Vite build)
pnpm preview          # Preview production build

# Code Quality
pnpm lint             # ESLint check (--max-warnings 0)
pnpm format           # Format code with Prettier
pnpm type-check       # TypeScript type checking without emission
```

## Architecture

### Chrome Extension Structure
- **Manifest V3**: Uses service worker (`src/background.ts`) instead of background pages
- **Entry Points**: 
  - `src/popup/index.html` - Main popup interface
  - `src/background.ts` - Service worker for tab management and commands
  - `src/pages/` - OAuth callback and auth pages

### State Management
- **Redux Toolkit** with three main slices:
  - `tabSlice` - Tab groups and tab data management
  - `settingsSlice` - User preferences and configuration
  - `authSlice` - Authentication state with Supabase

### Key Features Implementation
- **Drag & Drop**: Uses `@dnd-kit` library with custom sortable components
- **Cloud Sync**: Supabase backend with real-time sync and encryption
- **Theme System**: Context-based dark/light/auto mode switching
- **Performance**: Lazy loading with React.Suspense, virtualization for large lists

### File Organization
```
src/
├── components/        # Reusable UI components
│   ├── business/     # Feature-specific components (Header, TabGroup, etc.)
│   ├── dnd/          # Drag & drop related components  
│   └── auth/         # Authentication components
├── store/            # Redux store and slices
├── utils/            # Utility functions (storage, sync, encryption)
├── types/            # TypeScript type definitions
└── contexts/         # React contexts (Theme, Toast)
```

### Storage Strategy
- **Local Storage**: Chrome extension storage API for offline data
- **Cloud Storage**: Supabase with JSONB format and optional encryption
- **Caching**: Auth state cached for 30 days to reduce re-login frequency

### Build Configuration
- **Vite** with `@crxjs/vite-plugin` for Chrome extension development
- **Code Splitting**: Manual chunks for React, Redux, Supabase, and utils
- **Path Alias**: `@/*` maps to `src/*`

## Testing

No automated test framework is currently configured. Manual testing is done through:
- Chrome extension developer mode loading
- Development server (`pnpm dev`) for UI components

## Chrome Extension Deployment

1. Build: `pnpm build`
2. Load `dist/` folder in Chrome Extensions (Developer Mode)
3. Test keyboard shortcuts: Alt+Shift+S (save all), Alt+S (save current), Ctrl+Shift+S (open popup)

## Important Implementation Notes

- Service worker handles tab saving/restoring and OAuth callbacks
- DnD operations sync to cloud in real-time when authenticated  
- Tab groups auto-delete when empty after drag operations
- Chrome internal pages (chrome://, chrome-extension://) are filtered out
- Supports OneTab format import/export for compatibility