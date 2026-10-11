import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Vercel Cron の認証。Vercel は環境変数 CRON_SECRET があると `Authorization: Bearer <CRON_SECRET>` を付けて呼ぶ。
 *
 * - 比較は定数時間（`timingSafeEqual`）。長さの違いが漏れないよう、両方を SHA-256 にして同じ長さにしてから比べる
 * - ヘッダが無い・`Bearer ` で始まらない・秘密が空のときは false（例外にしない）。秘密が空のときに
 *   「Bearer 」だけのヘッダを通してしまわないよう、空の秘密は常に不一致にする
 */
export function isCronAuthorized(authorization: string | null, secret: string): boolean {
  if (!authorization || !secret) return false;
  const prefix = 'Bearer ';
  if (!authorization.startsWith(prefix)) return false;
  return timingSafeEqual(digest(authorization.slice(prefix.length)), digest(secret));
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
