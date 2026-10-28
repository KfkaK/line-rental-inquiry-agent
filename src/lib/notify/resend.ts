import { formatViewingTime, TOPIC_LABEL } from '@/domain/messages';
import type { LlmOutage } from '@/lib/llm/client';
import type { StaffNotifier } from '@/server/handleEvent';
import type { DailyJobStep, OpsNotifier } from '@/server/opsAlert';

/**
 * 担当者への通知メールと、運営者への通知メール（AI の停止・処理の失敗。src/server/opsAlert.ts）。Resend の REST API を fetch で呼ぶ（SDK は入れない）。
 *
 * - 個人情報（LINE ユーザー ID・表示名）は本文に入れない。詳細は管理画面のリンクで見てもらう（不変条件 12）
 * - 利用者の発言の本文は、どのメールにも載せない。引き継ぎ（AI が答えずに回した質問）の通知にも、担当者対応中の返信の通知にも載せず、
 *   質問の内容は管理画面の会話ログで確認してもらう。利用者が書いた偽の行やリンクが、会社の差出人のメールにそのまま載るのを防ぐため
 *   （セキュリティ点検 A6）。名前・電話番号の返事が入りうる点も同じ
 * - 実装は例外を投げない。HTTP エラー・ネットワークエラー・時間切れは console.error に操作名と status だけ出して握りつぶす
 *   （本文・宛先・API キーはログに出さない）。通知の失敗で利用者への返信や保存を止めない
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
/** 1通の送信の待ち時間の上限。Webhook の maxDuration（60 秒）に収める */
const SEND_TIMEOUT_MS = 10_000;
/** 話題が決まっていない引き継ぎ（レコードに無い情報・根拠検証の差し替え・回答生成の失敗）の件名 */
const UNKNOWN_TOPIC_SUBJECT = 'AIが答えられなかった質問';

export interface ResendNotifierOptions {
  apiKey: string;
  /** 宛先（担当者のメールアドレス） */
  to: string;
  /** 差出人（例: 'お部屋探しAI <onboarding@resend.dev>'） */
  from: string;
  /** 管理画面の URL の起点（例: https://line-rental-agent.vercel.app）。末尾の / は落とす */
  baseUrl: string;
  /** テストは偽物を渡す。省略時は globalThis.fetch */
  fetch?: typeof fetch;
}

export interface EmailContent {
  subject: string;
  text: string;
}

type ViewingInfo = Parameters<StaffNotifier['viewingRequested']>[0];
type HandoffInfo = Parameters<StaffNotifier['handoffRequested']>[0];
type PausedReplyInfo = Parameters<StaffNotifier['userRepliedWhilePaused']>[0];

/** 件名に改行を入れない（物件名などに紛れても1行に保つ） */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function receptionLine(outsideHours: boolean): string {
  return `受付: ${outsideHours ? '営業時間外' : '営業時間内'}`;
}

export function buildViewingEmail(info: ViewingInfo, baseUrl: string): EmailContent {
  const subject = `【内見の仮受付】${oneLine(info.propertyName)}${info.receivedOutsideHours ? '（営業時間外）' : ''}`;
  const times = info.candidateTimes.map((t) => `・${formatViewingTime(t)}`);
  const text = [
    '内見の仮受付が届きました。',
    '',
    `物件: ${info.propertyName}`,
    '候補日時:',
    ...times,
    receptionLine(info.receivedOutsideHours),
    '',
    `詳細: ${baseUrl}/admin/viewings/${info.viewingRequestId}`,
    '',
    'AI は内見を確定していません。確定・却下は管理画面で行ってください。',
  ].join('\n');
  return { subject, text };
}

/** AI が答えずに回した質問の通知。利用者の発話（`info.question`）は載せない（buildPausedReplyEmail と同じ考え方）。内容はリンク先の会話ログで */
export function buildHandoffEmail(info: HandoffInfo, baseUrl: string): EmailContent {
  const subject = `【引き継ぎ】${info.topic ? TOPIC_LABEL[info.topic] : UNKNOWN_TOPIC_SUBJECT}`;
  const lines = ['AI が答えずに担当者へ回した質問があります。', '質問の内容は管理画面の会話ログで確認してください。', ''];
  if (info.propertyNames.length > 0) lines.push(`対象物件: ${info.propertyNames.join('、')}`);
  lines.push(
    receptionLine(info.receivedOutsideHours),
    '',
    `会話の詳細: ${baseUrl}/admin/conversations/${info.conversationId}`,
  );
  return { subject, text: lines.join('\n') };
}

/** 担当者が対応中（AI 停止中）の会話への利用者の返信。本文は載せない（担当者が聞いた個人情報の返事が入りうる）。詳細はリンク先で */
export function buildPausedReplyEmail(info: PausedReplyInfo, baseUrl: string): EmailContent {
  const subject = `【返信あり】担当者が対応中の会話${info.receivedOutsideHours ? '（営業時間外）' : ''}`;
  const text = [
    '担当者が対応中（AI 停止中）の会話に、利用者から返信がありました。',
    '',
    receptionLine(info.receivedOutsideHours),
    '',
    `会話の詳細: ${baseUrl}/admin/conversations/${info.conversationId}`,
    '',
    'AI は最終の担当者返信から 24 時間で自動で再開します。',
  ].join('\n');
  return { subject, text };
}

const OUTAGE_LABEL: Record<LlmOutage, string> = {
  credit: 'Anthropic の前払いクレジットの残高切れ',
  auth: 'Anthropic の API キーが無効か期限切れ',
};

const OUTAGE_FIX: Record<LlmOutage, string> = {
  credit: 'https://platform.claude.com/settings/billing でクレジットを足してください（自動チャージと月の上限もここで設定できます）。',
  auth: 'キーを作り直して Vercel の ANTHROPIC_API_KEY を差し替え、Redeploy してください（手順は引き継ぎ書6章①）。',
};

const DAILY_STEP_LABEL: Record<DailyJobStep, string> = {
  setup: 'ジョブの起動（環境変数を確かめる）',
  demo: 'デモ会話の作り直し',
  viewer: '閲覧用アカウントのパスワードを戻す',
  purge: '会話ログの90日削除',
};

/** AI が返事を作れない（残高切れ・キーの失効）。運営者向け。利用者のことは何も載せない */
export function buildAiUnavailableEmail(info: Parameters<OpsNotifier['aiUnavailable']>[0]): EmailContent {
  return {
    subject: `【要対応】AI が返事を作れません（${OUTAGE_LABEL[info.outage]}）`,
    text: [
      'LINE の問い合わせに、AI が返事を作れなくなっています。',
      '利用者には「ただいま混み合っています」（物件への質問には担当者への引き継ぎ文）を返しています。',
      '',
      `原因: ${OUTAGE_LABEL[info.outage]}`,
      `対処: ${OUTAGE_FIX[info.outage]}`,
      '',
      `気づいた経路: ${info.source === 'cron' ? '毎朝の確認（Cron）' : '利用者の発話の処理'}`,
      '直るまで、毎朝の確認でも同じ通知が届きます。',
    ].join('\n'),
  };
}

/** 1日の API 費用の上限に達した。運営者向け */
export function buildCostLimitEmail(info: Parameters<OpsNotifier['costLimitReached']>[0]): EmailContent {
  return {
    subject: `【確認】1日の AI の費用が上限（$${info.limitUsd}）に達しました`,
    text: [
      `今日（日本時間）の AI の費用が $${info.spentUsd.toFixed(2)} になり、上限 $${info.limitUsd}（DAILY_COST_LIMIT_USD）に達しました。`,
      '日付が変わるまで、すべての利用者に「ただいま混み合っています」と返しています。',
      '',
      '想定より多いときは、管理画面の会話ログで同じ人の連投や、長い発話の繰り返しがないかを確かめてください。',
      '上限を変えるなら Vercel の DAILY_COST_LIMIT_USD を変えて Redeploy してください。',
    ].join('\n'),
  };
}

/** LINE のイベントの処理が例外で落ちた。運営者向け */
export function buildWebhookFailedEmail(info: Parameters<OpsNotifier['webhookFailed']>[0]): EmailContent {
  return {
    subject: '【要対応】LINE の問い合わせの処理が失敗しました',
    text: [
      `LINE から届いたイベント（種類: ${oneLine(info.eventType)}）の処理が途中で失敗しました。利用者に返事が届いていないかもしれません。`,
      'Vercel の Logs で「[processWebhook]」を検索して原因を確かめてください（DB・LINE の障害、キーの差し替え漏れなど）。',
      '',
      '続けて失敗しても、同じ通知はしばらくの間1通にまとめています。',
    ].join('\n'),
  };
}

/** 毎朝のジョブの段が失敗した。運営者向け */
export function buildDailyJobFailedEmail(info: Parameters<OpsNotifier['dailyJobFailed']>[0]): EmailContent {
  const labels = info.steps.map((step) => DAILY_STEP_LABEL[step]);
  return {
    subject: `【要対応】毎朝のジョブが失敗しました（${labels.join('・')}）`,
    text: [
      '毎朝のジョブ（/api/cron/daily）で、次の段が失敗しました。',
      ...labels.map((label) => `・${label}`),
      '',
      'Vercel の Logs で「[cron daily]」を検索して原因を確かめてください。デモ会話の作り直しが失敗したときは、前日のデモ会話が残っています。',
    ].join('\n'),
  };
}

/** Resend で1通送る口。例外を投げない（失敗は操作名と status だけをログに出す） */
function createSender(options: ResendNotifierOptions): (operation: string, build: () => EmailContent) => Promise<void> {
  return async (operation, build) => {
    try {
      const email = build();
      const doFetch = options.fetch ?? globalThis.fetch;
      const response = await doFetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: options.from, to: [options.to], subject: email.subject, text: email.text }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!response.ok) console.error(`[notify] ${operation}のメール送信に失敗しました status=${response.status}`);
    } catch (error) {
      // メッセージには宛先や URL が入りうるので、エラーの種類（TimeoutError など）だけ残す
      console.error(`[notify] ${operation}のメール送信に失敗しました`, error instanceof Error ? error.name : 'unknown');
    }
  };
}

export function createResendNotifier(options: ResendNotifierOptions): StaffNotifier {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const send = createSender(options);
  return {
    viewingRequested: (info) => send('内見の仮受付', () => buildViewingEmail(info, baseUrl)),
    handoffRequested: (info) => send('引き継ぎ', () => buildHandoffEmail(info, baseUrl)),
    userRepliedWhilePaused: (info) => send('担当者対応中の返信', () => buildPausedReplyEmail(info, baseUrl)),
  };
}

/** 運営者への通知（src/server/opsAlert.ts）。宛先は運営者（options.to）。baseUrl は使わない（管理画面へのリンクを載せない） */
export function createResendOpsNotifier(options: ResendNotifierOptions): OpsNotifier {
  const send = createSender(options);
  return {
    aiUnavailable: (info) => send('AI の停止', () => buildAiUnavailableEmail(info)),
    costLimitReached: (info) => send('費用の上限', () => buildCostLimitEmail(info)),
    webhookFailed: (info) => send('イベントの処理の失敗', () => buildWebhookFailedEmail(info)),
    dailyJobFailed: (info) => send('毎朝のジョブの失敗', () => buildDailyJobFailedEmail(info)),
  };
}
