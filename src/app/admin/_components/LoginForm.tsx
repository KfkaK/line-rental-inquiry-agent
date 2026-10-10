'use client';

import { useState } from 'react';
import { login } from '../actions';
import { FormMessage } from './FormMessage';
import { inputClass, labelClass, SubmitButton } from './ui';
import { useServerForm } from './useServerForm';

export function LoginForm() {
  // 失敗したときにメールアドレスが消えないよう制御コンポーネントにする（パスワードは毎回入れ直す）
  const [email, setEmail] = useState('');
  const [state, formAction, pending] = useServerForm(login);

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label htmlFor="email" className={labelClass}>
          メールアドレス
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="password" className={labelClass}>
          パスワード
        </label>
        <input id="password" name="password" type="password" autoComplete="current-password" required className={inputClass} />
      </div>
      <SubmitButton pending={pending}>ログイン</SubmitButton>
      <FormMessage state={state} />
    </form>
  );
}
