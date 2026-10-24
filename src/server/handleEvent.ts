/**
 * LINE のイベント1件を処理する（I/O の層）。判断は会話エンジン `decideTurn`（純関数）に任せ、
 * ここでは 重複排除 → 有人対応中の判定 → レート制限と費用上限 → 条件抽出（LLM）→ 判断 → 回答生成（LLM）
 * → 保存 → 送信 → 担当者通知 だけを行う。外部サービスはすべて Deps で差し込む（不変条件 10）。
 */
import type { webhook } from '@line/bot-sdk';
import { fromJst, isOpenAt, nextContactDay, toJst } from '@/domain/businessHours';
import * as msg from '@/domain/messages';
import { isOpenViewing } from '@/domain/staff';
import {
  AI_RESUME_AFTER_MS,
  DAILY_TURNS_PER_USER,
  EVENT_RATE_LIMIT_PER_MINUTE,
  RATE_LIMIT_PER_MINUTE,
  UTTERANCE_MAX_CHARS,
} from '@/domain/rules';
import { decideTurn, isUnstarted, type ButtonEvent, type ConversationSnapshot, type TurnEvent } from '@/domain/turn';
import type { ExtractionResult, ForbiddenTopic, Property, Slots } from '@/domain/types';
import type { Conversation, Repositories, Verification } from '@/lib/db';
import type { LineMessenger, LineMessage } from '@/lib/line/messenger';
import { parseButtonEvent, renderMessages, type RenderBlock } from './render';

// ---------- 差し込む外部の処理 ----------

export interface ExtractInput {
  utterance: string;
  slots: Slots;
  /** 提示済みの物件（表示番号つき）。「2番目」「さっきの安い方」の解決に使う */
  shown: { position: number; property: Property }[];
  now: Date;
}
export interface ExtractOutput {
  result: ExtractionResult;
  latencyMs: number;
  costUsd: number;
  model: string;
}
/** 意図分類＋条件抽出（安いモデル） */
export type Extractor = (input: ExtractInput) => Promise<ExtractOutput>;

export interface AnswerInput {
  question: string;
  targets: { property: Property; position: number | null }[];
  now: Date;
}
export interface AnswerOutput {
  /** 利用者に送る回答文（根拠検証を通ったものだけ）。null なら送らない */
  text: string | null;
  /** 担当者へ回すとき（レコードに無い情報・禁止トピック・差し替え）。定型の引き継ぎ文を足し、引き継ぎメモを残す */
  handoff: { topic: ForbiddenTopic | null } | null;
  /** ok: そのまま / replaced: 根拠検証で不一致になり定型の引き継ぎ文に差し替えた */
  verification: Verification;
  latencyMs: number;
  costUsd: number;
  /** messages.tool_calls に残す記録（不一致の回答を評価セットに足すため。DESIGN.md 4.3） */
  toolCalls?: unknown;
}
/** 提示物件への質問の回答生成＋根拠検証 */
export type Answerer = (input: AnswerInput) => Promise<AnswerOutput>;

/**
 * 担当者への通知（メール）。個人情報（LINE ユーザー ID・表示名）は渡さず、管理画面へのリンクで詳細を見てもらう。
 * 実装は例外を投げない（通知の失敗で利用者への返信や保存を止めない）
 */
export interface StaffNotifier {
  viewingRequested(info: {
    viewingRequestId: string;
    conversationId: string;
    propertyName: string;
    candidateTimes: string[];
    receivedOutsideHours: boolean;
  }): Promise<void>;
  /** 引き継ぎメモ（AI が答えずに担当者へ回した質問）。会話に未対応のメモが無かったときだけ呼ぶ（続けて届いたメモでメールを重ねない） */
  handoffRequested(info: {
    conversationId: string;
    /** 利用者の発話（原文） */
    question: string;
    topic: ForbiddenTopic | null;
    /** 質問の対象物件の名前。無ければ空 */
    propertyNames: string[];
    receivedOutsideHours: boolean;
  }): Promise<void>;
  /**
   * 担当者が対応中（AI 停止中）の会話に、利用者から返信があった。最終の担当者返信につき最初の発言のときだけ呼ぶ
   * （続けて届いた発言でメールを重ねない）。
   * **利用者の発言の本文は渡さない**（担当者が聞いた名前・電話番号の返事が入りうるので、メールに個人情報を載せない）。
   * 詳細は管理画面の会話ログで見てもらう
   */
  userRepliedWhilePaused(info: { conversationId: string; receivedOutsideHours: boolean }): Promise<void>;
}

export interface Deps {
  repos: Repositories;
  messenger: LineMessenger;
  extract: Extractor;
  answer: Answerer;
  notifier: StaffNotifier;
  clock: () => Date;
  dailyCostLimitUsd: number;
  /**
   * 公開デモ（環境変数 DEMO_MODE=1）。あいさつと引き継ぎ・仮受付の文に「デモのため担当者からの連絡はありません」を足す。
   * 省略は false（Deps を組み立てるほかの処理を壊さないよう必須にしない）
   */
  demoMode?: boolean;
}

/** 入力中アニメーションの秒数（LLM の待ち時間の体感を下げる。DESIGN.md 4.4） */
const LOADING_SECONDS = 20;
const MINUTE_MS = 60 * 1000;

// ---------- 本体 ----------

export async function handleEvent(event: webhook.Event, deps: Deps): Promise<void> {
  const { repos, messenger } = deps;
  const startedAt = deps.clock();

  // 再送による二重処理を防ぐ（DESIGN.md 6.1）
  if (!(await repos.webhookEvents.markIfNew(event.webhookEventId))) return;

  const userId = event.source?.type === 'user' ? event.source.userId : undefined;
  if (!userId) return;
  const replyToken = 'replyToken' in event ? event.replyToken : undefined;

  // ---- イベント → 会話エンジンへの入力 ----
  let userText: string;
  let button: ButtonEvent | null = null;
  let nonText = false;
  switch (event.type) {
    case 'follow': {
      const profile = await messenger.getProfile(userId);
      await repos.lineUsers.upsert({ lineUserId: userId, displayName: profile?.displayName ?? null });
      userText = '[友だち追加]';
      break;
    }
    case 'message': {
      await repos.lineUsers.upsert({ lineUserId: userId });
      // 画像・スタンプなどは、有人対応中かを見てから扱う（停止中に AI が定型文を返さない。不変条件 8・セキュリティ点検 A8）
      nonText = event.message.type !== 'text';
      userText = event.message.type === 'text' ? clip(event.message.text) : '[画像・スタンプなど]';
      break;
    }
    case 'postback': {
      button = parseButtonEvent(event.postback.data);
      if (!button) return; // 偽造・古い形式の data は無視する
      await repos.lineUsers.upsert({ lineUserId: userId });
      userText = `[ボタン] ${event.postback.data}`;
      break;
    }
    default:
      return; // unfollow など
  }

  let conv = await repos.conversations.getOrCreate(userId);

  // ---- 有人対応中は AI が返信しない（不変条件 8）。最終の担当者返信から 24 時間で自動再開 ----
  if (conv.aiPaused) {
    const last = conv.lastStaffReplyAt ? Date.parse(conv.lastStaffReplyAt) : null;
    if (last !== null && startedAt.getTime() - last >= AI_RESUME_AFTER_MS) {
      await repos.conversations.update(conv.id, { aiPaused: false, pausedAt: null });
      conv = { ...conv, aiPaused: false, pausedAt: null };
    } else {
      // 最終の担当者返信（無ければ停止）以降で、利用者の最初の発言のときだけ担当者へ知らせる。
      // 数えるのは保存の前（保存した後だと必ず 1 以上になる）
      const first = await isFirstUserMessageSinceStaff(repos, conv);
      await repos.messages.insert({ conversationId: conv.id, role: 'user', text: userText });
      if (first) {
        const conversationId = conv.id;
        // 本文は渡さない（StaffNotifier.userRepliedWhilePaused）。営業カレンダーの読み出しの失敗も通知の失敗として扱う
        await notifySafely('担当者対応中の返信', async () =>
          deps.notifier.userRepliedWhilePaused({
            conversationId,
            receivedOutsideHours: !isOpenAt(startedAt, await repos.businessCalendar.get()),
          }),
        );
      }
      return;
    }
  }

  if (nonText) {
    await send(messenger, userId, replyToken, [{ type: 'text', text: msg.textOnly() }]);
    return;
  }

  // ---- レート制限と1日の費用上限（LLM を呼ぶ自由文だけ。DESIGN.md 4.4） ----
  // 数えるのは条件抽出を通したターン。ボタン・友だち追加は LLM を呼ばないので数えない（意思決定ログ10）。
  // 1日の費用上限は全員で1つなので、利用者ごとの1日のターン数でも止める（1人で全員の枠を使い切らない。セキュリティ点検 A5）
  const isText = event.type === 'message';
  if (isText) {
    const today = fromJst(toJst(startedAt).date, '00:00');
    const recent = await repos.messages.countExtractedTurnsSince(userId, new Date(startedAt.getTime() - MINUTE_MS));
    const turnsToday = await repos.messages.countExtractedTurnsSince(userId, today);
    const spent = await repos.messages.sumCostSince(today);
    await repos.messages.insert({ conversationId: conv.id, role: 'user', text: userText });
    const refusal =
      event.message.type === 'text' && Array.from(event.message.text).length > UTTERANCE_MAX_CHARS
        ? msg.tooLong(UTTERANCE_MAX_CHARS)
        : turnsToday >= DAILY_TURNS_PER_USER
          ? msg.dailyLimitReached()
          : recent >= RATE_LIMIT_PER_MINUTE || spent >= deps.dailyCostLimitUsd
            ? msg.rateLimited()
            : null;
    if (refusal) {
      await send(messenger, userId, replyToken, [{ type: 'text', text: refusal }]);
      return;
    }
    await messenger.showLoading(userId, LOADING_SECONDS);
  } else if (button) {
    // LLM を呼ばない操作も、連打で DB と送信を埋めないよう緩く止める（保存はこのあと。数えるのはそれまでの発言）
    const recentEvents = await repos.messages.countUserMessagesSince(conv.id, new Date(startedAt.getTime() - MINUTE_MS));
    if (recentEvents >= EVENT_RATE_LIMIT_PER_MINUTE) {
      await send(messenger, userId, replyToken, [{ type: 'text', text: msg.rateLimited() }]);
      return;
    }
  }

  const [properties, calendar] = await Promise.all([repos.properties.listPublic(), repos.businessCalendar.get()]);
  const snapshot: ConversationSnapshot = {
    state: conv.state,
    slots: conv.slots,
    shownPropertyIds: conv.shownPropertyIds,
    priorityAskedCount: conv.priorityAskedCount,
    booking: conv.booking,
  };

  // ---- 条件抽出（自由文だけ） ----
  let turnEvent: TurnEvent;
  let extraction: ExtractOutput | null = null;
  if (event.type === 'follow') {
    turnEvent = { kind: 'follow' };
  } else if (button) {
    turnEvent = button;
  } else {
    try {
      extraction = await deps.extract({
        utterance: userText,
        slots: conv.slots,
        shown: shownWithPositions(conv, properties),
        now: startedAt,
      });
    } catch (error) {
      // API の障害（認証・429・ネット）。状態は進めず、時間をおいて送ってもらう
      console.error('[handleEvent] 条件抽出に失敗しました', error instanceof Error ? error.message : error);
      await send(messenger, userId, replyToken, [{ type: 'text', text: msg.rateLimited() }]);
      return;
    }
    turnEvent = { kind: 'text', text: userText, extraction: extraction.result };
  }

  // 営業時間外の案内をまだ出していない会話だけ、最初の発話に案内を足す（turn.ts）。
  // 時間外の友だち追加のあいさつは同じ一文を含むので、会話ログにその一文があるかで決める（営業時間内のあいさつは含まないので、
  // その後に時間外で話しかけられたら案内する）。時間外で、まだ何も始まっていない会話のときだけ読む
  const greeted =
    event.type === 'message' && isUnstarted(snapshot) && !isOpenAt(startedAt, calendar)
      ? await hasShownOutsideHoursNote(repos, conv.id)
      : false;
  const demo = deps.demoMode === true;
  // 未対応の仮受付（同じ物件の重複と、会話ごとの数の上限に使う。セキュリティ点検 A4）。友だち追加では内見に進まないので読まない
  const openViewings =
    event.type === 'follow'
      ? []
      : (await repos.viewingRequests.listByConversation(conv.id)).filter((v) => isOpenViewing(v.status)).map((v) => v.propertyId);
  const decision = decideTurn(snapshot, turnEvent, { now: startedAt, calendar, properties, demo, greeted, openViewings });

  // ---- 回答生成（提示物件への質問） ----
  const blocks: RenderBlock[] = [];
  let answerCost = 0;
  let verification: Verification | null = null;
  let toolCalls: unknown = null;
  for (const block of decision.replies) {
    if (block.type !== 'answer') {
      blocks.push(block);
      continue;
    }
    const handOff = (topic: ForbiddenTopic | null): string => {
      decision.handoffNote ??= { text: block.question, topic, propertyIds: block.targets.map((t) => t.property.id) };
      return msg.handoff(topic, !isOpenAt(startedAt, calendar), nextContactDay(startedAt, calendar), demo);
    };
    try {
      const answer = await deps.answer({ question: block.question, targets: block.targets, now: startedAt });
      answerCost += answer.costUsd;
      verification = answer.verification;
      toolCalls = answer.toolCalls ?? null;
      // 答えられた部分を先に、担当者へ回す旨を後ろに（「駐輪場の記載はありません。」＋「このご質問は担当者が確認します。…」）
      const parts = answer.text ? [answer.text] : [];
      if (answer.handoff || parts.length === 0) parts.push(handOff(answer.handoff?.topic ?? null));
      blocks.push({ type: 'text', text: parts.join('\n\n') });
    } catch (error) {
      // 回答生成に失敗したら推測で埋めず、担当者へ回す
      console.error('[handleEvent] 回答生成に失敗しました', error instanceof Error ? error.message : error);
      blocks.push({ type: 'text', text: handOff(null) });
      verification = 'replaced';
    }
  }

  // ---- 保存（送信より先。送信に失敗しても状態は進める） ----
  if (!isText) await repos.messages.insert({ conversationId: conv.id, role: 'user', text: userText });
  // 担当者への通知は、足す前の会話に未対応のメモが無かったときだけ（続けて届いたメモでメールを重ねない）
  const hadOpenHandoff = conv.handoffNotes.length > conv.handoffResolvedCount;
  const handoffNotes = decision.handoffNote
    ? [...conv.handoffNotes, { ...decision.handoffNote, at: startedAt.toISOString() }]
    : undefined;
  await repos.conversations.update(conv.id, {
    state: decision.next.state,
    slots: decision.next.slots,
    shownPropertyIds: decision.next.shownPropertyIds,
    shownOffset: decision.next.shownPropertyIds.length,
    priorityAskedCount: decision.next.priorityAskedCount,
    booking: decision.next.booking,
    handoffNotes,
  });
  const finishedAt = deps.clock();
  await repos.messages.insert({
    conversationId: conv.id,
    role: 'ai',
    text: describeBlocks(blocks),
    intent: extraction?.result.intent ?? null,
    slotDiff: extraction?.result.ops ?? null,
    toolCalls,
    verification,
    latencyMs: finishedAt.getTime() - startedAt.getTime(),
    costUsd: (extraction?.costUsd ?? 0) + answerCost,
  });

  const receivedOutsideHours = !isOpenAt(startedAt, calendar);
  let viewing: { id: string; propertyName: string } | null = null;
  if (decision.viewingRequest) {
    const created = await repos.viewingRequests.create({
      conversationId: conv.id,
      propertyId: decision.viewingRequest.propertyId,
      candidateTimes: decision.viewingRequest.candidateTimes,
      receivedOutsideHours,
    });
    const property = properties.find((p) => p.id === decision.viewingRequest!.propertyId);
    viewing = { id: created.id, propertyName: property?.name ?? decision.viewingRequest.propertyId };
  }

  // ---- 送信と通知（送信に失敗しても、保存済みの仮受付・メモは担当者へ知らせる） ----
  try {
    await send(messenger, userId, replyToken, renderMessages(blocks, decision.quickReplies));
  } finally {
    const notifications: Promise<void>[] = [];
    if (viewing && decision.viewingRequest) {
      const { id, propertyName } = viewing;
      const { candidateTimes } = decision.viewingRequest;
      notifications.push(
        notifySafely('内見の仮受付', () =>
          deps.notifier.viewingRequested({
            viewingRequestId: id,
            conversationId: conv.id,
            propertyName,
            candidateTimes,
            receivedOutsideHours,
          }),
        ),
      );
    }
    if (decision.handoffNote && !hadOpenHandoff) {
      const note = decision.handoffNote;
      notifications.push(
        notifySafely('引き継ぎ', () =>
          deps.notifier.handoffRequested({
            conversationId: conv.id,
            question: note.text,
            topic: note.topic,
            propertyNames: note.propertyIds.map((id) => properties.find((p) => p.id === id)?.name ?? id),
            receivedOutsideHours,
          }),
        ),
      );
    }
    await Promise.all(notifications);
  }
}

/**
 * 有人対応中の会話で、これから保存する発言が「最終の担当者返信以降で最初の利用者の発言」か。
 * 担当者の返信なしで止まっている（lastStaffReplyAt が null）なら停止（pausedAt）以降、どちらも null なら最初とみなす。
 * 数えられなかったとき（DB の一時的な失敗）は通知する側に倒す（発言の保存は止めない）
 */
async function isFirstUserMessageSinceStaff(repos: Repositories, conv: Conversation): Promise<boolean> {
  const since = conv.lastStaffReplyAt ?? conv.pausedAt;
  const sinceMs = since === null ? Number.NaN : Date.parse(since);
  if (Number.isNaN(sinceMs)) return true;
  try {
    return (await repos.messages.countUserMessagesSince(conv.id, new Date(sinceMs))) === 0;
  } catch (error) {
    console.error('[handleEvent] 担当者対応中の発言の数え上げに失敗しました', error instanceof Error ? error.message : error);
    return true;
  }
}

/**
 * この会話の AI の発話に、営業時間外の案内（`msg.outsideHoursNote()`。時間外の友だち追加のあいさつにも同じ一文が入る）があるか。
 * 読めなかったときは false（営業時間外の案内が重なるだけで、返信は止めない）
 */
async function hasShownOutsideHoursNote(repos: Repositories, conversationId: string): Promise<boolean> {
  const note = msg.outsideHoursNote();
  try {
    return (await repos.messages.listByConversation(conversationId)).some((m) => m.role === 'ai' && m.text.includes(note));
  } catch (error) {
    console.error('[handleEvent] 会話ログの読み出しに失敗しました', error instanceof Error ? error.message : error);
    return false;
  }
}

/** 通知は実装が投げない約束だが、投げても利用者への返信や元の例外を覆わない */
async function notifySafely(label: string, notify: () => Promise<void>): Promise<void> {
  try {
    await notify();
  } catch (error) {
    console.error(`[handleEvent] 担当者通知（${label}）に失敗しました`, error instanceof Error ? error.message : error);
  }
}

/** reply を試し、reply token が無い・失効していたら push に切り替える（DESIGN.md 6.1） */
async function send(
  messenger: LineMessenger,
  userId: string,
  replyToken: string | undefined,
  messages: LineMessage[],
): Promise<void> {
  if (messages.length === 0) return;
  if (replyToken) {
    try {
      await messenger.reply(replyToken, messages);
      return;
    } catch (error) {
      console.warn('[handleEvent] reply に失敗したので push に切り替えます', error instanceof Error ? error.message : error);
    }
  }
  await messenger.push(userId, messages);
}

function shownWithPositions(conv: Conversation, properties: readonly Property[]): ExtractInput['shown'] {
  const result: ExtractInput['shown'] = [];
  conv.shownPropertyIds.forEach((id, i) => {
    const property = properties.find((p) => p.id === id);
    if (property) result.push({ position: i + 1, property });
  });
  return result;
}

/** 会話ログに残す AI の発話（カードは物件 ID で残す） */
function describeBlocks(blocks: readonly RenderBlock[]): string {
  return blocks
    .map((b) =>
      b.type === 'text'
        ? b.text
        : `[物件カード ${b.startPosition}〜${b.startPosition + b.items.length - 1}番目: ${b.items.map((i) => i.property.id).join(', ')}]`,
    )
    .join('\n\n');
}

/** 保存する発話を字数の上限で切る（上限を超えた発話は LLM に渡さずに断るので、ここは保存の大きさを抑えるだけ） */
function clip(text: string): string {
  const chars = Array.from(text);
  return chars.length > UTTERANCE_MAX_CHARS ? `${chars.slice(0, UTTERANCE_MAX_CHARS).join('')}…` : text;
}
