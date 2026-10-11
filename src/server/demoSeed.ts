/**
 * 公開デモの閲覧用アカウントに見せる「デモ会話」の種まきと、日次の保守（会話ログの90日削除）。
 *
 * - 閲覧用（viewer）は is_demo の会話だけを読める（supabase/migrations/20261011000000_admin_roles.sql）。
 *   プレビュー用のデモデータ `buildPreviewSeed`（src/server/admin/previewSeed.ts）を、本番の Supabase に is_demo = true で書く
 * - 朝の引き継ぎ一覧の「夜間・休日分」は前回の営業終了からの案件なので、種まきの時刻が古くなると一覧から落ちる。
 *   Vercel Cron（src/app/api/cron/daily/route.ts）が毎朝この関数で作り直す
 * - service role のクライアントを使うサーバーの処理。管理画面のセッション経由の層（src/server/admin/session.ts・不変条件 14）とは別
 *
 * **消すのは is_demo の会話（messages・viewing_requests は on delete cascade で道連れ）と、LINE ユーザー ID が 'demo-' で始まる
 * line_users だけ**。本物の利用者の行は、条件に当たらないので消えない（demoSeed.test.ts が偽の DB で確かめる）。
 * Supabase にトランザクションは無いので、種を先に組み立ててから「消す → 入れる」を続けて行う（途中で失敗しても入れ直せば戻る）。
 */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { MESSAGE_RETENTION_DAYS } from '@/domain/rules';
import { createSupabaseRepositories, DbError, type MemorySeed } from '@/lib/db';
import { newMessageToRow, type ConversationDbRow, type ViewingRequestDbRow } from '@/lib/db/mappers';
import { buildPreviewSeed } from './admin/previewSeed';

/** デモ用 line_users の line_user_id の接頭辞（previewSeed の `demo-…`）。本物の LINE ユーザー ID は U から始まる */
export const DEMO_LINE_USER_PREFIX = 'demo-';

/** 一括 insert 1 回あたりの行数 */
const INSERT_CHUNK = 200;

// ---------- 行の組み立て（純関数） ----------

type ConversationInsertRow = Omit<ConversationDbRow, 'handoff_open_count'>;
type MessageInsertRow = ReturnType<typeof newMessageToRow> & { id: string };

export interface DemoRows {
  lineUsers: { line_user_id: string; display_name: string | null }[];
  conversations: ConversationInsertRow[];
  messages: MessageInsertRow[];
  viewingRequests: ViewingRequestDbRow[];
}

/**
 * 名前から決まる UUID（v5 の形。SHA-1）。プレビューの固定 ID（'conv-demo-yamada' など）は uuid 列に入らないので写す。
 * 毎日作り直しても同じ ID になるので、デモ会話の管理画面の URL が変わらない
 */
export function demoUuid(name: string): string {
  const bytes = createHash('sha1').update(`line-rental-agent/demo/${name}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // バージョン 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // バリアント RFC 4122
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * 種（`buildPreviewSeed` の出力）を DB の行にする。種が「すべてデモ」であることをここで確かめ、崩れていたら投げる
 * （is_demo でない会話や 'demo-' で始まらない LINE ユーザーを書くと、次の作り直しで消せなくなる）
 */
export function buildDemoRows(seed: MemorySeed): DemoRows {
  const lineUsers = (seed.lineUsers ?? []).map((u) => {
    assertDemoLineUser(u.lineUserId);
    return { line_user_id: u.lineUserId, display_name: u.displayName ?? null };
  });

  const conversationIds = new Map<string, string>(); // 種の ID → UUID
  const conversations = (seed.conversations ?? []).map((c): ConversationInsertRow => {
    if (c.isDemo !== true) throw new Error(`デモ会話ではない会話が種に入っています: ${c.id}`);
    assertDemoLineUser(c.lineUserId);
    const id = demoUuid(`conversation:${c.id}`);
    conversationIds.set(c.id, id);
    return {
      id,
      line_user_id: c.lineUserId,
      state: c.state,
      slots: c.slots,
      shown_property_ids: [...c.shownPropertyIds],
      shown_offset: c.shownOffset,
      last_search_total: c.lastSearchTotal,
      priority_asked_count: c.priorityAskedCount,
      ai_paused: c.aiPaused,
      paused_at: c.pausedAt,
      last_staff_reply_at: c.lastStaffReplyAt,
      booking: c.booking,
      handoff_notes: c.handoffNotes,
      handoff_resolved_count: c.handoffResolvedCount ?? 0,
      is_demo: true,
      created_at: c.createdAt,
      updated_at: c.updatedAt,
    };
  });
  const conversationIdOf = (seedId: string): string => {
    const id = conversationIds.get(seedId);
    if (!id) throw new Error(`会話が種にありません: ${seedId}`);
    return id;
  };

  const messages = (seed.messages ?? []).map((m): MessageInsertRow => ({
    id: demoUuid(`message:${m.id}`),
    ...newMessageToRow({
      conversationId: conversationIdOf(m.conversationId),
      role: m.role,
      text: m.text,
      intent: m.intent,
      slotDiff: m.slotDiff,
      toolCalls: m.toolCalls,
      verification: m.verification,
      latencyMs: m.latencyMs,
      costUsd: m.costUsd,
      createdAt: m.createdAt,
    }),
  }));

  const viewingRequests = (seed.viewingRequests ?? []).map(
    (v): ViewingRequestDbRow => ({
      id: demoUuid(`viewing:${v.id}`),
      conversation_id: conversationIdOf(v.conversationId),
      property_id: v.propertyId,
      candidate_times: [...v.candidateTimes],
      status: v.status,
      confirmed_time: v.confirmedTime,
      staff_note: v.staffNote,
      received_outside_hours: v.receivedOutsideHours,
      created_at: v.createdAt,
      updated_at: v.updatedAt,
    }),
  );

  assertUnique('会話', conversations.map((c) => c.id));
  assertUnique('メッセージ', messages.map((m) => m.id));
  assertUnique('内見の仮受付', viewingRequests.map((v) => v.id));
  return { lineUsers, conversations, messages, viewingRequests };
}

function assertDemoLineUser(lineUserId: string): void {
  if (!lineUserId.startsWith(DEMO_LINE_USER_PREFIX)) {
    throw new Error(`LINE ユーザー ID が ${DEMO_LINE_USER_PREFIX} で始まらないデモ会話は書けません（作り直しで消せなくなります）: ${lineUserId}`);
  }
}

function assertUnique(what: string, ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length) throw new Error(`${what}の ID が重複しています（種の ID から UUID への写しが衝突しました）`);
}

// ---------- 書き込み（I/O） ----------

export interface DemoRefreshResult {
  dryRun: boolean;
  /** 種の作成に使った公開物件の数 */
  properties: number;
  /** 書いた（dry-run では書くはずだった）件数 */
  lineUsers: number;
  conversations: number;
  messages: number;
  viewingRequests: number;
  /** 消した件数。dry-run では null */
  deleted: { conversations: number; lineUsers: number } | null;
}

/**
 * デモ会話を作り直す: 既存のデモ（is_demo の会話・'demo-' のLINEユーザー）を消し、`buildPreviewSeed(now, 公開物件)` を入れ直す。
 * 物件は Supabase の properties から読む（Vercel の関数は data/ を fs で読めない）。公開物件が 0 件なら何もせず投げる。
 * `dryRun` は読むだけ（物件の読み出し）で、件数を返す
 */
export async function refreshDemoData(
  client: SupabaseClient,
  now: Date,
  options: { dryRun?: boolean } = {},
): Promise<DemoRefreshResult> {
  const properties = await createSupabaseRepositories(client).properties.listPublic();
  if (properties.length === 0) {
    throw new Error('公開物件が 0 件のため、デモ会話を作り直しません（先に npm run data:import で物件を取り込んでください）');
  }
  // 消す前に組み立てる（組み立てに失敗しても、いまのデモ会話は残る）
  const rows = buildDemoRows(buildPreviewSeed(now, properties));
  const counts = {
    properties: properties.length,
    lineUsers: rows.lineUsers.length,
    conversations: rows.conversations.length,
    messages: rows.messages.length,
    viewingRequests: rows.viewingRequests.length,
  };
  if (options.dryRun) return { dryRun: true, ...counts, deleted: null };

  const deleted = await deleteDemoRows(client);
  // 外部キーの順: line_users → conversations → messages / viewing_requests
  await insertRows(client, 'line_users', rows.lineUsers);
  await insertRows(client, 'conversations', rows.conversations);
  await insertRows(client, 'messages', rows.messages);
  await insertRows(client, 'viewing_requests', rows.viewingRequests);
  return { dryRun: false, ...counts, deleted };
}

/**
 * 既存のデモを消す。条件は2つだけ:
 *   conversations: is_demo = true（messages・viewing_requests は on delete cascade）
 *   line_users:    line_user_id like 'demo-%'
 */
async function deleteDemoRows(client: SupabaseClient): Promise<{ conversations: number; lineUsers: number }> {
  const conversations = await client.from('conversations').delete().eq('is_demo', true).select('id');
  if (conversations.error) throw fail('demo.deleteConversations', conversations.error);
  const lineUsers = await client.from('line_users').delete().like('line_user_id', `${DEMO_LINE_USER_PREFIX}%`).select('id');
  if (lineUsers.error) throw fail('demo.deleteLineUsers', lineUsers.error);
  return { conversations: conversations.data?.length ?? 0, lineUsers: lineUsers.data?.length ?? 0 };
}

async function insertRows(client: SupabaseClient, table: string, rows: readonly object[]): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const { error } = await client.from(table).insert(rows.slice(i, i + INSERT_CHUNK));
    if (error) throw fail(`demo.insert.${table}`, error);
  }
}

function fail(operation: string, error: { message: string; code?: string }): DbError {
  return new DbError(operation, error.message, error.code);
}

/** 会話ログの90日削除（SQL 関数 purge_old_messages。DESIGN.md 5章・8章）。削除した件数を返す */
export async function purgeOldMessages(client: SupabaseClient): Promise<number> {
  const { data, error } = await client.rpc('purge_old_messages', { retention_days: MESSAGE_RETENTION_DAYS });
  if (error) throw fail('purge_old_messages', error);
  return Number(data ?? 0);
}

// ---------- 日次の処理（Cron） ----------

export type StepResult<T> = { status: 'ok'; value: T } | { status: 'skipped'; reason: string } | { status: 'error'; message: string };

export interface DailyJobResult {
  /** どの段階も error でなければ true */
  ok: boolean;
  demo: StepResult<DemoRefreshResult>;
  purge: StepResult<{ deleted: number }>;
}

/**
 * 日次の処理。デモ会話の作り直し（`demo` が false ならスキップ）と、会話ログの90日削除。
 * 2つは独立していて、片方が失敗してももう片方は行う（個人情報の削除をデモの失敗で止めない）
 */
export async function runDailyJob(client: SupabaseClient, now: Date, options: { demo: boolean }): Promise<DailyJobResult> {
  const demo: StepResult<DemoRefreshResult> = options.demo
    ? await step(() => refreshDemoData(client, now))
    : { status: 'skipped', reason: 'DEMO_MODE が 1 ではないので、デモ会話は作り直しません' };
  const purge = await step(async () => ({ deleted: await purgeOldMessages(client) }));
  return { ok: demo.status !== 'error' && purge.status !== 'error', demo, purge };
}

async function step<T>(run: () => Promise<T>): Promise<StepResult<T>> {
  try {
    return { status: 'ok', value: await run() };
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}
