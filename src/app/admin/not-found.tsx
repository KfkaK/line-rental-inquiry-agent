import Link from 'next/link';
import { cardClass } from './_components/ui';

export default function AdminNotFound() {
  return (
    <div className={`${cardClass} space-y-3`}>
      <p className="font-semibold">ページが見つかりません。</p>
      <p className="text-sm leading-relaxed text-muted">削除されたか、アドレスが違う可能性があります。</p>
      <Link href="/admin" className="inline-flex min-h-11 items-center text-accent underline underline-offset-4">
        引き継ぎ一覧へ
      </Link>
    </div>
  );
}
