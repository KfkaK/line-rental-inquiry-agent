'use server';
/**
 * 管理画面の Server Action。フォームの値を読み、権限を確かめ（`getStaffDeps`）、担当者の操作（src/server/admin/service.ts）を呼ぶ。
 * 結果は `useActionState` で画面に出す。成功したら `refresh()` で画面の一覧を読み直す。
 * Server Action は誰でも直接呼べるので、ページで隠したボタンも必ずここで役割を確かめる（閲覧用は RLS でも止まる）。
 */
import { refresh } from 'next/cache';
import { redirect } from 'next/navigation';
import { defaultCalendar } from '@/domain/businessHours';
import type { BusinessCalendar } from '@/domain/types';
import { isAdminPreview } from '@/server/admin/previewFlag';
import {
  confirmViewing,
  rejectViewing,
  resolveHandoff,
  resumeAi,
  saveCalendar,
  sendStaffReply,
  setViewingProgress,
  type ActionResult,
} from '@/server/admin/service';
import { createSessionClient, getStaffDeps } from '@/server/admin/session';

/** `useActionState` の状態。null は未送信 */
export type FormState = { ok: boolean; message: string } | null;

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

function toState(result: ActionResult): FormState {
  if (result.ok) refresh();
  return result.ok ? { ok: true, message: result.message } : { ok: false, message: result.error };
}

/** 権限を確かめてから操作を呼ぶ */
async function asStaff(run: (deps: Exclude<Awaited<ReturnType<typeof getStaffDeps>>, { error: string }>) => Promise<ActionResult>): Promise<FormState> {
  const deps = await getStaffDeps();
  if ('error' in deps) return { ok: false, message: deps.error };
  return toState(await run(deps));
}

// ---------- ログイン ----------

export async function login(_prev: FormState, formData: FormData): Promise<FormState> {
  if (isAdminPreview()) redirect('/admin');
  const email = text(formData, 'email').trim();
  const password = text(formData, 'password');
  if (!email || !password) return { ok: false, message: 'メールアドレスとパスワードを入れてください。' };
  const supabase = await createSessionClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  // どちらが違うかは教えない
  if (error) return { ok: false, message: 'メールアドレスかパスワードが違います。' };
  redirect('/admin');
}

export async function logout(): Promise<void> {
  if (!isAdminPreview()) {
    const supabase = await createSessionClient();
    await supabase.auth.signOut();
  }
  redirect('/admin/login');
}

// ---------- 内見の仮受付 ----------

/** フォーム: viewingRequestId・candidate（候補日時の値）・time（'HH:MM'。候補に時刻があれば空でよい）・note（任意） */
export async function confirmViewingAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return asStaff((deps) =>
    confirmViewing(deps, {
      viewingRequestId: text(formData, 'viewingRequestId'),
      candidate: text(formData, 'candidate'),
      time: text(formData, 'time'),
      note: text(formData, 'note'),
    }),
  );
}

/** フォーム: viewingRequestId・reason（必須。利用者に送る） */
export async function rejectViewingAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return asStaff((deps) => rejectViewing(deps, { viewingRequestId: text(formData, 'viewingRequestId'), reason: text(formData, 'reason') }));
}

/** フォーム: viewingRequestId・status（'pending' | 'in_progress'） */
export async function setViewingProgressAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const status = text(formData, 'status');
  if (status !== 'pending' && status !== 'in_progress') return { ok: false, message: '状態が読めません。' };
  return asStaff((deps) => setViewingProgress(deps, { viewingRequestId: text(formData, 'viewingRequestId'), status }));
}

// ---------- 会話 ----------

/** フォーム: conversationId・text */
export async function sendStaffReplyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return asStaff((deps) => sendStaffReply(deps, { conversationId: text(formData, 'conversationId'), text: text(formData, 'text') }));
}

/** フォーム: conversationId */
export async function resumeAiAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return asStaff((deps) => resumeAi(deps, { conversationId: text(formData, 'conversationId') }));
}

/** フォーム: conversationId・seen（画面に出したメモの件数 = handoffNotes.length） */
export async function resolveHandoffAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const seen = Number(text(formData, 'seen'));
  if (!Number.isFinite(seen)) return { ok: false, message: '件数が読めません。' };
  return asStaff((deps) => resolveHandoff(deps, { conversationId: text(formData, 'conversationId'), seen }));
}

// ---------- 営業時間 ----------

/**
 * フォーム: 曜日 w（0=日 … 6=土）ごとに `closed-w`（チェックで休み）・`open-w`・`close-w`（'HH:MM'）、
 * 休業日は `holiday`（'YYYY-MM-DD'。複数。空は無視）
 */
export async function saveCalendarAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const fallback = defaultCalendar().hours;
  const calendar: BusinessCalendar = {
    hours: fallback.map(({ weekday, open, close }) => {
      const isClosed = formData.get(`closed-${weekday}`) !== null;
      // 休みの曜日は時刻が空でも DB の制約（time not null）を満たすよう既定の時刻を入れておく
      return {
        weekday,
        isClosed,
        open: text(formData, `open-${weekday}`).trim() || (isClosed ? open : ''),
        close: text(formData, `close-${weekday}`).trim() || (isClosed ? close : ''),
      };
    }),
    holidays: [...new Set(formData.getAll('holiday').map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean))].sort(),
  };
  return asStaff((deps) => saveCalendar(deps, calendar));
}
