'use client';

import { cardClass, hintClass } from './_components/ui';

/** 画面を読み込めなかったとき（設定の不足・DB の失敗など）。中身は本番では伏せられるので、再試行を案内する */
export default function AdminError({ reset }: { reset: () => void }) {
  return (
    <div className={`${cardClass} space-y-3`} role="alert">
      <p className="font-semibold">画面を読み込めませんでした。</p>
      <p className={hintClass}>時間をおいてもう一度お試しください。続くときは、環境変数（Supabase の設定）を確かめてください。</p>
      <button
        type="button"
        onClick={() => reset()}
        className="inline-flex min-h-11 items-center rounded-md border border-line-strong bg-surface px-5 text-sm font-semibold"
      >
        もう一度読み込む
      </button>
    </div>
  );
}
