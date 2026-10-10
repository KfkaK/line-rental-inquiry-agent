'use client';

import { useState } from 'react';
import { closeViewingManuallyAction, confirmViewingAction, rejectViewingAction, setViewingProgressAction } from '../actions';
import { STAFF_NOTE_MAX_CHARS } from '@/domain/rules';
import { canTransition } from '@/domain/staff';
import type { ViewingStatus } from '@/domain/types';
import { FormMessage } from './FormMessage';
import { cardClass, hintClass, inputClass, labelClass, SubmitButton } from './ui';
import { useServerForm } from './useServerForm';

export interface CandidateOption {
  /** 候補日時の値（'2026-10-10T14:00'。時刻が無ければ '2026-10-10'） */
  value: string;
  /** 画面に出す日時（'10月10日(土) 14:00'） */
  label: string;
  /** 候補の時刻（'14:00'）。日付だけなら空 */
  time: string;
  /** その日の営業時間（いまの設定）。休業日なら null。確定できるのはこの時間内だけ（サーバーでも検証する） */
  hours: { open: string; close: string } | null;
}

/** 候補の時刻が営業時間外か（日付だけの候補は時刻が無いので外にしない） */
function isOffHours(c: CandidateOption): boolean {
  if (!c.hours) return true;
  return c.time !== '' && (c.time < c.hours.open || c.time >= c.hours.close);
}

interface Props {
  viewingRequestId: string;
  status: ViewingStatus;
  candidates: CandidateOption[];
  /** デモの会話（LINE には送らない） */
  isDemo: boolean;
  /** この仮受付が届いた後に担当者が手動返信している（「手動で対応済み」を出せる。サーバーでも確かめる） */
  canCloseManually: boolean;
}

/**
 * 内見の仮受付の操作（担当者だけに出す）。確定・却下は終わりの状態なので、成功するとサーバー側の画面が結果の表示に変わり、
 * フォームは消える。そのあとも「確定しました」の文が残るよう、成功の文はここ（親は同じ位置に置き続ける）で持つ。
 */
export function ViewingActions({ viewingRequestId, status, candidates, isDemo, canCloseManually }: Props) {
  const [done, setDone] = useState<string | null>(null);
  const open = canTransition(status, 'confirmed');
  if (!open && done === null) return null;

  return (
    <section aria-labelledby="actions-heading" className={`${cardClass} space-y-6`}>
      <h2 id="actions-heading" className="text-base font-semibold">
        操作
      </h2>
      <p role="status" className="text-sm leading-relaxed empty:sr-only">
        {done}
      </p>
      {open && (
        <>
          <ConfirmForm viewingRequestId={viewingRequestId} candidates={candidates} isDemo={isDemo} onDone={setDone} />
          <hr className="border-line" />
          <RejectForm viewingRequestId={viewingRequestId} isDemo={isDemo} onDone={setDone} />
          <hr className="border-line" />
          <ProgressForm viewingRequestId={viewingRequestId} status={status} onDone={setDone} />
          <hr className="border-line" />
          <ManualCloseForm viewingRequestId={viewingRequestId} available={canCloseManually} onDone={setDone} />
        </>
      )}
    </section>
  );
}

function ConfirmForm({
  viewingRequestId,
  candidates,
  isDemo,
  onDone,
}: {
  viewingRequestId: string;
  candidates: CandidateOption[];
  isDemo: boolean;
  onDone: (message: string) => void;
}) {
  const [candidate, setCandidate] = useState(candidates[0]?.value ?? '');
  const [time, setTime] = useState(candidates[0]?.time ?? '');
  const [note, setNote] = useState('');
  const [state, formAction, pending] = useServerForm(confirmViewingAction, onDone);
  const selected = candidates.find((c) => c.value === candidate);

  return (
    <form action={formAction} className="space-y-4">
      <h3 className="text-sm font-semibold">確定する</h3>
      <input type="hidden" name="viewingRequestId" value={viewingRequestId} />
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm text-muted">利用者の候補から日時を選びます</legend>
        {candidates.map((c) => (
          <label key={c.value} className="flex min-h-11 items-center gap-3 rounded-md border border-line px-3 py-2">
            <input
              type="radio"
              name="candidate"
              value={c.value}
              checked={candidate === c.value}
              onChange={() => {
                setCandidate(c.value);
                setTime(c.time);
              }}
              className="size-4"
            />
            <span>
              {c.label}
              {isOffHours(c) && <span className="ml-2 text-sm text-muted">（{c.hours ? '営業時間外' : '休業日'}）</span>}
            </span>
          </label>
        ))}
      </fieldset>
      <div>
        <label htmlFor="confirm-time" className={labelClass}>
          時刻
        </label>
        <input
          id="confirm-time"
          name="time"
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          required={!selected?.time}
          min={selected?.hours?.open}
          max={selected?.hours?.close}
          className={`${inputClass} sm:max-w-40`}
        />
        <p className={`${hintClass} mt-1`}>
          {selected?.time ? '空にすると、候補の時刻で確定します。' : 'この候補は日付だけなので、時刻を入れてください。'}
        </p>
        <p className={`${hintClass} mt-1`}>
          {selected?.hours
            ? `この日の営業時間: ${selected.hours.open}〜${selected.hours.close}（この時間内でだけ確定できます）`
            : 'この日は休業日の設定のため確定できません。'}
          営業時間外の内見は、会話ログの手動返信で利用者と調整してください。
        </p>
      </div>
      <div>
        <label htmlFor="confirm-note" className={labelClass}>
          ひとこと（任意。利用者に送ります）
        </label>
        <textarea
          id="confirm-note"
          name="note"
          rows={3}
          maxLength={STAFF_NOTE_MAX_CHARS}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className={inputClass}
        />
        <p className={`${hintClass} mt-1`}>
          {note.length} / {STAFF_NOTE_MAX_CHARS} 字
        </p>
      </div>
      <p className={hintClass}>{isDemo ? '確定しても、デモの会話なので LINE には送りません。' : '確定すると、利用者に LINE で知らせます。'}</p>
      <SubmitButton pending={pending}>この日時で確定する</SubmitButton>
      <FormMessage state={state} errorsOnly />
    </form>
  );
}

function RejectForm({
  viewingRequestId,
  isDemo,
  onDone,
}: {
  viewingRequestId: string;
  isDemo: boolean;
  onDone: (message: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [state, formAction, pending] = useServerForm(rejectViewingAction, onDone);

  return (
    <form action={formAction} className="space-y-4">
      <h3 className="text-sm font-semibold">却下する</h3>
      <input type="hidden" name="viewingRequestId" value={viewingRequestId} />
      <div>
        <label htmlFor="reject-reason" className={labelClass}>
          理由（必須。利用者に送ります）
        </label>
        <textarea
          id="reject-reason"
          name="reason"
          rows={3}
          required
          maxLength={STAFF_NOTE_MAX_CHARS}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className={inputClass}
        />
        <p className={`${hintClass} mt-1`}>
          {reason.length} / {STAFF_NOTE_MAX_CHARS} 字
        </p>
      </div>
      <p className={hintClass}>
        {isDemo ? 'デモの会話なので、却下の連絡は LINE には送りません。' : 'この理由を、却下の連絡として利用者に LINE で送ります。'}
      </p>
      <SubmitButton pending={pending} variant="danger">
        却下する
      </SubmitButton>
      <FormMessage state={state} errorsOnly />
    </form>
  );
}

/**
 * 手動で対応済み（意思決定ログ15）。営業時間外の内見などを手動返信で取り決めたときに、記録だけを閉じる。
 * 確定のボタンではない（利用者には何も送らない）。手動返信の後にだけ出す
 */
function ManualCloseForm({
  viewingRequestId,
  available,
  onDone,
}: {
  viewingRequestId: string;
  available: boolean;
  onDone: (message: string) => void;
}) {
  const [note, setNote] = useState('');
  const [state, formAction, pending] = useServerForm(closeViewingManuallyAction, onDone);

  if (!available) {
    return (
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">手動で対応済みにする</h3>
        <p className={hintClass}>
          営業時間外の内見などを会話ログの手動返信で利用者と取り決めたら、ここで記録を閉じられます（手動返信の後に出ます）。
        </p>
      </div>
    );
  }
  return (
    <form action={formAction} className="space-y-4">
      <h3 className="text-sm font-semibold">手動で対応済みにする</h3>
      <input type="hidden" name="viewingRequestId" value={viewingRequestId} />
      <p className={hintClass}>
        手動返信で利用者と取り決めた内見の記録だけを閉じます。<strong className="font-semibold text-fg">利用者には何も送りません</strong>
        （確定の連絡は手動返信で済ませてください）。
      </p>
      <div>
        <label htmlFor="manual-note" className={labelClass}>
          取り決めた内容（必須。日時と経緯）
        </label>
        <textarea
          id="manual-note"
          name="note"
          rows={3}
          required
          maxLength={STAFF_NOTE_MAX_CHARS}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className={inputClass}
        />
        <p className={`${hintClass} mt-1`}>
          {note.length} / {STAFF_NOTE_MAX_CHARS} 字
        </p>
      </div>
      <SubmitButton pending={pending} variant="secondary">
        手動で対応済みにする
      </SubmitButton>
      <FormMessage state={state} errorsOnly />
    </form>
  );
}

/** 未対応 ⇄ 対応中（担当者の手元の印。利用者には送らない） */
function ProgressForm({
  viewingRequestId,
  status,
  onDone,
}: {
  viewingRequestId: string;
  status: ViewingStatus;
  onDone: (message: string) => void;
}) {
  const [state, formAction, pending] = useServerForm(setViewingProgressAction, onDone);
  const next = canTransition(status, 'in_progress') ? 'in_progress' : 'pending';

  return (
    <form action={formAction} className="space-y-3">
      <h3 className="text-sm font-semibold">手元の印</h3>
      <input type="hidden" name="viewingRequestId" value={viewingRequestId} />
      <input type="hidden" name="status" value={next} />
      <p className={hintClass}>利用者には送りません。ほかの担当者に、対応を始めたことを伝える印です。</p>
      <SubmitButton pending={pending} variant="secondary">
        {next === 'in_progress' ? '対応中にする' : '未対応に戻す'}
      </SubmitButton>
      <FormMessage state={state} errorsOnly />
    </form>
  );
}
