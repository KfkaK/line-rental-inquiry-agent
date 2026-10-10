import { formatViewingTime, TOPIC_LABEL } from '@/domain/messages';
import type { StaffNotifier } from '@/server/handleEvent';

/**
 * 担当者への通知メール（Resend の REST API を fetch で呼ぶ。SDK は入れない）。
 *
 * - 個人情報（LINE ユーザー ID・表示名）は本文に入れない。詳細は管理画面のリンクで見てもらう（不変条件 12）
 * - 担当者対応中の返信の通知にも利用者の発言の本文は載せない（名前・電話番号の返事が入りうる）
 * - 実装は例外を投げない。HTTP エラー・ネットワークエラー・時間切れは console.error に操作名と status だけ出して握りつぶす
 *   （本文・宛先・API キーはログに出さない）。通知の失敗で利用者への返信や保存を止めない
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
/** 1通の送信の待ち時間の上限。Webhook の maxDuration（60 秒）に収める */
const SEND_TIMEOUT_MS = 10_000;
/** 引き継ぎメールに載せる質問の最大文字数（超えたら「…」で切る） */
export const QUESTION_MAX_CHARS = 200;
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

/** 200 字（サロゲートペアは1字と数える）を超えたら切って「…」を付ける */
export function truncateQuestion(question: string, max = QUESTION_MAX_CHARS): string {
  const chars = Array.from(question);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : question;
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

export function buildHandoffEmail(info: HandoffInfo, baseUrl: string): EmailContent {
  const subject = `【引き継ぎ】${info.topic ? TOPIC_LABEL[info.topic] : UNKNOWN_TOPIC_SUBJECT}`;
  const lines = ['AI が答えずに担当者へ回した質問があります。', '', `質問: ${truncateQuestion(info.question)}`];
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

export function createResendNotifier(options: ResendNotifierOptions): StaffNotifier {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const send = async (operation: string, build: () => EmailContent): Promise<void> => {
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

  return {
    viewingRequested: (info) => send('内見の仮受付', () => buildViewingEmail(info, baseUrl)),
    handoffRequested: (info) => send('引き継ぎ', () => buildHandoffEmail(info, baseUrl)),
    userRepliedWhilePaused: (info) => send('担当者対応中の返信', () => buildPausedReplyEmail(info, baseUrl)),
  };
}
