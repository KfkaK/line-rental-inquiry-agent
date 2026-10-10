/**
 * 会話エンジンの判断（ReplyBlock・QuickReplyItem）を LINE のメッセージに変換する。
 * postback の data と会話エンジンのボタン操作（ButtonEvent）の対応もここに置く。
 */
import type { ButtonEvent, QuickReplyItem } from '@/domain/turn';
import { buildPropertyCarousel, buildQuickReply, withQuickReply, type QuickReplyInput } from '@/lib/line/flex';
import type { LineMessage } from '@/lib/line/messenger';
import { buildPostbackData, parsePostbackData, type PostbackData } from '@/lib/line/postback';

/** 文字の返信と、回答生成が済んだ答え（answer ブロックはサーバーが文にしてから渡す） */
export type RenderBlock =
  | { type: 'text'; text: string }
  | { type: 'carousel'; items: Parameters<typeof buildPropertyCarousel>[0]; startPosition: number; hasMore: boolean };

export function toPostbackData(event: ButtonEvent): PostbackData {
  switch (event.kind) {
    case 'more':
      return { action: 'more' };
    case 'detail':
      return { action: 'detail', propertyId: event.propertyId };
    case 'viewing':
      return { action: 'viewing', propertyId: event.propertyId };
    case 'viewingDay':
      return { action: 'viewingDay', date: event.date };
    case 'bookingSubmit':
      return { action: 'bookingSubmit' };
    case 'relax':
      return { action: 'relax', ref: event.ref, accept: event.accept };
    case 'priority':
      return { action: 'priority', ref: event.ref };
    case 'loosen':
      return { action: 'loosen', ref: event.ref };
  }
}

/** postback の data → ボタン操作。不正・偽造された data は null（無視する） */
export function parseButtonEvent(raw: unknown): ButtonEvent | null {
  const data = parsePostbackData(raw);
  if (!data) return null;
  switch (data.action) {
    case 'more':
      return { kind: 'more' };
    case 'detail':
      return { kind: 'detail', propertyId: data.propertyId };
    case 'viewing':
      return { kind: 'viewing', propertyId: data.propertyId };
    case 'viewingDay':
      return { kind: 'viewingDay', date: data.date };
    case 'bookingSubmit':
      return { kind: 'bookingSubmit' };
    case 'relax':
      return { kind: 'relax', ref: data.ref, accept: data.accept };
    case 'priority':
      return { kind: 'priority', ref: data.ref };
    case 'loosen':
      return { kind: 'loosen', ref: data.ref };
  }
}

function toQuickReplyInput(item: QuickReplyItem): QuickReplyInput {
  return item.action.kind === 'text'
    ? { label: item.label, text: item.action.text }
    : { label: item.label, postback: buildPostbackData(toPostbackData(item.action.event)), displayText: item.label };
}

/**
 * ブロックを LINE のメッセージに並べ、クイックリプライを最後のメッセージに付ける。
 * カルーセルは「Flex ＋ 免責の一言」の 2 通になる。カルーセル自身の「もっと見る」は使わず、
 * 会話エンジンが決めたクイックリプライ（もっと見る を含む）に一本化する
 */
export function renderMessages(blocks: readonly RenderBlock[], quickReplies: readonly QuickReplyItem[]): LineMessage[] {
  const messages: LineMessage[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      messages.push({ type: 'text', text: block.text });
    } else {
      messages.push(...buildPropertyCarousel(block.items, { startPosition: block.startPosition, hasMore: false }));
    }
  }
  return withQuickReply(messages, buildQuickReply(quickReplies.map(toQuickReplyInput)));
}
