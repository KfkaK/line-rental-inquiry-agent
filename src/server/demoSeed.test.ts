import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { fromJst } from '@/domain/businessHours';
import { MESSAGE_RETENTION_DAYS } from '@/domain/rules';
import { DbError } from '@/lib/db';
import { propertyToRow, rowToConversation, rowToMessage, rowToViewingRequest } from '@/lib/db/mappers';
import { buildPreviewSeed, loadPreviewProperties } from './admin/previewSeed';
import {
  buildDemoRows,
  DEMO_LINE_USER_PREFIX,
  demoUuid,
  purgeOldMessages,
  refreshDemoData,
  resetDemoViewerPassword,
  runDailyJob,
} from './demoSeed';

// ---------- マイグレーションの列（insert の列名が実在するかを偽の DB で検査する） ----------

const MIGRATIONS_DIR = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
const sql = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => readFileSync(MIGRATIONS_DIR + name, 'utf8'))
  .join('\n');

function tableColumns(table: string): string[] {
  const block = new RegExp(`create table public\\.${table} \\(\\r?\\n([\\s\\S]*?)\\r?\\n\\);`).exec(sql)?.[1];
  if (!block) throw new Error(`${table} の create table が見つかりません`);
  const created = block
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, '').trim())
    .filter((line) => line !== '' && !/^(constraint|primary|unique|check|foreign)\b/i.test(line))
    .map((line) => line.split(/\s+/)[0]);
  const added = [...sql.matchAll(new RegExp(`^alter table public\\.${table} add column (\\w+)`, 'gm'))].map((m) => m[1]);
  return [...created, ...added];
}

// ---------- 偽の Supabase（行を持ち、フィルタ・外部キー・on delete cascade・一意制約を実際に当てる） ----------

type Row = Record<string, unknown>;
interface PgError {
  message: string;
  code?: string;
}

interface FakeAuthUser {
  id: string;
  email?: string;
  app_metadata?: Record<string, unknown>;
}

/** テーブルごとの外部キー（子 → 親）。on delete cascade は deleteRows が親から子へたどる */
const FOREIGN_KEYS: { table: string; column: string; parent: string; parentColumn: string; cascade: boolean }[] = [
  { table: 'conversations', column: 'line_user_id', parent: 'line_users', parentColumn: 'line_user_id', cascade: true },
  { table: 'messages', column: 'conversation_id', parent: 'conversations', parentColumn: 'id', cascade: true },
  { table: 'viewing_requests', column: 'conversation_id', parent: 'conversations', parentColumn: 'id', cascade: true },
  { table: 'viewing_requests', column: 'property_id', parent: 'properties', parentColumn: 'id', cascade: false },
];
const UNIQUE: Record<string, string[][]> = {
  properties: [['id']],
  line_users: [['id'], ['line_user_id']],
  conversations: [['id'], ['line_user_id']],
  messages: [['id']],
  viewing_requests: [['id']],
};
/** 生成列。書くとエラー */
const GENERATED = new Set(['handoff_open_count']);

class FakeDb {
  readonly tables: Record<string, Row[]> = {
    properties: [],
    line_users: [],
    conversations: [],
    messages: [],
    viewing_requests: [],
  };
  /** 実行した書き込みの記録（'delete conversations where is_demo = true' など） */
  readonly ops: string[] = [];
  readonly rpcCalls: { name: string; args: unknown }[] = [];
  rpcResult = 3;
  /** 'insert:messages' のように、失敗させる操作（Auth は 'auth:listUsers'・'auth:updateUser'） */
  readonly failOn = new Map<string, PgError>();
  /** Auth のアカウント（Admin API の listUsers・updateUserById が読み書きする） */
  authUsers: FakeAuthUser[] = [];
  readonly authListCalls: { page: number; perPage: number }[] = [];
  readonly authUpdates: { id: string; attributes: Record<string, unknown> }[] = [];

  readonly client = {
    from: (table: string) => new FakeQuery(this, table),
    rpc: async (name: string, args: unknown) => {
      this.rpcCalls.push({ name, args });
      const error = this.failOn.get(`rpc:${name}`);
      return error ? { data: null, error } : { data: this.rpcResult, error: null };
    },
    auth: {
      admin: {
        listUsers: async ({ page, perPage }: { page: number; perPage: number }) => {
          this.authListCalls.push({ page, perPage });
          const error = this.failOn.get('auth:listUsers');
          if (error) return { data: { users: [] }, error };
          return { data: { users: this.authUsers.slice((page - 1) * perPage, page * perPage).map((u) => structuredClone(u)) }, error: null };
        },
        updateUserById: async (id: string, attributes: Record<string, unknown>) => {
          this.authUpdates.push({ id, attributes });
          const error = this.failOn.get('auth:updateUser');
          return error ? { data: { user: null }, error } : { data: { user: this.authUsers.find((u) => u.id === id) ?? null }, error: null };
        },
      },
    },
  } as unknown as SupabaseClient;

  rows(table: string): Row[] {
    return this.tables[table];
  }

  insertRows(table: string, rows: Row[]): PgError | null {
    const injected = this.failOn.get(`insert:${table}`);
    if (injected) return injected;
    const allowed = new Set(tableColumns(table));
    const staged: Row[] = [];
    for (const given of rows) {
      // id の既定値（gen_random_uuid()）
      const row: Row = { ...given, id: given.id ?? globalThis.crypto.randomUUID() };
      for (const column of Object.keys(given)) {
        if (GENERATED.has(column)) return { code: '428C9', message: `generated column ${column} には書けません` };
        if (!allowed.has(column)) return { code: 'PGRST204', message: `${table} に列 ${column} がありません` };
      }
      for (const key of UNIQUE[table]) {
        const same = (other: Row): boolean => key.every((column) => other[column] === row[column]);
        if ([...this.tables[table], ...staged].some(same)) return { code: '23505', message: `${table} の一意制約違反 (${key.join(',')})` };
      }
      for (const fk of FOREIGN_KEYS.filter((f) => f.table === table)) {
        if (!this.tables[fk.parent].some((parent) => parent[fk.parentColumn] === row[fk.column])) {
          return { code: '23503', message: `${table}.${fk.column} の親が ${fk.parent} にありません: ${String(row[fk.column])}` };
        }
      }
      staged.push(structuredClone(row));
    }    this.tables[table].push(...staged);
    return null;
  }

  /** 行を消し、on delete cascade で子も消す。消した行を返す */
  deleteRows(table: string, predicate: (row: Row) => boolean): Row[] {
    const removed = this.tables[table].filter(predicate);
    this.tables[table] = this.tables[table].filter((row) => !predicate(row));
    for (const fk of FOREIGN_KEYS.filter((f) => f.parent === table)) {
      const parentValues = new Set(removed.map((row) => row[fk.parentColumn]));
      if (fk.cascade) this.deleteRows(fk.table, (child) => parentValues.has(child[fk.column]));
      else if (this.tables[fk.table].some((child) => parentValues.has(child[fk.column]))) {
        throw new Error(`${fk.table} が ${table} を参照しているので消せません`);
      }
    }
    return removed;
  }
}

class FakeQuery implements PromiseLike<{ data: Row[] | null; error: PgError | null }> {
  private mode: 'select' | 'insert' | 'delete' = 'select';
  private payload: Row[] = [];
  private returning = false;
  private readonly filters: { description: string; test: (row: Row) => boolean }[] = [];
  private orderBy: string | null = null;
  private window: [number, number] | null = null;

  constructor(
    private readonly db: FakeDb,
    private readonly table: string,
  ) {}

  select(): this {
    this.returning = true;
    return this;
  }
  insert(rows: Row | Row[]): this {
    this.mode = 'insert';
    this.payload = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  delete(): this {
    this.mode = 'delete';
    return this;
  }
  eq(column: string, value: unknown): this {
    this.filters.push({ description: `${column} = ${String(value)}`, test: (row) => row[column] === value });
    return this;
  }
  like(column: string, pattern: string): this {
    const regex = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`);
    this.filters.push({ description: `${column} like ${pattern}`, test: (row) => typeof row[column] === 'string' && regex.test(row[column]) });
    return this;
  }
  order(column: string): this {
    this.orderBy = column;
    return this;
  }
  range(from: number, to: number): this {
    this.window = [from, to];
    return this;
  }

  private matches(row: Row): boolean {
    return this.filters.every((f) => f.test(row));
  }

  private execute(): { data: Row[] | null; error: PgError | null } {
    const where = this.filters.map((f) => f.description).join(' and ');
    if (this.mode === 'insert') {
      this.db.ops.push(`insert ${this.table} x${this.payload.length}`);
      const error = this.db.insertRows(this.table, this.payload);
      return { data: error || !this.returning ? null : this.payload, error };
    }
    if (this.mode === 'delete') {
      // 条件なしの DELETE は PostgREST が拒否する
      if (this.filters.length === 0) return { data: null, error: { code: '21000', message: 'DELETE requires a WHERE clause' } };
      this.db.ops.push(`delete ${this.table} where ${where}`);
      const injected = this.db.failOn.get(`delete:${this.table}`);
      if (injected) return { data: null, error: injected };
      const removed = this.db.deleteRows(this.table, (row) => this.matches(row));
      return { data: this.returning ? removed : null, error: null };
    }
    let rows = this.db.rows(this.table).filter((row) => this.matches(row));
    const orderBy = this.orderBy;
    if (orderBy) rows = [...rows].sort((a, b) => (String(a[orderBy]) < String(b[orderBy]) ? -1 : String(a[orderBy]) > String(b[orderBy]) ? 1 : 0));
    if (this.window) rows = rows.slice(this.window[0], this.window[1] + 1);
    return { data: rows.map((row) => structuredClone(row)), error: null };
  }

  then<R1 = { data: Row[] | null; error: PgError | null }, R2 = never>(
    onfulfilled?: ((value: { data: Row[] | null; error: PgError | null }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve().then(() => this.execute()).then(onfulfilled, onrejected);
  }
}

// ---------- 道具 ----------

const properties = loadPreviewProperties();
const PUBLIC_COUNT = properties.filter((p) => p.status === 'public').length;
const PRIVATE_IDS = new Set(properties.filter((p) => p.status !== 'public').map((p) => p.id));
/** 月曜 06:30 JST（Cron が走る時刻の例） */
const NOW = fromJst('2026-10-12', '06:30');

const REAL_USER = 'U0123456789abcdef0123456789abcdef';

/** 公開・非公開の物件（data/ の全件 ＋ 非公開 1 件）と、本物の利用者の会話、前日までのデモ会話（古い）を入れた偽の DB */
function setupDb(options: { withProperties?: boolean } = {}): FakeDb {
  const db = new FakeDb();
  if (options.withProperties !== false) {
    for (const p of properties) db.tables.properties.push({ ...propertyToRow(p), updated_at: NOW.toISOString() });
    db.tables.properties.push({ ...propertyToRow({ ...properties[0], id: 'ZZ-private', status: 'private' }), updated_at: NOW.toISOString() });
  }
  // 本物の利用者（消えてはいけない）
  db.tables.line_users.push({ id: 'lu-real', line_user_id: REAL_USER, display_name: '本物の利用者', created_at: NOW.toISOString() });
  db.tables.conversations.push({ id: 'conv-real', line_user_id: REAL_USER, is_demo: false, state: 'presenting', updated_at: NOW.toISOString() });
  db.tables.messages.push(
    { id: 'msg-real-1', conversation_id: 'conv-real', role: 'user', text: '渋谷で9万まで', created_at: NOW.toISOString() },
    { id: 'msg-real-2', conversation_id: 'conv-real', role: 'ai', text: 'カードを出しました', created_at: NOW.toISOString() },
  );
  db.tables.viewing_requests.push({
    id: 'vr-real',
    conversation_id: 'conv-real',
    property_id: properties[0].id,
    candidate_times: ['2026-10-13T14:00'],
    status: 'pending',
  });
  // 前日までのデモ会話（作り直しで消える）と、会話のない demo- の LINE ユーザー
  db.tables.line_users.push(
    { id: 'lu-old-demo', line_user_id: 'demo-old', display_name: '古いデモ', created_at: NOW.toISOString() },
    { id: 'lu-orphan', line_user_id: 'demo-orphan', display_name: null, created_at: NOW.toISOString() },
  );
  db.tables.conversations.push({ id: 'conv-old-demo', line_user_id: 'demo-old', is_demo: true, state: 'hearing', updated_at: '2026-10-10T00:00:00.000Z' });
  db.tables.messages.push({ id: 'msg-old-demo', conversation_id: 'conv-old-demo', role: 'user', text: '古いデモの発言', created_at: '2026-10-10T00:00:00.000Z' });
  db.tables.viewing_requests.push({ id: 'vr-old-demo', conversation_id: 'conv-old-demo', property_id: properties[0].id, candidate_times: [], status: 'pending' });
  return db;
}

/** 閲覧用アカウントの資格情報（環境変数 DEMO_VIEWER_EMAIL・DEMO_VIEWER_PASSWORD の値）。テスト用の架空の値 */
const VIEWER = { email: 'Demo.Viewer@Example.com', password: 'public-demo-pass-123' };
const VIEWER_ID = 'auth-viewer';
const STAFF_ID = 'auth-staff';

/** 担当者・閲覧用・別の閲覧用のアカウントがいる Auth。メールアドレスの大文字小文字は環境変数の値と変えてある */
function setupViewerDb(): FakeDb {
  const db = setupDb();
  db.authUsers = [
    { id: STAFF_ID, email: 'staff@example.com', app_metadata: { role: 'staff' } },
    { id: VIEWER_ID, email: 'demo.viewer@example.com', app_metadata: { role: 'viewer' } },
    { id: 'auth-other-viewer', email: 'other.viewer@example.com', app_metadata: { role: 'viewer' } },
  ];
  return db;
}

/** 投げられた文・返り値のどこにも、パスワードとメールアドレスが出ていないこと */
function expectNoSecrets(value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  expect(text).not.toContain(VIEWER.password);
  expect(text.toLowerCase()).not.toContain(VIEWER.email.toLowerCase());
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ---------- 行の組み立て ----------

describe('demoUuid', () => {
  it('名前から決まる UUID（v5 の形）。同じ名前は同じ、違う名前は違う', () => {
    expect(demoUuid('conversation:conv-demo-yamada')).toMatch(UUID);
    expect(demoUuid('conversation:conv-demo-yamada')).toBe(demoUuid('conversation:conv-demo-yamada'));
    expect(demoUuid('conversation:conv-demo-yamada')).not.toBe(demoUuid('conversation:conv-demo-suzuki'));
    expect(demoUuid('conversation:conv-demo-yamada')).not.toBe(demoUuid('viewing:conv-demo-yamada'));
  });
});

describe('buildDemoRows', () => {
  const seed = buildPreviewSeed(NOW, properties);
  const rows = buildDemoRows(seed);

  it('プレビューの種と同じ件数。ID はすべて UUID で、種の ID から決まる（毎日作り直しても変わらない）', () => {
    expect(rows.lineUsers).toHaveLength(6);
    expect(rows.conversations).toHaveLength(6);
    expect(rows.messages).toHaveLength(seed.messages?.length ?? -1);
    expect(rows.viewingRequests).toHaveLength(seed.viewingRequests?.length ?? -1);
    for (const id of [...rows.conversations, ...rows.messages, ...rows.viewingRequests].map((r) => r.id)) expect(id).toMatch(UUID);

    // 別の時刻に作っても同じ ID（時刻だけが動く）
    const later = buildDemoRows(buildPreviewSeed(fromJst('2026-10-13', '06:40'), properties));
    expect(later.conversations.map((c) => c.id)).toEqual(rows.conversations.map((c) => c.id));
    expect(later.messages.map((m) => m.id)).toEqual(rows.messages.map((m) => m.id));
    expect(later.conversations[0].created_at).not.toBe(rows.conversations[0].created_at);
  });

  it('会話はすべて is_demo = true で、LINE ユーザー ID は demo- で始まる。生成列は書かない', () => {
    for (const c of rows.conversations) {
      expect(c.is_demo).toBe(true);
      expect(c.line_user_id.startsWith(DEMO_LINE_USER_PREFIX)).toBe(true);
      expect(c).not.toHaveProperty('handoff_open_count');
    }
    for (const u of rows.lineUsers) expect(u.line_user_id.startsWith('demo-')).toBe(true);
    expect(new Set(rows.conversations.map((c) => c.line_user_id))).toEqual(new Set(rows.lineUsers.map((u) => u.line_user_id)));
  });

  it('子の行は写した会話の ID を指し、内見の物件は渡した物件に実在する', () => {
    const conversationIds = new Set(rows.conversations.map((c) => c.id));
    for (const m of rows.messages) expect(conversationIds.has(m.conversation_id)).toBe(true);
    const propertyIds = new Set(properties.map((p) => p.id));
    for (const v of rows.viewingRequests) {
      expect(conversationIds.has(v.conversation_id)).toBe(true);
      expect(propertyIds.has(v.property_id)).toBe(true);
    }
  });

  it('マッパーで読み戻すと、種と同じ内容になる（列名・型の写しの食い違い検査）', () => {
    const conversation = rowToConversation({ ...rows.conversations[0], handoff_open_count: 0 });
    const original = seed.conversations![0];
    expect(conversation).toMatchObject({
      lineUserId: original.lineUserId,
      state: original.state,
      slots: original.slots,
      shownPropertyIds: original.shownPropertyIds,
      handoffNotes: original.handoffNotes,
      isDemo: true,
      createdAt: original.createdAt,
      updatedAt: original.updatedAt,
    });
    const message = rowToMessage({ ...rows.messages[0], created_at: rows.messages[0].created_at ?? '' });
    expect(message).toMatchObject({ role: seed.messages![0].role, text: seed.messages![0].text, createdAt: seed.messages![0].createdAt });
    const viewing = rowToViewingRequest(rows.viewingRequests[0]);
    expect(viewing).toMatchObject({
      propertyId: seed.viewingRequests![0].propertyId,
      candidateTimes: seed.viewingRequests![0].candidateTimes,
      status: seed.viewingRequests![0].status,
      receivedOutsideHours: seed.viewingRequests![0].receivedOutsideHours,
    });
  });

  it('デモでない会話・demo- で始まらない LINE ユーザーが種に混じっていたら書かずに投げる（作り直しで消せなくなる）', () => {
    const conversations = seed.conversations!;
    expect(() => buildDemoRows({ ...seed, conversations: [{ ...conversations[0], isDemo: false }, ...conversations.slice(1)] })).toThrow('デモ会話ではない');
    expect(() => buildDemoRows({ ...seed, conversations: [{ ...conversations[0], lineUserId: REAL_USER }, ...conversations.slice(1)] })).toThrow(
      'demo- で始まらない',
    );
    expect(() => buildDemoRows({ ...seed, lineUsers: [{ lineUserId: REAL_USER, displayName: null }] })).toThrow('demo- で始まらない');
    expect(() => buildDemoRows({ ...seed, messages: [{ ...seed.messages![0], conversationId: 'conv-unknown' }] })).toThrow('会話が種にありません');
  });
});

// ---------- 偽の DB に書く ----------

describe('refreshDemoData', () => {
  it('古いデモを消して入れ直す。本物の利用者の行（line_users・会話・メッセージ・内見）には触れない', async () => {
    const db = setupDb();
    const realBefore = {
      lineUsers: structuredClone(db.rows('line_users').filter((r) => r.line_user_id === REAL_USER)),
      conversations: structuredClone(db.rows('conversations').filter((r) => r.id === 'conv-real')),
      messages: structuredClone(db.rows('messages').filter((r) => r.conversation_id === 'conv-real')),
      viewings: structuredClone(db.rows('viewing_requests').filter((r) => r.conversation_id === 'conv-real')),
      properties: structuredClone(db.rows('properties')),
    };

    const result = await refreshDemoData(db.client, NOW);

    expect(result).toEqual({
      dryRun: false,
      properties: PUBLIC_COUNT,
      lineUsers: 6,
      conversations: 6,
      messages: expect.any(Number),
      viewingRequests: 3,
      deleted: { conversations: 1, lineUsers: 2 },
    });

    // 本物の行はそのまま
    expect(db.rows('line_users').filter((r) => r.line_user_id === REAL_USER)).toEqual(realBefore.lineUsers);
    expect(db.rows('conversations').filter((r) => r.id === 'conv-real')).toEqual(realBefore.conversations);
    expect(db.rows('messages').filter((r) => r.conversation_id === 'conv-real')).toEqual(realBefore.messages);
    expect(db.rows('viewing_requests').filter((r) => r.conversation_id === 'conv-real')).toEqual(realBefore.viewings);
    expect(db.rows('properties')).toEqual(realBefore.properties);

    // 古いデモは消えて、新しいデモに置き換わった
    expect(db.rows('conversations').some((r) => r.id === 'conv-old-demo')).toBe(false);
    expect(db.rows('messages').some((r) => r.id === 'msg-old-demo')).toBe(false);
    expect(db.rows('viewing_requests').some((r) => r.id === 'vr-old-demo')).toBe(false);
    expect(db.rows('line_users').some((r) => r.line_user_id === 'demo-orphan')).toBe(false);
    const demoConversations = db.rows('conversations').filter((r) => r.is_demo === true);
    expect(demoConversations).toHaveLength(6);
    expect(demoConversations.every((r) => String(r.line_user_id).startsWith('demo-'))).toBe(true);
    // 本物の会話は is_demo = false のまま、デモ会話以外に is_demo の行は無い
    expect(db.rows('conversations').filter((r) => r.is_demo !== true).map((r) => r.id)).toEqual(['conv-real']);
    expect(db.rows('messages')).toHaveLength(2 + result.messages);
    expect(db.rows('viewing_requests')).toHaveLength(1 + result.viewingRequests);
    expect(db.rows('line_users')).toHaveLength(1 + 6);
  });

  it('消す条件は2つだけ（conversations は is_demo = true、line_users は demo- で始まるもの）。ほかのテーブルは消さない', async () => {
    const db = setupDb();
    await refreshDemoData(db.client, NOW);
    expect(db.ops.filter((op) => op.startsWith('delete'))).toEqual([
      'delete conversations where is_demo = true',
      'delete line_users where line_user_id like demo-%',
    ]);
  });

  it('外部キーの順に入れる（line_users → conversations → messages → viewing_requests）。消してから入れる', async () => {
    const db = setupDb();
    await refreshDemoData(db.client, NOW);
    const writes = db.ops.map((op) => op.split(' ').slice(0, 2).join(' '));
    expect(writes).toEqual(['delete conversations', 'delete line_users', 'insert line_users', 'insert conversations', 'insert messages', 'insert viewing_requests']);
  });

  it('物件は properties の公開のものだけで種を作る（非公開の物件は内見の対象にならない）', async () => {
    const db = setupDb();
    const result = await refreshDemoData(db.client, NOW);
    expect(PRIVATE_IDS.size).toBeGreaterThan(0);
    expect(result.properties).toBe(PUBLIC_COUNT);
    const inserted = db.rows('viewing_requests').filter((r) => r.conversation_id !== 'conv-real');
    expect(inserted).toHaveLength(3);
    expect(inserted.every((r) => !PRIVATE_IDS.has(String(r.property_id)) && r.property_id !== 'ZZ-private')).toBe(true);
    // 会話に出す物件カードの ID も公開物件だけ
    const shown = db.rows('conversations').filter((r) => r.is_demo === true).flatMap((r) => r.shown_property_ids as string[]);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((id) => !PRIVATE_IDS.has(id))).toBe(true);
  });

  it('2回続けて流しても同じ（ID は変わらず、件数も増えない）。時刻は新しい now に動く', async () => {
    const db = setupDb();
    await refreshDemoData(db.client, NOW);
    const first = db.rows('conversations').filter((r) => r.is_demo === true);
    const next = fromJst('2026-10-13', '06:40');
    const result = await refreshDemoData(db.client, next);
    expect(result.deleted).toEqual({ conversations: 6, lineUsers: 6 });
    const second = db.rows('conversations').filter((r) => r.is_demo === true);
    expect(second.map((r) => r.id).sort()).toEqual(first.map((r) => r.id).sort());
    expect(second).toHaveLength(6);
    const newest = Math.max(...db.rows('messages').filter((r) => r.conversation_id !== 'conv-real').map((r) => Date.parse(String(r.created_at))));
    expect(newest).toBeLessThanOrEqual(next.getTime());
    expect(newest).toBeGreaterThan(NOW.getTime());
  });

  it('dry-run: 何も書かず・消さず、件数だけ返す', async () => {
    const db = setupDb();
    const before = structuredClone(db.tables);
    const result = await refreshDemoData(db.client, NOW, { dryRun: true });
    expect(result).toMatchObject({ dryRun: true, conversations: 6, lineUsers: 6, viewingRequests: 3, deleted: null });
    expect(db.ops).toEqual([]);
    expect(db.tables).toEqual(before);
  });

  it('公開物件が 0 件なら、何も消さずに投げる', async () => {
    const db = setupDb({ withProperties: false });
    const before = structuredClone(db.tables);
    await expect(refreshDemoData(db.client, NOW)).rejects.toThrow('公開物件が 0 件');
    expect(db.ops).toEqual([]);
    expect(db.tables).toEqual(before);
  });

  it('消す段階で失敗したら入れずに投げる。入れる段階で失敗したら操作名つきの DbError', async () => {
    const del = setupDb();
    del.failOn.set('delete:line_users', { code: '42501', message: 'permission denied' });
    await expect(refreshDemoData(del.client, NOW)).rejects.toThrow('permission denied');
    expect(del.ops.some((op) => op.startsWith('insert'))).toBe(false);

    const ins = setupDb();
    ins.failOn.set('insert:messages', { code: '23514', message: 'check violation' });
    const error = await refreshDemoData(ins.client, NOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DbError);
    expect(error).toMatchObject({ operation: 'demo.insert.messages', code: '23514' });
  });
});

describe('purgeOldMessages / runDailyJob', () => {
  it('purge_old_messages を rules.MESSAGE_RETENTION_DAYS で呼び、削除した件数を返す', async () => {
    const db = setupDb();
    db.rpcResult = 7;
    await expect(purgeOldMessages(db.client)).resolves.toBe(7);
    expect(db.rpcCalls).toEqual([{ name: 'purge_old_messages', args: { retention_days: MESSAGE_RETENTION_DAYS } }]);
  });

  it('デモ会話の作り直しと90日削除を両方行う', async () => {
    const db = setupDb();
    const result = await runDailyJob(db.client, NOW, { demo: true });
    expect(result.ok).toBe(true);
    expect(result.demo).toMatchObject({ status: 'ok', value: { conversations: 6 } });
    expect(result.purge).toEqual({ status: 'ok', value: { deleted: 3 } });
  });

  it('デモでない環境（demo: false）ではデモ会話に触れず、90日削除だけ行う', async () => {
    const db = setupDb();
    const before = structuredClone(db.tables);
    const result = await runDailyJob(db.client, NOW, { demo: false });
    expect(result.ok).toBe(true);
    expect(result.demo.status).toBe('skipped');
    expect(result.purge.status).toBe('ok');
    expect(db.ops).toEqual([]);
    expect(db.tables).toEqual(before);
  });

  it('デモでない環境では、閲覧用の資格情報が渡されても Auth には触れない', async () => {
    const db = setupViewerDb();
    const result = await runDailyJob(db.client, NOW, { demo: false, viewer: VIEWER });
    expect(result.viewer).toEqual({ status: 'skipped', reason: expect.stringContaining('DEMO_MODE') });
    expect(result.ok).toBe(true);
    expect(db.authListCalls).toEqual([]);
    expect(db.authUpdates).toEqual([]);
  });

  it('デモの作り直しが失敗しても90日削除は行い、全体は ok: false', async () => {
    const db = setupDb();
    db.failOn.set('insert:conversations', { code: '23505', message: 'duplicate key' });
    const result = await runDailyJob(db.client, NOW, { demo: true });
    expect(result.ok).toBe(false);
    expect(result.demo).toEqual({ status: 'error', message: expect.stringContaining('duplicate key') });
    expect(result.purge.status).toBe('ok');
    expect(db.rpcCalls).toHaveLength(1);
  });

  it('90日削除が失敗してもデモの作り直しは行い、全体は ok: false', async () => {
    const db = setupDb();
    db.failOn.set('rpc:purge_old_messages', { code: '42883', message: 'function does not exist' });
    const result = await runDailyJob(db.client, NOW, { demo: true });
    expect(result.ok).toBe(false);
    expect(result.demo.status).toBe('ok');
    expect(result.purge).toEqual({ status: 'error', message: expect.stringContaining('function does not exist') });
  });
});

// ---------- 閲覧用アカウントのパスワードを戻す ----------

describe('resetDemoViewerPassword', () => {
  /** 失敗の理由を取り出す（投げなければテストを落とす） */
  async function rejection(db: FakeDb, credentials = VIEWER): Promise<string> {
    const error = await resetDemoViewerPassword(db.client, credentials).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  }

  it('メールアドレスが一致する viewer のパスワードだけを環境変数の値に上書きする（大文字小文字は区別しない）', async () => {
    const db = setupViewerDb();
    const result = await resetDemoViewerPassword(db.client, VIEWER);
    expect(result).toEqual({ restored: true });
    expect(db.authUpdates).toEqual([{ id: VIEWER_ID, attributes: { password: VIEWER.password } }]);
    expectNoSecrets(result);
  });

  it('役割は変えない・消さない（更新するのはパスワードだけ）', async () => {
    const db = setupViewerDb();
    await resetDemoViewerPassword(db.client, VIEWER);
    expect(Object.keys(db.authUpdates[0].attributes)).toEqual(['password']);
    expect(db.authUsers.map((u) => u.app_metadata?.role)).toEqual(['staff', 'viewer', 'viewer']);
  });

  it('見つかったアカウントが viewer でなければ、何も変えずに投げる（担当者のパスワードを公開の値に戻さない）', async () => {
    const db = setupViewerDb();
    db.authUsers[1] = { id: VIEWER_ID, email: 'demo.viewer@example.com', app_metadata: { role: 'staff' } };
    const message = await rejection(db);
    expect(message).toContain('viewer ではない');
    expect(message).toContain('staff');
    expect(db.authUpdates).toEqual([]);
    expectNoSecrets(message);
  });

  it('役割の無いアカウントも変えずに投げる', async () => {
    const db = setupViewerDb();
    db.authUsers[1] = { id: VIEWER_ID, email: 'demo.viewer@example.com' };
    expect(await rejection(db)).toContain('役割なし');
    db.authUsers[1] = { id: VIEWER_ID, email: 'demo.viewer@example.com', app_metadata: { role: 'none' } };
    expect(await rejection(db)).toContain('viewer ではない');
    expect(db.authUpdates).toEqual([]);
  });

  it('アカウントが無ければ、何も変えずに投げる。作り方（npm run admin:user）を案内する', async () => {
    const db = setupViewerDb();
    db.authUsers = db.authUsers.filter((u) => u.id !== VIEWER_ID);
    const message = await rejection(db);
    expect(message).toContain('npm run admin:user');
    expect(message).toContain('--role=viewer');
    expect(db.authUpdates).toEqual([]);
    expectNoSecrets(message);
  });

  it('パスワードが 8 文字未満なら、アカウントを探さず変えずに投げる。8 文字ちょうどは通る', async () => {
    const db = setupViewerDb();
    const message = await rejection(db, { ...VIEWER, password: '1234567' });
    expect(message).toContain('8 文字未満');
    expect(db.authListCalls).toEqual([]);
    expect(db.authUpdates).toEqual([]);
    expect(message).not.toContain('1234567');

    await expect(resetDemoViewerPassword(db.client, { ...VIEWER, password: '12345678' })).resolves.toEqual({ restored: true });
    expect(db.authUpdates).toEqual([{ id: VIEWER_ID, attributes: { password: '12345678' } }]);
  });

  it('アカウントが 1,000 件を超えても、次のページまで探す', async () => {
    const db = setupViewerDb();
    const filler: FakeAuthUser[] = Array.from({ length: 1000 }, (_, i) => ({ id: `auth-filler-${i}`, email: `filler${i}@example.com`, app_metadata: { role: 'staff' } }));
    db.authUsers = [...filler, ...db.authUsers];
    await expect(resetDemoViewerPassword(db.client, VIEWER)).resolves.toEqual({ restored: true });
    expect(db.authListCalls).toEqual([
      { page: 1, perPage: 1000 },
      { page: 2, perPage: 1000 },
    ]);
    expect(db.authUpdates).toEqual([{ id: VIEWER_ID, attributes: { password: VIEWER.password } }]);
  });

  it('一覧が取れなかったら、変えずに投げる', async () => {
    const db = setupViewerDb();
    db.failOn.set('auth:listUsers', { message: 'service unavailable' });
    expect(await rejection(db)).toContain('service unavailable');
    expect(db.authUpdates).toEqual([]);
  });

  it('更新に失敗したら投げる（文にパスワード・メールアドレスは出ない）。同じパスワードを弾かれたときは戻っているので成功', async () => {
    const db = setupViewerDb();
    db.failOn.set('auth:updateUser', { message: 'Password should contain letters and digits', code: 'weak_password' });
    const message = await rejection(db);
    expect(message).toContain('戻せません');
    expectNoSecrets(message);

    db.failOn.set('auth:updateUser', { message: 'New password should be different from the old password.', code: 'same_password' });
    await expect(resetDemoViewerPassword(db.client, VIEWER)).resolves.toEqual({ restored: true });
  });
});

describe('runDailyJob の viewer 段', () => {
  it('DEMO_MODE で資格情報があれば、閲覧用のパスワードを戻す。デモ会話の作り直し・90日削除と並んで動く', async () => {
    const db = setupViewerDb();
    const result = await runDailyJob(db.client, NOW, { demo: true, viewer: VIEWER });
    expect(result.ok).toBe(true);
    expect(result.demo.status).toBe('ok');
    expect(result.purge.status).toBe('ok');
    expect(result.viewer).toEqual({ status: 'ok', value: { restored: true } });
    expect(db.authUpdates).toEqual([{ id: VIEWER_ID, attributes: { password: VIEWER.password } }]);
    // 結果（Cron の応答とログになる）にパスワード・メールアドレスを含めない
    expectNoSecrets(result);
  });

  it('資格情報が無い（片方だけでも呼ぶ側が null にする）なら skipped。Auth には触れない', async () => {
    const db = setupViewerDb();
    for (const viewer of [undefined, null]) {
      const result = await runDailyJob(db.client, NOW, { demo: true, viewer });
      expect(result.viewer).toEqual({ status: 'skipped', reason: expect.stringContaining('DEMO_VIEWER_EMAIL') });
      expect(result.ok).toBe(true);
    }
    expect(db.authListCalls).toEqual([]);
    expect(db.authUpdates).toEqual([]);
  });

  it('viewer の段が失敗しても、デモ会話の作り直しと90日削除は行い、全体は ok: false（理由にパスワード・メールアドレスは出ない）', async () => {
    const db = setupViewerDb();
    db.authUsers[1] = { id: VIEWER_ID, email: 'demo.viewer@example.com', app_metadata: { role: 'staff' } };
    const result = await runDailyJob(db.client, NOW, { demo: true, viewer: VIEWER });
    expect(result.ok).toBe(false);
    expect(result.viewer).toEqual({ status: 'error', message: expect.stringContaining('viewer ではない') });
    expect(result.demo.status).toBe('ok');
    expect(result.purge.status).toBe('ok');
    expect(db.authUpdates).toEqual([]);
    expectNoSecrets(result);
  });

  it('デモ会話や90日削除が失敗しても、閲覧用のパスワードは戻す', async () => {
    const db = setupViewerDb();
    db.failOn.set('insert:conversations', { code: '23505', message: 'duplicate key' });
    db.failOn.set('rpc:purge_old_messages', { code: '42883', message: 'function does not exist' });
    const result = await runDailyJob(db.client, NOW, { demo: true, viewer: VIEWER });
    expect(result.ok).toBe(false);
    expect(result.demo.status).toBe('error');
    expect(result.purge.status).toBe('error');
    expect(result.viewer.status).toBe('ok');
    expect(db.authUpdates).toHaveLength(1);
  });
});
