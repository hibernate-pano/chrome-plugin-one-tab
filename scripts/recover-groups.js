// 数据恢复工具：当扩展 ID 变化导致 V2 blob 无法解密时，
// 用「旧扩展 ID」手动解密 IndexedDB 里的 tab_groups 并导出 JSON。
//
// 用法（真实 Chrome 环境）：
//   1. 打开扩展 popup，F12 → Console
//   2. 粘贴下面脚本（把 OLD_EXTENSION_ID 换成你写数据时的扩展 ID）
//   3. 运行后会在下载 tabstack-recovered-groups.json
//
// 旧扩展 ID 怎么找？
//   - chrome://extensions 页面当前显示的就是**当前** ID（不对）
//   - 如果你升级过扩展且 ID 变了，旧 ID 可能在：
//     a) 你记录过的任何位置
//     b) chrome://extensions 里"错误"提示中
//     c) 旧备份 / 旧 git 提交 / 旧文档
//   - 如果实在找不到，只能从云端重新下载数据（需要登录同账号）

const OLD_EXTENSION_ID = 'REPLACE_WITH_OLD_ID';

(async () => {
  const extId = chrome.runtime.id;
  if (OLD_EXTENSION_ID === 'REPLACE_WITH_OLD_ID') {
    console.error('请先把脚本里的 OLD_EXTENSION_ID 改成你写数据时的扩展 ID');
    console.log('当前 ID 是:', extId);
    return;
  }

  // 1. 读 IndexedDB blob
  const blob = await new Promise((resolve) => {
    const req = indexedDB.open('tabvaultpro', 1);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('kv', 'readonly');
      const g = tx.objectStore('kv').get('tab_groups');
      g.onsuccess = () => { resolve(g.result?.value ?? null); db.close(); };
      g.onerror = () => { resolve(null); db.close(); };
    };
    req.onerror = () => resolve(null);
  });

  if (typeof blob !== 'string' || !blob.startsWith('SECURE_V2:')) {
    console.error('没找到 SECURE_V2 blob（或数据已经是 V3 格式，直接就能读了）');
    return;
  }

  // 2. 用旧 ID 解密
  const enc = new TextEncoder();
  const b64 = blob.substring('SECURE_V2:'.length);
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const salt = bytes.slice(0, 16);
  const iv = bytes.slice(16, 28);
  const ciphertext = bytes.slice(28);

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(OLD_EXTENSION_ID + 'storage_key_v2'),
    'PBKDF2', false, ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );

  try {
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    const groups = JSON.parse(new TextDecoder().decode(decrypted));
    console.log(`✅ 解密成功！共 ${groups.length} 个会话`);

    // 3. 导出 JSON
    const json = JSON.stringify({
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      data: { groups, settings: {} },
    }, null, 2);
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tabstack-recovered-groups.json';
    a.click();
    URL.revokeObjectURL(url);
    console.log('✅ 已下载 tabstack-recovered-groups.json');
    console.log('恢复方式：扩展菜单 → 导入数据 → JSON 备份 → 选择该文件');
  } catch (e) {
    console.error('❌ 解密失败:', e.message);
    console.error('请确认 OLD_EXTENSION_ID 是正确的旧扩展 ID');
  }
})();