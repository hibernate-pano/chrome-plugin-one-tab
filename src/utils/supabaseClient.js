// 创建 Supabase 客户端
const SUPABASE_URL = 'https://reccclnaxadbuccsrwmg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJlY2NjbG5heGFkYnVjY3Nyd21nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDQyOTExODYsImV4cCI6MjA1OTg2NzE4Nn0.nHkOtkUtkzEUnF9ajUipD37SbAGH9znkVekI8N6hvdo';

// 动态加载 Supabase 客户端库
const loadSupabaseClient = async () => {
  // 加载 Supabase JS 库
  const supabaseScript = document.createElement('script');
  supabaseScript.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
  supabaseScript.async = true;
  
  // 等待脚本加载完成
  await new Promise((resolve) => {
    supabaseScript.onload = resolve;
    document.head.appendChild(supabaseScript);
  });
  
  // 创建 Supabase 客户端
  return window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
};

// 初始化 Supabase 客户端
let supabasePromise = loadSupabaseClient();

// 导出 Supabase 客户端
window.supabase = {
  auth: {
    verifyOtp: async (params) => {
      const supabase = await supabasePromise;
      return supabase.auth.verifyOtp(params);
    }
  }
};
