/**
 * 管理画面の担当者の操作（I/O の層。DESIGN.md 2.2）。判断は `src/domain/staff.ts` の純関数に任せ、
 * ここでは 読む → 検証 → 保存 → LINE に送る → 会話ログに残す だけを行う。
 *
 * - `repos` はログインした担当者のセッションのクライアントで作ったもの（RLS が本物の門。service role は使わない）。
 *   呼び出し側（Server Action）が役割（staff）を確かめてから渡す
 * - 利用者へ送った文は role='staff' で会話ログに残す。デモ会話（is_demo）は LINE に送らず、ログにだけ残す
 * - 例外は投げず、画面に出す文を `ActionResult` で返す（DB の失敗はログに出して一般的な文にする）。
 *   ok は「保存した」の意味。保存した後に LINE への送信だけ失敗したときも ok にし、文で手動返信を頼む（画面を読み直させるため）
 */
import * as msg from '@/domain/messages';
import {
  canCloseManually,
  canTransition,
  checkConfirmNote,
  checkManualCloseNote,
  checkRejectReason,
  checkStaffReply,
  nextResolvedCount,
  resolveConfirmedTime,
  validateCalendar,
  VIEWING_STATUS_LABEL,
} from '@/domain/staff';
import { VIEWING_STATUSES, type BusinessCalendar, type ViewingStatus } from '@/domain/types';
import type { Conversation, Repositories, ViewingRequestListItem, ViewingRequestPatch } from '@/lib/db';
import type { LineMessenger } from '@/lib/line/messenger';

export interface StaffDeps {
  repos: Repositories;
  messenger: Pick<LineMessenger, 'push'>;
  clock: () => Date;
}

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

const fail = (error: string): ActionResult => ({ ok: false, error });
const done = (message: string): ActionResult => ({ ok: true, message });

/** DB・LINE の想定外の失敗。中身（個人情報を含みうる）は画面に出さず、ログには操作名とメッセージだけ */
function unexpected(operation: string, error: unknown): ActionResult {
  console.error(`[admin] ${operation} に失敗しました`, error instanceof Error ? error.message : error);
  return fail('保存に失敗しました。時間をおいてもう一度お試しください。');
}

// ---------- 内見の仮受付 ----------

type ViewingTarget = { viewing: ViewingRequestListItem; conversation: Conversation };

async function loadViewing(deps: StaffDeps, id: string, to: ViewingStatus): Promise<ViewingTarget | ActionResult> {
  const viewing = await deps.repos.viewingRequests.getById(id);
  if (!viewing) return fail('この仮受付は見つかりません。');
  if (!canTransition(viewing.status, to)) {
    return fail(`この仮受付はすでに「${VIEWING_STATUS_LABEL[viewing.status]}」のため、「${VIEWING_STATUS_LABEL[to]}」にできません。`);
  }
  const conversation = await deps.repos.conversations.getById(viewing.conversationId);
  if (!conversation) return fail('この仮受付の会話が見つかりません。');
  return { viewing, conversation };
}

/**
 * 状態を変える。確認と更新を1回の UPDATE で行い、2つのタブ・2人の担当者が同時に確定しても片方だけを通す
 * （両方通ると利用者に食い違う確定の文が2通届く）。先を越されたら false
 */
async function applyTransition(deps: StaffDeps, id: string, to: ViewingStatus, patch: ViewingRequestPatch): Promise<boolean> {
  const from = VIEWING_STATUSES.filter((status) => canTransition(status, to));
  return (await deps.repos.viewingRequests.transition(id, from, { ...patch, status: to })) !== null;
}

const RACED = 'ほかの操作で状態が変わりました。画面を読み直してから、もう一度お試しください。';

/**
 * 利用者へ送り、会話ログに残す。送れなかったら false（状態は保存済みなので、担当者に手動返信で伝えてもらう）。
 * デモ会話は送らずにログだけ残す
 */
async function sendToUser(deps: StaffDeps, conversation: Conversation, text: string): Promise<boolean> {
  if (!conversation.isDemo) {
    try {
      await deps.messenger.push(conversation.lineUserId, [{ type: 'text', text }]);
    } catch (error) {
      console.error('[admin] LINE への送信に失敗しました', error instanceof Error ? error.message : error);
      return false;
    }
  }
  try {
    await deps.repos.messages.insert({ conversationId: conversation.id, role: 'staff', text });
  } catch (error) {
    // 利用者には届いている。失敗を返すと担当者が送り直して2通になるので、ログだけ残して送れた扱いにする
    console.error('[admin] 担当者の発言を会話ログに残せませんでした', error instanceof Error ? error.message : error);
  }
  return true;
}

function sentMessage(conversation: Conversation, what: string): string {
  return conversation.isDemo ? `${what}（デモの会話なので LINE には送っていません）` : `${what}。LINE でお知らせしました。`;
}

const SEND_FAILED = 'ただし LINE への送信に失敗しました。お手数ですが、会話ログの手動返信でお伝えください。';

export async function confirmViewing(
  deps: StaffDeps,
  input: { viewingRequestId: string; candidate: string; time: string; note: string },
): Promise<ActionResult> {
  try {
    const target = await loadViewing(deps, input.viewingRequestId, 'confirmed');
    if ('ok' in target) return target;
    const { viewing, conversation } = target;
    const calendar = await deps.repos.businessCalendar.get();
    const time = resolveConfirmedTime(viewing.candidateTimes, input.candidate, input.time, calendar);
    if (!time.ok) return fail(time.error);
    const note = checkConfirmNote(input.note);
    if (!note.ok) return fail(note.error);

    const saved = await applyTransition(deps, viewing.id, 'confirmed', { confirmedTime: time.value, staffNote: note.value || null });
    if (!saved) return fail(RACED);
    const text = msg.viewingConfirmed(viewing.propertyName ?? viewing.propertyId, time.value, note.value);
    if (!(await sendToUser(deps, conversation, text))) return done(`確定は保存しました。${SEND_FAILED}`);
    return done(sentMessage(conversation, `${msg.formatViewingTime(time.value)} で確定しました`));
  } catch (error) {
    return unexpected('内見の確定', error);
  }
}

export async function rejectViewing(deps: StaffDeps, input: { viewingRequestId: string; reason: string }): Promise<ActionResult> {
  try {
    const target = await loadViewing(deps, input.viewingRequestId, 'rejected');
    if ('ok' in target) return target;
    const { viewing, conversation } = target;
    const reason = checkRejectReason(input.reason);
    if (!reason.ok) return fail(reason.error);

    if (!(await applyTransition(deps, viewing.id, 'rejected', { staffNote: reason.value }))) return fail(RACED);
    const text = msg.viewingRejected(viewing.propertyName ?? viewing.propertyId, reason.value);
    if (!(await sendToUser(deps, conversation, text))) return done(`却下は保存しました。${SEND_FAILED}`);
    return done(sentMessage(conversation, '却下しました'));
  } catch (error) {
    return unexpected('内見の却下', error);
  }
}

/**
 * 手動で対応済み（意思決定ログ15）。営業時間外の内見などを手動返信で利用者と取り決めたときに、記録だけを閉じる。
 * 利用者には何も送らない。取り決めた日時と経緯のメモが必須で、その仮受付が届いた後に手動返信した会話だけ
 */
export async function closeViewingManually(deps: StaffDeps, input: { viewingRequestId: string; note: string }): Promise<ActionResult> {
  try {
    const target = await loadViewing(deps, input.viewingRequestId, 'closed_manually');
    if ('ok' in target) return target;
    const { viewing, conversation } = target;
    if (!canCloseManually(viewing.createdAt, conversation.lastStaffReplyAt)) {
      return fail('手動返信で利用者とやりとりした仮受付だけを「手動で対応済み」にできます。先に会話ログの手動返信で調整してください。');
    }
    const note = checkManualCloseNote(input.note);
    if (!note.ok) return fail(note.error);
    if (!(await applyTransition(deps, viewing.id, 'closed_manually', { staffNote: note.value }))) return fail(RACED);
    return done('手動で対応済みにしました（利用者には何も送っていません）。');
  } catch (error) {
    return unexpected('手動で対応済み', error);
  }
}

/** 未対応 ⇄ 対応中（担当者の手元の印。利用者には送らない） */
export async function setViewingProgress(
  deps: StaffDeps,
  input: { viewingRequestId: string; status: 'pending' | 'in_progress' },
): Promise<ActionResult> {
  try {
    const target = await loadViewing(deps, input.viewingRequestId, input.status);
    if ('ok' in target) return target;
    if (!(await applyTransition(deps, target.viewing.id, input.status, {}))) return fail(RACED);
    return done(`「${VIEWING_STATUS_LABEL[input.status]}」にしました。`);
  } catch (error) {
    return unexpected('内見の状態の変更', error);
  }
}

// ---------- 会話（手動返信・AI に戻す・引き継ぎメモ） ----------

/**
 * 担当者の手動返信（DESIGN.md 3.4）。AI と人が同時に返信しないよう、送る前に AI を止める（不変条件 8）。
 * 最終の担当者返信（24 時間の自動再開の起点）は送れた後に書く。送れなかったら AI は止めたまま（「AIに戻す」で再開できる）
 */
export async function sendStaffReply(deps: StaffDeps, input: { conversationId: string; text: string }): Promise<ActionResult> {
  try {
    const text = checkStaffReply(input.text);
    if (!text.ok) return fail(text.error);
    const conversation = await deps.repos.conversations.getById(input.conversationId);
    if (!conversation) return fail('この会話は見つかりません。');

    const now = deps.clock().toISOString();
    if (!conversation.aiPaused) await deps.repos.conversations.update(conversation.id, { aiPaused: true, pausedAt: now });
    if (!(await sendToUser(deps, conversation, text.value))) {
      return fail('LINE への送信に失敗しました。AI は止めたままです（「AIに戻す」で再開できます）。');
    }
    await deps.repos.conversations.update(conversation.id, { lastStaffReplyAt: now });
    return done(sentMessage(conversation, '返信しました。AI の自動応答は止めています'));
  } catch (error) {
    return unexpected('手動返信', error);
  }
}

/** 「AIに戻す」。最終の担当者返信から 24 時間でも自動で戻る（handleEvent） */
export async function resumeAi(deps: StaffDeps, input: { conversationId: string }): Promise<ActionResult> {
  try {
    const conversation = await deps.repos.conversations.getById(input.conversationId);
    if (!conversation) return fail('この会話は見つかりません。');
    if (!conversation.aiPaused) return done('AI の自動応答はすでに動いています。');
    await deps.repos.conversations.update(conversation.id, { aiPaused: false, pausedAt: null });
    return done('AI の自動応答を再開しました。');
  } catch (error) {
    return unexpected('AI の再開', error);
  }
}

/** 引き継ぎメモを対応済みにする。`seen` は担当者が画面で見たメモの件数（見た後に届いたメモは未対応のまま） */
export async function resolveHandoff(deps: StaffDeps, input: { conversationId: string; seen: number }): Promise<ActionResult> {
  try {
    const conversation = await deps.repos.conversations.getById(input.conversationId);
    if (!conversation) return fail('この会話は見つかりません。');
    const count = nextResolvedCount(conversation.handoffResolvedCount, input.seen, conversation.handoffNotes.length);
    if (count === conversation.handoffResolvedCount) return done('対応済みにするメモはありません。');
    await deps.repos.conversations.update(conversation.id, { handoffResolvedCount: count });
    const left = conversation.handoffNotes.length - count;
    return done(left > 0 ? `対応済みにしました（このあと届いたメモが ${left} 件あります）。` : '対応済みにしました。');
  } catch (error) {
    return unexpected('引き継ぎメモの対応済み', error);
  }
}

// ---------- 営業時間 ----------

export async function saveCalendar(deps: StaffDeps, calendar: BusinessCalendar): Promise<ActionResult> {
  const checked = validateCalendar(calendar, deps.clock());
  if (!checked.ok) return fail(checked.error);
  try {
    await deps.repos.businessCalendar.setHours(checked.value.hours);
    await deps.repos.businessCalendar.setHolidays(checked.value.holidays);
    return done('営業時間と休業日を保存しました。AI の時間外の案内と内見の候補日に使います。');
  } catch (error) {
    return unexpected('営業時間の保存', error);
  }
}
