import { describe, expect, it } from 'vitest';
import {
  defaultCalendar,
  formatJstDay,
  fromJst,
  isBusinessDay,
  isOpenAt,
  nextContactDay,
  previousClose,
  toJst,
  viewingCandidateDays,
} from './businessHours';

// 2026-10-07 は水曜（既定の定休日）、10-08 木、10-09 金、10-10 土、10-11 日、10-12 月（スポーツの日）
const cal = defaultCalendar();
const jst = (date: string, time: string) => fromJst(date, time);

describe('JST の変換', () => {
  it('UTC 15:00 は JST の翌日 0:00', () => {
    expect(toJst(new Date('2026-10-07T15:00:00Z'))).toEqual({ date: '2026-10-08', time: '00:00', weekday: 4 });
  });

  it('fromJst と toJst は往復する', () => {
    expect(toJst(jst('2026-10-08', '09:30'))).toEqual({ date: '2026-10-08', time: '09:30', weekday: 4 });
  });

  it('formatJstDay', () => {
    expect(formatJstDay('2026-10-08')).toBe('10月8日(木)');
  });
});

describe('営業時間の判定（既定: 10〜19時・水曜定休）', () => {
  it('水曜は休み、木曜は営業日', () => {
    expect(isBusinessDay('2026-10-07', cal)).toBe(false);
    expect(isBusinessDay('2026-10-08', cal)).toBe(true);
  });

  it('開店ちょうどは営業中、閉店ちょうどは時間外', () => {
    expect(isOpenAt(jst('2026-10-08', '09:59'), cal)).toBe(false);
    expect(isOpenAt(jst('2026-10-08', '10:00'), cal)).toBe(true);
    expect(isOpenAt(jst('2026-10-08', '18:59'), cal)).toBe(true);
    expect(isOpenAt(jst('2026-10-08', '19:00'), cal)).toBe(false);
  });

  it('休業日リスト（祝日）は休み', () => {
    const withHoliday = { ...cal, holidays: ['2026-10-12'] };
    expect(isBusinessDay('2026-10-12', withHoliday)).toBe(false);
    expect(isOpenAt(jst('2026-10-12', '12:00'), withHoliday)).toBe(false);
  });
});

describe('連絡日と内見候補日', () => {
  it('火曜の深夜 → 水曜定休なので木曜に連絡', () => {
    expect(nextContactDay(jst('2026-10-06', '23:30'), cal)).toBe('2026-10-08');
  });

  it('営業日の開店前なら当日に連絡', () => {
    expect(nextContactDay(jst('2026-10-08', '08:00'), cal)).toBe('2026-10-08');
  });

  it('営業日の閉店後なら次の営業日', () => {
    expect(nextContactDay(jst('2026-10-08', '19:00'), cal)).toBe('2026-10-09');
  });

  it('内見候補日は翌営業日から（当日と定休日を含めない）', () => {
    expect(viewingCandidateDays(jst('2026-10-06', '12:00'), cal, 3)).toEqual(['2026-10-08', '2026-10-09', '2026-10-10']);
  });

  it('祝日を飛ばす', () => {
    const withHoliday = { ...cal, holidays: ['2026-10-12'] };
    expect(viewingCandidateDays(jst('2026-10-10', '12:00'), withHoliday, 2)).toEqual(['2026-10-11', '2026-10-13']);
  });

  it('全曜日が休みの設定では例外（無限ループしない）', () => {
    const closed = { hours: cal.hours.map((h) => ({ ...h, isClosed: true })), holidays: [] };
    expect(() => nextContactDay(jst('2026-10-08', '12:00'), closed)).toThrow();
  });
});

describe('previousClose（朝の引き継ぎ一覧の起点）', () => {
  it('木曜の朝 → 火曜 19:00（水曜は定休）', () => {
    expect(previousClose(jst('2026-10-08', '09:00'), cal).toISOString()).toBe(jst('2026-10-06', '19:00').toISOString());
  });

  it('営業時間中 → 前の営業日の閉店', () => {
    expect(previousClose(jst('2026-10-09', '12:00'), cal).toISOString()).toBe(jst('2026-10-08', '19:00').toISOString());
  });

  it('閉店後 → 当日の閉店', () => {
    expect(previousClose(jst('2026-10-09', '21:00'), cal).toISOString()).toBe(jst('2026-10-09', '19:00').toISOString());
  });
});
