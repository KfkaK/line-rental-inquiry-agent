/**
 * インメモリのリポジトリ実装。テストと、Supabase 未接続のローカル開発で使う。
 * Supabase 実装と同じ契約（一意制約・外部キー・NOT_FOUND・並び順）を守る。返す値も渡された値も複製するので、
 * 呼び出し側が受け取ったオブジェクトを書き換えても内部の状態は変わらない。
 *
 * 現在時刻は `options.clock` で受け取る（既定は実時計。テストでは固定・進行する偽物を渡す）。
 */
import { DEFAULT_CLOSE, DEFAULT_CLOSED_WEEKDAYS, DEFAULT_OPEN } from '@/domain/rules';
import type { BusinessCalendar, BusinessHoursRow, Property } from '@/domain/types';
import {
  conversationPatchToRow,
  normalizeHoursRows,
  normalizeHolidays,
  toConversationSummary,
  toIso,
  viewingRequestPatchToRow,
} from './mappers';
import {
  DbError,
  type Conversation,
  type ConversationListOptions,
  type ConversationPatch,
  type LineUser,
  type LineUserInput,
  type Message,
  type NewMessage,
  type NewViewingRequest,
  type Repositories,
  type ViewingRequest,
  type ViewingRequestListItem,
  type ViewingRequestPatch,
  type ViewingStatus,
} from './types';

export interface MemorySeed {
  properties?: Property[];
  /** 表示名つきで LINE ユーザーを作っておく */
  lineUsers?: LineUserInput[];
  /** `lineUserId` の LINE ユーザーが無ければ、表示名なしで作る。`handoffResolvedCount`・`isDemo` の省略は 0・false */
  conversations?: SeedConversation[];
  messages?: Message[];
  viewingRequests?: ViewingRequest[];
  /** 渡した曜日だけ既定値を上書きする（DB と同じく 7 曜日は常にある） */
  calendar?: BusinessCalendar;
}

export type SeedConversation = Omit<Conversation, 'handoffResolvedCount' | 'isDemo'> &
  Partial<Pick<Conversation, 'handoffResolvedCount' | 'isDemo'>>;

export interface MemoryOptions {
  /** 現在時刻。既定は実時計 */
  clock?: () => Date;
  /** ID の採番。既定は `crypto.randomUUID()`。テストでは連番を渡すと読みやすい */
  newId?: () => string;
}

const DEFAULT_LIST_LIMIT = 50;

/** 営業時間の既定値（rules.ts）。init.sql の business_hours の初期値と同じ */
function defaultHours(): BusinessHoursRow[] {
  return [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    open: DEFAULT_OPEN,
    close: DEFAULT_CLOSE,
    isClosed: DEFAULT_CLOSED_WEEKDAYS.includes(weekday),
  }));
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

/** patch のうち undefined でない項目だけを base に重ねる（null は上書きする） */
function withPatch<T extends object>(base: T, patch: Partial<T>): T {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (next as Record<string, unknown>)[key] = copy(value);
  }
  return next;
}

function compareId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function notFound(operation: string, what: string, id: string): DbError {
  return new DbError(operation, `${what}が見つかりません: ${id}`, 'NOT_FOUND');
}

function foreignKey(operation: string, what: string, id: string): DbError {
  return new DbError(operation, `${what}が存在しません: ${id}`, '23503');
}

export function createMemoryRepositories(seed: MemorySeed = {}, options: MemoryOptions = {}): Repositories {
  const clock = options.clock ?? (() => new Date());
  const newId = options.newId ?? (() => globalThis.crypto.randomUUID());
  const now = (): string => clock().toISOString();

  const properties = new Map<string, Property>();
  const lineUsers = new Map<string, LineUser>(); // キーは lineUserId
  const conversations = new Map<string, Conversation>(); // キーは会話 ID
  const messages: Message[] = [];
  const viewingRequests = new Map<string, ViewingRequest>();
  const hours = new Map<number, BusinessHoursRow>(defaultHours().map((row) => [row.weekday, row]));
  let holidays: string[] = [];
  const webhookEventIds = new Set<string>();

  // ---------- 内部の操作 ----------

  const upsertLineUser = (input: LineUserInput): LineUser => {
    const existing = lineUsers.get(input.lineUserId);
    if (existing) {
      if (input.displayName != null) existing.displayName = input.displayName;
      return existing;
    }
    const user: LineUser = {
      id: newId(),
      lineUserId: input.lineUserId,
      displayName: input.displayName ?? null,
      createdAt: now(),
    };
    lineUsers.set(user.lineUserId, user);
    return user;
  };

  const findConversationByLineUser = (lineUserId: string): Conversation | undefined => {
    for (const conversation of conversations.values()) {
      if (conversation.lineUserId === lineUserId) return conversation;
    }
    return undefined;
  };

  const displayNameOf = (lineUserId: string): string | null => lineUsers.get(lineUserId)?.displayName ?? null;

  const toListItem = (request: ViewingRequest): ViewingRequestListItem => {
    const conversation = conversations.get(request.conversationId);
    return copy({
      ...request,
      displayName: conversation ? displayNameOf(conversation.lineUserId) : null,
      propertyName: properties.get(request.propertyId)?.name ?? null,
      handoffNotes: conversation?.handoffNotes ?? [],
      handoffResolvedCount: conversation?.handoffResolvedCount ?? 0,
      isDemo: conversation?.isDemo ?? false,
    });
  };

  // ---------- 初期データ ----------

  for (const property of seed.properties ?? []) properties.set(property.id, copy(property));
  for (const user of seed.lineUsers ?? []) upsertLineUser(user);
  for (const conversation of seed.conversations ?? []) {
    upsertLineUser({ lineUserId: conversation.lineUserId });
    conversations.set(conversation.id, copy({ handoffResolvedCount: 0, isDemo: false, ...conversation }));
  }
  for (const message of seed.messages ?? []) messages.push(copy(message));
  for (const request of seed.viewingRequests ?? []) viewingRequests.set(request.id, copy(request));
  for (const row of normalizeHoursRows(seed.calendar?.hours ?? [])) hours.set(row.weekday, row);
  holidays = normalizeHolidays(seed.calendar?.holidays ?? []);

  // ---------- リポジトリ ----------

  return {
    properties: {
      async listPublic() {
        return [...properties.values()]
          .filter((p) => p.status === 'public')
          .sort(compareId)
          .map(copy);
      },

      async getByIds(ids) {
        const seen = new Set<string>();
        const found: Property[] = [];
        for (const id of ids) {
          if (seen.has(id)) continue;
          seen.add(id);
          const property = properties.get(id);
          if (property) found.push(copy(property));
        }
        return found;
      },

      async upsertMany(list) {
        const unique = new Map<string, Property>();
        for (const property of list) unique.set(property.id, property);
        let inserted = 0;
        let updated = 0;
        for (const [id, property] of unique) {
          if (properties.has(id)) updated += 1;
          else inserted += 1;
          properties.set(id, copy(property));
        }
        return { inserted, updated };
      },
    },

    lineUsers: {
      async upsert(input) {
        return copy(upsertLineUser(input));
      },
    },

    conversations: {
      async getOrCreate(lineUserId) {
        const existing = findConversationByLineUser(lineUserId);
        if (existing) return copy(existing);
        if (!lineUsers.has(lineUserId)) throw foreignKey('conversations.getOrCreate', 'LINE ユーザー', lineUserId);
        const at = now();
        const conversation: Conversation = {
          id: newId(),
          lineUserId,
          state: 'hearing',
          slots: { tags: [] },
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
          isDemo: false,
          createdAt: at,
          updatedAt: at,
        };
        conversations.set(conversation.id, conversation);
        return copy(conversation);
      },

      async getById(id) {
        const conversation = conversations.get(id);
        return conversation ? copy(conversation) : null;
      },

      async update(id, patch: ConversationPatch) {
        const current = conversations.get(id);
        if (!current) throw notFound('conversations.update', '会話', id);
        // 空の patch は何も書かない（Supabase 実装と同じ。updatedAt も進めない）
        if (Object.keys(conversationPatchToRow(patch)).length === 0) return copy(current);
        // DB の check (handoff_resolved_count >= 0) と同じ
        if (patch.handoffResolvedCount !== undefined && patch.handoffResolvedCount < 0) {
          throw new DbError('conversations.update', 'handoff_resolved_count は 0 以上', '23514');
        }
        const next = { ...withPatch<Conversation>(current, patch), updatedAt: now() };
        conversations.set(id, next);
        return copy(next);
      },

      async listRecent(listOptions: ConversationListOptions = {}) {
        const { limit = DEFAULT_LIST_LIMIT, offset = 0, state, aiPaused } = listOptions;
        return (
          [...conversations.values()]
            // 後から作った会話を先に並べてから安定ソートする（同時刻は新しい方が先）
            .reverse()
            .filter((c) => (state === undefined || c.state === state) && (aiPaused === undefined || c.aiPaused === aiPaused))
            .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
            .slice(offset, offset + limit)
            .map((c) => toConversationSummary(copy(c), displayNameOf(c.lineUserId)))
        );
      },

      async getSummary(id) {
        const conversation = conversations.get(id);
        return conversation ? toConversationSummary(copy(conversation), displayNameOf(conversation.lineUserId)) : null;
      },

      async listWithOpenHandoff() {
        return [...conversations.values()]
          .reverse()
          .filter((c) => c.handoffNotes.length > c.handoffResolvedCount)
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
          .map((c) => toConversationSummary(copy(c), displayNameOf(c.lineUserId)));
      },
    },

    messages: {
      async insert(input: NewMessage) {
        const conversation = conversations.get(input.conversationId);
        if (!conversation) throw foreignKey('messages.insert', '会話', input.conversationId);
        const at = now();
        const message: Message = {
          id: newId(),
          conversationId: input.conversationId,
          role: input.role,
          text: input.text,
          intent: input.intent ?? null,
          slotDiff: copy(input.slotDiff ?? null),
          toolCalls: copy(input.toolCalls ?? null),
          verification: input.verification ?? null,
          latencyMs: input.latencyMs ?? null,
          costUsd: input.costUsd ?? 0,
          createdAt: input.createdAt !== undefined ? toIso(input.createdAt) : at,
        };
        messages.push(message);
        // DB のトリガー（messages_touch_conversation）と同じ
        conversation.updatedAt = at;
        return copy(message);
      },

      async listByConversation(conversationId) {
        return messages
          .filter((m) => m.conversationId === conversationId)
          .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
          .map(copy);
      },

      async countExtractedTurnsSince(lineUserId, since) {
        const conversation = findConversationByLineUser(lineUserId);
        if (!conversation) return 0;
        const from = since.getTime();
        return messages.filter(
          (m) => m.conversationId === conversation.id && m.role === 'ai' && m.intent != null && Date.parse(m.createdAt) >= from,
        ).length;
      },

      async sumCostSince(since) {
        const from = since.getTime();
        const sum = messages.filter((m) => Date.parse(m.createdAt) >= from).reduce((total, m) => total + m.costUsd, 0);
        // DB の numeric(12, 6) と同じ精度にそろえる
        return Math.round(sum * 1e6) / 1e6;
      },
    },

    viewingRequests: {
      async create(input: NewViewingRequest) {
        if (!conversations.has(input.conversationId)) {
          throw foreignKey('viewingRequests.create', '会話', input.conversationId);
        }
        if (!properties.has(input.propertyId)) throw foreignKey('viewingRequests.create', '物件', input.propertyId);
        const at = now();
        const request: ViewingRequest = {
          id: newId(),
          conversationId: input.conversationId,
          propertyId: input.propertyId,
          candidateTimes: [...input.candidateTimes],
          status: 'pending',
          confirmedTime: null,
          staffNote: null,
          receivedOutsideHours: input.receivedOutsideHours,
          createdAt: at,
          updatedAt: at,
        };
        viewingRequests.set(request.id, request);
        return copy(request);
      },

      async getById(id) {
        const request = viewingRequests.get(id);
        return request ? toListItem(request) : null;
      },

      async listSince(since) {
        const from = since.getTime();
        return [...viewingRequests.values()]
          .filter((r) => Date.parse(r.createdAt) >= from)
          .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
          .map(toListItem);
      },

      async listByStatus(status: ViewingStatus) {
        return [...viewingRequests.values()]
          .filter((r) => r.status === status)
          .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
          .map(toListItem);
      },

      async listByConversation(conversationId) {
        return [...viewingRequests.values()]
          .filter((r) => r.conversationId === conversationId)
          .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
          .map(toListItem);
      },

      async update(id, patch: ViewingRequestPatch) {
        const current = viewingRequests.get(id);
        if (!current) throw notFound('viewingRequests.update', '内見の仮受付', id);
        if (Object.keys(viewingRequestPatchToRow(patch)).length === 0) return copy(current);
        const next = { ...withPatch<ViewingRequest>(current, patch), updatedAt: now() };
        viewingRequests.set(id, next);
        return copy(next);
      },
    },

    businessCalendar: {
      async get() {
        return copy({
          hours: [...hours.values()].sort((a, b) => a.weekday - b.weekday),
          holidays,
        });
      },

      async setHours(rows) {
        for (const row of normalizeHoursRows(rows)) hours.set(row.weekday, row);
      },

      async setHolidays(dates) {
        holidays = normalizeHolidays(dates);
      },
    },

    webhookEvents: {
      async markIfNew(webhookEventId) {
        if (webhookEventIds.has(webhookEventId)) return false;
        webhookEventIds.add(webhookEventId);
        return true;
      },
    },
  };
}
