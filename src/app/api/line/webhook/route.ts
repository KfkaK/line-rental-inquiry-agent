import { after } from 'next/server';
import type { webhook } from '@line/bot-sdk';
import { requireEnv } from '@/lib/env';
import { verifySignature } from '@/lib/line/signature';
import { processWebhook } from '@/server/processWebhook';

/**
 * LINE Webhook。署名を検証してすぐ 200 を返し、本処理は `after()` で続ける（DESIGN.md 6.1・不変条件 7）。
 * `after()` のコールバックはレスポンス後もこの値の秒数まで走れる（Vercel は waitUntil で関数を延命する）。
 * Cache Components 有効下では `dynamic` などの Route Segment Config は使えないが、`maxDuration` は使える。
 */
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  // 署名は加工前のバイト列で検証する（JSON.parse して再シリアライズしたものでは一致しない）
  const rawBody = Buffer.from(await request.arrayBuffer());

  let channelSecret: string;
  try {
    channelSecret = requireEnv('LINE_CHANNEL_SECRET');
  } catch (error) {
    console.error('[line webhook] チャネルシークレットが未設定です', error instanceof Error ? error.message : error);
    return new Response('server misconfigured', { status: 500 });
  }

  if (!verifySignature(rawBody, request.headers.get('x-line-signature'), channelSecret)) {
    return new Response('invalid signature', { status: 401 });
  }

  let body: webhook.CallbackRequest;
  try {
    const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
    if (!isCallbackRequest(parsed)) return new Response('invalid body', { status: 400 });
    body = parsed;
  } catch {
    return new Response('invalid json', { status: 400 });
  }

  after(async () => {
    try {
      await processWebhook(body);
    } catch (error) {
      // after の中の例外は握りつぶされるので、ここでログに残す（ボディ・ユーザー情報は出さない）
      console.error('[line webhook] processWebhook が失敗しました', error);
    }
  });

  return new Response('OK', { status: 200 });
}

/** 署名が正しくても形は検証する（events が配列であること）。LINE の疎通確認は events が空で届く */
function isCallbackRequest(value: unknown): value is webhook.CallbackRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { events?: unknown }).events)
  );
}
