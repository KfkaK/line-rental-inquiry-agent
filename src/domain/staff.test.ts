import { describe, expect, it } from 'vitest';
import { defaultCalendar, fromJst } from './businessHours';
import { viewingConfirmed, viewingRejected } from './messages';
import { STAFF_NOTE_MAX_CHARS, STAFF_REPLY_MAX_CHARS } from './rules';
import {
  VIEWING_STATUS_LABEL,
  canTransition,
  checkConfirmNote,
  checkRejectReason,
  checkStaffReply,
  isOpenViewing,
  nextResolvedCount,
  openHandoffNotes,
  resolveConfirmedTime,
  validateCalendar,
} from './staff';
import { VIEWING_STATUSES, type BusinessCalendar, type HandoffNote } from './types';

/** 木曜 12:00 JST */
const NOW = fromJst('2026-10-08', '12:00');

describe('内見の仮受付の状態', () => {
  it('未対応・対応中からは確定・却下へ進め、未対応 ⇄ 対応中は行き来できる', () => {
    expect(canTransition('pending', 'in_progress')).toBe(true);
    expect(canTransition('in_progress', 'pending')).toBe(true);
    expect(canTransition('pending', 'confirmed')).toBe(true);
    expect(canTransition('in_progress', 'rejected')).toBe(true);
  });

  it('確定・却下は終わり（LINE で知らせた後なので戻さない）。同じ状態への遷移もしない', () => {
    for (const to of VIEWING_STATUSES) {
      expect(canTransition('confirmed', to)).toBe(false);
      expect(canTransition('rejected', to)).toBe(false);
    }
    expect(canTransition('pending', 'pending')).toBe(false);
  });

  it('担当者の手が要るのは未対応と対応中。表示名がすべての状態にある', () => {
    expect(VIEWING_STATUSES.filter(isOpenViewing)).toEqual(['pending', 'in_progress']);
    expect(VIEWING_STATUSES.map((s) => VIEWING_STATUS_LABEL[s])).toEqual(['未対応', '対応中', '確定', '却下']);
  });
});

describe('resolveConfirmedTime', () => {
  const candidates = ['2026-10-10T14:00', '2026-10-11'];
  /** 既定: 毎日 10:00〜19:00・水曜定休（2026-10-10 は土曜、10-11 は日曜） */
  const cal = defaultCalendar();
  const guide = '営業時間外の内見は、会話ログの手動返信で利用者と調整してください。';

  it('候補の日付に担当者の時刻を付ける。候補に時刻があって空欄なら候補の時刻', () => {
    expect(resolveConfirmedTime(candidates, '2026-10-11', '10:30', cal)).toEqual({ ok: true, value: '2026-10-11T10:30' });
    expect(resolveConfirmedTime(candidates, '2026-10-10T14:00', '', cal)).toEqual({ ok: true, value: '2026-10-10T14:00' });
    expect(resolveConfirmedTime(candidates, '2026-10-10T14:00', ' 15:00 ', cal)).toEqual({ ok: true, value: '2026-10-10T15:00' });
  });

  it('候補に無い日・日付だけの候補で時刻なし・形の崩れた時刻は断る', () => {
    expect(resolveConfirmedTime(candidates, '2026-10-12', '10:00', cal)).toMatchObject({ ok: false });
    expect(resolveConfirmedTime(candidates, '2026-10-11', '', cal)).toEqual({ ok: false, error: '時刻を入れてください（候補が日付だけのため）。' });
    expect(resolveConfirmedTime(candidates, '2026-10-11', '25:00', cal)).toMatchObject({ ok: false });
    expect(resolveConfirmedTime(candidates, '2026-10-11', '9:00', cal)).toMatchObject({ ok: false });
    expect(resolveConfirmedTime(['あした'], 'あした', '10:00', cal)).toMatchObject({ ok: false });
  });

  it('営業時間外の時刻は確定させず、手動返信での調整を案内する（午前・午後の取り違えを止める）', () => {
    expect(resolveConfirmedTime(candidates, '2026-10-11', '05:05', cal)).toEqual({
      ok: false,
      error: `10月11日(日)の営業時間は 10:00〜19:00 です。${guide}`,
    });
    // 候補の時刻そのものが時間外でも、空欄のまま押せば候補の時刻で判定して断る
    expect(resolveConfirmedTime(['2026-10-10T21:00'], '2026-10-10T21:00', '', cal)).toMatchObject({ ok: false });
  });

  it('境界は isOpenAt と同じ: 開店ちょうどは可、閉店ちょうどは不可、閉店間際は可', () => {
    expect(resolveConfirmedTime(candidates, '2026-10-11', '10:00', cal)).toMatchObject({ ok: true });
    expect(resolveConfirmedTime(candidates, '2026-10-11', '09:59', cal)).toMatchObject({ ok: false });
    expect(resolveConfirmedTime(candidates, '2026-10-11', '18:59', cal)).toMatchObject({ ok: true });
    expect(resolveConfirmedTime(candidates, '2026-10-11', '19:00', cal)).toMatchObject({ ok: false });
  });

  it('いまの設定でその日が休業日（定休日・後から足した休業日）なら断る', () => {
    expect(resolveConfirmedTime(['2026-10-14'], '2026-10-14', '14:00', cal)).toEqual({
      ok: false,
      error: `10月14日(水)は休業日の設定です。${guide}`,
    });
    expect(resolveConfirmedTime(candidates, '2026-10-11', '14:00', { ...cal, holidays: ['2026-10-11'] })).toMatchObject({ ok: false });
    // 営業時間を変えたら、いまの設定で判定する
    const late = { ...cal, hours: cal.hours.map((h) => (h.weekday === 0 ? { ...h, open: '12:00', close: '21:00' } : h)) };
    expect(resolveConfirmedTime(candidates, '2026-10-11', '10:30', late)).toMatchObject({ ok: false });
    expect(resolveConfirmedTime(candidates, '2026-10-11', '20:00', late)).toMatchObject({ ok: true });
  });
});

describe('担当者が書く文', () => {
  it('前後の空白を落とす。返信と却下の理由は必須、確定のひとことは任意', () => {
    expect(checkStaffReply('  こんにちは \n')).toEqual({ ok: true, value: 'こんにちは' });
    expect(checkStaffReply('   ')).toMatchObject({ ok: false });
    expect(checkRejectReason('')).toMatchObject({ ok: false });
    expect(checkConfirmNote('')).toEqual({ ok: true, value: '' });
  });

  it('字数の上限（rules.ts）を超えたら断り、いまの字数を添える', () => {
    expect(checkStaffReply('あ'.repeat(STAFF_REPLY_MAX_CHARS))).toMatchObject({ ok: true });
    const over = checkStaffReply('あ'.repeat(STAFF_REPLY_MAX_CHARS + 1));
    expect(over).toMatchObject({ ok: false });
    expect(!over.ok && over.error).toContain(`${STAFF_REPLY_MAX_CHARS + 1}字`);
    expect(checkRejectReason('い'.repeat(STAFF_NOTE_MAX_CHARS + 1))).toMatchObject({ ok: false });
  });

  it('確定・却下の LINE の文は担当者からと分かり、日時を読める形にする', () => {
    const confirmed = viewingConfirmed('ヴィラふじみ', '2026-10-10T14:00', '');
    expect(confirmed).toContain('【担当者より】');
    expect(confirmed).toContain('10月10日(土) 14:00');
    expect(confirmed).not.toContain('\n\n\n');
    expect(viewingConfirmed('ヴィラふじみ', '2026-10-10T14:00', '鍵は店舗でお渡しします。')).toContain('鍵は店舗でお渡しします。');
    const rejected = viewingRejected('ヴィラふじみ', 'その日は先約があります。');
    expect(rejected).toContain('【担当者より】');
    expect(rejected).toContain('その日は先約があります。');
  });
});

describe('引き継ぎメモの対応済み', () => {
  const note = (text: string): HandoffNote => ({ text, topic: null, propertyIds: [], at: '2026-10-07T00:00:00.000Z' });
  const notes = [note('a'), note('b'), note('c')];

  it('先頭から resolvedCount 件が対応済みで、残りが未対応', () => {
    expect(openHandoffNotes(notes, 0).map((n) => n.text)).toEqual(['a', 'b', 'c']);
    expect(openHandoffNotes(notes, 2).map((n) => n.text)).toEqual(['c']);
    expect(openHandoffNotes(notes, 5)).toEqual([]);
    expect(openHandoffNotes(notes, -1)).toHaveLength(3);
  });

  it('対応済みにする件数は見た件数まで。いまの件数を超えず、減らさない', () => {
    // 2件見て押した後に3件目が届いていても、3件目は未対応のまま
    expect(nextResolvedCount(0, 2, 3)).toBe(2);
    expect(nextResolvedCount(0, 9, 3)).toBe(3);
    expect(nextResolvedCount(2, 1, 3)).toBe(2);
    expect(nextResolvedCount(0, -4, 3)).toBe(0);
    expect(nextResolvedCount(0, 1.7, 3)).toBe(1);
  });
});

describe('validateCalendar', () => {
  it('既定の営業カレンダーは通る', () => {
    expect(validateCalendar(defaultCalendar(), NOW)).toMatchObject({ ok: true });
  });

  it('開店が閉店より後・時刻の形の崩れ・曜日の欠けや重複は断る（休みの曜日は時刻を見ない）', () => {
    const base = defaultCalendar();
    const withRow = (weekday: number, patch: Partial<BusinessCalendar['hours'][number]>): BusinessCalendar => ({
      ...base,
      hours: base.hours.map((h) => (h.weekday === weekday ? { ...h, ...patch } : h)),
    });
    expect(validateCalendar(withRow(1, { open: '19:00', close: '10:00' }), NOW)).toEqual({
      ok: false,
      error: '月曜日は開店を閉店より前にしてください。',
    });
    expect(validateCalendar(withRow(1, { open: '9:00' }), NOW)).toMatchObject({ ok: false });
    expect(validateCalendar(withRow(3, { open: '', close: '' }), NOW)).toMatchObject({ ok: true });
    expect(validateCalendar({ ...base, hours: base.hours.slice(1) }, NOW)).toMatchObject({ ok: false });
    expect(validateCalendar({ ...base, hours: [...base.hours.slice(1), base.hours[1]] }, NOW)).toMatchObject({ ok: false });
  });

  it('営業日が無い・休業日が続きすぎて翌営業日が決められない設定は断る（Webhook の返信が止まるため）', () => {
    const base = defaultCalendar();
    expect(validateCalendar({ ...base, hours: base.hours.map((h) => ({ ...h, isClosed: true })) }, NOW)).toEqual({
      ok: false,
      error: '営業日が1日もありません。',
    });
    const days = Array.from({ length: 90 }, (_, i) => new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10));
    expect(validateCalendar({ ...base, holidays: days }, NOW)).toMatchObject({ ok: false });
    expect(validateCalendar({ ...base, holidays: ['2026/10/12'] }, NOW)).toMatchObject({ ok: false });
  });
});
