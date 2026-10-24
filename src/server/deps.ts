/**
 * 本番の部品の組み立て（Supabase・LINE・Claude・Resend）。テストは handleEvent に偽物の Deps を渡す。
 * 担当者へのメール通知は Resend。RESEND_API_KEY と STAFF_NOTIFY_EMAIL が揃わないときはログで代える。
 */
import { createSupabaseRepositories } from '@/lib/db';
import { isDemoMode, optionalEnv } from '@/lib/env';
import { createLineMessenger } from '@/lib/line/messenger';
import { generateAnswer } from '@/lib/llm/answer';
import { createAnthropicClient, type Logger } from '@/lib/llm/client';
import { applyWalkNoPreference } from '@/domain/normalize';
import { extractIntentAndSlots, toShownProperties, withKeywordSafetyNet } from '@/lib/llm/extract';
import { createResendNotifier } from '@/lib/notify/resend';
import type { Answerer, Deps, Extractor, StaffNotifier } from './handleEvent';

/** DAILY_COST_LIMIT_USD が無いときの1日の API 費用上限（USD） */
const DEFAULT_DAILY_COST_LIMIT_USD = 5;
/** NOTIFY_FROM_EMAIL が無いときの差出人（Resend の検証用アドレス。Resend に登録したメールアドレスにだけ届く） */
const DEFAULT_NOTIFY_FROM = 'お部屋探しAI <onboarding@resend.dev>';

/** 評価（scripts/eval.ts）でモデルを差し替え、ログを集めるための口。本番は既定のまま */
export interface LlmStageOptions {
  model?: string;
  logger?: Logger;
  /** false で辞書の前段を通さない抽出にする（「辞書なし」の測定用。抽出だけに効く。本番は既定の true） */
  useDictionary?: boolean;
}

export function createExtractor(client = createAnthropicClient(), options: LlmStageOptions = {}): Extractor {
  return async ({ utterance, slots, shown, now }) => {
    const out = await extractIntentAndSlots({
      utterance,
      slots,
      now,
      client,
      model: options.model,
      logger: options.logger,
      useDictionary: options.useDictionary,
      shown: toShownProperties(shown, slots),
    });
    // 抽出に2回失敗して offTopic に倒れたときだけ、禁止トピックを語で拾う安全網をかける。
    // 「駅から遠くてもいい」は語で拾って徒歩の条件にする（プロンプトの規則にすると他の徒歩の発話が崩れた。意思決定ログ29）
    const result = applyWalkNoPreference(withKeywordSafetyNet(out.result, utterance, out.fallback), utterance);
    return { result, latencyMs: out.latencyMs, costUsd: out.costUsd, model: out.model };
  };
}

/**
 * 回答生成の1回の待ち時間の上限。条件抽出（30 秒・再試行 1 回）のあとに続くので、短くして再試行もしない。
 * Webhook の maxDuration（60 秒）に収め、時間切れでも引き継ぎ文で返せるようにする（実測 1.8〜5.8 秒）
 */
const ANSWER_TIMEOUT_MS = 15_000;

/**
 * 回答生成（Sonnet 5.5・ツール1回）＋根拠検証（`src/domain/verify.ts`）。意思決定ログ6。
 * 安全分類器の拒否でもサーバー側のフォールバックは使わない（拒否は引き継ぎに倒せば安全で、
 * 料金表に無いモデルで応答されると費用の計上が例外になるため）
 */
export function createAnswerer(
  client = createAnthropicClient({ timeoutMs: ANSWER_TIMEOUT_MS, maxRetries: 0 }),
  options: LlmStageOptions = {},
): Answerer {
  return async ({ question, targets, now }) => {
    const out = await generateAnswer({ question, targets, now, client, model: options.model, logger: options.logger });
    return {
      text: out.text,
      handoff: out.handoff,
      verification: out.verification,
      latencyMs: out.latencyMs,
      costUsd: out.costUsd,
      toolCalls: out.record,
    };
  };
}

/** 担当者通知のログ版（Resend の設定が無いとき）。質問の本文・個人情報はログに出さない */
export const logNotifier: StaffNotifier = {
  async viewingRequested(info) {
    console.log(
      `[notify] 内見の仮受付 id=${info.viewingRequestId} 候補=${info.candidateTimes.length}件 時間外=${info.receivedOutsideHours}`,
    );
  },
  async handoffRequested(info) {
    console.log(
      `[notify] 引き継ぎメモ 会話=${info.conversationId} 話題=${info.topic ?? 'なし'} 物件=${info.propertyNames.length}件 時間外=${info.receivedOutsideHours}`,
    );
  },
  async userRepliedWhilePaused(info) {
    console.log(`[notify] 担当者対応中の返信 会話=${info.conversationId} 時間外=${info.receivedOutsideHours}`);
  },
};

/** 通知メールの管理画面リンクの起点。APP_BASE_URL → Vercel の本番 URL → ローカル。末尾の / は落とす */
function resolveBaseUrl(): string {
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const url = optionalEnv('APP_BASE_URL') ?? (vercel ? `https://${vercel}` : 'http://localhost:3000');
  return url.replace(/\/+$/, '');
}

/** RESEND_API_KEY と STAFF_NOTIFY_EMAIL の両方があれば Resend のメール、無ければログだけ */
export function createNotifier(): StaffNotifier {
  const apiKey = optionalEnv('RESEND_API_KEY');
  const to = optionalEnv('STAFF_NOTIFY_EMAIL');
  if (!apiKey || !to) return logNotifier;
  return createResendNotifier({
    apiKey,
    to,
    from: optionalEnv('NOTIFY_FROM_EMAIL') ?? DEFAULT_NOTIFY_FROM,
    baseUrl: resolveBaseUrl(),
  });
}

export function createProductionDeps(): Deps {
  const limit = Number(optionalEnv('DAILY_COST_LIMIT_USD') ?? DEFAULT_DAILY_COST_LIMIT_USD);
  return {
    repos: createSupabaseRepositories(),
    messenger: createLineMessenger(),
    extract: createExtractor(),
    answer: createAnswerer(),
    notifier: createNotifier(),
    clock: () => new Date(),
    dailyCostLimitUsd: Number.isFinite(limit) ? limit : DEFAULT_DAILY_COST_LIMIT_USD,
    demoMode: isDemoMode(),
  };
}
