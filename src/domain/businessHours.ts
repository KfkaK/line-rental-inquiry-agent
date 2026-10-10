/**
 * 営業時間の判定（純関数。DESIGN.md 2.1「営業時間の認識」・2.2「朝の引き継ぎ一覧」）。
 * 現在時刻は引数で受け取り、すべて JST で解釈する（サーバーは UTC で動く）。
 * 日付は 'YYYY-MM-DD'、時刻は 'HH:MM' の文字列で扱う。
 */
import { DEFAULT_CLOSE, DEFAULT_CLOSED_WEEKDAYS, DEFAULT_OPEN, TIMEZONE_OFFSET_MINUTES } from './rules';
import type { BusinessCalendar, BusinessHoursRow } from './types';

const OFFSET_MS = TIMEZONE_OFFSET_MINUTES * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** 営業日を探す上限（全曜日が休みの設定で無限ループしないため） */
const SEARCH_LIMIT_DAYS = 60;
const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

export interface JstParts {
  /** 'YYYY-MM-DD' */
  date: string;
  /** 'HH:MM' */
  time: string;
  /** 0=日 … 6=土 */
  weekday: number;
}

export function toJst(instant: Date): JstParts {
  const t = new Date(instant.getTime() + OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`,
    time: `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`,
    weekday: t.getUTCDay(),
  };
}

/** JST の年（築年数の計算に使う） */
export function jstYear(instant: Date): number {
  return Number(toJst(instant).date.slice(0, 4));
}

/** JST の日付と時刻 → その瞬間 */
export function fromJst(date: string, time: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - OFFSET_MS);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + days * DAY_MS);
  return t.toISOString().slice(0, 10);
}

export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** '2026-10-08' → '10月8日(木)' */
export function formatJstDay(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${m}月${d}日(${WEEKDAY_JA[weekdayOf(date)]})`;
}

/** 既定の営業カレンダー（平日・土日 10〜19時、水曜定休、祝日なし） */
export function defaultCalendar(): BusinessCalendar {
  const hours: BusinessHoursRow[] = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    open: DEFAULT_OPEN,
    close: DEFAULT_CLOSE,
    isClosed: DEFAULT_CLOSED_WEEKDAYS.includes(weekday),
  }));
  return { hours, holidays: [] };
}

function rowFor(date: string, cal: BusinessCalendar): BusinessHoursRow | undefined {
  const weekday = weekdayOf(date);
  return cal.hours.find((h) => h.weekday === weekday);
}

/** その日の営業時間（'HH:MM'）。休業日（曜日の休み・休業日リスト）なら null */
export function hoursOn(date: string, cal: BusinessCalendar): { open: string; close: string } | null {
  if (!isBusinessDay(date, cal)) return null;
  const row = rowFor(date, cal)!;
  return { open: row.open, close: row.close };
}

/** 営業日か（曜日の設定が休みでなく、休業日リストに無い） */
export function isBusinessDay(date: string, cal: BusinessCalendar): boolean {
  const row = rowFor(date, cal);
  return !!row && !row.isClosed && !cal.holidays.includes(date);
}

/** いま営業時間内か（開店時刻ちょうどは営業中、閉店時刻ちょうどは時間外） */
export function isOpenAt(now: Date, cal: BusinessCalendar): boolean {
  const { date, time } = toJst(now);
  if (!isBusinessDay(date, cal)) return false;
  const row = rowFor(date, cal)!;
  return row.open <= time && time < row.close;
}

/** date より後の最初の営業日 */
export function nextBusinessDayAfter(date: string, cal: BusinessCalendar): string {
  for (let i = 1; i <= SEARCH_LIMIT_DAYS; i++) {
    const candidate = addDays(date, i);
    if (isBusinessDay(candidate, cal)) return candidate;
  }
  throw new Error(`${SEARCH_LIMIT_DAYS}日先まで営業日がありません。営業時間の設定を確認してください`);
}

/**
 * 担当者から連絡できる日（「翌営業日（○月○日）にご連絡します」の日）。
 * 今日が営業日で閉店前なら今日、そうでなければ次の営業日
 */
export function nextContactDay(now: Date, cal: BusinessCalendar): string {
  const { date, time } = toJst(now);
  if (isBusinessDay(date, cal) && time < rowFor(date, cal)!.close) return date;
  return nextBusinessDayAfter(date, cal);
}

/** 内見の候補日（翌営業日から count 日分の営業日） */
export function viewingCandidateDays(now: Date, cal: BusinessCalendar, count: number): string[] {
  const days: string[] = [];
  let date = toJst(now).date;
  while (days.length < count) {
    date = nextBusinessDayAfter(date, cal);
    days.push(date);
  }
  return days;
}

/**
 * 直前の営業終了の瞬間。朝の引き継ぎ一覧は「これ以降に届いた案件」を夜間・休日分としてまとめる。
 * 営業時間中なら前の営業日の閉店、時間外なら直近の閉店
 */
export function previousClose(now: Date, cal: BusinessCalendar): Date {
  const { date } = toJst(now);
  for (let i = 0; i <= SEARCH_LIMIT_DAYS; i++) {
    const candidate = addDays(date, -i);
    if (!isBusinessDay(candidate, cal)) continue;
    const close = fromJst(candidate, rowFor(candidate, cal)!.close);
    if (close.getTime() <= now.getTime()) return close;
  }
  throw new Error(`${SEARCH_LIMIT_DAYS}日前まで営業日がありません。営業時間の設定を確認してください`);
}
