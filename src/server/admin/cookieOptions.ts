/**
 * 管理画面のログインの cookie の属性（セキュリティ点検 A11）。`@supabase/ssr` の既定は `httpOnly: false`・`Secure` なし。
 * ブラウザ側の Supabase クライアントは使わず（cookie を読むのはサーバーの `createServerClient` だけ）、
 * ページの JS から認証の cookie を読む所も無いので、JS から読めない（XSS で盗まれにくい）・https でしか送らない形にする。
 *
 * - session.ts（Server Component / Server Action）と proxy.ts（トークンの更新）の両方の `createServerClient` に同じ値を渡すこと。
 *   属性が食い違うと、書いた cookie を消すとき（ログアウト）に別の cookie として残る
 * - `secure` は本番だけ。`next dev` の http://localhost で cookie が付かなくなるのを避ける
 * - 有効期間（maxAge）はここで変えられない。`@supabase/ssr` が書くときに 400 日で上書きする
 */
import type { CookieOptionsWithName } from '@supabase/ssr';

export function adminCookieOptions(nodeEnv: string | undefined = process.env.NODE_ENV): CookieOptionsWithName {
  return { httpOnly: true, secure: nodeEnv === 'production', sameSite: 'lax' };
}
