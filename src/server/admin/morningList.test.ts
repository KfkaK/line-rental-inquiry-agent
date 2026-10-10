import { describe, expect, it } from 'vitest';
import { defaultCalendar, fromJst } from '@/domain/businessHours';
import { makeProperty } from '@/domain/fixtures';
import type { HandoffNote } from '@/domain/types';
import { createMemoryRepositories, type ConversationSummary, type ViewingRequestListItem } from '@/lib/db';
import { buildMorningList, loadMorningList } from './morningList';

/** 木曜 9:00 JST。前回の営業終了は火曜 19:00（水曜定休） */
const MORNING = fromJst('2026-10-08', '09:00');
const SINCE = fromJst('2026-10-06', '19:00');

const iso = (date: string, time: string) => fromJst(date, time).toISOString();
const note = (text: string, at: string): HandoffNote => ({ text, topic: 'vacancy', propertyIds: [], at });

function viewing(id: string, conversationId: string, createdAt: string, status: ViewingRequestListItem['status'] = 'pending'): ViewingRequestListItem {
  return {
    id,
    conversationId,
    propertyId: 'P1',
    candidateTimes: ['2026-10-09'],
    status,
    confirmedTime: null,
    staffNote: null,
    receivedOutsideHours: true,
    createdAt,
    updatedAt: createdAt,
    displayName: null,
    propertyName: 'ヴィラふじみ',
    handoffNotes: [],
    handoffResolvedCount: 0,
    isDemo: false,
  };
}

function conversation(id: string, notes: HandoffNote[], resolved = 0): ConversationSummary {
  return {
    id,
    state: 'qa',
    slots: { tags: [] },
    shownPropertyIds: [],
    shownOffset: 0,
    lastSearchTotal: null,
    priorityAskedCount: 0,
    aiPaused: false,
    pausedAt: null,
    lastStaffReplyAt: null,
    booking: null,
    handoffNotes: notes,
    handoffResolvedCount: resolved,
    isDemo: false,
    createdAt: notes[0]?.at ?? SINCE.toISOString(),
    updatedAt: notes.at(-1)?.at ?? SINCE.toISOString(),
    displayName: 'たろう',
  };
}

const ids = (items: ReturnType<typeof buildMorningList>['overnight']) =>
  items.map((i) => (i.kind === 'viewing' ? `v:${i.viewing.id}` : `h:${i.conversation.id}`));

describe('buildMorningList', () => {
  it('前回の営業終了以降を夜間・休日分に、それより前は担当者の手が要るものだけを残し、どちらも届いた順に', () => {
    const list = buildMorningList({
      since: SINCE,
      viewings: [
        viewing('v-late', 'c1', iso('2026-10-07', '23:00')),
        viewing('v-night-done', 'c2', iso('2026-10-06', '22:00'), 'confirmed'),
        viewing('v-old-open', 'c3', iso('2026-10-05', '12:00'), 'in_progress'),
        viewing('v-old-done', 'c4', iso('2026-10-05', '13:00'), 'rejected'),
        // 同じ仮受付が「以降」と「未対応」の両方の取得に入っても1行
        viewing('v-late', 'c1', iso('2026-10-07', '23:00')),
      ],
      handoffConversations: [conversation('c5', [note('治安は？', iso('2026-10-07', '01:00'))])],
    });
    expect(list.since).toBe(SINCE.toISOString());
    expect(ids(list.overnight)).toEqual(['v:v-night-done', 'h:c5', 'v:v-late']);
    expect(ids(list.earlier)).toEqual(['v:v-old-open']);
  });

  it('未対応のメモは会話の最新の仮受付の行にだけ載せ、対応済みのメモは出さない', () => {
    const notes = [note('a', iso('2026-10-06', '20:00')), note('b', iso('2026-10-06', '21:00')), note('c', iso('2026-10-07', '02:00'))];
    const list = buildMorningList({
      since: SINCE,
      viewings: [viewing('v1', 'c1', iso('2026-10-06', '20:30')), viewing('v2', 'c1', iso('2026-10-07', '03:00'))],
      handoffConversations: [conversation('c1', notes, 1)],
    });
    expect(ids(list.overnight)).toEqual(['v:v1', 'v:v2']);
    expect(list.overnight[0].openNotes).toEqual([]);
    expect(list.overnight[1].openNotes.map((n) => n.text)).toEqual(['b', 'c']);
  });

  it('仮受付が「それ以前」にしか無い会話に夜間のメモが届いたら、夜間・休日分に別の行で出す', () => {
    const list = buildMorningList({
      since: SINCE,
      viewings: [viewing('v-old', 'c1', iso('2026-10-05', '12:00'))],
      handoffConversations: [conversation('c1', [note('空いてますか', iso('2026-10-07', '22:00'))])],
    });
    expect(ids(list.overnight)).toEqual(['h:c1']);
    expect(ids(list.earlier)).toEqual(['v:v-old']);
    expect(list.earlier[0].openNotes).toEqual([]);
  });

  it('それ以前のメモは、それ以前の仮受付の行に載る。メモが全部対応済みの会話は出さない', () => {
    const list = buildMorningList({
      since: SINCE,
      viewings: [viewing('v-old', 'c1', iso('2026-10-05', '12:00'))],
      handoffConversations: [
        conversation('c1', [note('初期費用は？', iso('2026-10-05', '11:00'))]),
        conversation('c2', [note('済み', iso('2026-10-07', '22:00'))], 1),
      ],
    });
    expect(list.overnight).toEqual([]);
    expect(ids(list.earlier)).toEqual(['v:v-old']);
    expect(list.earlier[0].openNotes.map((n) => n.text)).toEqual(['初期費用は？']);
  });
});

describe('loadMorningList', () => {
  it('営業カレンダーから前回の営業終了を求め、リポジトリから集める', async () => {
    let now = fromJst('2026-10-06', '22:00').getTime();
    const repos = createMemoryRepositories(
      { properties: [makeProperty({ id: 'P1', name: 'ヴィラふじみ' })], lineUsers: [{ lineUserId: 'U1', displayName: 'たろう' }, { lineUserId: 'U2' }] },
      { clock: () => new Date(now) },
    );
    const c1 = await repos.conversations.getOrCreate('U1');
    const c2 = await repos.conversations.getOrCreate('U2');
    const v = await repos.viewingRequests.create({ conversationId: c1.id, propertyId: 'P1', candidateTimes: ['2026-10-08'], receivedOutsideHours: true });
    now = fromJst('2026-10-07', '01:00').getTime();
    await repos.conversations.update(c2.id, { handoffNotes: [note('騒音は？', new Date(now).toISOString())] });

    const list = await loadMorningList(repos, MORNING);
    expect(list.since).toBe(SINCE.toISOString());
    expect(ids(list.overnight)).toEqual([`v:${v.id}`, `h:${c2.id}`]);
    expect(list.overnight[0].kind === 'viewing' && list.overnight[0].viewing.displayName).toBe('たろう');

    // カレンダーを渡せばそれを使う（水曜も営業なら前回の営業終了は水曜 19:00）
    const open = defaultCalendar();
    const everyDay = { ...open, hours: open.hours.map((h) => ({ ...h, isClosed: false })) };
    expect((await loadMorningList(repos, MORNING, everyDay)).since).toBe(fromJst('2026-10-07', '19:00').toISOString());
  });
});
