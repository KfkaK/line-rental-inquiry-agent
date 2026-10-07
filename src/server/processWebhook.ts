import type { webhook } from '@line/bot-sdk';
import { createProductionDeps } from './deps';
import { handleEvent, type Deps } from './handleEvent';

let productionDeps: Deps | null = null;

/**
 * Webhook 本体の処理（`after()` の中で呼ばれる。200 は先に返してある）。
 * 同じユーザーの発話の順序を保つため、イベントは届いた順に1件ずつ処理する。
 * 1件の失敗で残りを止めない。ログには本文・ユーザー ID を出さない。
 */
export async function processWebhook(body: webhook.CallbackRequest, deps?: Deps): Promise<void> {
  const d = deps ?? (productionDeps ??= createProductionDeps());
  for (const event of body.events) {
    try {
      await handleEvent(event, d);
    } catch (error) {
      console.error(`[processWebhook] イベントの処理に失敗 type=${event.type}`, error instanceof Error ? error.message : error);
    }
  }
}
