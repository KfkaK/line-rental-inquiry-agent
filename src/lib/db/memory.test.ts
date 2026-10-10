import { describe, expect, it } from 'vitest';
import { DEFAULT_CLOSE, DEFAULT_CLOSED_WEEKDAYS, DEFAULT_OPEN } from '@/domain/rules';
import type { HandoffNote, Property } from '@/domain/types';
import { createMemoryRepositories, type MemorySeed } from './memory';
import { DbError, type Repositories } from './types';

// ---------- 小道具 ----------

const T0 = Date.parse('2026-10-07T00:00:00.000Z');

/** 手で進める時計と連番 ID。テストを決定的にする */
function setup(seed?: MemorySeed): { repos: Repositories; advance: (ms: number) => void; at: () => Date } {
  let t = T0;
  let n = 0;
  const repos = createMemoryRepositories(seed, {
    clock: () => new Date(t),
    newId: () => `id-${++n}`,
  });
  return { repos, advance: (ms) => (t += ms), at: () => new Date(t) };
}

function makeProperty(id: string, overrides: Partial<Property> = {}): Property {
  return {
    id,
    name: `物件${id}`,
    address: '東京都渋谷区',
    ward: '渋谷区',
    access: [{ station: '渋谷', walkMin: 7 }],
    rent: 100000,
    managementFee: 5000,
    depositMonths: 1,
    keyMoneyMonths: 0,
    layout: '1K',
    areaSqm: 25,
    floor: 2,
    builtYear: 2015,
    tags: ['ペット可'],
    note: '',
    availableFrom: null,
    status: 'public',
    ...overrides,
  };
}

async function expectDbError(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DbError);
  expect((error as DbError).code).toBe(code);
}

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

// ---------- properties ----------

describe('properties', () => {
  it('listPublic は公開物件だけを ID 昇順で返す', async () => {
    const { repos } = setup({
      properties: [makeProperty('P3'), makeProperty('P1'), makeProperty('P2', { status: 'private' })],
    });
    expect((await repos.properties.listPublic()).map((p) => p.id)).toEqual(['P1', 'P3']);
  });

  it('getByIds は渡した順で返し、無い ID は飛ばし、重複は 1 件にし、非公開も返す', async () => {
    const { repos } = setup({
      properties: [makeProperty('P1'), makeProperty('P2'), makeProperty('P3', { status: 'private' })],
    });
    const found = await repos.properties.getByIds(['P3', 'P1', 'NONE', 'P3', 'P2']);
    expect(found.map((p) => p.id)).toEqual(['P3', 'P1', 'P2']);
    expect(found[0].status).toBe('private');
    expect(await repos.properties.getByIds([])).toEqual([]);
  });

  it('upsertMany は登録と更新の件数を返し、同じ ID が重複したら後ろを採用する', async () => {
    const { repos } = setup({ properties: [makeProperty('P1', { rent: 90000 })] });
    const result = await repos.properties.upsertMany([
      makeProperty('P1', { rent: 95000 }),
      makeProperty('P2'),
      makeProperty('P2', { rent: 123000 }),
    ]);
    expect(result).toEqual({ inserted: 1, updated: 1 });
    const all = await repos.properties.listPublic();
    expect(all.find((p) => p.id === 'P1')?.rent).toBe(95000);
    expect(all.find((p) => p.id === 'P2')?.rent).toBe(123000);
    expect(await repos.properties.upsertMany([])).toEqual({ inserted: 0, updated: 0 });
  });

  it('upsertMany で非公開にすると検索対象から外れる', async () => {
    const { repos } = setup({ properties: [makeProperty('P1')] });
    await repos.properties.upsertMany([makeProperty('P1', { status: 'private' })]);
    expect(await repos.properties.listPublic()).toEqual([]);
  });

  it('返した値を書き換えても内部の状態は変わらない（渡した値も共有しない）', async () => {
    const original = makeProperty('P1');
    const { repos } = setup({ properties: [original] });
    original.name = '書き換え後';
    const [first] = await repos.properties.listPublic();
    expect(first.name).toBe('物件P1');
    first.tags.push('静か');
    first.access[0].walkMin = 99;
    const [second] = await repos.properties.listPublic();
    expect(second.tags).toEqual(['ペット可']);
    expect(second.access[0].walkMin).toBe(7);
  });
});

// ---------- line_users ----------

describe('lineUsers', () => {
  it('upsert は初回に作り、2 回目は同じ行を返す。表示名は null / 省略で消さない', async () => {
    const { repos, advance } = setup();
    const created = await repos.lineUsers.upsert({ lineUserId: 'U1', displayName: 'たろう' });
    expect(created).toMatchObject({ id: 'id-1', lineUserId: 'U1', displayName: 'たろう', createdAt: '2026-10-07T00:00:00.000Z' });

    advance(HOUR);
    const again = await repos.lineUsers.upsert({ lineUserId: 'U1' });
    expect(again.id).toBe('id-1');
    expect(again.displayName).toBe('たろう');
    expect(again.createdAt).toBe('2026-10-07T00:00:00.000Z');
    expect((await repos.lineUsers.upsert({ lineUserId: 'U1', displayName: null })).displayName).toBe('たろう');
    expect((await repos.lineUsers.upsert({ lineUserId: 'U1', displayName: 'はなこ' })).displayName).toBe('はなこ');
  });

  it('表示名なしで作ると null', async () => {
    const { repos } = setup();
    expect((await repos.lineUsers.upsert({ lineUserId: 'U2' })).displayName).toBeNull();
  });
});

// ---------- conversations ----------

describe('conversations', () => {
  it('LINE ユーザーが未登録なら getOrCreate は外部キー違反（23503）', async () => {
    const { repos } = setup();
    await expectDbError(repos.conversations.getOrCreate('U-unknown'), '23503');
  });

  it('getOrCreate は初期状態で作り、同じユーザーには同じ会話を返す', async () => {
    const { repos } = setup({ lineUsers: [{ lineUserId: 'U1', displayName: 'たろう' }] });
    const conversation = await repos.conversations.getOrCreate('U1');
    expect(conversation).toMatchObject({
      lineUserId: 'U1',
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
      createdAt: '2026-10-07T00:00:00.000Z',
      updatedAt: '2026-10-07T00:00:00.000Z',
    });
    const again = await repos.conversations.getOrCreate('U1');
    expect(again.id).toBe(conversation.id);
  });

  it('update は渡した項目だけ変え、undefined は変えず、null は null にし、updatedAt を進める', async () => {
    const { repos, advance } = setup({ lineUsers: [{ lineUserId: 'U1' }] });
    const { id } = await repos.conversations.getOrCreate('U1');

    advance(MINUTE);
    const updated = await repos.conversations.update(id, {
      state: 'presenting',
      slots: { tags: [{ value: 'ペット可', priority: 'must' }], rentMax: { value: 120000, priority: 'must' } },
      shownPropertyIds: ['P1', 'P2'],
      shownOffset: 2,
      lastSearchTotal: 7,
      booking: { propertyId: 'P1', candidateTimes: ['2026-10-10T14:00'] },
      handoffNotes: [{ text: '空いてますか', topic: 'vacancy', propertyIds: [], at: '2026-10-07T00:01:00.000Z' }],
    });
    expect(updated).toMatchObject({ state: 'presenting', shownOffset: 2, lastSearchTotal: 7, updatedAt: '2026-10-07T00:01:00.000Z' });
    expect(updated.createdAt).toBe('2026-10-07T00:00:00.000Z');

    advance(MINUTE);
    const partial = await repos.conversations.update(id, { aiPaused: true, pausedAt: '2026-10-07T00:02:00.000Z', state: undefined });
    expect(partial.state).toBe('presenting');
    expect(partial.aiPaused).toBe(true);
    expect(partial.shownPropertyIds).toEqual(['P1', 'P2']);

    advance(MINUTE);
    const cleared = await repos.conversations.update(id, { booking: null, pausedAt: null, lastSearchTotal: null });
    expect(cleared.booking).toBeNull();
    expect(cleared.pausedAt).toBeNull();
    expect(cleared.lastSearchTotal).toBeNull();
    expect(cleared.aiPaused).toBe(true);
    expect((await repos.conversations.getById(id))?.handoffNotes).toHaveLength(1);
  });

  it('空の patch は何もせず updatedAt も進めない。対象が無ければ NOT_FOUND', async () => {
    const { repos, advance } = setup({ lineUsers: [{ lineUserId: 'U1' }] });
    const { id, updatedAt } = await repos.conversations.getOrCreate('U1');
    advance(HOUR);
    expect((await repos.conversations.update(id, {})).updatedAt).toBe(updatedAt);
    await expectDbError(repos.conversations.update('nope', { state: 'qa' }), 'NOT_FOUND');
    await expectDbError(repos.conversations.update('nope', {}), 'NOT_FOUND');
    expect(await repos.conversations.getById('nope')).toBeNull();
  });

  it('返した会話を書き換えても内部の状態は変わらない', async () => {
    const { repos } = setup({ lineUsers: [{ lineUserId: 'U1' }] });
    const conversation = await repos.conversations.getOrCreate('U1');
    conversation.slots.tags.push({ value: 'ペット可', priority: 'must' });
    conversation.shownPropertyIds.push('P1');
    const fresh = await repos.conversations.getOrCreate('U1');
    expect(fresh.slots.tags).toEqual([]);
    expect(fresh.shownPropertyIds).toEqual([]);
  });

  it('listRecent は最終動作の新しい順で、管理画面向けに lineUserId を持たず表示名を持つ', async () => {
    const { repos, advance } = setup({
      lineUsers: [
        { lineUserId: 'U1', displayName: 'いち' },
        { lineUserId: 'U2', displayName: 'に' },
        { lineUserId: 'U3' },
      ],
    });
    const c1 = await repos.conversations.getOrCreate('U1');
    advance(MINUTE);
    const c2 = await repos.conversations.getOrCreate('U2');
    advance(MINUTE);
    const c3 = await repos.conversations.getOrCreate('U3');
    advance(MINUTE);
    await repos.conversations.update(c1.id, { aiPaused: true });

    const list = await repos.conversations.listRecent();
    expect(list.map((c) => c.id)).toEqual([c1.id, c3.id, c2.id]);
    expect(list.map((c) => c.displayName)).toEqual(['いち', null, 'に']);
    for (const summary of list) expect(summary).not.toHaveProperty('lineUserId');

    expect((await repos.conversations.listRecent({ aiPaused: true })).map((c) => c.id)).toEqual([c1.id]);
    expect((await repos.conversations.listRecent({ state: 'hearing', limit: 2 })).map((c) => c.id)).toEqual([c1.id, c3.id]);
    expect((await repos.conversations.listRecent({ limit: 2, offset: 2 })).map((c) => c.id)).toEqual([c2.id]);
    expect(await repos.conversations.listRecent({ state: 'booking' })).toEqual([]);
  });

  it('同時刻に作った会話は新しい方が先', async () => {
    const { repos } = setup({ lineUsers: [{ lineUserId: 'U1' }, { lineUserId: 'U2' }] });
    const first = await repos.conversations.getOrCreate('U1');
    const second = await repos.conversations.getOrCreate('U2');
    expect((await repos.conversations.listRecent()).map((c) => c.id)).toEqual([second.id, first.id]);
  });

  it('getSummary は 1 件（lineUserId なし）。無ければ null', async () => {
    const { repos } = setup({ lineUsers: [{ lineUserId: 'U1', displayName: 'いち' }] });
    const { id } = await repos.conversations.getOrCreate('U1');
    const summary = await repos.conversations.getSummary(id);
    expect(summary).toMatchObject({ id, displayName: 'いち' });
    expect(summary).not.toHaveProperty('lineUserId');
    expect(await repos.conversations.getSummary('nope')).toBeNull();
  });
});

// ---------- messages ----------

describe('messages', () => {
  async function withConversation(lineUserId = 'U1') {
    const ctx = setup({ lineUsers: [{ lineUserId }] });
    const conversation = await ctx.repos.conversations.getOrCreate(lineUserId);
    return { ...ctx, conversation };
  }

  it('会話が無ければ insert は外部キー違反（23503）', async () => {
    const { repos } = setup();
    await expectDbError(repos.messages.insert({ conversationId: 'nope', role: 'user', text: 'x' }), '23503');
  });

  it('insert は既定値を補い、listByConversation は古い順に返す', async () => {
    const { repos, advance, conversation } = await withConversation();
    const first = await repos.messages.insert({ conversationId: conversation.id, role: 'user', text: 'こんにちは' });
    expect(first).toMatchObject({
      role: 'user',
      intent: null,
      slotDiff: null,
      toolCalls: null,
      verification: null,
      latencyMs: null,
      costUsd: 0,
      createdAt: '2026-10-07T00:00:00.000Z',
    });
    advance(1000);
    await repos.messages.insert({
      conversationId: conversation.id,
      role: 'ai',
      text: '渋谷で探します',
      intent: 'conditions',
      slotDiff: [{ op: 'unset', key: 'rentMax' }],
      toolCalls: [{ name: 'search' }],
      verification: 'ok',
      latencyMs: 1500,
      costUsd: 0.002,
    });
    const list = await repos.messages.listByConversation(conversation.id);
    expect(list.map((m) => m.role)).toEqual(['user', 'ai']);
    expect(list[1]).toMatchObject({ intent: 'conditions', verification: 'ok', latencyMs: 1500, costUsd: 0.002 });
    expect(list[1].slotDiff).toEqual([{ op: 'unset', key: 'rentMax' }]);
    expect(await repos.messages.listByConversation('other')).toEqual([]);
  });

  it('createdAt を指定した順序で並ぶ（挿入順ではなく時刻順）', async () => {
    const { repos, conversation } = await withConversation();
    await repos.messages.insert({ conversationId: conversation.id, role: 'ai', text: '2番目', createdAt: '2026-10-07T00:00:02.000Z' });
    await repos.messages.insert({ conversationId: conversation.id, role: 'user', text: '1番目', createdAt: '2026-10-07T00:00:01.000Z' });
    expect((await repos.messages.listByConversation(conversation.id)).map((m) => m.text)).toEqual(['1番目', '2番目']);
  });

  it('メッセージを足すと会話の updatedAt が進む（DB のトリガーと同じ）', async () => {
    const { repos, advance, conversation } = await withConversation();
    advance(HOUR);
    await repos.messages.insert({ conversationId: conversation.id, role: 'user', text: 'x' });
    expect((await repos.conversations.getById(conversation.id))?.updatedAt).toBe('2026-10-07T01:00:00.000Z');
  });

  it('countExtractedTurnsSince は そのユーザーの、条件抽出を通した AI の返信（intent あり）だけを since 以降（含む）で数える', async () => {
    const { repos, advance, at, conversation } = await withConversation('U1');
    await repos.lineUsers.upsert({ lineUserId: 'U2' });
    const other = await repos.conversations.getOrCreate('U2');

    await repos.messages.insert({ conversationId: conversation.id, role: 'ai', text: '古い', intent: 'conditions' });
    advance(30_000);
    const since = at();
    await repos.messages.insert({ conversationId: conversation.id, role: 'ai', text: 'ちょうど', intent: 'propertyQuestion' });
    // ボタン・友だち追加の返信（intent なし）・利用者と担当者の発言は数えない
    await repos.messages.insert({ conversationId: conversation.id, role: 'ai', text: 'ボタンへの返信' });
    await repos.messages.insert({ conversationId: conversation.id, role: 'user', text: '[ボタン] more' });
    await repos.messages.insert({ conversationId: conversation.id, role: 'staff', text: '担当者' });
    await repos.messages.insert({ conversationId: other.id, role: 'ai', text: '別のユーザー', intent: 'conditions' });
    advance(1000);
    await repos.messages.insert({ conversationId: conversation.id, role: 'ai', text: '新しい', intent: 'offTopic' });

    expect(await repos.messages.countExtractedTurnsSince('U1', since)).toBe(2);
    expect(await repos.messages.countExtractedTurnsSince('U1', new Date(T0))).toBe(3);
    expect(await repos.messages.countExtractedTurnsSince('U2', since)).toBe(1);
    expect(await repos.messages.countExtractedTurnsSince('U-none', since)).toBe(0);
  });

  it('sumCostSince は since 以降（含む）の全ロールの費用を合計する', async () => {
    const { repos, advance, at, conversation } = await withConversation();
    await repos.messages.insert({ conversationId: conversation.id, role: 'ai', text: '前日', costUsd: 5 });
    advance(24 * HOUR);
    const since = at();
    await repos.messages.insert({ conversationId: conversation.id, role: 'ai', text: 'a', costUsd: 0.1 });
    await repos.messages.insert({ conversationId: conversation.id, role: 'ai', text: 'b', costUsd: 0.2 });
    await repos.messages.insert({ conversationId: conversation.id, role: 'user', text: 'c' });
    expect(await repos.messages.sumCostSince(since)).toBe(0.3);
    expect(await repos.messages.sumCostSince(new Date(T0))).toBe(5.3);
    expect(await repos.messages.sumCostSince(new Date(at().getTime() + 1))).toBe(0);
  });
});

// ---------- viewing_requests ----------

describe('viewingRequests', () => {
  async function withConversation() {
    const ctx = setup({
      properties: [makeProperty('P1', { name: 'レジデンス渋谷' }), makeProperty('P2')],
      lineUsers: [{ lineUserId: 'U1', displayName: 'たろう' }],
    });
    const conversation = await ctx.repos.conversations.getOrCreate('U1');
    return { ...ctx, conversation };
  }

  it('会話か物件が無ければ create は外部キー違反（23503）', async () => {
    const { repos, conversation } = await withConversation();
    await expectDbError(
      repos.viewingRequests.create({ conversationId: 'nope', propertyId: 'P1', candidateTimes: [], receivedOutsideHours: false }),
      '23503',
    );
    await expectDbError(
      repos.viewingRequests.create({ conversationId: conversation.id, propertyId: 'NONE', candidateTimes: [], receivedOutsideHours: false }),
      '23503',
    );
  });

  it('create は pending で作る', async () => {
    const { repos, conversation } = await withConversation();
    const request = await repos.viewingRequests.create({
      conversationId: conversation.id,
      propertyId: 'P1',
      candidateTimes: ['2026-10-10T14:00', '2026-10-11'],
      receivedOutsideHours: true,
    });
    expect(request).toMatchObject({
      status: 'pending',
      confirmedTime: null,
      staffNote: null,
      receivedOutsideHours: true,
      candidateTimes: ['2026-10-10T14:00', '2026-10-11'],
      createdAt: '2026-10-07T00:00:00.000Z',
      updatedAt: '2026-10-07T00:00:00.000Z',
    });
  });

  it('一覧は届いた順で、表示名・物件名・会話の handoffNotes を持ち、lineUserId を持たない', async () => {
    const { repos, advance, at, conversation } = await withConversation();
    const note: HandoffNote = { text: '初期費用はいくら？', topic: 'initialCostTotal', propertyIds: ['P1'], at: '2026-10-07T00:00:00.000Z' };
    await repos.conversations.update(conversation.id, { handoffNotes: [note] });
    const early = await repos.viewingRequests.create({ conversationId: conversation.id, propertyId: 'P1', candidateTimes: [], receivedOutsideHours: false });
    advance(HOUR);
    const since = at();
    const late = await repos.viewingRequests.create({ conversationId: conversation.id, propertyId: 'P2', candidateTimes: [], receivedOutsideHours: true });
    const lateTwo = await repos.viewingRequests.create({ conversationId: conversation.id, propertyId: 'P1', candidateTimes: [], receivedOutsideHours: true });

    const list = await repos.viewingRequests.listSince(since);
    expect(list.map((r) => r.id)).toEqual([late.id, lateTwo.id]);
    expect(list[1]).toMatchObject({ displayName: 'たろう', propertyName: 'レジデンス渋谷', handoffNotes: [note] });
    for (const item of list) expect(item).not.toHaveProperty('lineUserId');

    expect((await repos.viewingRequests.listSince(new Date(T0))).map((r) => r.id)).toEqual([early.id, late.id, lateTwo.id]);
    expect(await repos.viewingRequests.listSince(new Date(at().getTime() + 1))).toEqual([]);
  });

  it('listByStatus は status で絞る。update で状態が変わる', async () => {
    const { repos, advance, conversation } = await withConversation();
    const a = await repos.viewingRequests.create({ conversationId: conversation.id, propertyId: 'P1', candidateTimes: ['2026-10-10'], receivedOutsideHours: false });
    advance(MINUTE);
    const b = await repos.viewingRequests.create({ conversationId: conversation.id, propertyId: 'P2', candidateTimes: ['2026-10-11'], receivedOutsideHours: false });

    advance(MINUTE);
    const confirmed = await repos.viewingRequests.update(a.id, { status: 'confirmed', confirmedTime: '2026-10-10', staffNote: '確定' });
    expect(confirmed).toMatchObject({ status: 'confirmed', confirmedTime: '2026-10-10', staffNote: '確定', updatedAt: '2026-10-07T00:02:00.000Z' });
    expect(confirmed.createdAt).toBe('2026-10-07T00:00:00.000Z');

    expect((await repos.viewingRequests.listByStatus('pending')).map((r) => r.id)).toEqual([b.id]);
    expect((await repos.viewingRequests.listByStatus('confirmed')).map((r) => r.id)).toEqual([a.id]);
    expect(await repos.viewingRequests.listByStatus('rejected')).toEqual([]);

    const inProgress = await repos.viewingRequests.update(b.id, { status: 'in_progress' });
    expect(inProgress.status).toBe('in_progress');
    const cleared = await repos.viewingRequests.update(a.id, { staffNote: null });
    expect(cleared.staffNote).toBeNull();
    expect(cleared.confirmedTime).toBe('2026-10-10');
  });

  it('空の patch は updatedAt を進めない。対象が無ければ NOT_FOUND。getById は一覧の行を返す', async () => {
    const { repos, advance, conversation } = await withConversation();
    const request = await repos.viewingRequests.create({ conversationId: conversation.id, propertyId: 'P1', candidateTimes: [], receivedOutsideHours: false });
    advance(HOUR);
    expect((await repos.viewingRequests.update(request.id, {})).updatedAt).toBe(request.updatedAt);
    await expectDbError(repos.viewingRequests.update('nope', { status: 'rejected' }), 'NOT_FOUND');
    expect(await repos.viewingRequests.getById('nope')).toBeNull();
    expect(await repos.viewingRequests.getById(request.id)).toMatchObject({ id: request.id, displayName: 'たろう', propertyName: 'レジデンス渋谷' });
  });
});

// ---------- business_hours / holidays ----------

describe('businessCalendar', () => {
  it('既定は rules.ts の営業時間（平日・土日 10:00-19:00、水曜定休）で、休業日なし', async () => {
    const { repos } = setup();
    const calendar = await repos.businessCalendar.get();
    expect(calendar.hours.map((h) => h.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    for (const row of calendar.hours) {
      expect(row.open).toBe(DEFAULT_OPEN);
      expect(row.close).toBe(DEFAULT_CLOSE);
      expect(row.isClosed).toBe(DEFAULT_CLOSED_WEEKDAYS.includes(row.weekday));
    }
    expect(calendar.hours[3].isClosed).toBe(true);
    expect(calendar.holidays).toEqual([]);
  });

  it('setHours は渡した曜日だけを上書きし、検証に失敗したら何も変えない', async () => {
    const { repos } = setup();
    await repos.businessCalendar.setHours([
      { weekday: 6, open: '11:00', close: '17:00', isClosed: false },
      { weekday: 3, open: '10:00', close: '19:00', isClosed: false },
    ]);
    const calendar = await repos.businessCalendar.get();
    expect(calendar.hours[6]).toEqual({ weekday: 6, open: '11:00', close: '17:00', isClosed: false });
    expect(calendar.hours[3].isClosed).toBe(false);
    expect(calendar.hours[1]).toEqual({ weekday: 1, open: '10:00', close: '19:00', isClosed: false });

    await expect(
      repos.businessCalendar.setHours([
        { weekday: 1, open: '09:00', close: '18:00', isClosed: false },
        { weekday: 2, open: '19:00', close: '10:00', isClosed: false },
      ]),
    ).rejects.toThrow();
    expect((await repos.businessCalendar.get()).hours[1].open).toBe('10:00');
  });

  it('setHolidays は一覧を置き換え（日付順・重複なし）、不正な日付は拒否する', async () => {
    const { repos } = setup();
    await repos.businessCalendar.setHolidays(['2026-12-31', '2026-11-03', '2026-11-03']);
    expect((await repos.businessCalendar.get()).holidays).toEqual(['2026-11-03', '2026-12-31']);
    await repos.businessCalendar.setHolidays(['2027-01-01']);
    expect((await repos.businessCalendar.get()).holidays).toEqual(['2027-01-01']);
    await expect(repos.businessCalendar.setHolidays(['2027-02-30'])).rejects.toThrow();
    expect((await repos.businessCalendar.get()).holidays).toEqual(['2027-01-01']);
    await repos.businessCalendar.setHolidays([]);
    expect((await repos.businessCalendar.get()).holidays).toEqual([]);
  });

  it('初期データの営業時間は渡した曜日だけを上書きする', async () => {
    const { repos } = setup({
      calendar: { hours: [{ weekday: 0, open: '12:00', close: '16:00', isClosed: false }], holidays: ['2026-11-03'] },
    });
    const calendar = await repos.businessCalendar.get();
    expect(calendar.hours[0]).toEqual({ weekday: 0, open: '12:00', close: '16:00', isClosed: false });
    expect(calendar.hours[1].open).toBe(DEFAULT_OPEN);
    expect(calendar.holidays).toEqual(['2026-11-03']);
  });

  it('返したカレンダーを書き換えても内部の状態は変わらない', async () => {
    const { repos } = setup();
    const calendar = await repos.businessCalendar.get();
    calendar.hours[0].open = '03:00';
    calendar.holidays.push('2026-01-01');
    const fresh = await repos.businessCalendar.get();
    expect(fresh.hours[0].open).toBe(DEFAULT_OPEN);
    expect(fresh.holidays).toEqual([]);
  });
});

// ---------- webhook_events ----------

describe('webhookEvents', () => {
  it('markIfNew は初回だけ true', async () => {
    const { repos } = setup();
    expect(await repos.webhookEvents.markIfNew('evt-1')).toBe(true);
    expect(await repos.webhookEvents.markIfNew('evt-1')).toBe(false);
    expect(await repos.webhookEvents.markIfNew('evt-2')).toBe(true);
  });
});

// ---------- 初期データ・時計 ----------

describe('初期データと時計', () => {
  it('conversations を渡すと LINE ユーザーも作られ、getOrCreate がその会話を返す', async () => {
    const seeded = setup();
    const created = await seeded.repos.lineUsers.upsert({ lineUserId: 'U1', displayName: 'たろう' });
    const conversation = await seeded.repos.conversations.getOrCreate('U1');

    const { repos } = setup({ conversations: [{ ...conversation, state: 'qa' }] });
    expect((await repos.conversations.getOrCreate(conversation.lineUserId)).state).toBe('qa');
    expect(created.lineUserId).toBe('U1');
  });

  it('messages / viewingRequests を渡せる', async () => {
    const ctx = setup({ properties: [makeProperty('P1')], lineUsers: [{ lineUserId: 'U1' }] });
    const conversation = await ctx.repos.conversations.getOrCreate('U1');
    const message = await ctx.repos.messages.insert({ conversationId: conversation.id, role: 'user', text: 'x' });
    const request = await ctx.repos.viewingRequests.create({ conversationId: conversation.id, propertyId: 'P1', candidateTimes: [], receivedOutsideHours: false });

    const { repos } = setup({
      properties: [makeProperty('P1')],
      conversations: [conversation],
      messages: [message],
      viewingRequests: [request],
    });
    expect(await repos.messages.listByConversation(conversation.id)).toEqual([message]);
    expect((await repos.viewingRequests.getById(request.id))?.id).toBe(request.id);
  });

  it('時計を渡さなければ実時計を使う', async () => {
    const repos = createMemoryRepositories({ lineUsers: [{ lineUserId: 'U1' }] });
    const before = Date.now();
    const conversation = await repos.conversations.getOrCreate('U1');
    expect(Date.parse(conversation.createdAt)).toBeGreaterThanOrEqual(before - 1);
    expect(conversation.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
