import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

function readEnvFile(path) {
  const env = {};
  const text = readFileSync(path, 'utf8');

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex);
    const value = line.slice(separatorIndex + 1);
    env[key] = value;
  }

  return env;
}

async function generateKeyFromUserId(userId) {
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(userId));
  return crypto.subtle.importKey('raw', hashBuffer, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function encryptData(data, userId) {
  const encoder = new TextEncoder();
  const plaintext = encoder.encode(JSON.stringify(data));
  const key = await generateKeyFromUserId(userId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const result = new Uint8Array(iv.length + ciphertext.byteLength);

  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), iv.length);

  return `ENCRYPTED_V1:${Buffer.from(result).toString('base64')}`;
}

async function main() {
  const env = {
    ...readEnvFile('.env'),
    ...process.env,
  };

  const url = env.VITE_SUPABASE_URL;
  const key = env.VITE_SUPABASE_ANON_KEY;
  const email = env.TEST_EMAIL;
  const password = env.TEST_PASSWORD;

  if (!url || !key) {
    throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY');
  }

  if (!email || !password) {
    throw new Error('Missing TEST_EMAIL or TEST_PASSWORD');
  }

  const supabase = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (authError) {
    throw authError;
  }

  const user = authData.user;
  if (!user) {
    throw new Error('No user returned after sign in');
  }

  console.log('login_ok', JSON.stringify({ userId: user.id, email: user.email }));

  const { data: settingsBefore, error: settingsBeforeError } = await supabase
    .from('user_settings')
    .select('user_id, layout_mode, reorder_mode, theme_mode, collect_pinned_tabs, last_sync')
    .eq('user_id', user.id)
    .maybeSingle();

  if (settingsBeforeError) {
    throw settingsBeforeError;
  }

  console.log('settings_before', JSON.stringify(settingsBefore));

  const updatedLayoutMode = settingsBefore?.layout_mode === 'double' ? 'single' : 'double';
  const updatedReorderMode = !(settingsBefore?.reorder_mode ?? false);

  const { error: updateSettingsError } = await supabase
    .from('user_settings')
    .upsert({
      user_id: user.id,
      layout_mode: updatedLayoutMode,
      reorder_mode: updatedReorderMode,
      last_sync: new Date().toISOString(),
    }, { onConflict: 'user_id' });

  if (updateSettingsError) {
    throw updateSettingsError;
  }

  const { data: settingsAfter, error: settingsAfterError } = await supabase
    .from('user_settings')
    .select('user_id, layout_mode, reorder_mode, last_sync')
    .eq('user_id', user.id)
    .single();

  if (settingsAfterError) {
    throw settingsAfterError;
  }

  console.log('settings_after', JSON.stringify(settingsAfter));

  const tempGroupId = `codex-test-${randomUUID()}`;
  const tempTabId = `tab-${randomUUID()}`;
  const now = new Date().toISOString();
  const encryptedTabsData = await encryptData([
    {
      id: tempTabId,
      url: 'https://example.com/',
      title: 'Example Domain',
      favicon: 'https://example.com/favicon.ico',
      created_at: now,
      last_accessed: now,
      pinned: false,
    },
  ], user.id);

  const { error: insertGroupError } = await supabase
    .from('tab_groups')
    .insert({
      id: tempGroupId,
      user_id: user.id,
      name: 'Codex Sync Test Session',
      created_at: now,
      updated_at: now,
      is_locked: false,
      device_id: 'codex-mcp-test',
      last_sync: now,
      tabs_data: encryptedTabsData,
    });

  if (insertGroupError) {
    throw insertGroupError;
  }

  const { data: recentGroups, error: recentGroupsError } = await supabase
    .from('tab_groups')
    .select('id, name, updated_at')
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false })
    .limit(3);

  if (recentGroupsError) {
    throw recentGroupsError;
  }

  console.log('recent_groups', JSON.stringify({
    count: recentGroups.length,
    tempGroupVisible: recentGroups.some((group) => group.id === tempGroupId),
  }));

  const { error: insertTabError } = await supabase
    .from('tabs')
    .insert({
      id: tempTabId,
      group_id: tempGroupId,
      url: 'https://example.com/test',
      title: 'Codex Temp Tab',
      favicon: null,
      created_at: now,
      last_accessed: now,
    });

  if (insertTabError) {
    throw insertTabError;
  }

  const { data: tabs, error: tabsError } = await supabase
    .from('tabs')
    .select('id, group_id, title')
    .eq('group_id', tempGroupId);

  if (tabsError) {
    throw tabsError;
  }

  console.log('tabs_after_insert', JSON.stringify({
    count: tabs.length,
    tempTabVisible: tabs.some((tab) => tab.id === tempTabId),
  }));

  const { error: deleteTabError } = await supabase
    .from('tabs')
    .delete()
    .eq('id', tempTabId);

  if (deleteTabError) {
    throw deleteTabError;
  }

  const { error: deleteGroupError } = await supabase
    .from('tab_groups')
    .delete()
    .eq('id', tempGroupId);

  if (deleteGroupError) {
    throw deleteGroupError;
  }

  const { error: restoreSettingsError } = await supabase
    .from('user_settings')
    .upsert({
      user_id: user.id,
      layout_mode: settingsBefore?.layout_mode ?? 'single',
      reorder_mode: settingsBefore?.reorder_mode ?? false,
      last_sync: settingsBefore?.last_sync ?? now,
    }, { onConflict: 'user_id' });

  if (restoreSettingsError) {
    throw restoreSettingsError;
  }

  console.log('cleanup_ok', JSON.stringify({ tempGroupId, tempTabId }));

  await supabase.auth.signOut();
}

main().catch((error) => {
  console.error('smoke_test_failed', error);
  process.exitCode = 1;
});
