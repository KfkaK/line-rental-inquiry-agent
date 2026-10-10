import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { optionalEnv } from '@/lib/env';
import { isAdminPreview } from '@/server/admin/previewFlag';
import { getAdminUser } from '@/server/admin/session';
import { logout } from '../actions';
import { LoginForm } from '../_components/LoginForm';
import { cardClass, hintClass } from '../_components/ui';

export const metadata: Metadata = { title: 'ログイン' };

export default function LoginPage({ searchParams }: PageProps<'/admin/login'>) {
  return (
    <div className="mx-auto max-w-md space-y-6">
      <h1 className="text-xl font-semibold">ログイン</h1>
      <Suspense fallback={<p className="text-sm text-muted">読み込み中…</p>}>
        <LoginContent searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function LoginContent({ searchParams }: { searchParams: PageProps<'/admin/login'>['searchParams'] }) {
  const { reason } = await searchParams;

  if (isAdminPreview()) {
    return (
      <div className={`${cardClass} space-y-3`}>
        <p className="leading-relaxed">プレビュー中のため、ログインは不要です。</p>
        <Link href="/admin" className="inline-flex min-h-11 items-center font-semibold text-accent underline underline-offset-4">
          管理画面へ
        </Link>
      </div>
    );
  }

  if (!optionalEnv('SUPABASE_URL') || !optionalEnv('SUPABASE_PUBLISHABLE_KEY')) {
    return (
      <div className={`${cardClass} space-y-2`}>
        <p className="font-semibold">ログインの設定がありません。</p>
        <p className={hintClass}>
          .env.local に SUPABASE_URL と SUPABASE_PUBLISHABLE_KEY を入れてください。ログインせずに見るには、開発環境で ADMIN_PREVIEW=1 を入れます。
        </p>
      </div>
    );
  }

  // 役割のあるアカウントで開いたら、ログイン画面ではなく管理画面へ（役割が無いアカウントはここで案内する）
  const user = await getAdminUser();
  if (user?.role) redirect('/admin');

  if (reason === 'norole' || user) {
    return (
      <div className={`${cardClass} space-y-4`}>
        <p className="leading-relaxed">このアカウントには管理画面の権限がありません。管理者に役割の付与を依頼してください。</p>
        <form action={logout}>
          <button
            type="submit"
            className="inline-flex min-h-11 items-center justify-center rounded-md border border-line-strong bg-surface px-5 text-sm font-semibold"
          >
            ログアウト
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className={cardClass}>
      <LoginForm />
    </div>
  );
}
