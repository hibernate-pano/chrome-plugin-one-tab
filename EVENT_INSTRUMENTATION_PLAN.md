# TabVault Pro Event Instrumentation Plan

目标：先把“首次安装后 24 小时内是否完成保存一次 + 恢复一次”这条漏斗定义清楚，再决定接入哪种分析平台。

## Core Events

- `onboarding_completed`
- `session_saved`
- `session_renamed`
- `session_favorited`
- `session_note_saved`
- `session_restored`
- `session_restored_again`
- `search_performed`
- `search_filtered`
- `sync_upload_started`
- `sync_upload_completed`
- `sync_download_started`
- `sync_download_completed`
- `onetab_import_completed`

## Event Properties

- `session_id`
- `session_name`
- `tab_count`
- `pinned_count`
- `restore_source`
- `query_length`
- `filter_domain`
- `filter_saved_within`
- `sync_mode`
- `overwrite_mode`

## First-Day Funnel

1. 安装完成
2. 完成 onboarding
3. 保存第一个会话
4. 在 24 小时内执行至少一次搜索
5. 在 24 小时内恢复至少一个会话
6. 登录并完成至少一次手动同步

## Gating Rules

- 没有分析平台前，先不要在 README 或商店页宣称“已验证转化漏斗”
- 先记录事件定义和属性，再接 PostHog / Amplitude / 自建埋点
- 只采产品行为，不采浏览内容正文
