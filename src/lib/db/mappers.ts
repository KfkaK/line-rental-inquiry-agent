/**
 * DB の行（snake_case）⇔ ドメインの型（camelCase）の変換と、入力の検証。
 * Supabase 実装とインメモリ実装が同じ規則を使うので、挙動がずれない。
 * 列名は supabase/migrations/20261007000000_init.sql と揃える（mappers.test.ts が突き合わせる）。
 */
import { TAGS } from '@/domain/types';
import type { Access, BusinessCalendar, BusinessHoursRow, ConversationState, Intent, Layout, Property, SlotOp, Slots, Tag } from '@/domain/types';
import type {
  BookingDraft,
  Conversation,
  ConversationPatch,
  ConversationSummary,
  HandoffNote,
  LineUser,
  Message,
  MessageRole,
  NewMessage,
  NewViewingRequest,
  Verification,
  ViewingRequest,
  ViewingRequestListItem,
  ViewingRequestPatch,
  ViewingStatus,
} from './types';

// ---------- 行の型（PostgREST が返す形） ----------

/** PostgREST の埋め込み。多対1 は通常オブジェクトだが、配列で返る形にも備える */
export type Embedded<T> = T | T[] | null | undefined;

/** numeric 列は JSON の数値で返るが、文字列で返る形にも備える */
type Numeric = number | string;

export interface PropertyDbRow {
  id: string;
  name: string;
  address: string;
  ward: string;
  access: { station: string; walk_min: number }[];
  rent: number;
  management_fee: number;
  deposit_months: Numeric;
  key_money_months: Numeric;
  layout: Layout;
  area_sqm: Numeric;
  floor: number;
  built_year: number;
  tags: string[];
  note: string;
  available_from: string | null;
  status: 'public' | 'private';
  updated_at: string;
}

export interface LineUserDbRow {
  id: string;
  line_user_id: string;
  display_name: string | null;
  created_at: string;
}

export interface ConversationDbRow {
  id: string;
  line_user_id: string;
  state: ConversationState;
  slots: Slots | null;
  shown_property_ids: string[];
  shown_offset: number;
  last_search_total: number | null;
  priority_asked_count: number;
  ai_paused: boolean;
  paused_at: string | null;
  last_staff_reply_at: string | null;
  booking: BookingDraft | null;
  handoff_notes: HandoffNote[] | null;
  created_at: string;
  updated_at: string;
}

export type ConversationSummaryDbRow = Omit<ConversationDbRow, 'line_user_id'> & {
  line_users?: Embedded<{ display_name: string | null }>;
};

export interface MessageDbRow {
  id: string;
  conversation_id: string;
  role: MessageRole;
  text: string;
  intent: string | null;
  slot_diff: SlotOp[] | null;
  tool_calls: unknown;
  verification: Verification | null;
  latency_ms: number | null;
  cost_usd: Numeric;
  created_at: string;
}

export interface ViewingRequestDbRow {
  id: string;
  conversation_id: string;
  property_id: string;
  candidate_times: string[];
  status: ViewingStatus;
  confirmed_time: string | null;
  staff_note: string | null;
  received_outside_hours: boolean;
  created_at: string;
  updated_at: string;
}

export type ViewingRequestListDbRow = ViewingRequestDbRow & {
  properties?: Embedded<{ name: string }>;
  conversations?: Embedded<{
    handoff_notes: HandoffNote[] | null;
    line_users?: Embedded<{ display_name: string | null }>;
  }>;
};

export interface BusinessHoursDbRow {
  weekday: number;
  open_time: string;
  close_time: string;
  is_closed: boolean;
}

export interface HolidayDbRow {
  date: string;
  name: string | null;
}

// ---------- select 句（列を明示して `line_user_id` を管理画面向けの戻り値に入れない） ----------

export const CONVERSATION_SUMMARY_COLUMNS = [
  'id',
  'state',
  'slots',
  'shown_property_ids',
  'shown_offset',
  'last_search_total',
  'priority_asked_count',
  'ai_paused',
  'paused_at',
  'last_staff_reply_at',
  'booking',
  'handoff_notes',
  'created_at',
  'updated_at',
] as const;

export const CONVERSATION_SUMMARY_SELECT = `${CONVERSATION_SUMMARY_COLUMNS.join(', ')}, line_users(display_name)`;

/** 内見の一覧: 物件名・表示名・会話の引き継ぎメモを埋め込みで引く（`line_user_id` は選ばない） */
export const VIEWING_REQUEST_LIST_SELECT = '*, properties(name), conversations(handoff_notes, line_users(display_name))';

// ---------- 小さな変換 ----------

function first<T>(value: Embedded<T>): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function toNumber(value: Numeric, label: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`数値として読めません（${label}）: ${String(value)}`);
  return n;
}

/** timestamptz を `toISOString()` 形式（UTC・ミリ秒）にそろえる。PostgREST は '+00:00'・マイクロ秒で返す */
export function toIso(value: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`日時として読めません: ${value}`);
  return new Date(ms).toISOString();
}

function toIsoOrNull(value: string | null | undefined): string | null {
  return value == null ? null : toIso(value);
}

/** PG の time は 'HH:MM:SS' で返る。ドメインは 'HH:MM' */
export function toHHMM(value: string): string {
  const m = /^(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value);
  if (!m) throw new Error(`時刻として読めません: ${value}`);
  return `${m[1]}:${m[2]}`;
}

const TAG_SET: ReadonlySet<string> = new Set(TAGS);

// ---------- properties ----------

export function rowToProperty(row: PropertyDbRow): Property {
  const access: Access[] = row.access.map((a) => ({ station: a.station, walkMin: a.walk_min }));
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    ward: row.ward,
    access,
    rent: row.rent,
    managementFee: row.management_fee,
    depositMonths: toNumber(row.deposit_months, 'deposit_months'),
    keyMoneyMonths: toNumber(row.key_money_months, 'key_money_months'),
    layout: row.layout,
    areaSqm: toNumber(row.area_sqm, 'area_sqm'),
    floor: row.floor,
    builtYear: row.built_year,
    // 古い語彙が DB に残っていても、型（閉じた集合）を守る
    tags: row.tags.filter((t): t is Tag => TAG_SET.has(t)),
    note: row.note,
    availableFrom: row.available_from,
    status: row.status,
  };
}

/** `updated_at` は DB のトリガーが付けるので含めない */
export function propertyToRow(property: Property): Omit<PropertyDbRow, 'updated_at'> {
  return {
    id: property.id,
    name: property.name,
    address: property.address,
    ward: property.ward,
    access: property.access.map((a) => ({ station: a.station, walk_min: a.walkMin })),
    rent: property.rent,
    management_fee: property.managementFee,
    deposit_months: property.depositMonths,
    key_money_months: property.keyMoneyMonths,
    layout: property.layout,
    area_sqm: property.areaSqm,
    floor: property.floor,
    built_year: property.builtYear,
    tags: [...property.tags],
    note: property.note,
    available_from: property.availableFrom,
    status: property.status,
  };
}

// ---------- line_users ----------

export function rowToLineUser(row: LineUserDbRow): LineUser {
  return {
    id: row.id,
    lineUserId: row.line_user_id,
    displayName: row.display_name,
    createdAt: toIso(row.created_at),
  };
}

// ---------- conversations ----------

function normalizeSlots(raw: Slots | null | undefined): Slots {
  const slots = (raw && typeof raw === 'object' ? raw : {}) as Partial<Slots>;
  return { ...slots, tags: Array.isArray(slots.tags) ? slots.tags : [] };
}

function normalizeBooking(raw: BookingDraft | null | undefined): BookingDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  return {
    propertyId: raw.propertyId,
    candidateTimes: Array.isArray(raw.candidateTimes) ? [...raw.candidateTimes] : [],
  };
}

function normalizeHandoffNotes(raw: HandoffNote[] | null | undefined): HandoffNote[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((n) => ({
    text: n.text,
    topic: n.topic ?? null,
    propertyIds: Array.isArray(n.propertyIds) ? [...n.propertyIds] : [],
    at: n.at,
  }));
}

export function rowToConversation(row: ConversationDbRow): Conversation {
  const { line_user_id, ...rest } = row;
  return { lineUserId: line_user_id, ...rowToConversationBody(rest) };
}

function rowToConversationBody(row: Omit<ConversationDbRow, 'line_user_id'>): Omit<Conversation, 'lineUserId'> {
  return {
    id: row.id,
    state: row.state,
    slots: normalizeSlots(row.slots),
    shownPropertyIds: [...(row.shown_property_ids ?? [])],
    shownOffset: row.shown_offset,
    lastSearchTotal: row.last_search_total,
    priorityAskedCount: row.priority_asked_count,
    aiPaused: row.ai_paused,
    pausedAt: toIsoOrNull(row.paused_at),
    lastStaffReplyAt: toIsoOrNull(row.last_staff_reply_at),
    booking: normalizeBooking(row.booking),
    handoffNotes: normalizeHandoffNotes(row.handoff_notes),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** 管理画面向け。埋め込みの `line_users` から表示名を取る。`line_user_id` は含めない */
export function rowToConversationSummary(row: ConversationSummaryDbRow): ConversationSummary {
  const { line_users, ...rest } = row;
  return { ...rowToConversationBody(rest), displayName: first(line_users)?.display_name ?? null };
}

/** `Conversation` を管理画面向けにする（インメモリ実装が使う） */
export function toConversationSummary(conversation: Conversation, displayName: string | null): ConversationSummary {
  // 管理画面向けには `lineUserId` を落とす
  const rest: Omit<Conversation, 'lineUserId'> & { lineUserId?: string } = { ...conversation };
  delete rest.lineUserId;
  return { ...rest, displayName };
}

/** undefined の項目は含めない（変えない）。null は含める（null に更新する） */
export function conversationPatchToRow(patch: ConversationPatch): Partial<Omit<ConversationDbRow, 'id' | 'line_user_id' | 'created_at' | 'updated_at'>> {
  const row: Partial<Omit<ConversationDbRow, 'id' | 'line_user_id' | 'created_at' | 'updated_at'>> = {};
  if (patch.state !== undefined) row.state = patch.state;
  if (patch.slots !== undefined) row.slots = patch.slots;
  if (patch.shownPropertyIds !== undefined) row.shown_property_ids = patch.shownPropertyIds;
  if (patch.shownOffset !== undefined) row.shown_offset = patch.shownOffset;
  if (patch.lastSearchTotal !== undefined) row.last_search_total = patch.lastSearchTotal;
  if (patch.priorityAskedCount !== undefined) row.priority_asked_count = patch.priorityAskedCount;
  if (patch.aiPaused !== undefined) row.ai_paused = patch.aiPaused;
  if (patch.pausedAt !== undefined) row.paused_at = patch.pausedAt;
  if (patch.lastStaffReplyAt !== undefined) row.last_staff_reply_at = patch.lastStaffReplyAt;
  if (patch.booking !== undefined) row.booking = patch.booking;
  if (patch.handoffNotes !== undefined) row.handoff_notes = patch.handoffNotes;
  return row;
}

// ---------- messages ----------

export function rowToMessage(row: MessageDbRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    text: row.text,
    intent: (row.intent as Intent | null) ?? null,
    slotDiff: row.slot_diff ?? null,
    toolCalls: row.tool_calls ?? null,
    verification: row.verification ?? null,
    latencyMs: row.latency_ms ?? null,
    costUsd: toNumber(row.cost_usd, 'cost_usd'),
    createdAt: toIso(row.created_at),
  };
}

/** `created_at` は指定があるときだけ含める（無ければ DB の now()） */
export function newMessageToRow(message: NewMessage): Omit<MessageDbRow, 'id' | 'created_at'> & { created_at?: string } {
  const row: Omit<MessageDbRow, 'id' | 'created_at'> & { created_at?: string } = {
    conversation_id: message.conversationId,
    role: message.role,
    text: message.text,
    intent: message.intent ?? null,
    slot_diff: message.slotDiff ?? null,
    tool_calls: message.toolCalls ?? null,
    verification: message.verification ?? null,
    latency_ms: message.latencyMs ?? null,
    cost_usd: message.costUsd ?? 0,
  };
  if (message.createdAt !== undefined) row.created_at = toIso(message.createdAt);
  return row;
}

// ---------- viewing_requests ----------

export function rowToViewingRequest(row: ViewingRequestDbRow): ViewingRequest {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    propertyId: row.property_id,
    candidateTimes: [...(row.candidate_times ?? [])],
    status: row.status,
    confirmedTime: row.confirmed_time ?? null,
    staffNote: row.staff_note ?? null,
    receivedOutsideHours: row.received_outside_hours,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function rowToViewingRequestListItem(row: ViewingRequestListDbRow): ViewingRequestListItem {
  const { properties, conversations, ...rest } = row;
  const conversation = first(conversations);
  return {
    ...rowToViewingRequest(rest),
    displayName: first(conversation?.line_users)?.display_name ?? null,
    propertyName: first(properties)?.name ?? null,
    handoffNotes: normalizeHandoffNotes(conversation?.handoff_notes),
  };
}

/** `status` は DB の既定値（pending）に任せる */
export function newViewingRequestToRow(
  input: NewViewingRequest,
): Pick<ViewingRequestDbRow, 'conversation_id' | 'property_id' | 'candidate_times' | 'received_outside_hours'> {
  return {
    conversation_id: input.conversationId,
    property_id: input.propertyId,
    candidate_times: [...input.candidateTimes],
    received_outside_hours: input.receivedOutsideHours,
  };
}

export function viewingRequestPatchToRow(
  patch: ViewingRequestPatch,
): Partial<Pick<ViewingRequestDbRow, 'status' | 'confirmed_time' | 'staff_note'>> {
  const row: Partial<Pick<ViewingRequestDbRow, 'status' | 'confirmed_time' | 'staff_note'>> = {};
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.confirmedTime !== undefined) row.confirmed_time = patch.confirmedTime;
  if (patch.staffNote !== undefined) row.staff_note = patch.staffNote;
  return row;
}

// ---------- business_hours / holidays ----------

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 'YYYY-MM-DD' で、実在する日付であること（'2026-02-30' は不可）。フィルタ文字列に埋め込むので形式も固める */
export function assertDate(value: string): string {
  const m = DATE_PATTERN.exec(value);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const date = new Date(Date.UTC(y, mo - 1, d));
    if (date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d) return value;
  }
  throw new Error(`日付は 'YYYY-MM-DD' の実在する日で指定してください: ${value}`);
}

/** 休業日の一覧を検証し、重複を除いて日付順にする */
export function normalizeHolidays(dates: readonly string[]): string[] {
  return [...new Set(dates.map(assertDate))].sort();
}

/** 曜日 0〜6・時刻 'HH:MM'・営業日は open < close を検証する。同じ曜日が複数あれば後ろを採用し、曜日順にする */
export function normalizeHoursRows(rows: readonly BusinessHoursRow[]): BusinessHoursRow[] {
  const byWeekday = new Map<number, BusinessHoursRow>();
  for (const row of rows) {
    if (!Number.isInteger(row.weekday) || row.weekday < 0 || row.weekday > 6) {
      throw new Error(`曜日は 0（日）〜6（土）で指定してください: ${row.weekday}`);
    }
    if (!TIME_PATTERN.test(row.open) || !TIME_PATTERN.test(row.close)) {
      throw new Error(`営業時間は 'HH:MM' で指定してください: ${row.open}-${row.close}`);
    }
    if (!row.isClosed && row.open >= row.close) {
      throw new Error(`営業日の開始は終了より前にしてください: ${row.open}-${row.close}`);
    }
    byWeekday.set(row.weekday, { weekday: row.weekday, open: row.open, close: row.close, isClosed: row.isClosed });
  }
  return [...byWeekday.values()].sort((a, b) => a.weekday - b.weekday);
}

export function hoursToRow(row: BusinessHoursRow): BusinessHoursDbRow {
  return { weekday: row.weekday, open_time: row.open, close_time: row.close, is_closed: row.isClosed };
}

export function rowsToCalendar(hours: readonly BusinessHoursDbRow[], holidays: readonly HolidayDbRow[]): BusinessCalendar {
  return {
    hours: hours
      .map((r) => ({ weekday: r.weekday, open: toHHMM(r.open_time), close: toHHMM(r.close_time), isClosed: r.is_closed }))
      .sort((a, b) => a.weekday - b.weekday),
    holidays: holidays.map((r) => r.date).sort(),
  };
}
