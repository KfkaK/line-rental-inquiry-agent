import type { FormState } from '../actions';

/**
 * Server Action の結果の文。読み上げされるよう、結果が無いときも領域だけは出しておく。失敗は danger の色。
 * `errorsOnly`: 成功の文を別の場所に出すとき、ここでは失敗だけを出す
 */
export function FormMessage({ state, errorsOnly = false }: { state: FormState; errorsOnly?: boolean }) {
  const hidden = errorsOnly && state?.ok;
  return (
    <p role="status" className={`text-sm leading-relaxed empty:sr-only ${state && !state.ok ? 'font-semibold text-danger' : 'text-fg'}`}>
      {hidden ? null : state?.message}
    </p>
  );
}
