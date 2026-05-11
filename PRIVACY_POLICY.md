# TabVault Pro Privacy Policy

Last updated: 2026-05-11

TabVault Pro is a Chrome extension for saving, organizing, exporting, and restoring browser tab sessions.

## What data the extension handles

The extension may handle the following user data as part of its core functionality:

- Tab metadata you choose to save, including page titles, URLs, pinned state, notes, and session names
- Extension settings such as theme, layout, and collection preferences
- Account identity data when you choose to sign in, such as your email address and Supabase user ID
- Manual sync metadata such as device ID and last sync timestamps

## How data is used

TabVault Pro uses this data only to provide its product features:

- Save and restore tab sessions locally in your browser
- Search, rename, favorite, lock, import, and export saved sessions
- Authenticate your account when you explicitly sign in
- Upload local sessions and settings to the cloud only when you manually trigger sync
- Download cloud sessions and settings only when you manually trigger sync

The extension does not perform background cloud sync and does not sell user data.

## Where data is stored

- By default, saved sessions and settings are stored locally in Chrome extension storage
- If you sign in and use manual sync, synced data is transmitted to and stored in the project's Supabase backend

## When network access happens

The extension accesses the network only for explicit account and sync flows against the configured Supabase project:

- Sign up
- Sign in
- Sign out
- Email verification
- Manual upload
- Manual download

## Data sharing

TabVault Pro does not share your data with advertisers or unrelated third parties.
Data may be processed by Supabase solely to provide authentication and manual cloud sync for this extension.

## Data retention and control

You control when local data is deleted from the extension.
If you use manual sync, cloud data remains in the Supabase project until you remove it through product actions or backend administration.

## Contact

Project repository: https://github.com/hibernate-pano/chrome-plugin-one-tab

