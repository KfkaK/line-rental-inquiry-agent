/**
 * DB 層の型とリポジトリのインターフェース（不変条件 10: 外部サービスはインターフェースの背後に置く）。
 * 実装は supabase.ts（本番）と memory.ts（テスト・Supabase 未接続のローカル開発）。同じ契約のテストで揃える。
 *
 * 規約
 * - 日時はすべて ISO 8601（UTC・`toISOString()` 形式）の文字列。比較は `Date.parse` で行う。
 * - 現在時刻が要る操作は引数で受け取る。リポジトリの中では `new Date()` を呼ばない
 *   （`created_at` / `updated_at` は DB 側の `now()`。インメモリ実装は時計関数を差し込む）。
 * - `line_user_id` は個人情報。管理画面向けの戻り値（`ConversationSummary` `ViewingRequestListItem`）には含めず、表示名だけを持たせる。
 */
import type {
  BookingDraft,
  BusinessCalendar,
  BusinessHoursRow,
  ConversationState,
  HandoffNote,
  Intent,
  Property,
  SlotOp,
  Slots,
} from '@/domain/types';

// ---------- エラー ----------

/**
 * リポジトリの失敗。`code` は Postgres のエラーコード（'23503' 外部キー違反・'23505' 一意制約違反）か、
 * 対象が無いときの 'NOT_FOUND'。Supabase 実装とインメモリ実装で同じ code を返す。
 */
export class DbError extends Error {
  readonly operation: string;
  readonly code: string | undefined;

  constructor(operation: string, message: string, code?: string) {
    super(`DB エラー（${operation}）: ${message}`);
    this.name = 'DbError';
    this.operation = operation;
    this.code = code;
  }
}

// ---------- LINE ユーザー ----------

export interface LineUser {
  id: string;
  /** 個人情報。管理画面に出さない */
  lineUserId: string;
  displayName: string | null;
  createdAt: string;
}

export interface LineUserInput {
  lineUserId: string;
  /** null / 省略のときは既存の表示名を消さない */
  displayName?: string | null;
}

// ---------- 会話 ----------

// BookingDraft・HandoffNote は会話エンジン（src/domain/turn.ts）と共有するのでドメインの型契約に置く
export type { BookingDraft, HandoffNote };

export interface Conversation {
  id: string;
  /** 個人情報。管理画面に出さない（管理画面向けは `ConversationSummary`） */
  lineUserId: string;
  state: ConversationState;
  slots: Slots;
  /** 提示済みの物件 ID（表示順）。「2番目」などの参照解決に使う */
  shownPropertyIds: string[];
  /** 「もっと見る」の位置（検索結果の何件目まで見せたか） */
  shownOffset: number;
  /** 直近の検索の must 通過件数。null は未検索 */
  lastSearchTotal: number | null;
  /** 優先順位を聞いた回数 */
  priorityAskedCount: number;
  aiPaused: boolean;
  pausedAt: string | null;
  /** 最終の担当者返信。AI_RESUME_AFTER_MS で自動再開を判定する */
  lastStaffReplyAt: string | null;
  /** 内見の聞き取り途中の状態。聞き取り中でなければ null */
  booking: BookingDraft | null;
  /** 担当者へ回した質問のメモ（古い順） */
  handoffNotes: HandoffNote[];
  createdAt: string;
  /** 会話の最終動作（状態の更新・メッセージの追加）の時刻 */
  updatedAt: string;
}

/** `update` に渡せる項目。省略（undefined）した項目は変えない。null は null に更新する */
export type ConversationPatch = Partial<
  Pick<
    Conversation,
    | 'state'
    | 'slots'
    | 'shownPropertyIds'
    | 'shownOffset'
    | 'lastSearchTotal'
    | 'priorityAskedCount'
    | 'aiPaused'
    | 'pausedAt'
    | 'lastStaffReplyAt'
    | 'booking'
    | 'handoffNotes'
  >
>;

/** 管理画面向けの会話。`lineUserId` を持たず、表示名を持つ */
export type ConversationSummary = Omit<Conversation, 'lineUserId'> & {
  displayName: string | null;
};

export interface ConversationListOptions {
  /** 既定 50 */
  limit?: number;
  /** 既定 0 */
  offset?: number;
  state?: ConversationState;
  aiPaused?: boolean;
}

// ---------- メッセージ ----------

export const MESSAGE_ROLES = ['user', 'ai', 'staff'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/** ok: そのまま送った / replaced: 根拠検証で不一致になり定型の引き継ぎ文に差し替えた */
export const VERIFICATIONS = ['ok', 'replaced'] as const;
export type Verification = (typeof VERIFICATIONS)[number];

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  text: string;
  intent: Intent | null;
  /** そのターンの条件の差分。管理画面の会話ログで「検索に使った条件」を見せる */
  slotDiff: SlotOp[] | null;
  /** tool use の呼び出しと結果（形は LLM 層が決める）。無ければ null */
  toolCalls: unknown;
  verification: Verification | null;
  latencyMs: number | null;
  /** そのターンの API 費用（USD） */
  costUsd: number;
  createdAt: string;
}

export interface NewMessage {
  conversationId: string;
  role: MessageRole;
  text: string;
  intent?: Intent | null;
  slotDiff?: SlotOp[] | null;
  toolCalls?: unknown;
  verification?: Verification | null;
  latencyMs?: number | null;
  /** 省略は 0 */
  costUsd?: number;
  /** 省略は DB の now()（インメモリは時計関数） */
  createdAt?: string;
}

// ---------- 内見の仮受付 ----------

/** 管理画面の 未対応 / 対応中 / 確定 / 却下 */
export const VIEWING_STATUSES = ['pending', 'in_progress', 'confirmed', 'rejected'] as const;
export type ViewingStatus = (typeof VIEWING_STATUSES)[number];

export interface ViewingRequest {
  id: string;
  conversationId: string;
  propertyId: string;
  /** JST の 'YYYY-MM-DDTHH:mm'（時刻が無ければ 'YYYY-MM-DD'） */
  candidateTimes: string[];
  status: ViewingStatus;
  /** 確定した日時。candidateTimes と同じ形式 */
  confirmedTime: string | null;
  staffNote: string | null;
  /** 営業時間外に受け付けた（効果測定用） */
  receivedOutsideHours: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * 管理画面向けの一覧の行。`lineUserId` は持たず、表示名・物件名・会話の `handoffNotes`
 * （AI が答えずに担当者へ回した質問。「AIが聞き取れなかったこと」の元）を持つ。
 */
export type ViewingRequestListItem = ViewingRequest & {
  displayName: string | null;
  propertyName: string | null;
  handoffNotes: HandoffNote[];
};

export interface NewViewingRequest {
  conversationId: string;
  propertyId: string;
  candidateTimes: string[];
  receivedOutsideHours: boolean;
}

/** 省略（undefined）した項目は変えない。null は null に更新する */
export interface ViewingRequestPatch {
  status?: ViewingStatus;
  confirmedTime?: string | null;
  staffNote?: string | null;
}

// ---------- リポジトリ ----------

export interface PropertyRepository {
  /** `status = 'public'` の物件を全件（ID 昇順）。must 条件の絞り込みはアプリの純関数が行う */
  listPublic(): Promise<Property[]>;
  /**
   * 渡した順で返す。status は問わない（非公開になった物件は呼び出し側で除外する）。
   * 存在しない ID は飛ばし、重複した ID は最初の1件だけ返す。
   */
  getByIds(ids: readonly string[]): Promise<Property[]>;
  /** ID をキーに登録・更新する。同じ ID が複数あれば後ろを採用する。件数は重複を除いたもの */
  upsertMany(properties: readonly Property[]): Promise<{ inserted: number; updated: number }>;
}

export interface LineUserRepository {
  upsert(input: LineUserInput): Promise<LineUser>;
}

export interface ConversationRepository {
  /**
   * 1 LINE ユーザー 1 会話。無ければ初期状態（hearing・条件なし）で作る。
   * 先に `lineUsers.upsert` で LINE ユーザーを登録しておくこと（無ければ DbError code '23503'）。
   */
  getOrCreate(lineUserId: string): Promise<Conversation>;
  /** サーバー専用（`lineUserId` を含む）。LINE への push など */
  getById(id: string): Promise<Conversation | null>;
  /** 空の patch は何もしない。対象が無ければ DbError code 'NOT_FOUND' */
  update(id: string, patch: ConversationPatch): Promise<Conversation>;
  /** 管理画面用。最終動作（updatedAt）の新しい順 */
  listRecent(options?: ConversationListOptions): Promise<ConversationSummary[]>;
  /** 管理画面用。1 件 */
  getSummary(id: string): Promise<ConversationSummary | null>;
}

export interface MessageRepository {
  /** 会話が無ければ DbError code '23503'。成功すると会話の updatedAt も進む */
  insert(message: NewMessage): Promise<Message>;
  /** 古い順 */
  listByConversation(conversationId: string): Promise<Message[]>;
  /** レート制限用。その LINE ユーザーの role='user' のメッセージのうち、`since` 以降（含む）の件数 */
  countUserMessagesSince(lineUserId: string, since: Date): Promise<number>;
  /** 1 日の費用上限用。`since` 以降（含む）の全メッセージの `costUsd` の合計 */
  sumCostSince(since: Date): Promise<number>;
}

export interface ViewingRequestRepository {
  /** 会話か物件が無ければ DbError code '23503'。status は 'pending' で作る */
  create(input: NewViewingRequest): Promise<ViewingRequest>;
  getById(id: string): Promise<ViewingRequestListItem | null>;
  /** 朝の引き継ぎ一覧用。`since` 以降（含む）に届いた全ステータスの案件を、届いた順（古い順）に */
  listSince(since: Date): Promise<ViewingRequestListItem[]>;
  /** 届いた順（古い順） */
  listByStatus(status: ViewingStatus): Promise<ViewingRequestListItem[]>;
  /** 空の patch は何もしない。対象が無ければ DbError code 'NOT_FOUND' */
  update(id: string, patch: ViewingRequestPatch): Promise<ViewingRequest>;
}

export interface BusinessCalendarRepository {
  /** 曜日順の営業時間と、日付順の休業日（祝日・臨時休業） */
  get(): Promise<BusinessCalendar>;
  /** 曜日ごとに登録・更新する。渡さなかった曜日は変えない。時刻は 'HH:MM'、営業日は open < close */
  setHours(rows: readonly BusinessHoursRow[]): Promise<void>;
  /** 休業日を渡した一覧に置き換える（'YYYY-MM-DD'）。残る日付の名前は保つ */
  setHolidays(dates: readonly string[]): Promise<void>;
}

export interface WebhookEventRepository {
  /** 初回だけ true、同じ ID の再送は false（二重処理の防止） */
  markIfNew(webhookEventId: string): Promise<boolean>;
}

export interface Repositories {
  properties: PropertyRepository;
  lineUsers: LineUserRepository;
  conversations: ConversationRepository;
  messages: MessageRepository;
  viewingRequests: ViewingRequestRepository;
  businessCalendar: BusinessCalendarRepository;
  webhookEvents: WebhookEventRepository;
}
