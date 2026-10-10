/**
 * 管理画面の共通の部品とクラス。色は globals.css の `@theme inline`（= src/constants/theme.ts のトークン）経由のクラスだけを使う。
 * 太字は font-semibold（600）まで。サーバー・クライアントどちらのコンポーネントからも使える（状態を持たない）。
 */
import type { ReactNode } from 'react';
import { VIEWING_STATUS_LABEL } from '@/domain/staff';
import type { ViewingStatus } from '@/domain/types';

export const cardClass = 'rounded-lg border border-line bg-surface p-4 sm:p-5';

/** 入力欄。16px（text-base）にして、スマホで入力時に拡大されないようにする */
export const inputClass =
  'block w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-base text-fg placeholder:text-muted read-only:bg-sunken read-only:text-muted';

export const labelClass = 'mb-1 block text-sm font-semibold';

export const hintClass = 'text-sm text-muted leading-relaxed';

// ---------- 印（チップ） ----------

type ChipTone = 'solid' | 'soft' | 'plain' | 'outline' | 'danger';

const CHIP_TONE: Record<ChipTone, string> = {
  solid: 'bg-accent text-on-accent',
  soft: 'bg-accent-soft text-accent',
  plain: 'bg-sunken text-fg',
  outline: 'border border-line-strong text-fg',
  danger: 'bg-danger-soft text-danger',
};

export function Chip({ tone = 'plain', children }: { tone?: ChipTone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded px-2 py-0.5 text-xs font-semibold leading-normal ${CHIP_TONE[tone]}`}>
      {children}
    </span>
  );
}

const STATUS_TONE: Record<ViewingStatus, ChipTone> = {
  pending: 'solid',
  in_progress: 'soft',
  confirmed: 'outline',
  rejected: 'plain',
};

/** 内見の仮受付の状態。手がまだ要る「未対応」だけを塗りつぶす */
export function StatusBadge({ status }: { status: ViewingStatus }) {
  return <Chip tone={STATUS_TONE[status]}>{VIEWING_STATUS_LABEL[status]}</Chip>;
}

// ---------- ボタン ----------

type ButtonVariant = 'primary' | 'secondary' | 'danger';

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent border border-accent',
  secondary: 'bg-surface text-fg border border-line-strong',
  danger: 'bg-surface text-danger border border-danger',
};

/** 送信ボタン。送信中は無効にして「送信中…」を出す（`pending` は useActionState の値） */
export function SubmitButton({
  pending,
  variant = 'primary',
  children,
}: {
  pending: boolean;
  variant?: ButtonVariant;
  children: ReactNode;
}) {
  return (
    <button
      type="submit"
      disabled={pending}
      className={`inline-flex min-h-11 items-center justify-center rounded-md px-5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60 ${BUTTON_VARIANT[variant]}`}
    >
      {pending ? '送信中…' : children}
    </button>
  );
}
