'use client';

import { useState } from 'react';
import { resolveHandoffAction, resumeAiAction, sendStaffReplyAction } from '../actions';
import { STAFF_REPLY_MAX_CHARS } from '@/domain/rules';
import { FormMessage } from './FormMessage';
import { hintClass, inputClass, labelClass, SubmitButton } from './ui';
import { useServerForm } from './useServerForm';

/** 手動返信。送ると AI の自動応答を止める（不変条件 8）。失敗しても入力が消えないよう制御コンポーネントにする */
export function StaffReplyForm({ conversationId, isDemo }: { conversationId: string; isDemo: boolean }) {
  const [text, setText] = useState('');
  const [state, formAction, pending] = useServerForm(sendStaffReplyAction, () => setText(''));

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="conversationId" value={conversationId} />
      <div>
        <label htmlFor="reply-text" className={labelClass}>
          担当者からの返信
        </label>
        <textarea
          id="reply-text"
          name="text"
          rows={4}
          required
          maxLength={STAFF_REPLY_MAX_CHARS}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className={inputClass}
        />
        <p className={`${hintClass} mt-1`}>
          {text.length} / {STAFF_REPLY_MAX_CHARS} 字
        </p>
      </div>
      <p className={hintClass}>
        送ると AI の自動応答を止めます。{isDemo ? 'デモの会話なので LINE には送らず、ログにだけ残します。' : '利用者に LINE で送ります。'}
      </p>
      <SubmitButton pending={pending}>返信を送る</SubmitButton>
      <FormMessage state={state} />
    </form>
  );
}

/** 「AIに戻す」 */
export function ResumeAiForm({ conversationId }: { conversationId: string }) {
  const [state, formAction, pending] = useServerForm(resumeAiAction);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="conversationId" value={conversationId} />
      <SubmitButton pending={pending} variant="secondary">
        AIに戻す
      </SubmitButton>
      <FormMessage state={state} />
    </form>
  );
}

/** 「対応済みにする」。`seen` は画面に出した引き継ぎメモの件数（見た後に届いたメモは未対応のまま残る） */
export function ResolveHandoffForm({ conversationId, seen }: { conversationId: string; seen: number }) {
  const [state, formAction, pending] = useServerForm(resolveHandoffAction);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="conversationId" value={conversationId} />
      <input type="hidden" name="seen" value={seen} />
      <SubmitButton pending={pending} variant="secondary">
        対応済みにする
      </SubmitButton>
      <FormMessage state={state} />
    </form>
  );
}
