import { describe, expect, it, vi } from 'vitest';
import { defaultCalendar, fromJst } from '@/domain/businessHours';
import { makeProperty } from '@/domain/fixtures';
import type { HandoffNote } from '@/domain/types';
import { createMemoryRepositories } from '@/lib/db';
import { createFakeMessenger } from '@/lib/line/messenger';
import {
  confirmViewing,
  rejectViewing,
  resolveHandoff,
  resumeAi,
  saveCalendar,
  sendStaffReply,
  setViewingProgress,
  type StaffDeps,
} from './service';

const USER = 'U-service-user';
/** 木曜 12:00 JST */
const NOW = fromJst('2026-10-08', '12:00');

async function setup(options: { isDemo?: boolean } = {}) {
  let now = NOW.getTime();
  const clock = () => new Date(now);
  const property = makeProperty({ id: 'P1', name: 'ヴィラふじみ' });
  const repos = createMemoryRepositories({ properties: [property], lineUsers: [{ lineUserId: USER, displayName: 'たろう' }] }, { clock });
  let conversation = await repos.conversations.getOrCreate(USER);
  if (options.isDemo) {
    // デモ会話は種まきで作る（リポジトリの patch では is_demo を変えない）
    const seeded = createMemoryRepositories(
      { properties: [property], conversations: [{ ...conversation, isDemo: true }] },
      { clock },
    );
    return finish(seeded, (await seeded.conversations.getById(conversation.id))!);
  }
  return finish(repos, conversation);

  async function finish(r: typeof repos, c: typeof conversation) {
    conversation = c;
    const viewing = await r.viewingRequests.create({
      conversationId: c.id,
      propertyId: 'P1',
      candidateTimes: ['2026-10-10T14:00', '2026-10-11'],
      receivedOutsideHours: true,
    });
    const messenger = createFakeMessenger();
    const deps: StaffDeps = { repos: r, messenger, clock };
    return {
      deps,
      repos: r,
      messenger,
      conversation: c,
      viewing,
      advance: (ms: number) => {
        now += ms;
      },
      staffMessages: async () => (await r.messages.listByConversation(c.id)).filter((m) => m.role === 'staff').map((m) => m.text),
    };
  }
}

const pushedTexts = (messenger: ReturnType<typeof createFakeMessenger>) =>
  messenger.pushes.flatMap((p) => p.messages.map((m) => (m.type === 'text' ? m.text : m.type)));

describe('confirmViewing', () => {
  it('候補の日付と担当者の時刻で確定し、利用者へ LINE で知らせて会話ログに残す', async () => {
    const { deps, repos, messenger, viewing, staffMessages } = await setup();
    const result = await confirmViewing(deps, { viewingRequestId: viewing.id, candidate: '2026-10-11', time: '10:30', note: '' });
    expect(result).toEqual({ ok: true, message: '10月11日(日) 10:30 で確定しました。LINE でお知らせしました。' });
    expect(await repos.viewingRequests.getById(viewing.id)).toMatchObject({ status: 'confirmed', confirmedTime: '2026-10-11T10:30', staffNote: null });
    expect(messenger.pushes).toHaveLength(1);
    expect(messenger.pushes[0].to).toBe(USER);
    const [text] = pushedTexts(messenger);
    expect(text).toContain('「ヴィラふじみ」の内見日時が確定しました');
    expect(text).toContain('10月11日(日) 10:30');
    expect(await staffMessages()).toEqual([text]);
  });

  it('ひとことを添えると保存して文に入れる。AI は止めない（止めるのは手動返信だけ）', async () => {
    const { deps, repos, messenger, viewing, conversation } = await setup();
    await confirmViewing(deps, { viewingRequestId: viewing.id, candidate: '2026-10-10T14:00', time: '', note: '鍵は店舗でお渡しします。' });
    expect((await repos.viewingRequests.getById(viewing.id))?.staffNote).toBe('鍵は店舗でお渡しします。');
    expect(pushedTexts(messenger)[0]).toContain('鍵は店舗でお渡しします。');
    expect((await repos.conversations.getById(conversation.id))?.aiPaused).toBe(false);
  });

  it('営業時間外の時刻・休業日は確定させず（送らない）、手動返信での調整を案内する', async () => {
    const { deps, repos, messenger, viewing } = await setup();
    const result = await confirmViewing(deps, { viewingRequestId: viewing.id, candidate: '2026-10-11', time: '05:05', note: '' });
    expect(result).toEqual({
      ok: false,
      error: '10月11日(日)の営業時間は 10:00〜19:00 です。営業時間外の内見は、会話ログの手動返信で利用者と調整してください。',
    });
    // 営業カレンダーは確定の時点の DB の設定で判定する（受付の後に休業日を足した場合）
    await repos.businessCalendar.setHolidays(['2026-10-11']);
    expect(await confirmViewing(deps, { viewingRequestId: viewing.id, candidate: '2026-10-11', time: '14:00', note: '' })).toMatchObject({ ok: false });
    expect((await repos.viewingRequests.getById(viewing.id))?.status).toBe('pending');
    expect(messenger.pushes).toEqual([]);
  });

  it('時刻の不足・候補に無い日は何も保存せず送らない', async () => {
    const { deps, repos, messenger, viewing } = await setup();
    expect(await confirmViewing(deps, { viewingRequestId: viewing.id, candidate: '2026-10-11', time: '', note: '' })).toMatchObject({ ok: false });
    expect(await confirmViewing(deps, { viewingRequestId: viewing.id, candidate: '2026-10-12', time: '10:00', note: '' })).toMatchObject({ ok: false });
    expect((await repos.viewingRequests.getById(viewing.id))?.status).toBe('pending');
    expect(messenger.pushes).toEqual([]);
  });

  it('確定・却下済みは確定し直せない（二重送信もしない）。無い ID は断る', async () => {
    const { deps, messenger, viewing } = await setup();
    await confirmViewing(deps, { viewingRequestId: viewing.id, candidate: '2026-10-11', time: '10:00', note: '' });
    const again = await confirmViewing(deps, { viewingRequestId: viewing.id, candidate: '2026-10-11', time: '11:00', note: '' });
    expect(again).toEqual({ ok: false, error: 'この仮受付はすでに「確定」のため、「確定」にできません。' });
    expect(messenger.pushes).toHaveLength(1);
    expect(await confirmViewing(deps, { viewingRequestId: 'nope', candidate: '2026-10-11', time: '10:00', note: '' })).toMatchObject({ ok: false });
  });

  it('LINE への送信に失敗しても確定は保存し（ok で画面を読み直させる）、手動返信で伝えるよう返す（会話ログには残さない）', async () => {
    const { deps, repos, messenger, viewing, staffMessages } = await setup();
    messenger.failPushWith = new Error('429');
    const result = await confirmViewing(deps, { viewingRequestId: viewing.id, candidate: '2026-10-11', time: '10:00', note: '' });
    expect(result).toEqual({
      ok: true,
      message: '確定は保存しました。ただし LINE への送信に失敗しました。お手数ですが、会話ログの手動返信でお伝えください。',
    });
    expect((await repos.viewingRequests.getById(viewing.id))?.status).toBe('confirmed');
    expect(await staffMessages()).toEqual([]);
  });

  it('2つのタブで同時に確定しても片方だけ通し、LINE には1通だけ送る', async () => {
    const { deps, repos, messenger, viewing } = await setup();
    const [a, b] = await Promise.all([
      confirmViewing(deps, { viewingRequestId: viewing.id, candidate: '2026-10-11', time: '10:00', note: '' }),
      confirmViewing(deps, { viewingRequestId: viewing.id, candidate: '2026-10-11', time: '15:00', note: '' }),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(messenger.pushes).toHaveLength(1);
    const winner = a.ok ? '2026-10-11T10:00' : '2026-10-11T15:00';
    expect((await repos.viewingRequests.getById(viewing.id))?.confirmedTime).toBe(winner);
    expect(pushedTexts(messenger)[0]).toContain(winner.endsWith('10:00') ? '10:00' : '15:00');
  });

  it('LINE に送れた後に会話ログへの保存だけ失敗しても、送れた扱いにする（担当者に送り直させない）', async () => {
    const { deps, messenger, viewing } = await setup();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    deps.repos.messages.insert = async () => {
      throw new Error('timeout');
    };
    const result = await confirmViewing(deps, { viewingRequestId: viewing.id, candidate: '2026-10-11', time: '10:00', note: '' });
    expect(result).toMatchObject({ ok: true, message: '10月11日(日) 10:00 で確定しました。LINE でお知らせしました。' });
    expect(messenger.pushes).toHaveLength(1);
    spy.mockRestore();
  });

  it('デモ会話は LINE に送らず、会話ログにだけ残す', async () => {
    const { deps, messenger, viewing, staffMessages } = await setup({ isDemo: true });
    const result = await confirmViewing(deps, { viewingRequestId: viewing.id, candidate: '2026-10-11', time: '10:00', note: '' });
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.message).toContain('LINE には送っていません');
    expect(messenger.pushes).toEqual([]);
    expect(await staffMessages()).toHaveLength(1);
  });

  it('DB の想定外の失敗は投げずに一般的な文で返す', async () => {
    const { deps, viewing } = await setup();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    deps.repos.viewingRequests.transition = async () => {
      throw new Error('connection reset');
    };
    const result = await confirmViewing(deps, { viewingRequestId: viewing.id, candidate: '2026-10-11', time: '10:00', note: '' });
    expect(result).toEqual({ ok: false, error: '保存に失敗しました。時間をおいてもう一度お試しください。' });
    spy.mockRestore();
  });
});

describe('rejectViewing と setViewingProgress', () => {
  it('却下は理由が必須で、理由を保存して利用者へ送る', async () => {
    const { deps, repos, messenger, viewing } = await setup();
    expect(await rejectViewing(deps, { viewingRequestId: viewing.id, reason: '  ' })).toMatchObject({ ok: false });
    expect(messenger.pushes).toEqual([]);
    const result = await rejectViewing(deps, { viewingRequestId: viewing.id, reason: 'その日は先約があります。' });
    expect(result).toEqual({ ok: true, message: '却下しました。LINE でお知らせしました。' });
    expect(await repos.viewingRequests.getById(viewing.id)).toMatchObject({ status: 'rejected', staffNote: 'その日は先約があります。' });
    expect(pushedTexts(messenger)[0]).toContain('その日は先約があります。');
  });

  it('未対応 ⇄ 対応中は送らずに印だけ変える。却下の後は変えられない', async () => {
    const { deps, repos, messenger, viewing } = await setup();
    expect(await setViewingProgress(deps, { viewingRequestId: viewing.id, status: 'in_progress' })).toEqual({ ok: true, message: '「対応中」にしました。' });
    expect((await repos.viewingRequests.getById(viewing.id))?.status).toBe('in_progress');
    expect(await setViewingProgress(deps, { viewingRequestId: viewing.id, status: 'in_progress' })).toMatchObject({ ok: false });
    await setViewingProgress(deps, { viewingRequestId: viewing.id, status: 'pending' });
    await rejectViewing(deps, { viewingRequestId: viewing.id, reason: '満室' });
    expect(await setViewingProgress(deps, { viewingRequestId: viewing.id, status: 'pending' })).toMatchObject({ ok: false });
    expect(messenger.pushes).toHaveLength(1);
  });
});

describe('sendStaffReply と resumeAi', () => {
  it('手動返信は AI を止めてから送り、担当者の返信として残す', async () => {
    const { deps, repos, messenger, conversation, staffMessages } = await setup();
    const result = await sendStaffReply(deps, { conversationId: conversation.id, text: ' お名前を教えてください。 ' });
    expect(result).toMatchObject({ ok: true });
    expect(pushedTexts(messenger)).toEqual(['お名前を教えてください。']);
    expect(await staffMessages()).toEqual(['お名前を教えてください。']);
    expect(await repos.conversations.getById(conversation.id)).toMatchObject({
      aiPaused: true,
      pausedAt: NOW.toISOString(),
      lastStaffReplyAt: NOW.toISOString(),
    });
  });

  it('止めている間の2通目は pausedAt を保ち、lastStaffReplyAt だけ進める（24時間の自動再開の起点）', async () => {
    const { deps, repos, conversation, advance } = await setup();
    await sendStaffReply(deps, { conversationId: conversation.id, text: '1通目' });
    advance(60 * 60 * 1000);
    await sendStaffReply(deps, { conversationId: conversation.id, text: '2通目' });
    expect(await repos.conversations.getById(conversation.id)).toMatchObject({
      pausedAt: NOW.toISOString(),
      lastStaffReplyAt: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
    });
  });

  it('空の返信は断り、送信に失敗したら AI は止めたままで知らせる', async () => {
    const { deps, repos, messenger, conversation, staffMessages } = await setup();
    expect(await sendStaffReply(deps, { conversationId: conversation.id, text: '' })).toMatchObject({ ok: false });
    expect((await repos.conversations.getById(conversation.id))?.aiPaused).toBe(false);
    messenger.failPushWith = new Error('network');
    const result = await sendStaffReply(deps, { conversationId: conversation.id, text: 'こんにちは' });
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toContain('AI は止めたまま');
    // 届いていない返信は 24 時間の自動再開の起点にしない
    expect(await repos.conversations.getById(conversation.id)).toMatchObject({ aiPaused: true, lastStaffReplyAt: null });
    expect(await staffMessages()).toEqual([]);
  });

  it('AIに戻すと pausedAt を消す。動いている会話には何もしない', async () => {
    const { deps, repos, conversation } = await setup();
    expect(await resumeAi(deps, { conversationId: conversation.id })).toEqual({ ok: true, message: 'AI の自動応答はすでに動いています。' });
    await sendStaffReply(deps, { conversationId: conversation.id, text: 'x' });
    expect(await resumeAi(deps, { conversationId: conversation.id })).toEqual({ ok: true, message: 'AI の自動応答を再開しました。' });
    expect(await repos.conversations.getById(conversation.id)).toMatchObject({ aiPaused: false, pausedAt: null });
    expect(await resumeAi(deps, { conversationId: 'nope' })).toMatchObject({ ok: false });
  });
});

describe('resolveHandoff', () => {
  const note = (text: string): HandoffNote => ({ text, topic: 'vacancy', propertyIds: ['P1'], at: NOW.toISOString() });

  it('見た件数まで対応済みにし、見た後に届いたメモは残す', async () => {
    const { deps, repos, conversation } = await setup();
    await repos.conversations.update(conversation.id, { handoffNotes: [note('a'), note('b'), note('c')] });
    expect(await resolveHandoff(deps, { conversationId: conversation.id, seen: 2 })).toEqual({
      ok: true,
      message: '対応済みにしました（このあと届いたメモが 1 件あります）。',
    });
    expect((await repos.conversations.getById(conversation.id))?.handoffResolvedCount).toBe(2);
    expect(await resolveHandoff(deps, { conversationId: conversation.id, seen: 2 })).toEqual({ ok: true, message: '対応済みにするメモはありません。' });
    expect(await resolveHandoff(deps, { conversationId: conversation.id, seen: 3 })).toEqual({ ok: true, message: '対応済みにしました。' });
    expect(await repos.conversations.listWithOpenHandoff()).toEqual([]);
  });
});

describe('saveCalendar', () => {
  it('検証を通った設定だけを保存する', async () => {
    const { deps, repos } = await setup();
    const calendar = defaultCalendar();
    const next = {
      hours: calendar.hours.map((h) => (h.weekday === 2 ? { ...h, isClosed: true } : h)),
      holidays: ['2026-10-12'],
    };
    expect(await saveCalendar(deps, next)).toMatchObject({ ok: true });
    expect(await repos.businessCalendar.get()).toEqual(next);

    const broken = { ...next, hours: next.hours.map((h) => (h.weekday === 1 ? { ...h, open: '20:00' } : h)) };
    expect(await saveCalendar(deps, broken)).toEqual({ ok: false, error: '月曜日は開店を閉店より前にしてください。' });
    expect(await repos.businessCalendar.get()).toEqual(next);
  });
});
