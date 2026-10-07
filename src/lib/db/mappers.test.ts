import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MESSAGE_RETENTION_DAYS } from '@/domain/rules';
import { CONVERSATION_STATES, LAYOUTS } from '@/domain/types';
import type { Property } from '@/domain/types';
import { createMemoryRepositories } from './memory';
import {
  CONVERSATION_SUMMARY_COLUMNS,
  CONVERSATION_SUMMARY_SELECT,
  VIEWING_REQUEST_LIST_SELECT,
  assertDate,
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
  toConversationSummary,
  toHHMM,
  toIso,
  viewingRequestPatchToRow,
  type BusinessHoursDbRow,
  type ConversationDbRow,
  type HolidayDbRow,
  type LineUserDbRow,
  type MessageDbRow,
  type PropertyDbRow,
  type ViewingRequestDbRow,
} from './mappers';
import { MESSAGE_ROLES, VERIFICATIONS, VIEWING_STATUSES } from './types';

// ---------- 行の見本（列は init.sql と同じ。型が Row の全列を要求するので、足りなければ tsc が落ちる） ----------

const propertyRow: PropertyDbRow = {
  id: 'P0001',
  name: 'サンプルレジデンス渋谷',
  address: '東京都渋谷区神南1-1-1',
  ward: '渋谷区',
  access: [
    { station: '渋谷', walk_min: 7 },
    { station: '原宿', walk_min: 12 },
  ],
  rent: 98000,
  management_fee: 5000,
  deposit_months: 1,
  key_money_months: 0.5,
  layout: '1LDK',
  area_sqm: 32.5,
  floor: 3,
  built_year: 2015,
  tags: ['ペット可', 'オートロック'],
  note: '角部屋',
  available_from: '2026-11-01',
  status: 'public',
  updated_at: '2026-10-07T09:00:00.123456+00:00',
};

const lineUserRow: LineUserDbRow = {
  id: 'u-1',
  line_user_id: 'U1234567890',
  display_name: 'たろう',
  created_at: '2026-10-07T09:00:00+00:00',
};

const conversationRow: ConversationDbRow = {
  id: 'c-1',
  line_user_id: 'U1234567890',
  state: 'presenting',
  slots: { tags: [{ value: 'ペット可', priority: 'must' }], rentMax: { value: 100000, priority: 'must' } },
  shown_property_ids: ['P0001', 'P0002'],
  shown_offset: 2,
  last_search_total: 7,
  priority_asked_count: 1,
  ai_paused: true,
  paused_at: '2026-10-07T10:00:00.5+00:00',
  last_staff_reply_at: '2026-10-07T10:00:00.5+00:00',
  booking: { propertyId: 'P0001', candidateTimes: ['2026-10-10T14:00'] },
  handoff_notes: [{ text: '今空いてますか？', topic: 'vacancy', propertyIds: ['P0001'], at: '2026-10-07T09:30:00.000Z' }],
  created_at: '2026-10-07T09:00:00+00:00',
  updated_at: '2026-10-07T10:00:00+00:00',
};

const messageRow: MessageDbRow = {
  id: 'm-1',
  conversation_id: 'c-1',
  role: 'ai',
  text: '5件見つかりました',
  intent: 'conditions',
  slot_diff: [{ op: 'set', key: 'rentMax', value: 100000, priority: 'must' }],
  tool_calls: [{ name: 'search', input: { rentMax: 100000 } }],
  verification: 'ok',
  latency_ms: 1800,
  cost_usd: '0.001234',
  created_at: '2026-10-07T09:00:01+00:00',
};

const viewingRow: ViewingRequestDbRow = {
  id: 'v-1',
  conversation_id: 'c-1',
  property_id: 'P0001',
  candidate_times: ['2026-10-10T14:00', '2026-10-11'],
  status: 'pending',
  confirmed_time: null,
  staff_note: null,
  received_outside_hours: true,
  created_at: '2026-10-07T09:00:00+00:00',
  updated_at: '2026-10-07T09:00:00+00:00',
};

const hoursRow: BusinessHoursDbRow = { weekday: 1, open_time: '10:00:00', close_time: '19:00:00', is_closed: false };
const holidayRow: HolidayDbRow = { date: '2026-11-03', name: '文化の日' };

// ---------- 変換 ----------

describe('日時と時刻の正規化', () => {
  it('timestamptz を toISOString() 形式にそろえる', () => {
    expect(toIso('2026-10-07T09:00:00.123456+00:00')).toBe('2026-10-07T09:00:00.123Z');
    expect(toIso('2026-10-07T18:00:00+09:00')).toBe('2026-10-07T09:00:00.000Z');
    expect(() => toIso('昨日')).toThrow();
  });

  it("time を 'HH:MM' にそろえる", () => {
    expect(toHHMM('10:00:00')).toBe('10:00');
    expect(toHHMM('19:30')).toBe('19:30');
    expect(() => toHHMM('10時')).toThrow();
  });
});

describe('properties', () => {
  it('行 → ドメイン: access を walkMin に、numeric の文字列を数値に変える', () => {
    const property = rowToProperty({ ...propertyRow, area_sqm: '32.50', deposit_months: '1.0' });
    expect(property.access).toEqual([
      { station: '渋谷', walkMin: 7 },
      { station: '原宿', walkMin: 12 },
    ]);
    expect(property.areaSqm).toBe(32.5);
    expect(property.depositMonths).toBe(1);
    expect(property.managementFee).toBe(5000);
    expect(property.availableFrom).toBe('2026-11-01');
  });

  it('ドメイン → 行 → ドメインで元に戻り、行は updated_at を含まない', () => {
    const property = rowToProperty(propertyRow);
    const row = propertyToRow(property);
    expect(row).not.toHaveProperty('updated_at');
    expect(row.access[0]).toEqual({ station: '渋谷', walk_min: 7 });
    expect(rowToProperty({ ...row, updated_at: propertyRow.updated_at })).toEqual(property);
  });

  it('語彙にないタグは落とし、即入居可（null）はそのまま', () => {
    const property = rowToProperty({ ...propertyRow, tags: ['ペット可', '古い語彙'], available_from: null });
    expect(property.tags).toEqual(['ペット可']);
    expect(property.availableFrom).toBeNull();
  });

  it('propertyToRow は渡された配列を共有しない', () => {
    const property: Property = rowToProperty(propertyRow);
    const row = propertyToRow(property);
    row.tags.push('静か');
    expect(property.tags).toEqual(['ペット可', 'オートロック']);
  });
});

describe('line_users', () => {
  it('camelCase に変える', () => {
    expect(rowToLineUser(lineUserRow)).toEqual({
      id: 'u-1',
      lineUserId: 'U1234567890',
      displayName: 'たろう',
      createdAt: '2026-10-07T09:00:00.000Z',
    });
  });
});

describe('conversations', () => {
  it('行 → ドメイン: 日時を ISO にそろえ、jsonb を取り込む', () => {
    const conversation = rowToConversation(conversationRow);
    expect(conversation.lineUserId).toBe('U1234567890');
    expect(conversation.pausedAt).toBe('2026-10-07T10:00:00.500Z');
    expect(conversation.lastSearchTotal).toBe(7);
    expect(conversation.booking).toEqual({ propertyId: 'P0001', candidateTimes: ['2026-10-10T14:00'] });
    expect(conversation.handoffNotes).toEqual([
      { text: '今空いてますか？', topic: 'vacancy', propertyIds: ['P0001'], at: '2026-10-07T09:30:00.000Z' },
    ]);
    expect(conversation.slots.rentMax).toEqual({ value: 100000, priority: 'must' });
  });

  it('slots が null・tags が無くても tags: [] を保証し、booking / handoff_notes の欠けも既定値にする', () => {
    const base = { ...conversationRow, booking: null, handoff_notes: null, paused_at: null, last_staff_reply_at: null };
    expect(rowToConversation({ ...base, slots: null }).slots).toEqual({ tags: [] });
    expect(rowToConversation({ ...base, slots: {} as ConversationDbRow['slots'] }).slots).toEqual({ tags: [] });
    const conversation = rowToConversation(base);
    expect(conversation.booking).toBeNull();
    expect(conversation.handoffNotes).toEqual([]);
    expect(conversation.pausedAt).toBeNull();
  });

  it('管理画面向け: line_user_id を持たず、埋め込みから表示名を取る（オブジェクト・配列・null）', () => {
    // 行に line_user_id が紛れ込んでいても、結果には出ない
    const asObject = rowToConversationSummary({ ...conversationRow, line_users: { display_name: 'たろう' } });
    const asArray = rowToConversationSummary({ ...conversationRow, line_users: [{ display_name: 'たろう' }] });
    const none = rowToConversationSummary({ ...conversationRow, line_users: null });
    expect(asObject.displayName).toBe('たろう');
    expect(asArray.displayName).toBe('たろう');
    expect(none.displayName).toBeNull();
    for (const summary of [asObject, asArray, none]) {
      expect(summary).not.toHaveProperty('lineUserId');
      expect(summary).not.toHaveProperty('line_user_id');
      expect(summary.handoffNotes).toHaveLength(1);
    }
  });

  it('toConversationSummary は lineUserId を落として表示名を付ける', () => {
    const summary = toConversationSummary(rowToConversation(conversationRow), 'たろう');
    expect(summary).not.toHaveProperty('lineUserId');
    expect(summary.displayName).toBe('たろう');
    expect(summary.id).toBe('c-1');
  });

  it('patch → 行: undefined は含めず（変えない）、null は含める（null に更新する）', () => {
    expect(conversationPatchToRow({})).toEqual({});
    expect(conversationPatchToRow({ state: 'qa', shownOffset: 5, pausedAt: null, booking: null })).toEqual({
      state: 'qa',
      shown_offset: 5,
      paused_at: null,
      booking: null,
    });
    expect(conversationPatchToRow({ state: undefined, aiPaused: false })).toEqual({ ai_paused: false });
    expect(
      conversationPatchToRow({
        slots: { tags: [] },
        shownPropertyIds: ['P0001'],
        lastSearchTotal: 3,
        priorityAskedCount: 1,
        lastStaffReplyAt: '2026-10-07T10:00:00.000Z',
        handoffNotes: [],
      }),
    ).toEqual({
      slots: { tags: [] },
      shown_property_ids: ['P0001'],
      last_search_total: 3,
      priority_asked_count: 1,
      last_staff_reply_at: '2026-10-07T10:00:00.000Z',
      handoff_notes: [],
    });
  });
});

describe('messages', () => {
  it('行 → ドメイン: numeric の費用を数値に、null の列は null のまま', () => {
    const message = rowToMessage(messageRow);
    expect(message.costUsd).toBe(0.001234);
    expect(message.intent).toBe('conditions');
    expect(message.slotDiff).toEqual(messageRow.slot_diff);
    expect(message.createdAt).toBe('2026-10-07T09:00:01.000Z');

    const bare = rowToMessage({
      ...messageRow,
      intent: null,
      slot_diff: null,
      tool_calls: null,
      verification: null,
      latency_ms: null,
      cost_usd: 0,
    });
    expect(bare).toMatchObject({ intent: null, slotDiff: null, toolCalls: null, verification: null, latencyMs: null, costUsd: 0 });
  });

  it('ドメイン → 行: 省略は null・費用 0、created_at は指定があるときだけ含める', () => {
    const row = newMessageToRow({ conversationId: 'c-1', role: 'user', text: 'こんにちは' });
    expect(row).toEqual({
      conversation_id: 'c-1',
      role: 'user',
      text: 'こんにちは',
      intent: null,
      slot_diff: null,
      tool_calls: null,
      verification: null,
      latency_ms: null,
      cost_usd: 0,
    });
    expect(row).not.toHaveProperty('created_at');
    expect(
      newMessageToRow({ conversationId: 'c-1', role: 'ai', text: 'x', createdAt: '2026-10-07T18:00:00+09:00' }).created_at,
    ).toBe('2026-10-07T09:00:00.000Z');
  });
});

describe('viewing_requests', () => {
  it('行 → ドメイン', () => {
    expect(rowToViewingRequest(viewingRow)).toEqual({
      id: 'v-1',
      conversationId: 'c-1',
      propertyId: 'P0001',
      candidateTimes: ['2026-10-10T14:00', '2026-10-11'],
      status: 'pending',
      confirmedTime: null,
      staffNote: null,
      receivedOutsideHours: true,
      createdAt: '2026-10-07T09:00:00.000Z',
      updatedAt: '2026-10-07T09:00:00.000Z',
    });
  });

  it('一覧の行: 物件名・表示名・会話の handoff_notes を埋め込みから取る（line_user_id は持たない）', () => {
    const item = rowToViewingRequestListItem({
      ...viewingRow,
      properties: { name: 'サンプルレジデンス渋谷' },
      conversations: {
        handoff_notes: [{ text: '治安は？', topic: 'safety', propertyIds: [], at: '2026-10-07T09:30:00.000Z' }],
        line_users: { display_name: 'たろう' },
      },
    });
    expect(item.propertyName).toBe('サンプルレジデンス渋谷');
    expect(item.displayName).toBe('たろう');
    expect(item.handoffNotes).toEqual([{ text: '治安は？', topic: 'safety', propertyIds: [], at: '2026-10-07T09:30:00.000Z' }]);
    expect(item).not.toHaveProperty('lineUserId');
    expect(item).not.toHaveProperty('conversations');
    expect(item).not.toHaveProperty('properties');
  });

  it('埋め込みが配列・欠けでも読める', () => {
    const asArray = rowToViewingRequestListItem({
      ...viewingRow,
      properties: [{ name: 'A' }],
      conversations: [{ handoff_notes: null, line_users: [{ display_name: 'B' }] }],
    });
    expect(asArray).toMatchObject({ propertyName: 'A', displayName: 'B', handoffNotes: [] });
    const missing = rowToViewingRequestListItem({ ...viewingRow });
    expect(missing).toMatchObject({ propertyName: null, displayName: null, handoffNotes: [] });
  });

  it('新規は status を DB の既定値に任せ、patch は undefined を含めない', () => {
    expect(
      newViewingRequestToRow({ conversationId: 'c-1', propertyId: 'P0001', candidateTimes: ['2026-10-10'], receivedOutsideHours: false }),
    ).toEqual({ conversation_id: 'c-1', property_id: 'P0001', candidate_times: ['2026-10-10'], received_outside_hours: false });
    expect(viewingRequestPatchToRow({})).toEqual({});
    expect(viewingRequestPatchToRow({ status: 'confirmed', confirmedTime: '2026-10-10T14:00', staffNote: undefined })).toEqual({
      status: 'confirmed',
      confirmed_time: '2026-10-10T14:00',
    });
    expect(viewingRequestPatchToRow({ staffNote: null })).toEqual({ staff_note: null });
  });
});

describe('営業時間と休業日', () => {
  it("行 → カレンダー: 'HH:MM:SS' を 'HH:MM' に、曜日順・日付順にする", () => {
    const calendar = rowsToCalendar(
      [
        { ...hoursRow, weekday: 3, is_closed: true },
        { ...hoursRow, weekday: 0 },
      ],
      [{ date: '2026-12-31', name: null }, holidayRow],
    );
    expect(calendar.hours).toEqual([
      { weekday: 0, open: '10:00', close: '19:00', isClosed: false },
      { weekday: 3, open: '10:00', close: '19:00', isClosed: true },
    ]);
    expect(calendar.holidays).toEqual(['2026-11-03', '2026-12-31']);
  });

  it('営業時間を行にする', () => {
    expect(hoursToRow({ weekday: 6, open: '11:00', close: '17:00', isClosed: false })).toEqual({
      weekday: 6,
      open_time: '11:00',
      close_time: '17:00',
      is_closed: false,
    });
  });

  it('休業日は実在する YYYY-MM-DD だけ受け、重複を除いて日付順にする', () => {
    expect(normalizeHolidays(['2026-12-31', '2026-11-03', '2026-11-03'])).toEqual(['2026-11-03', '2026-12-31']);
    expect(normalizeHolidays([])).toEqual([]);
    for (const bad of ['2026-02-30', '2026/10/01', '2026-1-1', '', "2026-10-01,2026-10-02", '2026-10-01)']) {
      expect(() => assertDate(bad)).toThrow();
    }
    expect(assertDate('2028-02-29')).toBe('2028-02-29');
    expect(() => assertDate('2027-02-29')).toThrow();
  });

  it('営業時間の検証: 曜日 0〜6・HH:MM・営業日は開始 < 終了（休業日は問わない）・同じ曜日は後ろを採用', () => {
    expect(() => normalizeHoursRows([{ weekday: 7, open: '10:00', close: '19:00', isClosed: false }])).toThrow();
    expect(() => normalizeHoursRows([{ weekday: 1.5, open: '10:00', close: '19:00', isClosed: false }])).toThrow();
    expect(() => normalizeHoursRows([{ weekday: 1, open: '9:00', close: '19:00', isClosed: false }])).toThrow();
    expect(() => normalizeHoursRows([{ weekday: 1, open: '10:00', close: '24:00', isClosed: false }])).toThrow();
    expect(() => normalizeHoursRows([{ weekday: 1, open: '19:00', close: '10:00', isClosed: false }])).toThrow();
    expect(normalizeHoursRows([{ weekday: 1, open: '19:00', close: '10:00', isClosed: true }])).toHaveLength(1);
    expect(
      normalizeHoursRows([
        { weekday: 2, open: '10:00', close: '19:00', isClosed: false },
        { weekday: 1, open: '10:00', close: '18:00', isClosed: false },
        { weekday: 2, open: '11:00', close: '19:00', isClosed: false },
      ]),
    ).toEqual([
      { weekday: 1, open: '10:00', close: '18:00', isClosed: false },
      { weekday: 2, open: '11:00', close: '19:00', isClosed: false },
    ]);
  });
});

// ---------- init.sql との食い違い検査 ----------

const sql = readFileSync(
  fileURLToPath(new URL('../../../supabase/migrations/20261007000000_init.sql', import.meta.url)),
  'utf8',
);

function tableBlock(table: string): string {
  const match = new RegExp(`create table public\\.${table} \\(\\r?\\n([\\s\\S]*?)\\r?\\n\\);`).exec(sql);
  if (!match) throw new Error(`init.sql に ${table} の create table が見つかりません`);
  return match[1];
}

function columns(table: string): string[] {
  return tableBlock(table)
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, '').trim())
    .filter((line) => line !== '' && !/^(constraint|primary|unique|check|foreign)\b/i.test(line))
    .map((line) => line.split(/\s+/)[0]);
}

/** `col text ... check (col in ('a', 'b'))` の値の一覧 */
function checkValues(table: string, column: string): string[] {
  const match = new RegExp(`^\\s*${column} text[^\\n]*check \\(${column} in \\(([^)]*)\\)\\)`, 'm').exec(tableBlock(table));
  if (!match) throw new Error(`${table}.${column} の check (... in (...)) が見つかりません`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('supabase/migrations/20261007000000_init.sql との突き合わせ', () => {
  const tables = ['properties', 'line_users', 'conversations', 'messages', 'viewing_requests', 'business_hours', 'holidays', 'webhook_events'];

  it('すべてのテーブルで RLS が有効', () => {
    const created = [...sql.matchAll(/create table public\.(\w+) \(/g)].map((m) => m[1]);
    expect(created.sort()).toEqual([...tables].sort());
    for (const table of created) {
      expect(sql).toMatch(new RegExp(`alter table public\\.${table} enable row level security;`));
    }
  });

  it('anon には何も許さず、webhook_events は担当者にも許さない', () => {
    expect(sql).not.toMatch(/grant[^;]*\bto\b[^;]*\banon\b/i);
    expect(sql).not.toMatch(/create policy[^;]*\banon\b/i);
    expect(sql).not.toMatch(/grant[^;]*public\.webhook_events[^;]*\bto\b[^;]*authenticated/i);
    expect(sql).not.toMatch(/create policy[^;]*on public\.webhook_events/i);
  });

  it('マッパーの行の列と DB の列が一致する', () => {
    const keys = (row: object): string[] => Object.keys(row).sort();
    expect(columns('properties').sort()).toEqual(keys(propertyRow));
    expect(columns('line_users').sort()).toEqual(keys(lineUserRow));
    expect(columns('conversations').sort()).toEqual(keys(conversationRow));
    expect(columns('messages').sort()).toEqual(keys(messageRow));
    expect(columns('viewing_requests').sort()).toEqual(keys(viewingRow));
    expect(columns('business_hours').sort()).toEqual(keys(hoursRow));
    expect(columns('holidays').sort()).toEqual(keys(holidayRow));
    expect(columns('webhook_events')).toEqual(['webhook_event_id', 'received_at']);
  });

  it('マッパーが書く列は DB にある（insert / update で未知の列を送らない）', () => {
    const property = rowToProperty(propertyRow);
    expect(columns('properties')).toEqual(expect.arrayContaining(Object.keys(propertyToRow(property))));
    expect(columns('messages')).toEqual(
      expect.arrayContaining(Object.keys(newMessageToRow({ conversationId: 'c', role: 'user', text: 't', createdAt: '2026-10-07T00:00:00Z' }))),
    );
    expect(columns('viewing_requests')).toEqual(
      expect.arrayContaining([
        ...Object.keys(newViewingRequestToRow({ conversationId: 'c', propertyId: 'p', candidateTimes: [], receivedOutsideHours: false })),
        ...Object.keys(viewingRequestPatchToRow({ status: 'confirmed', confirmedTime: 'x', staffNote: 'y' })),
      ]),
    );
    expect(columns('conversations')).toEqual(
      expect.arrayContaining(
        Object.keys(
          conversationPatchToRow({
            state: 'qa',
            slots: { tags: [] },
            shownPropertyIds: [],
            shownOffset: 0,
            lastSearchTotal: 0,
            priorityAskedCount: 0,
            aiPaused: false,
            pausedAt: null,
            lastStaffReplyAt: null,
            booking: null,
            handoffNotes: [],
          }),
        ),
      ),
    );
    expect(columns('business_hours')).toEqual(
      expect.arrayContaining(Object.keys(hoursToRow({ weekday: 0, open: '10:00', close: '19:00', isClosed: false }))),
    );
  });

  it('管理画面向けの select は line_user_id を取らず、DB にある列だけを指す', () => {
    expect(CONVERSATION_SUMMARY_COLUMNS).not.toContain('line_user_id');
    expect(CONVERSATION_SUMMARY_SELECT).not.toContain('line_user_id');
    expect(VIEWING_REQUEST_LIST_SELECT).not.toContain('line_user_id');
    expect(columns('conversations')).toEqual(expect.arrayContaining([...CONVERSATION_SUMMARY_COLUMNS]));
    expect(columns('conversations')).toContain('handoff_notes');
    expect(columns('properties')).toContain('name');
    expect(columns('line_users')).toContain('display_name');
  });

  it('check の値が TypeScript の語彙と同じ', () => {
    expect(checkValues('properties', 'layout')).toEqual([...LAYOUTS]);
    expect(checkValues('properties', 'status')).toEqual(['public', 'private']);
    expect(checkValues('conversations', 'state')).toEqual([...CONVERSATION_STATES]);
    expect(checkValues('messages', 'role')).toEqual([...MESSAGE_ROLES]);
    expect(checkValues('messages', 'verification')).toEqual([...VERIFICATIONS]);
    expect(checkValues('viewing_requests', 'status')).toEqual([...VIEWING_STATUSES]);
  });

  it('purge_old_messages の既定の日数が rules.MESSAGE_RETENTION_DAYS と同じ', () => {
    const match = /function public\.purge_old_messages\(retention_days integer default (\d+)\)/.exec(sql);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(MESSAGE_RETENTION_DAYS);
  });

  it('business_hours の初期値がインメモリ実装の既定（rules.ts の営業時間）と同じ', async () => {
    const seed = /insert into public\.business_hours[^;]*?values([^;]*?)on conflict/.exec(sql);
    expect(seed).not.toBeNull();
    const seeded = [...(seed?.[1] ?? '').matchAll(/\(\s*(\d),\s*'(\d{2}:\d{2})',\s*'(\d{2}:\d{2})',\s*(true|false)\s*\)/g)].map((m) => ({
      weekday: Number(m[1]),
      open: m[2],
      close: m[3],
      isClosed: m[4] === 'true',
    }));
    const calendar = await createMemoryRepositories().businessCalendar.get();
    expect(seeded).toEqual(calendar.hours);
    expect(calendar.holidays).toEqual([]);
  });
});
