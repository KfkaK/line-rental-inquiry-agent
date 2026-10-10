/**
 * Supabase 実装のリポジトリ。サーバー専用（service role で RLS をバイパスして読み書きする）。
 * 環境変数は関数の中で読む（モジュールの読み込みでは読まない。実キーなしでテストが通るように）。
 *
 * 管理画面向けの戻り値（`ConversationSummary` `ViewingRequestListItem`）は、select の列を明示して
 * `line_user_id` を取らない。PostgREST の既定の 1000 行上限に掛かる読み出しはページングする。
 */
import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';
import { requireEnv } from '@/lib/env';
import {
  CONVERSATION_SUMMARY_SELECT,
  VIEWING_REQUEST_LIST_SELECT,
  conversationPatchToRow,
  hoursToRow,
  newMessageToRow,
  newViewingRequestToRow,
  normalizeHolidays,
  normalizeHoursRows,
  propertyToRow,
  rowToConversation,
  rowToConversationSummary,
  rowToLineUser,
  rowToMessage,
  rowToProperty,
  rowToViewingRequest,
  rowToViewingRequestListItem,
  rowsToCalendar,
  viewingRequestPatchToRow,
  type BusinessHoursDbRow,
  type ConversationDbRow,
  type ConversationSummaryDbRow,
  type HolidayDbRow,
  type LineUserDbRow,
  type MessageDbRow,
  type PropertyDbRow,
  type ViewingRequestDbRow,
  type ViewingRequestListDbRow,
} from './mappers';
import { DbError, type Conversation, type Repositories, type ViewingRequest } from './types';

/** PostgREST が 1 リクエストで返す行数の上限（Supabase の既定）。ページングの単位 */
const PAGE_SIZE = 1000;
/** `in (...)` フィルタ 1 回あたりの ID 数（URL の長さを抑える） */
const IN_CHUNK = 100;
/** 一括 upsert 1 回あたりの行数 */
const UPSERT_CHUNK = 200;
const DEFAULT_LIST_LIMIT = 50;

/** service role のサーバー用クライアント。呼ぶたびに環境変数を読む */
export function createServiceClient(): SupabaseClient {
  return createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function fail(operation: string, error: PostgrestError): DbError {
  return new DbError(operation, error.message, error.code);
}

function notFound(operation: string, what: string, id: string): DbError {
  return new DbError(operation, `${what}が見つかりません: ${id}`, 'NOT_FOUND');
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** 1000 行を超える読み出しをページングして集める。`page` は安定した並び（ユニークな列を含む order）を付けること */
async function fetchAll<T>(
  operation: string,
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: PostgrestError | null }>,
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw fail(operation, error);
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) return all;
  }
}

/**
 * `client` を渡すと差し替えられる（テスト用の偽物や、ログイン済み担当者のセッションのクライアントなど）。
 * 省略時は service role のクライアントを作る（環境変数が無ければここで落ちる）。
 */
export function createSupabaseRepositories(client: SupabaseClient = createServiceClient()): Repositories {
  const getConversationRow = async (operation: string, id: string): Promise<Conversation | null> => {
    const { data, error } = await client.from('conversations').select('*').eq('id', id).maybeSingle();
    if (error) throw fail(operation, error);
    return data ? rowToConversation(data as ConversationDbRow) : null;
  };

  const getViewingRequestRow = async (operation: string, id: string): Promise<ViewingRequest | null> => {
    const { data, error } = await client.from('viewing_requests').select('*').eq('id', id).maybeSingle();
    if (error) throw fail(operation, error);
    return data ? rowToViewingRequest(data as ViewingRequestDbRow) : null;
  };

  return {
    properties: {
      async listPublic() {
        const rows = await fetchAll<PropertyDbRow>('properties.listPublic', (from, to) =>
          client.from('properties').select('*').eq('status', 'public').order('id').range(from, to),
        );
        // DB の照合順序に依らず、JS の文字列比較で ID 昇順にそろえる（インメモリ実装と同じ並び）
        return rows.map(rowToProperty).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      },

      async getByIds(ids) {
        const unique = [...new Set(ids)];
        if (unique.length === 0) return [];
        const byId = new Map<string, ReturnType<typeof rowToProperty>>();
        for (const part of chunk(unique, IN_CHUNK)) {
          const { data, error } = await client.from('properties').select('*').in('id', part);
          if (error) throw fail('properties.getByIds', error);
          for (const row of (data ?? []) as PropertyDbRow[]) byId.set(row.id, rowToProperty(row));
        }
        return unique.flatMap((id) => {
          const property = byId.get(id);
          return property ? [property] : [];
        });
      },

      async upsertMany(list) {
        const unique = new Map<string, (typeof list)[number]>();
        for (const property of list) unique.set(property.id, property);
        const ids = [...unique.keys()];
        if (ids.length === 0) return { inserted: 0, updated: 0 };

        // 既存の ID を先に調べて、登録と更新の件数を数える
        const existing = new Set<string>();
        for (const part of chunk(ids, IN_CHUNK)) {
          const { data, error } = await client.from('properties').select('id').in('id', part);
          if (error) throw fail('properties.upsertMany', error);
          for (const row of (data ?? []) as { id: string }[]) existing.add(row.id);
        }

        for (const part of chunk([...unique.values()], UPSERT_CHUNK)) {
          const { error } = await client.from('properties').upsert(part.map(propertyToRow), { onConflict: 'id' });
          if (error) throw fail('properties.upsertMany', error);
        }
        const updated = ids.filter((id) => existing.has(id)).length;
        return { inserted: ids.length - updated, updated };
      },
    },

    lineUsers: {
      async upsert(input) {
        // 表示名が無いとき（取得失敗など）は列ごと送らず、既存の表示名を消さない
        const row: { line_user_id: string; display_name?: string } = { line_user_id: input.lineUserId };
        if (input.displayName != null) row.display_name = input.displayName;
        const { data, error } = await client
          .from('line_users')
          .upsert(row, { onConflict: 'line_user_id' })
          .select()
          .single();
        if (error) throw fail('lineUsers.upsert', error);
        return rowToLineUser(data as LineUserDbRow);
      },
    },

    conversations: {
      async getOrCreate(lineUserId) {
        const find = async (): Promise<Conversation | null> => {
          const { data, error } = await client
            .from('conversations')
            .select('*')
            .eq('line_user_id', lineUserId)
            .maybeSingle();
          if (error) throw fail('conversations.getOrCreate', error);
          return data ? rowToConversation(data as ConversationDbRow) : null;
        };

        const existing = await find();
        if (existing) return existing;

        // 同時に 2 件の Webhook が来ても 1 会話になるよう、一意制約の衝突は無視して引き直す。
        // LINE ユーザーが未登録なら外部キー違反（'23503'）になる
        const { error } = await client
          .from('conversations')
          .upsert({ line_user_id: lineUserId }, { onConflict: 'line_user_id', ignoreDuplicates: true });
        if (error) throw fail('conversations.getOrCreate', error);
        const created = await find();
        if (!created) throw notFound('conversations.getOrCreate', '会話', lineUserId);
        return created;
      },

      async getById(id) {
        return getConversationRow('conversations.getById', id);
      },

      async update(id, patch) {
        const row = conversationPatchToRow(patch);
        if (Object.keys(row).length === 0) {
          const current = await getConversationRow('conversations.update', id);
          if (!current) throw notFound('conversations.update', '会話', id);
          return current;
        }
        const { data, error } = await client.from('conversations').update(row).eq('id', id).select().maybeSingle();
        if (error) throw fail('conversations.update', error);
        if (!data) throw notFound('conversations.update', '会話', id);
        return rowToConversation(data as ConversationDbRow);
      },

      async listRecent(options = {}) {
        const { limit = DEFAULT_LIST_LIMIT, offset = 0, state, aiPaused } = options;
        let query = client
          .from('conversations')
          .select(CONVERSATION_SUMMARY_SELECT)
          .order('updated_at', { ascending: false })
          .order('id', { ascending: false });
        if (state !== undefined) query = query.eq('state', state);
        if (aiPaused !== undefined) query = query.eq('ai_paused', aiPaused);
        const { data, error } = await query.range(offset, offset + limit - 1);
        if (error) throw fail('conversations.listRecent', error);
        return ((data ?? []) as unknown as ConversationSummaryDbRow[]).map(rowToConversationSummary);
      },

      async getSummary(id) {
        const { data, error } = await client
          .from('conversations')
          .select(CONVERSATION_SUMMARY_SELECT)
          .eq('id', id)
          .maybeSingle();
        if (error) throw fail('conversations.getSummary', error);
        return data ? rowToConversationSummary(data as unknown as ConversationSummaryDbRow) : null;
      },

      async listWithOpenHandoff() {
        const rows = await fetchAll<ConversationSummaryDbRow>('conversations.listWithOpenHandoff', (from, to) =>
          client
            .from('conversations')
            .select(CONVERSATION_SUMMARY_SELECT)
            .gt('handoff_open_count', 0)
            .order('updated_at', { ascending: false })
            .order('id', { ascending: false })
            .range(from, to)
            // select 句を定数の連結で組んでいるので、型の推論が効かない
            .overrideTypes<ConversationSummaryDbRow[], { merge: false }>(),
        );
        return rows.map(rowToConversationSummary);
      },
    },

    messages: {
      async insert(message) {
        const { data, error } = await client.from('messages').insert(newMessageToRow(message)).select().single();
        if (error) throw fail('messages.insert', error);
        return rowToMessage(data as MessageDbRow);
      },

      async listByConversation(conversationId) {
        const rows = await fetchAll<MessageDbRow>('messages.listByConversation', (from, to) =>
          client
            .from('messages')
            .select('*')
            .eq('conversation_id', conversationId)
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to),
        );
        return rows.map(rowToMessage);
      },

      async countExtractedTurnsSince(lineUserId, since) {
        // messages に line_user_id は持たせない（個人情報の重複を避ける）。会話は 1 ユーザー 1 件なので 2 段で引く
        const { data: conversation, error: conversationError } = await client
          .from('conversations')
          .select('id')
          .eq('line_user_id', lineUserId)
          .maybeSingle();
        if (conversationError) throw fail('messages.countExtractedTurnsSince', conversationError);
        if (!conversation) return 0;
        const { count, error } = await client
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('conversation_id', (conversation as { id: string }).id)
          .eq('role', 'ai')
          .not('intent', 'is', null)
          .gte('created_at', since.toISOString());
        if (error) throw fail('messages.countExtractedTurnsSince', error);
        return count ?? 0;
      },

      async sumCostSince(since) {
        // 行を取って足すと 1000 行の上限で過少になる。SQL 関数で集計する
        const { data, error } = await client.rpc('sum_message_cost_since', { p_since: since.toISOString() });
        if (error) throw fail('messages.sumCostSince', error);
        return Number(data ?? 0);
      },
    },

    viewingRequests: {
      async create(input) {
        const { data, error } = await client
          .from('viewing_requests')
          .insert(newViewingRequestToRow(input))
          .select()
          .single();
        if (error) throw fail('viewingRequests.create', error);
        return rowToViewingRequest(data as ViewingRequestDbRow);
      },

      async getById(id) {
        const { data, error } = await client
          .from('viewing_requests')
          .select(VIEWING_REQUEST_LIST_SELECT)
          .eq('id', id)
          .maybeSingle();
        if (error) throw fail('viewingRequests.getById', error);
        return data ? rowToViewingRequestListItem(data as unknown as ViewingRequestListDbRow) : null;
      },

      async listSince(since) {
        const sinceIso = since.toISOString();
        const rows = await fetchAll<ViewingRequestListDbRow>('viewingRequests.listSince', (from, to) =>
          client
            .from('viewing_requests')
            .select(VIEWING_REQUEST_LIST_SELECT)
            .gte('created_at', sinceIso)
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to),
        );
        return rows.map(rowToViewingRequestListItem);
      },

      async listByStatus(status) {
        const rows = await fetchAll<ViewingRequestListDbRow>('viewingRequests.listByStatus', (from, to) =>
          client
            .from('viewing_requests')
            .select(VIEWING_REQUEST_LIST_SELECT)
            .eq('status', status)
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to),
        );
        return rows.map(rowToViewingRequestListItem);
      },

      async listByConversation(conversationId) {
        const rows = await fetchAll<ViewingRequestListDbRow>('viewingRequests.listByConversation', (from, to) =>
          client
            .from('viewing_requests')
            .select(VIEWING_REQUEST_LIST_SELECT)
            .eq('conversation_id', conversationId)
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to),
        );
        return rows.map(rowToViewingRequestListItem);
      },

      async update(id, patch) {
        const row = viewingRequestPatchToRow(patch);
        if (Object.keys(row).length === 0) {
          const current = await getViewingRequestRow('viewingRequests.update', id);
          if (!current) throw notFound('viewingRequests.update', '内見の仮受付', id);
          return current;
        }
        const { data, error } = await client.from('viewing_requests').update(row).eq('id', id).select().maybeSingle();
        if (error) throw fail('viewingRequests.update', error);
        if (!data) throw notFound('viewingRequests.update', '内見の仮受付', id);
        return rowToViewingRequest(data as ViewingRequestDbRow);
      },
    },

    businessCalendar: {
      async get() {
        const [hours, holidays] = await Promise.all([
          client.from('business_hours').select('*').order('weekday'),
          client.from('holidays').select('*').order('date'),
        ]);
        if (hours.error) throw fail('businessCalendar.get', hours.error);
        if (holidays.error) throw fail('businessCalendar.get', holidays.error);
        return rowsToCalendar((hours.data ?? []) as BusinessHoursDbRow[], (holidays.data ?? []) as HolidayDbRow[]);
      },

      async setHours(rows) {
        const normalized = normalizeHoursRows(rows);
        if (normalized.length === 0) return;
        const { error } = await client
          .from('business_hours')
          .upsert(normalized.map(hoursToRow), { onConflict: 'weekday' });
        if (error) throw fail('businessCalendar.setHours', error);
      },

      async setHolidays(dates) {
        const normalized = normalizeHolidays(dates);
        if (normalized.length > 0) {
          // 先に追加してから消す（途中で失敗しても休業日が消えた状態にならない）。
          // 既にある日付は触らない（ignoreDuplicates）ので、名前が残る
          const { error } = await client
            .from('holidays')
            .upsert(
              normalized.map((date) => ({ date })),
              { onConflict: 'date', ignoreDuplicates: true },
            );
          if (error) throw fail('businessCalendar.setHolidays', error);
        }
        // 日付は assertDate で 'YYYY-MM-DD' に固めてあるので、フィルタ文字列に埋め込んでよい。
        // 条件なしの DELETE は拒否されることがあるので、全削除も条件を付ける
        const deletion = client.from('holidays').delete();
        const { error } =
          normalized.length > 0
            ? await deletion.not('date', 'in', `(${normalized.join(',')})`)
            : await deletion.gte('date', '0001-01-01');
        if (error) throw fail('businessCalendar.setHolidays', error);
      },
    },

    webhookEvents: {
      async markIfNew(webhookEventId) {
        const { error } = await client.from('webhook_events').insert({ webhook_event_id: webhookEventId });
        if (!error) return true;
        // 主キーの一意制約違反 = 再送された同じイベント
        if (error.code === '23505') return false;
        throw fail('webhookEvents.markIfNew', error);
      },
    },
  };
}
