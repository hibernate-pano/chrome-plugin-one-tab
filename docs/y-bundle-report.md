=== TapStack V2 影子双写 · 体积报告 ===

  [yjs] raw 292.8KB / gzip 61.5KB  (yjs/dist/yjs.mjs)
  [y-indexeddb] raw 5.8KB / gzip 1.6KB  (y-indexeddb/dist/y-indexeddb.cjs)
  [dexie] raw 255.5KB / gzip 49.7KB  (dexie/dist/dexie.mjs)

  新增依赖 gzip 合计：112.8KB（预算 120KB）

  dist/ JS chunk（gzip）：
    DndProvider-nEkWBtz7.js  gzip 0.1KB
    PerformanceTest-C2mBfo8m.js  gzip 1.7KB
    browser-CFPZfwi6.js  gzip 0.4KB
    confirm-FQFQ-czd.js  gzip 0.5KB
    import-wrapper-prod-9GCBUPWE.js  gzip 31.7KB
    index-DnHrCnR6.js  gzip 2.2KB
    modulepreload-polyfill-B5Qt9EMX.js  gzip 0.4KB
    popup-DJVQQsuj.js  gzip 0.1KB
    react-vendor-C7MXdU5W.js  gzip 59.1KB
    redux-vendor-CkU0op4d.js  gzip 8.5KB
    service-worker.js  gzip 9.4KB
    src/popup/index-BIcklrEw.js  gzip 38.6KB
    supabase-vendor-DpEJjyrZ.js  gzip 29.3KB
    tabGroupSyncService-Dms_vFVs.js  gzip 4.4KB
    utils-2FVIRoZk.js  gzip 25.8KB
    y-indexeddb-D8kWkn2G.js  gzip 1.2KB  ← Y 相关
    yMaterialize-WEQ0IiKN.js  gzip 0.7KB  ← Y 相关
    ydoc-HxH_DsLw.js  gzip 1.0KB  ← Y 相关
    yjs-DRlFm5UW.js  gzip 23.9KB  ← Y 相关
  dist JS gzip 合计：238.9KB

  ✅ 体积门控通过：新增依赖 gzip 112.8KB ≤ 120KB。
