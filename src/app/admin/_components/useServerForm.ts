'use client';

import { useActionState } from 'react';
import type { FormState } from '../actions';

type ServerFormAction = (prev: FormState, formData: FormData) => Promise<FormState>;

/**
 * `useActionState` に Server Action を繋ぐ。成功したときだけ `onSuccess(結果の文)` を呼ぶ（入力欄を空にする・親に知らせるなど）。
 * `<form action>` は送信が終わると未制御の入力欄を初期値に戻すので、失敗しても入力が消えないよう、
 * 文の入力欄は useState で持つ制御コンポーネントにする。
 */
export function useServerForm(action: ServerFormAction, onSuccess?: (message: string) => void) {
  return useActionState(async (prev: FormState, formData: FormData): Promise<FormState> => {
    const next = await action(prev, formData);
    if (next?.ok) onSuccess?.(next.message);
    return next;
  }, null);
}
