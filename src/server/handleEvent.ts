/**
 * LINE のイベント1件を処理する（I/O の層）。判断は会話エンジン `decideTurn`（純関数）に任せ、
 * ここでは 重複排除 → 有人対応中の判定 → レート制限と費用上限 → 条件抽出（LLM）→ 判断 → 回答生成（LLM）
 * → 保存 → 送信 → 担当者通知 だけを行う。外部サービスはすべて Deps で差し込む（不変条件 10）。
 */
import type { webhook } from '@line/bot-sdk';
import { fromJst, isOpenAt, nextContactDay, toJst } from '@/domain/businessHours';
import * as msg from '@/domain/messages';
import { AI_RESUME_AFTER_MS, RATE_LIMIT_PER_MINUTE } from '@/domain/rules';
import { decideTurn, type ButtonEvent, type ConversationSnapshot, type TurnEvent } from '@/domain/turn';
import type { ExtractionResult, Property, Slots } from '@/domain/types';
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
  text: string;
  /** ok: そのまま / replaced: 根拠検証で不一致になり定型の引き継ぎ文に差し替えた */
  verification: Verification;
  latencyMs: number;
  costUsd: number;
  toolCalls?: unknown;
}
/** 提示物件への質問の回答生成＋根拠検証 */
export type Answerer = (input: AnswerInput) => Promise<AnswerOutput>;

export interface StaffNotifier {
  viewingRequested(info: {
    viewingRequestId: string;
    propertyName: string;
    candidateTimes: string[];
    receivedOutsideHours: boolean;
  }): Promise<void>;
}

export interface Deps {
  repos: Repositories;
  messenger: LineMessenger;
  extract: Extractor;
  answer: Answerer;
  notifier: StaffNotifier;
  clock: () => Date;
  dailyCostLimitUsd: number;
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
  switch (event.type) {
    case 'follow': {
      const profile = await messenger.getProfile(userId);
      await repos.lineUsers.upsert({ lineUserId: userId, displayName: profile?.displayName ?? null });
      userText = '[友だち追加]';
      break;
    }
    case 'message': {
      await repos.lineUsers.upsert({ lineUserId: userId });
      if (event.message.type !== 'text') {
        await send(messenger, userId, replyToken, [{ type: 'text', text: msg.textOnly() }]);
        return;
      }
      userText = event.message.text;
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
      await repos.messages.insert({ conversationId: conv.id, role: 'user', text: userText });
      return;
    }
  }

  // ---- レート制限と1日の費用上限（LLM を呼ぶ自由文だけ。DESIGN.md 4.4） ----
  const isText = event.type === 'message';
  if (isText) {
    const recent = await repos.messages.countUserMessagesSince(userId, new Date(startedAt.getTime() - MINUTE_MS));
    const spent = await repos.messages.sumCostSince(fromJst(toJst(startedAt).date, '00:00'));
    await repos.messages.insert({ conversationId: conv.id, role: 'user', text: userText });
    if (recent >= RATE_LIMIT_PER_MINUTE || spent >= deps.dailyCostLimitUsd) {
      await send(messenger, userId, replyToken, [{ type: 'text', text: msg.rateLimited() }]);
      return;
    }
    await messenger.showLoading(userId, LOADING_SECONDS);
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

  const decision = decideTurn(snapshot, turnEvent, { now: startedAt, calendar, properties });

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
    try {
      const answer = await deps.answer({ question: block.question, targets: block.targets, now: startedAt });
      blocks.push({ type: 'text', text: answer.text });
      answerCost += answer.costUsd;
      verification = answer.verification;
      toolCalls = answer.toolCalls ?? null;
    } catch (error) {
      // 回答生成に失敗したら推測で埋めず、担当者へ回す
      console.error('[handleEvent] 回答生成に失敗しました', error instanceof Error ? error.message : error);
      const outside = !isOpenAt(startedAt, calendar);
      blocks.push({ type: 'text', text: msg.handoff(null, outside, nextContactDay(startedAt, calendar)) });
      verification = 'replaced';
      decision.handoffNote ??= { text: block.question, topic: null, propertyIds: block.targets.map((t) => t.property.id) };
    }
  }

  // ---- 保存（送信より先。送信に失敗しても状態は進める） ----
  if (!isText) await repos.messages.insert({ conversationId: conv.id, role: 'user', text: userText });
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

  let viewing: { id: string; propertyName: string } | null = null;
  if (decision.viewingRequest) {
    const outside = !isOpenAt(startedAt, calendar);
    const created = await repos.viewingRequests.create({
      conversationId: conv.id,
      propertyId: decision.viewingRequest.propertyId,
      candidateTimes: decision.viewingRequest.candidateTimes,
      receivedOutsideHours: outside,
    });
    const property = properties.find((p) => p.id === decision.viewingRequest!.propertyId);
    viewing = { id: created.id, propertyName: property?.name ?? decision.viewingRequest.propertyId };
  }

  // ---- 送信と通知 ----
  await send(messenger, userId, replyToken, renderMessages(blocks, decision.quickReplies));
  if (viewing && decision.viewingRequest) {
    await deps.notifier.viewingRequested({
      viewingRequestId: viewing.id,
      propertyName: viewing.propertyName,
      candidateTimes: decision.viewingRequest.candidateTimes,
      receivedOutsideHours: !isOpenAt(startedAt, calendar),
    });
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
