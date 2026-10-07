import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * LINE Webhook の署名（x-line-signature）を検証する。
 *
 * - 検証対象は**加工前のボディ**（JSON.parse して再シリアライズしたものでは一致しない）。
 *   文字化け・BOM 除去の影響を避けたいときは、文字列でなくバイト列（Uint8Array）で渡す。
 * - HMAC-SHA256 → base64 を `timingSafeEqual` で比較する。長さが違えば false。
 * - 署名ヘッダが無い（null・空）、チャネルシークレットが空のときも false（例外にしない）。
 */
export function verifySignature(
  rawBody: string | Uint8Array,
  signature: string | null,
  channelSecret: string,
): boolean {
  if (!signature || !channelSecret) return false;

  const expected = Buffer.from(createHmac('sha256', channelSecret).update(rawBody).digest('base64'));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}
