import type { messagingApi } from '@line/bot-sdk';
import { theme } from '@/constants/theme';
import { DISCLAIMER } from '@/domain/messages';
import { relevantAccess } from '@/domain/search';
import type { ScoredProperty } from '@/domain/types';
import { buildPostbackData, POSTBACK_DATA_MAX_LENGTH } from './postback';

/**
 * 物件カードの Flex Message とクイックリプライ。
 * - 色は `theme.light` のトークンだけ（LINE にダークモード用の指定は無い）。直書きしない
 * - 太字は物件名・家賃・番号・一致の要約だけ。装飾は控えめ
 * - LINE の上限: カルーセル 12 バブル・altText 400 文字・クイックリプライ 13 個（ラベル 20 文字）
 */

const c = theme.light;

/** 免責の一言（定型文は domain/messages に一本化） */
export const DISCLAIMER_TEXT = DISCLAIMER;

export const MAX_BUBBLES = 12;
export const ALT_TEXT_MAX_LENGTH = 400;
export const MAX_QUICK_REPLIES = 13;
export const QUICK_REPLY_LABEL_MAX_LENGTH = 20;
const QUICK_REPLY_TEXT_MAX_LENGTH = 300;

// ---------- 小さな部品 ----------

/** コードポイント単位で max 文字に収める（超えたら末尾を … にする） */
function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/** 3 桁区切り（ロケールに依存しない） */
function formatYen(yen: number): string {
  return `${String(Math.round(yen)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}円`;
}

/** Flex の text は空文字だとエラーになるので、空なら代わりの文字を使う */
function nonEmpty(text: string, fallback: string): string {
  return text.trim().length > 0 ? text : fallback;
}

type Message = messagingApi.Message;
type FlexComponent = messagingApi.FlexComponent;
type FlexBubble = messagingApi.FlexBubble;
type FlexMessage = messagingApi.FlexMessage;
type TextMessage = messagingApi.TextMessage;
type QuickReply = messagingApi.QuickReply;

// ---------- 一致の要約 ----------

/** 「希望5件中4件に一致」（カードの強調部分） */
function matchHead(item: ScoredProperty): string {
  return `希望${item.conditions.length}件中${item.matched.length}件に一致`;
}

/** 「・オートロックなし・徒歩12分」（不足の説明。無ければ空文字）。unmatched は表示できる文言として渡される */
function matchTail(item: ScoredProperty): string {
  const labels = item.unmatched.filter((label) => label.trim().length > 0);
  return labels.length > 0 ? `・${labels.join('・')}` : '';
}

/** 一致の要約（例: 「希望5件中4件に一致・オートロックなし」）。`unmatched` の各要素はそのまま「・」で連結する */
export function buildMatchSummary(item: ScoredProperty): string {
  return matchHead(item) + matchTail(item);
}

// ---------- バブル ----------

function infoLine(text: string): FlexComponent {
  return { type: 'text', text: nonEmpty(text, '-'), size: 'sm', color: c.textSecondary, wrap: true };
}

/**
 * 駅の行。聞かれた駅（displayAccess）を先に出し、ほかの駅のほうが近ければ「（最寄りは祐天寺駅 徒歩15分）」を添える。
 * 「中目黒駅 徒歩22分」だけだと、近い駅があることが伝わらないため（意思決定ログ24）
 */
export function stationLine(item: ScoredProperty): string {
  const shown = item.displayAccess;
  const nearest = relevantAccess(item.property);
  const head = `${shown.station}駅 徒歩${shown.walkMin}分`;
  return nearest.walkMin < shown.walkMin ? `${head}（最寄りは${nearest.station}駅 徒歩${nearest.walkMin}分）` : head;
}

function buildBubble(item: ScoredProperty, position: number): FlexBubble {
  const { property: p } = item;
  const tail = matchTail(item);

  const matchSpans: messagingApi.FlexSpan[] = [
    { type: 'span', text: matchHead(item), weight: 'bold', color: c.accent },
  ];
  if (tail) matchSpans.push({ type: 'span', text: tail, color: c.textSecondary });

  return {
    type: 'bubble',
    styles: {
      body: { backgroundColor: c.backgroundElement },
      footer: { backgroundColor: c.backgroundElement, separator: true, separatorColor: c.border },
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type: 'text', text: `${position}番目`, size: 'xs', weight: 'bold', color: c.accent },
        {
          type: 'text',
          text: nonEmpty(p.name, '（物件名なし）'),
          size: 'md',
          weight: 'bold',
          color: c.text,
          wrap: true,
          maxLines: 2,
        },
        {
          type: 'text',
          wrap: true,
          margin: 'sm',
          contents: [
            { type: 'span', text: formatYen(p.rent), size: 'lg', weight: 'bold', color: c.text },
            { type: 'span', text: `（管理費 ${formatYen(p.managementFee)}）`, size: 'xs', color: c.textSecondary },
          ],
        },
        infoLine(`${p.layout} ・ ${p.areaSqm}㎡`),
        infoLine(stationLine(item)),
        infoLine(`${p.floor}階 ・ ${p.builtYear}年築`),
        { type: 'separator', margin: 'md', color: c.border },
        { type: 'text', wrap: true, margin: 'md', size: 'sm', contents: matchSpans },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        {
          type: 'button',
          style: 'link',
          height: 'sm',
          color: c.accent,
          action: {
            type: 'postback',
            label: '詳細',
            data: buildPostbackData({ action: 'detail', propertyId: p.id }),
            displayText: `${position}番目の詳細`,
          },
        },
        {
          type: 'button',
          style: 'primary',
          height: 'sm',
          color: c.accent,
          action: {
            type: 'postback',
            label: '内見を希望',
            data: buildPostbackData({ action: 'viewing', propertyId: p.id }),
            displayText: `${position}番目の内見を希望`,
          },
        },
      ],
    },
  };
}

// ---------- カルーセル ----------

export interface CarouselOptions {
  /** 先頭カードの表示番号（1 始まり。2 ページ目なら 6）。「2番目の」と言えるように通し番号で振る */
  startPosition: number;
  /** 次のページがあるとき true → クイックリプライに「もっと見る」を付ける */
  hasMore: boolean;
  /** 「もっと見る」の後ろに足すクイックリプライ（例: 条件を変える） */
  extraQuickReplies?: QuickReplyInput[];
}

/**
 * 物件カードのカルーセル（Flex）＋免責の一言（テキスト）の 2 通を返す。
 * - 物件が 0 件なら空配列（0 件の案内は呼び出し側が作る）
 * - 12 件を超える分は切り捨てる（通常は PAGE_SIZE 件で渡る）
 * - クイックリプライは最後のメッセージ（免責）に付く。後ろにメッセージを足すときは `withQuickReply` で付け直す
 */
export function buildPropertyCarousel(items: ScoredProperty[], opts: CarouselOptions): Message[] {
  const shown = items.slice(0, MAX_BUBBLES);
  if (shown.length === 0) return [];

  const start = Number.isInteger(opts.startPosition) && opts.startPosition >= 1 ? opts.startPosition : 1;
  const bubbles = shown.map((item, i) => buildBubble(item, start + i));
  const last = start + shown.length - 1;

  const carousel: FlexMessage = {
    type: 'flex',
    altText: buildAltText(shown, start, last),
    contents: { type: 'carousel', contents: bubbles },
  };

  const quickItems: QuickReplyInput[] = [];
  if (opts.hasMore) {
    quickItems.push({ label: 'もっと見る', postback: buildPostbackData({ action: 'more' }), displayText: 'もっと見る' });
  }
  quickItems.push(...(opts.extraQuickReplies ?? []));

  return withQuickReply([carousel, buildDisclaimerMessage()], buildQuickReply(quickItems));
}

/** 免責の一言（物件カードの下に出す） */
export function buildDisclaimerMessage(): TextMessage {
  return { type: 'text', text: DISCLAIMER_TEXT };
}

function buildAltText(items: ScoredProperty[], first: number, last: number): string {
  const names = items.map((item) => item.property.name).join('、');
  const range = first === last ? `${first}番目` : `${first}〜${last}番目`;
  return truncate(`物件のご案内（${range}）: ${names}`, ALT_TEXT_MAX_LENGTH);
}

// ---------- クイックリプライ ----------

export type QuickReplyInput =
  | { label: string; postback: string; displayText?: string }
  | { label: string; text: string };

/**
 * クイックリプライを作る。13 個を超える分は切り捨て、ラベルは 20 文字、text は 300 文字に収める。
 * 0 個なら undefined（LINE は空配列を受け付けない）。postback の data が 300 文字を超えていたら例外（組み立て側のバグ）
 */
export function buildQuickReply(items: QuickReplyInput[]): QuickReply | undefined {
  if (items.length === 0) return undefined;
  return {
    items: items.slice(0, MAX_QUICK_REPLIES).map((item) => {
      const label = truncate(nonEmpty(item.label, '選択'), QUICK_REPLY_LABEL_MAX_LENGTH);
      if ('postback' in item) {
        if (item.postback.length > POSTBACK_DATA_MAX_LENGTH) {
          throw new Error(`クイックリプライの postback data が ${POSTBACK_DATA_MAX_LENGTH} 文字を超えています`);
        }
        return {
          type: 'action',
          action: { type: 'postback', label, data: item.postback, displayText: item.displayText ?? label },
        };
      }
      return {
        type: 'action',
        action: { type: 'message', label, text: truncate(nonEmpty(item.text, label), QUICK_REPLY_TEXT_MAX_LENGTH) },
      };
    }),
  };
}

/** 最後のメッセージにクイックリプライを付け直した配列を返す（元の配列は変えない）。quickReply が undefined なら外す */
export function withQuickReply(messages: Message[], quickReply: QuickReply | undefined): Message[] {
  if (messages.length === 0) return messages;
  const copy = messages.slice();
  const lastIndex = copy.length - 1;
  const next: Message = { ...copy[lastIndex] };
  if (quickReply) next.quickReply = quickReply;
  else delete next.quickReply;
  copy[lastIndex] = next;
  return copy;
}
