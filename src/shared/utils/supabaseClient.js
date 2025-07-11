// 导入 Supabase 客户端
import { createClient } from '@supabase/supabase-js';

// 从环境变量中获取 Supabase 配置
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// 检查环境变量是否存在
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('错误: Supabase 配置缺失。请确保在 .env 文件中设置了 VITE_SUPABASE_URL 和 VITE_SUPABASE_ANON_KEY。');
}

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
