/**
 * 担当者の操作の業務ルール（純関数。DESIGN.md 2.2）。
 * 内見の仮受付の状態の遷移・確定日時の決め方・引き継ぎメモの対応済み・営業時間の設定の検証を持つ。
 * 現在時刻は引数で受け取る（不変条件 5）。
 */
import { formatJstDay, hoursOn, nextContactDay, previousClose, viewingCandidateDays } from './businessHours';
import { STAFF_NOTE_MAX_CHARS, STAFF_REPLY_MAX_CHARS, VIEWING_DAYS_TO_OFFER } from './rules';
import type { BusinessCalendar, BusinessHoursRow, HandoffNote, ViewingStatus } from './types';

// ---------- 内見の仮受付の状態 ----------

/** 管理画面の表示名 */
export const VIEWING_STATUS_LABEL: Record<ViewingStatus, string> = {
  pending: '未対応',
  in_progress: '対応中',
  confirmed: '確定',
  rejected: '却下',
  closed_manually: '手動で対応済み',
};

/**
 * 遷移できる先。確定・却下・手動で対応済みは終わり（確定・却下は利用者へ LINE で知らせた後なので戻さない。取り消しは手動返信で伝える）。
 * 未対応 ⇄ 対応中 は担当者の手元の印なので行き来できる
 */
const TRANSITIONS: Record<ViewingStatus, readonly ViewingStatus[]> = {
  pending: ['in_progress', 'confirmed', 'rejected', 'closed_manually'],
  in_progress: ['pending', 'confirmed', 'rejected', 'closed_manually'],
  confirmed: [],
  rejected: [],
  closed_manually: [],
};

export function canTransition(from: ViewingStatus, to: ViewingStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** 担当者の手がまだ要る（朝の一覧の「それ以前の未対応」に残す） */
export function isOpenViewing(status: ViewingStatus): boolean {
  return status === 'pending' || status === 'in_progress';
}

// ---------- 確定日時 ----------

const CANDIDATE_PATTERN = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** 営業時間外の内見は確定ボタンでは確定させず、担当者が手動返信で利用者と調整する（意思決定ログ14） */
const OFF_HOURS_GUIDE = '営業時間外の内見は、会話ログの手動返信で利用者と調整してください。';

/**
 * 確定日時を決める（'YYYY-MM-DDTHH:mm'）。日付は利用者の候補から選ぶ（担当者が別の日を決めない。DESIGN.md 2.2）。
 * 時刻は担当者が入れる。候補に時刻があり、担当者が空にしたら候補の時刻を使う。候補が日付だけなら時刻は必須。
 * 開始時刻はいまの営業カレンダーでその日の営業時間内（開店ちょうどは可・閉店ちょうどは不可。`isOpenAt` と同じ境界）。
 * 時間外・休業日は断る（午前・午後の取り違えを止める。例外で受けるかは担当者がやりとりで決める。意思決定ログ14）
 */
export function resolveConfirmedTime(
  candidates: readonly string[],
  candidate: string,
  time: string,
  calendar: BusinessCalendar,
): Result<string> {
  if (!candidates.includes(candidate)) return { ok: false, error: '候補日時から選んでください。' };
  const m = CANDIDATE_PATTERN.exec(candidate);
  if (!m) return { ok: false, error: '候補日時の形式が読めません。' };
  const [, date, candidateTime] = m;
  const chosen = time.trim() || candidateTime || '';
  if (!chosen) return { ok: false, error: '時刻を入れてください（候補が日付だけのため）。' };
  if (!TIME_PATTERN.test(chosen)) return { ok: false, error: '時刻は 14:00 の形で入れてください。' };
  const hours = hoursOn(date, calendar);
  if (!hours) return { ok: false, error: `${formatJstDay(date)}は休業日の設定です。${OFF_HOURS_GUIDE}` };
  if (chosen < hours.open || chosen >= hours.close) {
    return { ok: false, error: `${formatJstDay(date)}の営業時間は ${hours.open}〜${hours.close} です。${OFF_HOURS_GUIDE}` };
  }
  return { ok: true, value: `${date}T${chosen}` };
}

// ---------- 担当者が書く文 ----------

/** 前後の空白を落とし、空・長すぎを弾く */
function checkText(raw: string, label: string, max: number, required: boolean): Result<string> {
  const text = raw.trim();
  if (required && !text) return { ok: false, error: `${label}を入れてください。` };
  if (text.length > max) return { ok: false, error: `${label}は${max}字以内にしてください（いま${text.length}字）。` };
  return { ok: true, value: text };
}

/** 手動返信の本文（必須） */
export function checkStaffReply(raw: string): Result<string> {
  return checkText(raw, '返信', STAFF_REPLY_MAX_CHARS, true);
}

/** 却下の理由（必須。利用者に送る） */
export function checkRejectReason(raw: string): Result<string> {
  return checkText(raw, '却下の理由', STAFF_NOTE_MAX_CHARS, true);
}

/** 手動で対応済みのメモ（必須。利用者には送らない。取り決めた日時と経緯を残す） */
export function checkManualCloseNote(raw: string): Result<string> {
  return checkText(raw, '取り決めた内容のメモ', STAFF_NOTE_MAX_CHARS, true);
}

/**
 * 「手動で対応済み」にできるか。その仮受付が届いた後に担当者が手動返信している（＝利用者とやりとりした）ときだけ。
 * 時間内の案件をこれで閉じて、利用者に確定の連絡が届かないのを防ぐ（意思決定ログ15）
 */
export function canCloseManually(viewingCreatedAt: string, lastStaffReplyAt: string | null): boolean {
  return lastStaffReplyAt !== null && Date.parse(lastStaffReplyAt) >= Date.parse(viewingCreatedAt);
}

/** 確定に添える一言（任意。利用者に送る） */
export function checkConfirmNote(raw: string): Result<string> {
  return checkText(raw, 'ひとこと', STAFF_NOTE_MAX_CHARS, false);
}

// ---------- 引き継ぎメモ ----------

/** 未対応のメモ（先頭から `resolvedCount` 件が対応済み。メモは追記だけ） */
export function openHandoffNotes(notes: readonly HandoffNote[], resolvedCount: number): HandoffNote[] {
  return notes.slice(Math.max(0, resolvedCount));
}

/**
 * 「対応済みにする」で書く件数。担当者が画面で見た件数（`seen`）までにし、いまの件数を超えない。
 * 見た後に届いたメモは未対応のまま残る。対応済みを減らす（戻す）操作にはしない
 */
export function nextResolvedCount(current: number, seen: number, total: number): number {
  return Math.max(current, Math.min(Math.max(0, Math.floor(seen)), total));
}

// ---------- 営業時間の設定 ----------

/**
 * 営業時間と休業日の設定を検証する。曜日ごとの形と open < close に加え、
 * 設定した後も「翌営業日」「内見の候補日」「前回の営業終了」が求まること（求まらないと Webhook の返信が止まる）
 */
export function validateCalendar(calendar: BusinessCalendar, now: Date): Result<BusinessCalendar> {
  const weekdays = new Set<number>();
  for (const row of calendar.hours) {
    const error = checkHoursRow(row);
    if (error) return { ok: false, error };
    if (weekdays.has(row.weekday)) return { ok: false, error: `${WEEKDAY_LABEL[row.weekday]}曜日が重複しています。` };
    weekdays.add(row.weekday);
  }
  if (weekdays.size !== 7) return { ok: false, error: '7曜日すべての設定が必要です。' };
  if (calendar.hours.every((row) => row.isClosed)) return { ok: false, error: '営業日が1日もありません。' };
  for (const date of calendar.holidays) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: `休業日の形式が読めません: ${date}` };
  }
  try {
    nextContactDay(now, calendar);
    viewingCandidateDays(now, calendar, VIEWING_DAYS_TO_OFFER);
    previousClose(now, calendar);
  } catch {
    return { ok: false, error: '休業日が続きすぎて、内見の候補日や連絡日が決められません。' };
  }
  return { ok: true, value: calendar };
}

const WEEKDAY_LABEL = ['日', '月', '火', '水', '木', '金', '土'];

function checkHoursRow(row: BusinessHoursRow): string | null {
  if (!Number.isInteger(row.weekday) || row.weekday < 0 || row.weekday > 6) return `曜日が読めません: ${row.weekday}`;
  const label = `${WEEKDAY_LABEL[row.weekday]}曜日`;
  if (row.isClosed) return null;
  if (!TIME_PATTERN.test(row.open) || !TIME_PATTERN.test(row.close)) return `${label}の時刻は 10:00 の形で入れてください。`;
  if (row.open >= row.close) return `${label}は開店を閉店より前にしてください。`;
  return null;
}
