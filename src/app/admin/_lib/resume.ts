/**
 * AI の自動再開の時刻（純関数）。handleEvent は「最終の担当者返信から AI_RESUME_AFTER_MS が経った」ときに再開する。
 * 最終の担当者返信が無い（null）停止は、自動では再開しない（担当者の「AIに戻す」だけ）。
 */
import { AI_RESUME_AFTER_MS } from '@/domain/rules';

/** 自動で再開する時刻（ISO）。自動再開しないなら null */
export function aiResumeAt(lastStaffReplyAt: string | null): string | null {
  if (lastStaffReplyAt === null) return null;
  const last = Date.parse(lastStaffReplyAt);
  return Number.isNaN(last) ? null : new Date(last + AI_RESUME_AFTER_MS).toISOString();
}
