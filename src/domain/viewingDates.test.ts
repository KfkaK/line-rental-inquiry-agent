import { describe, expect, it } from 'vitest';
import { fromJst } from './businessHours';
import { alignViewingWeekdays, withAlignedViewingWeekdays } from './viewingDates';

/** 2026-10-18（日）11:30 JST。評価 sc-12 の時刻 */
const SUNDAY = fromJst('2026-10-18', '11:30');

describe('alignViewingWeekdays（内見の候補日の曜日の読み違いを直す。意思決定ログ33）', () => {
  it('「火曜」を水曜の日付にした読み違いを、火曜の日付に直す（時刻は残す。評価 sc-12）', () => {
    expect(alignViewingWeekdays(['2026-10-19T15:00', '2026-10-21T11:00'], '1番目、明日の15時と火曜の11時で見に行きたいです', SUNDAY)).toEqual([
      '2026-10-19T15:00',
      '2026-10-20T11:00',
    ]);
  });

  it('正しく読めていれば変えない', () => {
    const times = ['2026-10-19T15:00', '2026-10-20T11:00'];
    expect(alignViewingWeekdays(times, '明日の15時と火曜の11時で', SUNDAY)).toEqual(times);
  });

  it('曜日の言い回しが無ければ変えない（「明日」だけの食い違いは直さない）', () => {
    expect(alignViewingWeekdays(['2026-10-21T15:00'], '明日の15時で', SUNDAY)).toEqual(['2026-10-21T15:00']);
  });

  it('日付（N月N日・N日）で説明できる候補は変えない', () => {
    expect(alignViewingWeekdays(['2026-10-21T11:00'], '火曜は無理なので、10月21日の11時で', SUNDAY)).toEqual(['2026-10-21T11:00']);
    expect(alignViewingWeekdays(['2026-10-21T11:00'], '火曜は無理なので、21日の11時で', SUNDAY)).toEqual(['2026-10-21T11:00']);
  });

  it('2つの曜日をどちらも読み違えたら、出てきた順に直す', () => {
    expect(alignViewingWeekdays(['2026-10-21', '2026-10-23'], '火曜と木曜の午後', SUNDAY)).toEqual(['2026-10-20', '2026-10-22']);
  });

  it('「来週の火曜」は月曜はじまりの次の週の火曜。曜日が合っていれば週の違いまでは直さない（保守的）', () => {
    expect(alignViewingWeekdays(['2026-10-21T11:00'], '来週の火曜の11時', SUNDAY)).toEqual(['2026-10-20T11:00']);
    expect(alignViewingWeekdays(['2026-10-27T11:00'], '来週の火曜の11時', SUNDAY)).toEqual(['2026-10-27T11:00']);
  });

  it('「週末」は土曜と日曜。使われていないほうの曜日に直す', () => {
    expect(alignViewingWeekdays(['2026-10-24T14:00', '2026-10-25T14:00'], '週末の14時', SUNDAY)).toEqual(['2026-10-24T14:00', '2026-10-25T14:00']);
    expect(alignViewingWeekdays(['2026-10-23T14:00', '2026-10-24T14:00'], '週末の14時', SUNDAY)).toEqual(['2026-10-25T14:00', '2026-10-24T14:00']);
  });

  it('withAlignedViewingWeekdays は変わらなければ同じ結果を返す', () => {
    const result = { intent: 'viewingRequest', viewingTimes: ['2026-10-20T11:00'] };
    expect(withAlignedViewingWeekdays(result, '火曜の11時', SUNDAY)).toBe(result);
    expect(withAlignedViewingWeekdays({ ...result, viewingTimes: ['2026-10-21T11:00'] }, '火曜の11時', SUNDAY).viewingTimes).toEqual(['2026-10-20T11:00']);
  });
});
