/**
 * プレビュー（ADMIN_PREVIEW=1）のデモデータ。ローカルの開発サーバーだけで使う（物件は data/ を fs で読む）。
 *
 * 朝の引き継ぎ一覧の両方の区分に案件が出るよう、時刻は `now` から作る:
 * - 夜間・休日分: 前回の営業終了（`previousClose`）から `now` までの間に届いた、仮受付 2 件（未対応・確定済み）と仮受付の無い引き継ぎ 1 件
 * - それ以前の未対応: 営業終了より前に届いた「対応中」の仮受付が 1 件
 * - 一覧に出ない会話: 担当者が手動返信して AI 停止中の会話、あいさつだけの会話
 * 文面は src/domain/messages.ts の実際の文から作る。ID は固定（乱数を使わない）。`line_user_id` は 'demo-…'。
 */
import fs from 'node:fs';
import path from 'node:path';
import { defaultCalendar, formatJstDay, nextContactDay, previousClose, viewingCandidateDays } from '@/domain/businessHours';
import * as msg from '@/domain/messages';
import { PAGE_SIZE, VIEWING_DAYS_TO_OFFER } from '@/domain/rules';
import { searchProperties } from '@/domain/search';
import { applySlotOps, emptySlots, listConditions } from '@/domain/slots';
import type { BusinessCalendar, HandoffNote, Intent, Property, SlotOp, Slots, Tag, ViewingStatus } from '@/domain/types';
import { attachTags } from '@/lib/csv/importProperties';
import { parsePropertiesCsv } from '@/lib/csv/properties';
import type { Message, MemorySeed, MessageRole, SeedConversation, Verification, ViewingRequest } from '@/lib/db';

/** data/properties.csv ＋ data/properties.truth.json の正解タグ（スクリプトと同じ読み方） */
export function loadPreviewProperties(): Property[] {
  const dir = path.join(process.cwd(), 'data');
  const { rows, errors } = parsePropertiesCsv(fs.readFileSync(path.join(dir, 'properties.csv'), 'utf8'));
  if (errors.length > 0) throw new Error(`data/properties.csv を読めません: ${errors[0].message}`);
  const truth = JSON.parse(fs.readFileSync(path.join(dir, 'properties.truth.json'), 'utf8')) as { id: string; tags: Tag[] }[];
  return attachTags(rows, new Map(truth.map((t) => [t.id, t.tags])));
}

interface MessageRow {
  role: MessageRole;
  text: string;
  at: string;
  intent?: Intent;
  slotDiff?: SlotOp[];
  verification?: Verification;
  latencyMs?: number;
  costUsd?: number;
}

function toMessages(conversationId: string, rows: readonly MessageRow[]): Message[] {
  return rows.map((row, i) => ({
    id: `${conversationId}-m${String(i + 1).padStart(2, '0')}`,
    conversationId,
    role: row.role,
    text: row.text,
    intent: row.intent ?? null,
    slotDiff: row.slotDiff ?? null,
    toolCalls: null,
    verification: row.verification ?? null,
    latencyMs: row.latencyMs ?? null,
    costUsd: row.costUsd ?? 0,
    createdAt: row.at,
  }));
}

/**
 * `calendar` は夜間の範囲（前回の営業終了から `now`）・連絡日・内見の候補日に使う。毎朝の作り直し（demoSeed.ts）は
 * DB の営業カレンダーを渡す（管理画面で営業時間を変えても、デモが「夜間・休日分」から外れないように）。
 * 内見の候補の時刻（14:00 など）は固定
 */
export function buildPreviewSeed(
  now: Date,
  properties: readonly Property[] = loadPreviewProperties(),
  calendar: BusinessCalendar = defaultCalendar(),
): MemorySeed {
  const close = previousClose(now, calendar);
  const gap = Math.max(now.getTime() - close.getTime(), 0);
  /** 前回の営業終了から `now` までの割合 f（0〜1）の時刻 */
  const overnight = (f: number): string => new Date(close.getTime() + Math.floor(gap * f)).toISOString();
  /** 前回の営業終了のさかのぼり */
  const before = (hours: number): string => new Date(close.getTime() - hours * 3_600_000).toISOString();
  const days = viewingCandidateDays(now, calendar, VIEWING_DAYS_TO_OFFER);
  const contactDayAt = (iso: string): string => nextContactDay(new Date(iso), calendar);
  const nameOf = (id: string): string => properties.find((p) => p.id === id)?.name ?? id;
  /** 'YYYY-MM-DD' の JST 日付に時刻を付けた候補（'2026-10-12T14:00'） */
  const candidate = (dayIndex: number, time: string): string => `${days[dayIndex]}T${time}`;
  /** 候補日時を利用者の言い方にする（'10月12日(月) 14時'） */
  const spoken = (value: string): string => {
    const [date, time] = value.split('T');
    return `${formatJstDay(date)} ${Number(time.slice(0, 2))}時`;
  };

  /** 条件で検索した上位（実際の検索結果なので、物件カードの ID は条件に合うものになる） */
  const search = (slots: Slots): { total: number; ids: string[] } => {
    const result = searchProperties(properties, slots);
    const ids = result.items.slice(0, PAGE_SIZE).map((item) => item.property.id);
    return ids.length > 0 ? { total: result.total, ids } : { total: properties.length, ids: properties.slice(0, PAGE_SIZE).map((p) => p.id) };
  };
  const cards = (ids: readonly string[]): string => `[物件カード 1〜${ids.length}番目: ${ids.join(', ')}]`;
  const presented = (slots: Slots, found: { total: number; ids: string[] }): string =>
    `${msg.searchIntro(found.total, found.ids.length, msg.conditionsSummary(listConditions(slots)))}\n\n${cards(found.ids)}`;
  const note = (text: string, topic: HandoffNote['topic'], propertyIds: string[], at: string): HandoffNote => ({ text, topic, propertyIds, at });

  const conversations: SeedConversation[] = [];
  const messages: Message[] = [];
  const viewingRequests: ViewingRequest[] = [];
  const lineUsers: { lineUserId: string; displayName: string | null }[] = [];

  /** 会話・メッセージ・LINE ユーザーを登録する。`updatedAt` は最後のメッセージの時刻 */
  const addConversation = (
    key: string,
    displayName: string | null,
    rows: readonly MessageRow[],
    fields: Partial<SeedConversation> & Pick<SeedConversation, 'state' | 'slots'>,
  ): string => {
    const id = `conv-demo-${key}`;
    lineUsers.push({ lineUserId: `demo-${key}`, displayName });
    messages.push(...toMessages(id, rows));
    conversations.push({
      id,
      lineUserId: `demo-${key}`,
      shownPropertyIds: [],
      shownOffset: 0,
      lastSearchTotal: null,
      priorityAskedCount: 0,
      aiPaused: false,
      pausedAt: null,
      lastStaffReplyAt: null,
      booking: null,
      handoffNotes: [],
      handoffResolvedCount: 0,
      isDemo: true,
      createdAt: rows[0].at,
      updatedAt: rows[rows.length - 1].at,
      ...fields,
    });
    return id;
  };

  const addViewing = (
    key: string,
    conversationId: string,
    propertyId: string,
    candidateTimes: string[],
    fields: { createdAt: string; receivedOutsideHours: boolean; status: ViewingStatus; confirmedTime?: string; staffNote?: string; updatedAt?: string },
  ): void => {
    viewingRequests.push({
      id: `vr-demo-${key}`,
      conversationId,
      propertyId,
      candidateTimes,
      status: fields.status,
      confirmedTime: fields.confirmedTime ?? null,
      staffNote: fields.staffNote ?? null,
      receivedOutsideHours: fields.receivedOutsideHours,
      createdAt: fields.createdAt,
      updatedAt: fields.updatedAt ?? fields.createdAt,
    });
  };

  // ---------- A. 夜間に条件を伝え、内見を仮受付（未対応・時間外）＋「空いてますか？」の引き継ぎメモ ----------
  {
    const ops: SlotOp[] = [
      { op: 'set', key: 'area', value: { stations: ['渋谷', '中目黒'], wards: [] }, priority: 'must' },
      { op: 'set', key: 'rentMax', value: 90000, priority: 'must' },
      { op: 'addTag', tag: 'バストイレ別', priority: 'want' },
      { op: 'addTag', tag: 'オートロック', priority: 'want' },
    ];
    const slots = applySlotOps(emptySlots(), ops);
    const found = search(slots);
    const first = found.ids[0];
    const chosen = [candidate(0, '14:00'), candidate(1, '11:00')];
    const t = (n: number): string => overnight(0.08 + n * 0.01);
    const askedAt = t(3);
    const vacancyQuestion = '1番目は今空いてますか？';
    const id = addConversation(
      'yamada',
      '山田 さくら',
      [
        { role: 'user', text: '渋谷か中目黒で9万円まで。バストイレ別とオートロックがあると嬉しいです', at: t(0) },
        { role: 'ai', text: presented(slots, found), at: t(1), intent: 'conditions', slotDiff: ops, latencyMs: 2410, costUsd: 0.0021 },
        { role: 'user', text: vacancyQuestion, at: askedAt },
        { role: 'ai', text: msg.handoff('vacancy', true, contactDayAt(askedAt)), at: t(4), intent: 'handoff', latencyMs: 1380, costUsd: 0.0009 },
        { role: 'user', text: '1番目の内見をしたいです', at: t(5) },
        { role: 'ai', text: msg.askViewingTimes(nameOf(first), [], days[0]), at: t(6), intent: 'viewingRequest', latencyMs: 1520, costUsd: 0.0008 },
        { role: 'user', text: `${spoken(chosen[0])}か、${spoken(chosen[1])}でお願いします`, at: t(7) },
        {
          role: 'ai',
          text: msg.viewingAccepted(nameOf(first), chosen, true, contactDayAt(t(8))),
          at: t(8),
          intent: 'viewingRequest',
          latencyMs: 1710,
          costUsd: 0.0011,
        },
      ],
      {
        state: 'presenting',
        slots,
        shownPropertyIds: found.ids,
        shownOffset: found.ids.length,
        lastSearchTotal: found.total,
        handoffNotes: [note(vacancyQuestion, 'vacancy', [first], askedAt)],
      },
    );
    addViewing('yamada', id, first, chosen, { createdAt: t(8), receivedOutsideHours: true, status: 'pending' });
  }

  // ---------- B. 深夜に周辺の治安を聞いただけ（引き継ぎメモだけ・仮受付なし） ----------
  {
    const ops: SlotOp[] = [
      { op: 'set', key: 'area', value: { stations: ['中目黒'], wards: [] }, priority: 'must' },
      { op: 'set', key: 'rentMax', value: 80000, priority: 'must' },
    ];
    const slots = applySlotOps(emptySlots(), ops);
    const found = search(slots);
    const second = found.ids[1] ?? found.ids[0];
    const t = (n: number): string => overnight(0.3 + n * 0.01);
    const question = '2番目のあたり、夜は治安どうですか？';
    addConversation(
      'suzuki',
      '鈴木 健太',
      [
        { role: 'user', text: '中目黒で8万円くらいで探しています', at: t(0) },
        { role: 'ai', text: presented(slots, found), at: t(1), intent: 'conditions', slotDiff: ops, latencyMs: 2290, costUsd: 0.0019 },
        { role: 'user', text: question, at: t(2) },
        { role: 'ai', text: msg.handoff('safety', true, contactDayAt(t(2))), at: t(3), intent: 'handoff', latencyMs: 1290, costUsd: 0.0008 },
      ],
      {
        state: 'handed_off',
        slots,
        shownPropertyIds: found.ids,
        shownOffset: found.ids.length,
        lastSearchTotal: found.total,
        handoffNotes: [note(question, 'safety', [second], t(2))],
      },
    );
  }

  // ---------- C. 夜間分の仮受付を、朝に担当者が確定済み ----------
  {
    const ops: SlotOp[] = [
      { op: 'set', key: 'area', value: { stations: ['吉祥寺', '西荻窪'], wards: [] }, priority: 'must' },
      { op: 'set', key: 'rentMax', value: 100000, priority: 'must' },
      { op: 'set', key: 'layouts', value: ['1LDK'], priority: 'want' },
    ];
    const slots = applySlotOps(emptySlots(), ops);
    const found = search(slots);
    const target = found.ids[1] ?? found.ids[0];
    const chosen = [candidate(0, '15:00')];
    const t = (n: number): string => overnight(0.5 + n * 0.01);
    const confirmedAt = overnight(0.96);
    const confirmedTime = candidate(0, '15:00');
    const staffNote = 'お待ちしております。ご不明な点があればこのトークでご連絡ください。';
    const id = addConversation(
      'takahashi',
      '高橋 美咲',
      [
        { role: 'user', text: '吉祥寺か西荻窪で10万円まで、1LDKを探しています', at: t(0) },
        { role: 'ai', text: presented(slots, found), at: t(1), intent: 'conditions', slotDiff: ops, latencyMs: 2530, costUsd: 0.0022 },
        { role: 'user', text: `2番目の内見をお願いします。${spoken(chosen[0])}で`, at: t(2) },
        {
          role: 'ai',
          text: msg.viewingAccepted(nameOf(target), chosen, true, contactDayAt(t(3))),
          at: t(3),
          intent: 'viewingRequest',
          latencyMs: 1640,
          costUsd: 0.001,
        },
        { role: 'staff', text: msg.viewingConfirmed(nameOf(target), confirmedTime, staffNote), at: confirmedAt },
      ],
      { state: 'presenting', slots, shownPropertyIds: found.ids, shownOffset: found.ids.length, lastSearchTotal: found.total },
    );
    addViewing('takahashi', id, target, chosen, {
      createdAt: t(3),
      receivedOutsideHours: true,
      status: 'confirmed',
      confirmedTime,
      staffNote,
      updatedAt: confirmedAt,
    });
  }

  // ---------- D. 前回の営業終了より前から「対応中」の仮受付（「それ以前の未対応」に残る） ----------
  {
    const ops: SlotOp[] = [
      { op: 'set', key: 'area', value: { stations: ['池袋', '大塚'], wards: [] }, priority: 'must' },
      { op: 'set', key: 'rentMax', value: 85000, priority: 'must' },
      { op: 'addTag', tag: 'ペット可', priority: 'want' },
    ];
    const slots = applySlotOps(emptySlots(), ops);
    const found = search(slots);
    const third = found.ids[2] ?? found.ids[0];
    const chosen = [candidate(1, '17:00'), candidate(2, '10:30')];
    const t = (n: number): string => before(27 - n * 0.2);
    const costQuestion = '初期費用はいくらくらいになりますか？';
    const id = addConversation(
      'ito',
      '伊藤 翔',
      [
        { role: 'user', text: '池袋か大塚で8.5万円まで、ペット可で探しています', at: t(0) },
        { role: 'ai', text: presented(slots, found), at: t(1), intent: 'conditions', slotDiff: ops, latencyMs: 2670, costUsd: 0.0023 },
        { role: 'user', text: `3番目の内見をしたいです。${spoken(chosen[0])}か${spoken(chosen[1])}`, at: t(2) },
        {
          role: 'ai',
          text: msg.viewingAccepted(nameOf(third), chosen, false, contactDayAt(t(3))),
          at: t(3),
          intent: 'viewingRequest',
          latencyMs: 1810,
          costUsd: 0.0012,
        },
        { role: 'user', text: costQuestion, at: t(4) },
        { role: 'ai', text: msg.handoff('initialCostTotal', false, contactDayAt(t(4))), at: t(5), intent: 'handoff', latencyMs: 1340, costUsd: 0.0008 },
      ],
      {
        state: 'presenting',
        slots,
        shownPropertyIds: found.ids,
        shownOffset: found.ids.length,
        lastSearchTotal: found.total,
        handoffNotes: [note(costQuestion, 'initialCostTotal', [third], t(4))],
      },
    );
    addViewing('ito', id, third, chosen, { createdAt: t(3), receivedOutsideHours: false, status: 'in_progress', updatedAt: t(5) });
  }

  // ---------- E. 担当者が手動返信して AI 停止中（根拠検証で差し替えた回答を含む） ----------
  {
    const ops: SlotOp[] = [
      { op: 'set', key: 'area', value: { stations: ['渋谷'], wards: [] }, priority: 'must' },
      { op: 'set', key: 'rentMax', value: 90000, priority: 'must' },
      { op: 'addTag', tag: 'ペット可', priority: 'want' },
    ];
    const slots = applySlotOps(emptySlots(), ops);
    const found = search(slots);
    const first = found.ids[0];
    const t = (n: number): string => overnight(0.6 + n * 0.01);
    const question = `${nameOf(first)}は、敷金と礼金を合わせるといくらになりますか？`;
    const repliedAt = overnight(0.9);
    addConversation(
      'watanabe',
      '渡辺 優',
      [
        { role: 'user', text: '渋谷で9万円まで、ペット可の部屋を探しています', at: t(0) },
        { role: 'ai', text: presented(slots, found), at: t(1), intent: 'conditions', slotDiff: ops, latencyMs: 2380, costUsd: 0.002 },
        { role: 'user', text: question, at: t(2) },
        {
          role: 'ai',
          text: msg.handoff(null, true, contactDayAt(t(3))),
          at: t(3),
          intent: 'propertyQuestion',
          verification: 'replaced',
          latencyMs: 3920,
          costUsd: 0.0046,
        },
        {
          role: 'staff',
          text: 'ご質問ありがとうございます。初期費用の概算をまとめて、このあとご連絡します。少々お待ちください。',
          at: repliedAt,
        },
        { role: 'user', text: 'ありがとうございます。よろしくお願いします', at: overnight(0.93) },
      ],
      {
        state: 'handed_off',
        slots,
        shownPropertyIds: found.ids,
        shownOffset: found.ids.length,
        lastSearchTotal: found.total,
        aiPaused: true,
        pausedAt: repliedAt,
        lastStaffReplyAt: repliedAt,
        handoffNotes: [note(question, null, [first], t(2))],
        // 担当者が返信して対応済み
        handoffResolvedCount: 1,
      },
    );
  }

  // ---------- F. 友だち追加してあいさつと条件を送っただけ（表示名なし） ----------
  {
    const ops: SlotOp[] = [{ op: 'set', key: 'area', value: { stations: ['新宿'], wards: [] }, priority: 'must' }];
    const slots = applySlotOps(emptySlots(), ops);
    addConversation(
      'newcomer',
      null,
      [
        { role: 'ai', text: msg.greeting(true), at: overnight(0.97), latencyMs: 420 },
        { role: 'user', text: '新宿あたりで探したいです', at: overnight(0.98) },
        { role: 'ai', text: msg.askFor('rentMax'), at: overnight(0.99), intent: 'conditions', slotDiff: ops, latencyMs: 1250, costUsd: 0.0007 },
      ],
      { state: 'hearing', slots },
    );
  }

  return {
    properties: properties.map((p) => ({ ...p })),
    lineUsers,
    conversations,
    messages,
    viewingRequests,
  };
}
