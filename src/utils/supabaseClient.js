// 导入 Supabase 客户端
import { createClient } from '@supabase/supabase-js';

// 创建 Supabase 客户端
const SUPABASE_URL = 'https://reccclnaxadbuccsrwmg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJlY2NjbG5heGFkYnVjY3Nyd21nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDQyOTExODYsImV4cCI6MjA1OTg2NzE4Nn0.nHkOtkUtkzEUnF9ajUipD37SbAGH9znkVekI8N6hvdo';

// 创建 Supabase 客户端
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// 导出 Supabase 客户端
window.supabase = {
  auth: {
    verifyOtp: async (params) => {
      return supabase.auth.verifyOtp(params);
    }
  }
};

export { supabase };
