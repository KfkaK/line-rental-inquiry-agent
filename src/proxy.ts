/**
 * Proxy（Next.js 16 で Middleware から改名）。管理画面（/admin）へのリクエストごとに Supabase のセッションを確かめ、
 * 期限の近いアクセストークンを更新して cookie に書き戻す（Server Component は cookie を書けないため、ここで行う）。
 * 未ログインならログイン画面へ送るが、これは見た目の近道で、権限の判定はページと Server Action（src/server/admin/session.ts）と RLS が行う。
 * Webhook（/api/line/webhook）は通さない（matcher で /admin だけ）。
 */
import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { optionalEnv } from '@/lib/env';
import { adminCookieOptions } from '@/server/admin/cookieOptions';
import { isAdminPreview } from '@/server/admin/previewFlag';

const LOGIN_PATH = '/admin/login';

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const url = optionalEnv('SUPABASE_URL');
  const key = optionalEnv('SUPABASE_PUBLISHABLE_KEY');
  // プレビュー・未設定（キーを入れる前）はそのまま通す。ページ側が設定の不足を表示する
  if (isAdminPreview() || !url || !key) return NextResponse.next({ request });

  let response = NextResponse.next({ request });
  // 認証の cookie を書くときに付けるキャッシュ禁止のヘッダー（リダイレクトにも同じものを付ける）
  let authHeaders: Record<string, string> = {};
  const supabase = createServerClient(url, key, {
    // session.ts と同じ属性にする（食い違うとログアウトで消えない cookie が残る）
    cookieOptions: adminCookieOptions(),
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        // 認証の cookie を書くレスポンスは CDN にキャッシュさせない（他人のセッションが配られないように）
        authHeaders = headers;
        for (const [header, value] of Object.entries(headers)) response.headers.set(header, value);
      },
    },
  });

  // getClaims がトークンを検証し、必要なら更新して setAll を呼ぶ。この間に別の処理を挟まない
  const { data } = await supabase.auth.getClaims();
  const loggedIn = !!data?.claims;
  if (!loggedIn && request.nextUrl.pathname !== LOGIN_PATH) {
    const redirect = NextResponse.redirect(new URL(LOGIN_PATH, request.url));
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    for (const [header, value] of Object.entries(authHeaders)) redirect.headers.set(header, value);
    return redirect;
  }
  return response;
}

export const config = {
  matcher: ['/admin/:path*', '/admin'],
};
