/**
 * 管理画面の表示用の整形（純関数）。時刻はすべて JST で出す（サーバーは UTC で動くので、ここで必ず変換する）。
 */
import { formatJstDay, toJst } from '@/domain/businessHours';
import { formatViewingTime } from '@/domain/messages';

/** ISO 8601 → '10月7日(水) 23:00'（JST） */
export function formatJstDateTime(iso: string): string {
  const { date, time } = toJst(new Date(iso));
  return `${formatJstDay(date)} ${time}`;
}

/** 内見の候補日時を '、' でつなぐ（'2026-10-10T14:00' → '10月10日(土) 14:00'） */
export function formatCandidates(times: readonly string[]): string {
  return times.map(formatViewingTime).join('、');
}

/** 候補日時の時刻部分（'2026-10-10T14:00' → '14:00'。日付だけなら空） */
export function candidateTimePart(candidate: string): string {
  return candidate.split('T')[1] ?? '';
}

/** 応答時間。1234 → '1.2秒' */
export function formatLatency(ms: number): string {
  return `${(ms / 1000).toFixed(1)}秒`;
}

/** そのターンの API 費用（USD）。0.00123 → '$0.0012' */
export function formatCostUsd(usd: number): string {
  return usd === 0 ? '$0' : `$${usd.toFixed(4)}`;
}

/** 表示名。LINE の表示名が取れていない会話は「（表示名なし）」 */
export function displayNameOf(name: string | null): string {
  return name?.trim() ? name : '（表示名なし）';
}
