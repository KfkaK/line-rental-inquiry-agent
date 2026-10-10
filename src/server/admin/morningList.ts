/**
 * 朝の引き継ぎ一覧（DESIGN.md 2.2）。前回の営業終了（`previousClose`）以降に届いた案件を「夜間・休日分」にまとめ、
 * それより前で担当者の手がまだ要るもの（未対応・対応中の仮受付、未対応の引き継ぎメモ）を「それ以前の未対応」に残す。
 *
 * 案件は2種類:
 * - viewing: 内見の仮受付1件。その会話の未対応の引き継ぎメモ（「AIが聞き取れなかったこと」）は、会話の最新の仮受付の行に載せる
 * - handoff: 仮受付の無い会話の、未対応の引き継ぎメモ（禁止トピック・記載の無い質問）。
 *   仮受付が「それ以前」にしか無い会話に夜間・休日のメモが届いたときも、見落とさないようこちらにする
 * どちらの区分も届いた順（古い順）に並べ、担当者が上から順に片付けられるようにする。
 */
import { previousClose } from '@/domain/businessHours';
import { isOpenViewing, openHandoffNotes } from '@/domain/staff';
import type { BusinessCalendar, HandoffNote } from '@/domain/types';
import type { ConversationSummary, Repositories, ViewingRequestListItem } from '@/lib/db';

export type MorningItem =
  | {
      kind: 'viewing';
      /** 並びと区分けに使う時刻（仮受付の届いた時刻） */
      at: string;
      viewing: ViewingRequestListItem;
      /** この会話の未対応のメモ（会話の最新の仮受付の行にだけ載せる） */
      openNotes: HandoffNote[];
    }
  | {
      kind: 'handoff';
      /** 最新の未対応のメモの時刻 */
      at: string;
      conversation: ConversationSummary;
      openNotes: HandoffNote[];
    };

export interface MorningList {
  /** 前回の営業終了（ISO）。これ以降が夜間・休日分 */
  since: string;
  overnight: MorningItem[];
  earlier: MorningItem[];
}

export interface MorningInput {
  since: Date;
  /** `since` 以降の仮受付（全ステータス）と、それより前の未対応・対応中の仮受付。重複してよい */
  viewings: readonly ViewingRequestListItem[];
  /** 未対応の引き継ぎメモがある会話 */
  handoffConversations: readonly ConversationSummary[];
}

/** 純関数。入力の重複（同じ仮受付が両方の取得に入る）は ID で除く */
export function buildMorningList(input: MorningInput): MorningList {
  const sinceMs = input.since.getTime();
  const viewings = new Map<string, ViewingRequestListItem>();
  for (const v of input.viewings) {
    // 夜間・休日分は全ステータス、それより前は担当者の手が要るものだけ
    if (Date.parse(v.createdAt) >= sinceMs || isOpenViewing(v.status)) viewings.set(v.id, v);
  }

  // 会話ごとの最新の仮受付（メモを載せる行）
  const latestByConversation = new Map<string, ViewingRequestListItem>();
  for (const v of viewings.values()) {
    const current = latestByConversation.get(v.conversationId);
    if (!current || compareItems(current.createdAt, current.id, v.createdAt, v.id) < 0) latestByConversation.set(v.conversationId, v);
  }

  // 未対応のメモをどの行に載せるか。会話の最新の仮受付に載せるが、仮受付が「それ以前」でメモが夜間・休日に届いたなら、
  // 夜間・休日分で見落とさないよう別の行（handoff）にする
  const notesOnViewing = new Map<string, HandoffNote[]>(); // キーは仮受付 ID
  const items: MorningItem[] = [];
  for (const conversation of input.handoffConversations) {
    const notes = openHandoffNotes(conversation.handoffNotes, conversation.handoffResolvedCount);
    if (notes.length === 0) continue;
    const at = notes[notes.length - 1].at;
    const latest = latestByConversation.get(conversation.id);
    if (latest && (Date.parse(latest.createdAt) >= sinceMs || Date.parse(at) < sinceMs)) {
      notesOnViewing.set(latest.id, notes);
    } else {
      items.push({ kind: 'handoff', at, conversation, openNotes: notes });
    }
  }
  for (const v of viewings.values()) {
    items.push({ kind: 'viewing', at: v.createdAt, viewing: v, openNotes: notesOnViewing.get(v.id) ?? [] });
  }

  items.sort((a, b) => compareItems(a.at, itemId(a), b.at, itemId(b)));
  return {
    since: input.since.toISOString(),
    overnight: items.filter((item) => Date.parse(item.at) >= sinceMs),
    earlier: items.filter((item) => Date.parse(item.at) < sinceMs),
  };
}

function itemId(item: MorningItem): string {
  return item.kind === 'viewing' ? item.viewing.id : item.conversation.id;
}

/** 時刻の古い順 → ID 昇順（同時刻でも並びを決める） */
function compareItems(atA: string, idA: string, atB: string, idB: string): number {
  const diff = Date.parse(atA) - Date.parse(atB);
  if (diff !== 0) return diff;
  return idA < idB ? -1 : idA > idB ? 1 : 0;
}

/** 一覧に要るものを読む（I/O）。`calendar` を渡さなければ DB の営業カレンダー */
export async function loadMorningList(repos: Repositories, now: Date, calendar?: BusinessCalendar): Promise<MorningList> {
  const since = previousClose(now, calendar ?? (await repos.businessCalendar.get()));
  const [recent, pending, inProgress, handoffConversations] = await Promise.all([
    repos.viewingRequests.listSince(since),
    repos.viewingRequests.listByStatus('pending'),
    repos.viewingRequests.listByStatus('in_progress'),
    repos.conversations.listWithOpenHandoff(),
  ]);
  return buildMorningList({ since, viewings: [...recent, ...pending, ...inProgress], handoffConversations });
}
