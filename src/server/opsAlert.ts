/**
 * 運営者への通知（AI が止まった・1日の費用の上限で止めた・処理が落ちた・毎朝のジョブが失敗した）。引き継ぎ書11章「止まったら困るものと監視」の通知の口。
 *
 * - 担当者への通知（StaffNotifier）と分けるのは、製品では宛先が違うため。Anthropic のキーと残高を持つのは開発者で、
 *   担当者は発注者の社員（意思決定ログ41）。宛先は OPS_NOTIFY_EMAIL、無ければ STAFF_NOTIFY_EMAIL（src/server/deps.ts）
 * - 利用者の発話・LINE の表示名・LINE ユーザー ID は渡さない（不変条件 15）
 * - 実装は例外を投げない（通知の失敗で利用者への返信を止めない）
 */
import type { LlmOutage } from '@/lib/llm/client';

/** 毎朝のジョブ（src/server/demoSeed.ts の runDailyJob）の段。setup はジョブを始められなかった（環境変数が無いなど） */
export type DailyJobStep = 'setup' | 'demo' | 'viewer' | 'purge';

export interface OpsNotifier {
  /** 残高切れ・キーの無効や失効で、AI が返事を作れない（利用者には「混み合っています」か引き継ぎ文を返している） */
  aiUnavailable(info: { outage: LlmOutage; source: 'webhook' | 'cron' }): Promise<void>;
  /** 1日の API 費用の上限（DAILY_COST_LIMIT_USD）に達し、日付が変わるまで全員に「混み合っています」を返している */
  costLimitReached(info: { limitUsd: number; spentUsd: number }): Promise<void>;
  /** LINE のイベント1件の処理が例外で落ちた（利用者に返事が届いていないかもしれない） */
  webhookFailed(info: { eventType: string }): Promise<void>;
  /** 毎朝のジョブの段が失敗した */
  dailyJobFailed(info: { steps: DailyJobStep[] }): Promise<void>;
}

/** Resend の設定が無いときのログ版 */
export const logOpsNotifier: OpsNotifier = {
  async aiUnavailable(info) {
    console.error(`[ops] AI が返事を作れません 原因=${info.outage} 経路=${info.source}`);
  },
  async costLimitReached(info) {
    console.error(`[ops] 1日の費用の上限に達しました 上限=$${info.limitUsd} 今日=$${info.spentUsd.toFixed(4)}`);
  },
  async webhookFailed(info) {
    console.error(`[ops] LINE のイベントの処理が失敗しました type=${info.eventType}`);
  },
  async dailyJobFailed(info) {
    console.error(`[ops] 毎朝のジョブが失敗しました 段=${info.steps.join(',')}`);
  },
};

/**
 * 同じ種類の通知を intervalMs に1回までに間引く（残高切れの間、発話のたびにメールが出ないように）。
 * 覚えておくのはこのインスタンスのメモリの中だけなので、Vercel のインスタンスが複数あれば、その数だけ届きうる。
 * 毎朝のジョブの通知は1日1回しか起きないので間引かない
 */
export function throttleOps(inner: OpsNotifier, options: { intervalMs: number; clock: () => Date }): OpsNotifier {
  const lastSent = new Map<string, number>();
  const once = async (key: string, notify: () => Promise<void>): Promise<void> => {
    const now = options.clock().getTime();
    const last = lastSent.get(key);
    if (last !== undefined && now - last < options.intervalMs) return;
    // 送る前に記録する（同時に届いた発話で2通出さない）
    lastSent.set(key, now);
    await notify();
  };
  return {
    aiUnavailable: (info) => once(`ai:${info.outage}`, () => inner.aiUnavailable(info)),
    costLimitReached: (info) => once('cost', () => inner.costLimitReached(info)),
    webhookFailed: (info) => once('webhook', () => inner.webhookFailed(info)),
    dailyJobFailed: (info) => inner.dailyJobFailed(info),
  };
}

/** 通知は実装が投げない約束だが、投げても呼び出し側の処理を止めない */
export async function notifyOpsSafely(label: string, notify: () => Promise<void>): Promise<void> {
  try {
    await notify();
  } catch (error) {
    console.error(`[ops] 運営者への通知（${label}）に失敗しました`, error instanceof Error ? error.name : 'unknown');
  }
}
