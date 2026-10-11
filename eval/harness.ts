/**
 * 会話を本番と同じ経路（handleEvent）で回す評価の土台。攻撃的質問とシナリオが使う（DESIGN.md 7章・意思決定ログ11 の7）。
 *
 * - DB はインメモリ（架空データの物件・営業時間は既定）、LINE は偽物、通知は捨てる。条件抽出と回答生成だけを
 *   差し込み（Pipeline）、本物の Claude・1モデル構成・正解の抽出（npm test）を同じ形で回す
 * - 時計は「仮想の開始時刻 ＋ 実際の経過時間 ＋ 手番の間隔」。handleEvent が記録する応答時間（latencyMs）は実測になり、
 *   営業時間の判定やプロンプトの「今日」は仮想の時刻になる。手番の間隔（既定 20 秒）でレート制限（1分5発話）に掛からない
 * - 1つの harness が1人の利用者の1会話。ケースごとに作り直す
 */
import type { webhook } from '@line/bot-sdk';
import { searchProperties } from '@/domain/search';
import { asAllMust, missingForSearch } from '@/domain/slots';
import type { ConversationState, HandoffNote, Property, Slots } from '@/domain/types';
import { createMemoryRepositories, type Repositories, type ViewingRequestListItem } from '@/lib/db';
import { createFakeMessenger, type LineMessage } from '@/lib/line/messenger';
import { buildPostbackData } from '@/lib/line/postback';
import {
  handleEvent,
  type AnswerInput,
  type AnswerOutput,
  type Answerer,
  type ExtractInput,
  type ExtractOutput,
  type Extractor,
  type StaffNotifier,
} from '@/server/handleEvent';

/** 条件抽出と回答生成の組（評価で比べる構成の単位） */
export interface Pipeline {
  /** 結果に残す名前（例: two-model） */
  name: string;
  extract: Extractor;
  answer: Answerer;
}

export interface HarnessOptions {
  /** 物件の全件（非公開を含む。検索は handleEvent が公開だけに絞る） */
  properties: readonly Property[];
  pipeline: Pipeline;
  /** 仮想の開始時刻 */
  start: Date;
  /** 手番の間に進める仮想の時間（既定 HARNESS_GAP_MS） */
  gapMs?: number;
  /** 最初の発話の前の会話（攻撃的質問の種まき）。省略時は会話なし（最初の発話で作られる） */
  initial?: { state?: ConversationState; slots?: Slots; shownPropertyIds?: string[] };
}

/** 手番の間隔の既定。1分に3手番までになり、レート制限（1分5発話）に掛からない */
export const HARNESS_GAP_MS = 20_000;
/** 評価の利用者（インメモリ DB の中だけ） */
export const HARNESS_USER_ID = 'U-eval-user';

/** 利用者の操作（クイックリプライ・カードのボタンは harness が postback の data に直す） */
export type HarnessInput =
  | { kind: 'follow' }
  | { kind: 'text'; text: string }
  /** 押したボタンのラベルは記録用 */
  | { kind: 'postback'; data: string; label: string };

export interface QuickReplyView {
  label: string;
  /** postback のボタン */
  data?: string;
  /** 押すとこの文を送るボタン */
  text?: string;
}

export interface HarnessTurn {
  input: HarnessInput;
  /** 返信の文（テキストメッセージだけ。カードは cardIds） */
  texts: string[];
  /** この手番で出したカードの物件 ID（表示順） */
  cardIds: string[];
  /** 最後のメッセージのクイックリプライ */
  quickReplies: QuickReplyView[];
  /** 手番の後の会話 */
  state: ConversationState;
  slots: Slots;
  shownPropertyIds: string[];
  /** この手番で増えた引き継ぎメモ・内見の仮受付 */
  handoffAdded: HandoffNote[];
  viewingCreated: ViewingRequestListItem[];
  /** この手番の条件抽出（自由文のときだけ） */
  extraction: ExtractOutput | null;
  /** この手番の回答生成の出力（提示物件への質問のとき。toolCalls に生の回答と自己申告が入る） */
  answers: AnswerOutput[];
  /** handleEvent が保存した AI の発言の計測（処理の開始から保存まで・抽出と回答の費用の合計）。返信しなかった手番は null */
  latencyMs: number | null;
  costUsd: number | null;
  /** 手番の後のスロットの must 通過件数と、全条件を must にした（Web サイト式の）件数。エリアと予算が揃っていなければ null */
  mustTotal: number | null;
  andTotal: number | null;
  /** handleEvent・条件抽出・回答生成が投げた例外（API の障害など）。投げても会話は続ける */
  error: string | null;
}

export interface ConversationHarness {
  send(input: HarnessInput): Promise<HarnessTurn>;
  /** 直前の返信のクイックリプライを押す（ラベルの完全一致 → 前方一致が1つだけ）。見つからなければ例外 */
  tap(label: string): Promise<HarnessTurn>;
  /** 直前の返信のクイックリプライを番号（0 始まり）で押す。範囲外なら例外 */
  tapIndex(index: number): Promise<HarnessTurn>;
  /** これまでに出したカードのボタン（表示番号 1 始まり）。提示リストに無い番号なら例外 */
  card(button: 'detail' | 'viewing', position: number): Promise<HarnessTurn>;
  readonly turns: readonly HarnessTurn[];
  readonly repos: Repositories;
}

const noopNotifier: StaffNotifier = {
  async viewingRequested() {},
  async handoffRequested() {},
  async userRepliedWhilePaused() {},
};

export function createConversationHarness(options: HarnessOptions): ConversationHarness {
  const gapMs = options.gapMs ?? HARNESS_GAP_MS;
  const realStart = performance.now();
  let virtualOffset = 0;
  const clock = () => new Date(options.start.getTime() + virtualOffset + (performance.now() - realStart));

  const startIso = options.start.toISOString();
  const repos = createMemoryRepositories(
    {
      properties: [...options.properties],
      // 会話の読み出し（snapshot）は最初の手番の前にも走るので、利用者は先に作っておく
      lineUsers: [{ lineUserId: HARNESS_USER_ID, displayName: '評価用の利用者' }],
      conversations: options.initial
        ? [
            {
              id: 'conv-eval',
              lineUserId: HARNESS_USER_ID,
              state: options.initial.state ?? 'presenting',
              slots: options.initial.slots ?? { tags: [] },
              shownPropertyIds: options.initial.shownPropertyIds ?? [],
              shownOffset: options.initial.shownPropertyIds?.length ?? 0,
              lastSearchTotal: null,
              priorityAskedCount: 0,
              aiPaused: false,
              pausedAt: null,
              lastStaffReplyAt: null,
              booking: null,
              handoffNotes: [],
              createdAt: startIso,
              updatedAt: startIso,
            },
          ]
        : [],
    },
    { clock },
  );
  const messenger = createFakeMessenger({ profiles: { [HARNESS_USER_ID]: { displayName: '評価用の利用者' } } });
  const publicProperties = options.properties.filter((p) => p.status === 'public');

  // 手番ごとの抽出・回答の出力を拾う（handleEvent は返さないので、差し込む関数を包む）
  let turnExtraction: ExtractOutput | null = null;
  let turnAnswers: AnswerOutput[] = [];
  let turnErrors: string[] = [];
  const extract: Extractor = async (input: ExtractInput) => {
    try {
      const out = await options.pipeline.extract(input);
      turnExtraction = out;
      return out;
    } catch (error) {
      turnErrors.push(`条件抽出: ${describe(error)}`);
      throw error;
    }
  };
  const answer: Answerer = async (input: AnswerInput) => {
    try {
      const out = await options.pipeline.answer(input);
      turnAnswers.push(out);
      return out;
    } catch (error) {
      turnErrors.push(`回答生成: ${describe(error)}`);
      throw error;
    }
  };

  const turns: HarnessTurn[] = [];
  let seq = 0;

  async function send(input: HarnessInput): Promise<HarnessTurn> {
    if (turns.length > 0) virtualOffset += gapMs;
    seq += 1;
    turnExtraction = null;
    turnAnswers = [];
    turnErrors = [];

    const before = await snapshot();
    const replyCount = messenger.replies.length;
    const pushCount = messenger.pushes.length;
    try {
      await handleEvent(toEvent(input, seq), {
        repos,
        messenger,
        extract,
        answer,
        notifier: noopNotifier,
        clock,
        dailyCostLimitUsd: Number.POSITIVE_INFINITY,
      });
    } catch (error) {
      turnErrors.push(`handleEvent: ${describe(error)}`);
    }
    const after = await snapshot();

    const sent: LineMessage[] = [
      ...messenger.replies.slice(replyCount).flatMap((r) => r.messages),
      ...messenger.pushes.slice(pushCount).flatMap((p) => p.messages),
    ];
    const aiMessage = after.aiMessages.length > before.aiMessages.length ? after.aiMessages.at(-1) : undefined;
    const searchReady = missingForSearch(after.slots).length === 0;
    const turn: HarnessTurn = {
      input,
      texts: sent.flatMap((m) => (m.type === 'text' ? [m.text] : [])),
      cardIds: aiMessage ? parseCardIds(aiMessage.text) : [],
      quickReplies: quickRepliesOf(sent.at(-1)),
      state: after.state,
      slots: after.slots,
      shownPropertyIds: after.shownPropertyIds,
      handoffAdded: after.handoffNotes.slice(before.handoffNotes.length),
      viewingCreated: after.viewings.filter((v) => !before.viewings.some((b) => b.id === v.id)),
      extraction: turnExtraction,
      answers: turnAnswers,
      latencyMs: aiMessage?.latencyMs ?? null,
      costUsd: aiMessage?.costUsd ?? null,
      mustTotal: searchReady ? searchProperties(publicProperties, after.slots).total : null,
      andTotal: searchReady ? searchProperties(publicProperties, asAllMust(after.slots)).total : null,
      error: turnErrors.length > 0 ? turnErrors.join(' / ') : null,
    };
    turns.push(turn);
    return turn;
  }

  async function snapshot() {
    const conv = await repos.conversations.getOrCreate(HARNESS_USER_ID);
    const messages = await repos.messages.listByConversation(conv.id);
    const viewings = await repos.viewingRequests.listByConversation(conv.id);
    return {
      state: conv.state,
      slots: conv.slots,
      shownPropertyIds: conv.shownPropertyIds,
      handoffNotes: conv.handoffNotes,
      aiMessages: messages.filter((m) => m.role === 'ai'),
      viewings,
    };
  }

  function lastQuickReplies(): QuickReplyView[] {
    const last = turns.at(-1);
    if (!last) throw new Error('まだ返信がありません');
    return last.quickReplies;
  }

  function press(item: QuickReplyView): Promise<HarnessTurn> {
    if (item.data !== undefined) return send({ kind: 'postback', data: item.data, label: item.label });
    return send({ kind: 'text', text: item.text ?? item.label });
  }

  return {
    send,
    tap(label) {
      const items = lastQuickReplies();
      const exact = items.find((i) => i.label === label);
      if (exact) return press(exact);
      const prefixed = items.filter((i) => i.label.startsWith(label));
      if (prefixed.length !== 1) {
        throw new Error(`クイックリプライ「${label}」が見つかりません（あるもの: ${items.map((i) => i.label).join(' / ') || 'なし'}）`);
      }
      return press(prefixed[0]);
    },
    tapIndex(index) {
      const items = lastQuickReplies();
      const item = items[index];
      if (!item) throw new Error(`クイックリプライの ${index} 番目がありません（${items.length} 個）`);
      return press(item);
    },
    async card(button, position) {
      const conv = await repos.conversations.getOrCreate(HARNESS_USER_ID);
      const propertyId = conv.shownPropertyIds[position - 1];
      if (!propertyId) throw new Error(`提示リストに ${position} 番目がありません（${conv.shownPropertyIds.length} 件）`);
      const data = buildPostbackData({ action: button, propertyId });
      return send({ kind: 'postback', data, label: `${position}番目の${button === 'detail' ? '詳細' : '内見を希望'}` });
    },
    get turns() {
      return turns;
    },
    repos,
  };
}

// ---------- 小道具 ----------

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function toEvent(input: HarnessInput, seq: number): webhook.Event {
  const base = {
    mode: 'active',
    timestamp: 0,
    source: { type: 'user', userId: HARNESS_USER_ID },
    webhookEventId: `EVAL-EV${seq}`,
    deliveryContext: { isRedelivery: false },
    replyToken: `EVAL-RT${seq}`,
  };
  switch (input.kind) {
    case 'follow':
      return { ...base, type: 'follow', follow: { isUnblocked: false } } as webhook.Event;
    case 'text':
      return { ...base, type: 'message', message: { type: 'text', id: `EVAL-M${seq}`, text: input.text, quoteToken: 'q' } } as webhook.Event;
    case 'postback':
      return { ...base, type: 'postback', postback: { data: input.data } } as webhook.Event;
  }
}

/** handleEvent が会話ログに残すカードの記述（`[物件カード 1〜5番目: P0001, P0002]`）から物件 ID を取り出す */
export function parseCardIds(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(/\[物件カード \d+〜\d+番目: ([^\]]*)\]/g)) {
    ids.push(...match[1].split(',').map((s) => s.trim()).filter((s) => s.length > 0));
  }
  return ids;
}

function quickRepliesOf(message: LineMessage | undefined): QuickReplyView[] {
  const items = message?.quickReply?.items ?? [];
  return items.flatMap((item): QuickReplyView[] => {
    const action = item.action as { type?: string; label?: string; data?: string; text?: string } | undefined;
    if (action?.type === 'postback') return [{ label: action.label ?? '', data: action.data ?? '' }];
    if (action?.type === 'message') return [{ label: action.label ?? '', text: action.text ?? '' }];
    return [];
  });
}
