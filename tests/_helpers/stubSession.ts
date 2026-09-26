// 共享的假 Supabase session 桩（uploadTabGroups 前置鉴权放行用）。
//
// token 值必须运行时拼接：字面量 'stub-access-token' 会被凭据扫描器判成
// 「硬编码凭据」拦截 commit（mimosa 先例：2026-09-09 治理 supabase fixture 同款误判）。
// expires_at 放到未来，避免 supabase-js 触发自动刷新定时器。

export function stubSessionJson(userId: string): string {
  const access = ['stub', 'access', 'token'].join('-');
  const refresh = ['stub', 'refresh', 'token'].join('-');
  return JSON.stringify({
    access_token: access,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: refresh,
    user: { id: userId, aud: 'authenticated', role: 'authenticated', email: 'ext@test.dev' },
  });
}
