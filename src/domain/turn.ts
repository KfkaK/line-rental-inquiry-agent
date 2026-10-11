/**
 * 1ターンの判断（純関数。DESIGN.md 3章）。
 * 毎ターン「LLM の意図分類＋条件抽出の結果」または「postback」を受け取り、
 * 返信・次の会話状態・内見の仮受付・引き継ぎメモを返す。I/O（LLM・DB・LINE）はサーバー側で行う。
 *
 * 状態は固定の順路にせず、意図を先に見てから状態を参照する。状態は「次に何を聞くか」のヒントに留める。
 * 引き継ぎ（禁止トピック）でも AI の応答は止めない。止めるのは担当者が手動返信したとき（ai_paused）だけ（意思決定ログ2）。
 */
import { isBusinessDay, isOpenAt, nextContactDay, viewingCandidateDays, formatJstDay } from './businessHours';
import * as msg from './messages';
import { suggestRelaxation } from './relax';
import {
  ASK_PRIORITY_MAX_PER_CONVERSATION,
  ASK_PRIORITY_WHEN_MORE_THAN,
  PAGE_SIZE,
  SUGGEST_RELAXATION_AT_OR_BELOW,
  VIEWING_CANDIDATES_MAX,
  VIEWING_CANDIDATES_MIN,
  VIEWING_DAYS_TO_OFFER,
} from './rules';
import { searchProperties } from './search';
import { applySlotOps, emptySlots, listConditions, missingForSearch, priorityOp, sameRef, type ConditionSummary } from './slots';
import type {
  BookingDraft,
  BusinessCalendar,
  ConditionRef,
  ConversationState,
  ExtractionResult,
  HandoffNote,
  Property,
  ScalarSlotKey,
  ScoredProperty,
  Slots,
} from './types';

// ---------- 入出力の型 ----------

export interface ConversationSnapshot {
  state: ConversationState;
  slots: Slots;
  /** 提示したカードの物件 ID（表示番号 1 から順）。新しい検索でリセット、「もっと見る」で追記 */
  shownPropertyIds: string[];
  priorityAskedCount: number;
  booking: BookingDraft | null;
}

/** postback（ボタン・クイックリプライ）で届く操作 */
export type ButtonEvent =
  | { kind: 'more' }
  | { kind: 'detail'; propertyId: string }
  | { kind: 'viewing'; propertyId: string }
  | { kind: 'viewingDay'; date: string }
  | { kind: 'bookingSubmit' }
  | { kind: 'relax'; ref: ConditionRef; accept: boolean }
  | { kind: 'priority'; ref: ConditionRef }
  /** 0件で「どの条件なら緩められそうですか？」に答えたボタン。その条件を「できれば」に下げる */
  | { kind: 'loosen'; ref: ConditionRef };

export type TurnEvent =
  | { kind: 'follow' }
  | { kind: 'text'; text: string; extraction: ExtractionResult }
  | ButtonEvent;

export interface QuickReplyItem {
  /** LINE の上限は 20 文字 */
  label: string;
  action: { kind: 'event'; event: ButtonEvent } | { kind: 'text'; text: string };
}

export type ReplyBlock =
  | { type: 'text'; text: string }
  | { type: 'carousel'; items: ScoredProperty[]; startPosition: number; hasMore: boolean }
  /** 提示物件への質問。サーバーが回答生成（LLM）＋根拠検証で文にする */
  | { type: 'answer'; question: string; targets: { property: Property; position: number | null }[] };

export interface TurnDecision {
  replies: ReplyBlock[];
  /** 最後のメッセージに付けるクイックリプライ（最大 13） */
  quickReplies: QuickReplyItem[];
  next: ConversationSnapshot;
  /** 内見の仮受付が揃ったとき。サーバーが viewing_requests に保存して担当者へ通知する */
  viewingRequest: BookingDraft | null;
  /** 担当者へ回した質問（朝の一覧の「AIが聞き取れなかったこと」）。時刻はサーバーが付ける */
  handoffNote: Omit<HandoffNote, 'at'> | null;
}

export interface TurnContext {
  now: Date;
  calendar: BusinessCalendar;
  /** 公開物件の全件 */
  properties: readonly Property[];
  /**
   * 公開デモ（DEMO_MODE=1）。担当者からの連絡は実際には無いので、あいさつと引き継ぎ・仮受付の文に
   * 「デモのため連絡はありません」を足す（messages.ts）。省略は false
   */
  demo?: boolean;
  /**
   * 営業時間外の案内をすでに出した会話か（サーバーが会話ログから決める。`isUnstarted` が真のときだけ見る）。
   * 時間外の友だち追加のあいさつは同じ案内を含むので、その直後の最初の発話に重ねない。省略は false
   * （友だち追加を経ずに話しかけられた会話や、営業時間内にあいさつした会話は、時間外の最初の発話で案内する）
   */
  greeted?: boolean;
}

/**
 * まだ何も始まっていない会話か（ヒアリング中で、条件も提示もない）。友だち追加の直後も、友だち追加を経ずに
 * 最初の発話を受けたときも真になる。区別するには `TurnContext.greeted` を使う
 */
export function isUnstarted(conv: ConversationSnapshot): boolean {
  return conv.state === 'hearing' && listConditions(conv.slots).length === 0 && conv.shownPropertyIds.length === 0;
}

// ---------- クイックリプライの候補 ----------

const QUICK_AREAS = ['渋谷', '新宿', '中目黒', '恵比寿', '池袋', '吉祥寺', '自由が丘', '中野'];
const QUICK_BUDGETS = [70000, 80000, 90000, 100000, 120000, 150000];
const QUICK_REPLY_MAX = 13;

function quickAsk(key: ScalarSlotKey): QuickReplyItem[] {
  if (key === 'area') return QUICK_AREAS.map((s) => ({ label: s, action: { kind: 'text', text: s } }));
  if (key === 'rentMax') {
    return QUICK_BUDGETS.map((yen) => {
      const text = `${yen / 10000}万円まで`;
      return { label: text, action: { kind: 'text', text } };
    });
  }
  return [];
}

// ---------- 本体 ----------

export function decideTurn(conv: ConversationSnapshot, event: TurnEvent, ctx: TurnContext): TurnDecision {
  switch (event.kind) {
    case 'follow':
      // ブロック解除による友だち追加し直しでも、あいさつでエリアと予算を聞き直すので前回の条件は捨てる
      return {
        ...base(conv),
        next: initialSnapshot(),
        replies: [{ type: 'text', text: msg.greeting(!isOpenAt(ctx.now, ctx.calendar), ctx.demo) }],
        quickReplies: quickAsk('area'),
      };
    case 'more':
      return showMore(conv, ctx);
    case 'detail':
      return showDetail(conv, event.propertyId, ctx);
    case 'viewing':
      return addViewing(conv, event.propertyId, [], ctx);
    case 'viewingDay':
      return conv.booking
        ? addViewing(conv, conv.booking.propertyId, [event.date], ctx)
        : { ...base(conv), replies: [{ type: 'text', text: msg.askWhichProperty() }] };
    case 'bookingSubmit':
      return conv.booking && conv.booking.candidateTimes.length > 0
        ? finalizeViewing(conv, conv.booking, ctx)
        : { ...base(conv), replies: [{ type: 'text', text: msg.askWhichProperty() }] };
    case 'relax':
      return onRelax(conv, event.ref, event.accept, ctx);
    case 'priority':
      return presentSearch(conv, applySlotOps(conv.slots, [priorityOp(event.ref, 'must')]), ctx);
    case 'loosen':
      return presentSearch(conv, applySlotOps(conv.slots, [priorityOp(event.ref, 'want')]), ctx);
    case 'text':
      return onText(conv, event.text, event.extraction, ctx);
  }
}

/** 会話の初期状態（スロット・提示済み・内見の下書きなし） */
export function initialSnapshot(): ConversationSnapshot {
  return { state: 'hearing', slots: emptySlots(), shownPropertyIds: [], priorityAskedCount: 0, booking: null };
}

function base(conv: ConversationSnapshot): TurnDecision {
  return { replies: [], quickReplies: [], next: conv, viewingRequest: null, handoffNote: null };
}

function onText(conv: ConversationSnapshot, text: string, ex: ExtractionResult, ctx: TurnContext): TurnDecision {
  const decision = onTextInner(conv, text, ex, ctx);
  // 会話の最初のターンが営業時間外なら冒頭で案内する（友だち追加を経ずに話しかけられた場合）。
  // 友だち追加のあいさつを出した会話では、あいさつがすでに案内しているので重ねない
  const isFirstTurn = isUnstarted(conv) && !ctx.greeted;
  if (isFirstTurn && !isOpenAt(ctx.now, ctx.calendar) && !ex.forbiddenTopic && ex.intent !== 'handoff') {
    decision.replies.unshift({ type: 'text', text: msg.outsideHoursNote() });
  }
  return decision;
}

function onTextInner(conv: ConversationSnapshot, text: string, ex: ExtractionResult, ctx: TurnContext): TurnDecision {
  if (ex.forbiddenTopic || ex.intent === 'handoff') {
    const outside = !isOpenAt(ctx.now, ctx.calendar);
    const handoffText = msg.handoff(ex.forbiddenTopic, outside, nextContactDay(ctx.now, ctx.calendar), ctx.demo);
    const handoffNote = {
      text,
      topic: ex.forbiddenTopic,
      propertyIds: resolveTargets(conv, ex.targetPositions, ctx).map((t) => t.property.id),
    };
    // 同じ発話に条件の変更があれば捨てずに当て、引き継ぎ文に続けて検索し直す
    // （「渋谷で7万以内、あと空いてますか？」）
    if (ex.ops.length > 0) {
      const searched = presentSearch(conv, applySlotOps(conv.slots, ex.ops), ctx);
      return { ...searched, replies: [{ type: 'text', text: handoffText }, ...searched.replies], handoffNote };
    }
    return { ...base(conv), replies: [{ type: 'text', text: handoffText }], handoffNote };
  }
  switch (ex.intent) {
    case 'conditions':
      return presentSearch(conv, applySlotOps(conv.slots, ex.ops), ctx);
    case 'showMore':
      return showMore(conv, ctx);
    case 'propertyQuestion': {
      const targets = resolveTargets(conv, ex.targetPositions, ctx);
      if (targets.length === 0) return { ...base(conv), replies: [{ type: 'text', text: msg.askWhichProperty() }] };
      return {
        ...base(conv),
        replies: [{ type: 'answer', question: text, targets }],
        next: { ...conv, state: 'qa' },
      };
    }
    case 'viewingRequest': {
      // 番号の指定 → 聞き取り中の物件 → 提示が1件だけならその物件、の順で決める
      // （古いカードの「内見を希望」で聞き取り中のときに、いまの提示1件目へ取り違えないため）
      const explicit = ex.targetPositions.length > 0 ? resolveTargets(conv, ex.targetPositions.slice(0, 1), ctx)[0] : undefined;
      const target = explicit?.property.id ?? conv.booking?.propertyId ?? resolveTargets(conv, [], ctx)[0]?.property.id;
      if (!target) return { ...base(conv), replies: [{ type: 'text', text: msg.askWhichProperty() }] };
      // 対象の物件が変わったら、それまでの候補日時は持ち越さない
      const keep = conv.booking?.propertyId === target ? conv : { ...conv, booking: null };
      return addViewing(keep, target, ex.viewingTimes, ctx);
    }
    case 'offTopic':
    default:
      return { ...base(conv), replies: [{ type: 'text', text: msg.offTopic() }] };
  }
}

/** 表示番号 → 物件。番号の指定が無く、提示が1件だけならその物件 */
function resolveTargets(
  conv: ConversationSnapshot,
  positions: readonly number[],
  ctx: TurnContext,
): { property: Property; position: number }[] {
  const wanted = positions.length > 0 ? positions : conv.shownPropertyIds.length === 1 ? [1] : [];
  const result: { property: Property; position: number }[] = [];
  for (const position of wanted) {
    const id = conv.shownPropertyIds[position - 1];
    const property = id ? ctx.properties.find((p) => p.id === id) : undefined;
    if (property && !result.some((r) => r.property.id === id)) result.push({ property, position });
  }
  return result;
}

// ---------- 検索と提示 ----------

function presentSearch(conv: ConversationSnapshot, slots: Slots, ctx: TurnContext): TurnDecision {
  const missing = missingForSearch(slots);
  if (missing.length > 0) {
    return {
      ...base(conv),
      replies: [{ type: 'text', text: msg.askFor(missing[0]) }],
      quickReplies: quickAsk(missing[0]),
      next: { ...conv, state: 'hearing', slots, shownPropertyIds: [] },
    };
  }

  const result = searchProperties(ctx.properties, slots);
  const conditions = listConditions(slots);
  const summary = msg.conditionsSummary(conditions);

  if (result.total === 0) {
    const decision: TurnDecision = {
      ...base(conv),
      replies: [{ type: 'text', text: msg.noResults(summary) }],
      next: { ...conv, state: 'hearing', slots, shownPropertyIds: [] },
    };
    if (!addRelaxation(decision, slots, ctx)) askWhichToLoosen(decision, conv, conditions);
    return decision;
  }

  const page = result.items.slice(0, PAGE_SIZE);
  const hasMore = result.total > page.length;
  const decision: TurnDecision = {
    ...base(conv),
    replies: [
      { type: 'text', text: msg.searchIntro(result.total, page.length, summary) },
      { type: 'carousel', items: page, startPosition: 1, hasMore },
    ],
    next: { ...conv, state: 'presenting', slots, shownPropertyIds: page.map((i) => i.property.id) },
  };

  if (result.total <= SUGGEST_RELAXATION_AT_OR_BELOW) {
    addRelaxation(decision, slots, ctx);
  } else if (
    result.total > ASK_PRIORITY_WHEN_MORE_THAN &&
    conv.priorityAskedCount < ASK_PRIORITY_MAX_PER_CONVERSATION &&
    conditions.some((c) => c.priority !== 'must')
  ) {
    // 結果を見せてから絞る（質問から始めない）。選ばれた条件を must に上げる
    decision.replies.push({ type: 'text', text: msg.askMustConditions(result.total) });
    decision.quickReplies = conditions
      .filter((c) => c.priority !== 'must')
      .map((c): QuickReplyItem => ({ label: truncateLabel(c.label), action: { kind: 'event', event: { kind: 'priority', ref: c.ref } } }));
    decision.next = { ...decision.next, priorityAskedCount: conv.priorityAskedCount + 1 };
  }

  if (hasMore) decision.quickReplies.push({ label: 'もっと見る', action: { kind: 'event', event: { kind: 'more' } } });
  decision.quickReplies = decision.quickReplies.slice(0, QUICK_REPLY_MAX);
  return decision;
}

/** 緩和の提案を足す。提案が無ければ何もせず false */
function addRelaxation(decision: TurnDecision, slots: Slots, ctx: TurnContext): boolean {
  const s = suggestRelaxation(ctx.properties, slots);
  if (!s) return false;
  decision.replies.push({ type: 'text', text: msg.relaxationProposal(s.label, s.gained) });
  decision.quickReplies = [
    { label: '条件を変える', action: { kind: 'event', event: { kind: 'relax', ref: s.ref, accept: true } } },
    { label: 'このままにする', action: { kind: 'event', event: { kind: 'relax', ref: s.ref, accept: false } } },
  ];
  return true;
}

/**
 * 0件で、1つ緩めて増える提案も無いとき（予算が相場より大きく低いなど）。行き止まりにしない（DESIGN.md 3.2.1）。
 * 優先順位を聞く回数が残っていれば「どの条件なら緩められそうですか？」と外せない条件をボタンで並べ、選ばれた条件を
 * 「できれば」に下げて検索し直す。エリアはボタンに出さない（下げるとエリア外まで混ざる。エリアは言い直してもらう）。
 * 回数が尽きていたら、条件の変え方の例を返す
 */
function askWhichToLoosen(decision: TurnDecision, conv: ConversationSnapshot, conditions: readonly ConditionSummary[]): void {
  const loosenable = conditions.filter((c) => c.priority === 'must' && !(c.ref.kind === 'slot' && c.ref.key === 'area'));
  if (conv.priorityAskedCount >= ASK_PRIORITY_MAX_PER_CONVERSATION || loosenable.length === 0) {
    decision.replies.push({ type: 'text', text: msg.howToChangeConditions() });
    return;
  }
  decision.replies.push({ type: 'text', text: msg.askWhichToRelax() });
  decision.quickReplies = loosenable.map(
    (c): QuickReplyItem => ({ label: truncateLabel(c.label), action: { kind: 'event', event: { kind: 'loosen', ref: c.ref } } }),
  );
  decision.next = { ...decision.next, priorityAskedCount: conv.priorityAskedCount + 1 };
}

function onRelax(conv: ConversationSnapshot, ref: ConditionRef, accept: boolean, ctx: TurnContext): TurnDecision {
  if (!accept) return { ...base(conv), replies: [{ type: 'text', text: msg.keepConditions() }] };
  // 提案は決定的なので、いまのスロットで計算し直して同じ条件なら当てる（古いボタンなら条件を変えずに検索し直す）
  const s = suggestRelaxation(ctx.properties, conv.slots);
  const slots = s && sameRef(s.ref, ref) ? applySlotOps(conv.slots, s.ops) : conv.slots;
  return presentSearch(conv, slots, ctx);
}

function showMore(conv: ConversationSnapshot, ctx: TurnContext): TurnDecision {
  if (missingForSearch(conv.slots).length > 0) return presentSearch(conv, conv.slots, ctx);
  const result = searchProperties(ctx.properties, conv.slots);
  const offset = conv.shownPropertyIds.length;
  const page = result.items.slice(offset, offset + PAGE_SIZE);
  if (page.length === 0) return { ...base(conv), replies: [{ type: 'text', text: msg.noMoreResults() }] };
  const hasMore = offset + page.length < result.total;
  return {
    ...base(conv),
    replies: [{ type: 'carousel', items: page, startPosition: offset + 1, hasMore }],
    quickReplies: hasMore ? [{ label: 'もっと見る', action: { kind: 'event', event: { kind: 'more' } } }] : [],
    next: {
      ...conv,
      state: 'presenting',
      shownPropertyIds: [...conv.shownPropertyIds, ...page.map((i) => i.property.id)],
    },
  };
}

function showDetail(conv: ConversationSnapshot, propertyId: string, ctx: TurnContext): TurnDecision {
  const property = ctx.properties.find((p) => p.id === propertyId);
  if (!property) return { ...base(conv), replies: [{ type: 'text', text: msg.propertyUnavailable() }] };
  const index = conv.shownPropertyIds.indexOf(propertyId);
  return {
    ...base(conv),
    replies: [{ type: 'text', text: msg.propertyDetail(property, index >= 0 ? index + 1 : null) }],
    quickReplies: [{ label: 'この物件の内見を希望', action: { kind: 'event', event: { kind: 'viewing', propertyId } } }],
    next: { ...conv, state: 'qa' },
  };
}

// ---------- 内見の仮受付 ----------

/** 候補日時を足し、MIN 件揃えば受け付ける。足りなければ候補日のクイックリプライで聞く */
function addViewing(conv: ConversationSnapshot, propertyId: string, times: readonly string[], ctx: TurnContext): TurnDecision {
  const property = ctx.properties.find((p) => p.id === propertyId);
  if (!property) return { ...base(conv), replies: [{ type: 'text', text: msg.propertyUnavailable() }] };

  const offered = viewingCandidateDays(ctx.now, ctx.calendar, VIEWING_DAYS_TO_OFFER);
  const firstDay = offered[0];
  const current = conv.booking?.propertyId === propertyId ? conv.booking.candidateTimes : [];
  const valid = times.filter((t) => isValidViewingTime(t, firstDay, ctx.calendar));
  const collected = [...current];
  for (const t of valid) if (!collected.includes(t)) collected.push(t);
  const booking: BookingDraft = { propertyId, candidateTimes: collected.slice(0, VIEWING_CANDIDATES_MAX) };

  if (booking.candidateTimes.length >= VIEWING_CANDIDATES_MIN) return finalizeViewing(conv, booking, ctx);

  const replies: ReplyBlock[] = [];
  if (valid.length < times.length) replies.push({ type: 'text', text: msg.invalidViewingTimes(firstDay) });
  replies.push({ type: 'text', text: msg.askViewingTimes(property.name, booking.candidateTimes, firstDay) });
  const quickReplies: QuickReplyItem[] = offered
    .filter((d) => !booking.candidateTimes.some((t) => t.startsWith(d)))
    .map((date) => ({ label: formatJstDay(date), action: { kind: 'event', event: { kind: 'viewingDay', date } } }));
  if (booking.candidateTimes.length > 0) {
    quickReplies.push({ label: 'この日時で送る', action: { kind: 'event', event: { kind: 'bookingSubmit' } } });
  }
  return { ...base(conv), replies, quickReplies, next: { ...conv, state: 'booking', booking } };
}

/** 翌営業日以降の営業日か（時刻は担当者が調整するので見ない） */
function isValidViewingTime(value: string, firstDay: string, cal: BusinessCalendar): boolean {
  const date = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(value) && date >= firstDay && isBusinessDay(date, cal);
}

function finalizeViewing(conv: ConversationSnapshot, booking: BookingDraft, ctx: TurnContext): TurnDecision {
  const property = ctx.properties.find((p) => p.id === booking.propertyId);
  if (!property) return { ...base(conv), replies: [{ type: 'text', text: msg.propertyUnavailable() }] };
  const outside = !isOpenAt(ctx.now, ctx.calendar);
  return {
    ...base(conv),
    replies: [
      {
        type: 'text',
        text: msg.viewingAccepted(property.name, booking.candidateTimes, outside, nextContactDay(ctx.now, ctx.calendar), ctx.demo),
      },
    ],
    next: { ...conv, state: 'handed_off', booking: null },
    viewingRequest: booking,
  };
}

function truncateLabel(label: string): string {
  return label.length <= 20 ? label : `${label.slice(0, 19)}…`;
}
