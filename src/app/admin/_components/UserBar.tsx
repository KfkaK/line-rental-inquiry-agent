import type { ReactNode } from 'react';
import { logout } from '../actions';
import { currentUser } from '../_lib/currentUser';
import { ADMIN_ROLE_LABEL } from '../_lib/labels';
import { Chip } from './ui';

/** ヘッダーの右側: ログイン中のメールと役割・ログアウト。cookie を読むので <Suspense> の内側に置く */
export async function UserBar() {
  const user = await currentUser();
  if (!user) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      {user.email && <span className="break-all text-muted">{user.email}</span>}
      <Chip tone="plain">{user.role ? ADMIN_ROLE_LABEL[user.role] : '権限なし'}</Chip>
      {!user.preview && (
        <form action={logout}>
          <button type="submit" className="min-h-11 rounded-md px-2 text-sm font-semibold text-accent underline underline-offset-4">
            ログアウト
          </button>
        </form>
      )}
    </div>
  );
}

/** ヘッダーの下の帯: プレビュー中・閲覧用アカウントのとき */
export async function Notices() {
  const user = await currentUser();
  if (!user) return null;
  return (
    <>
      {user.preview && <Banner>プレビュー（インメモリのデモデータ。LINE には送りません）</Banner>}
      {user.role === 'viewer' && <Banner>閲覧用アカウントです。デモの会話だけを表示し、確定・返信などの操作はできません。</Banner>}
    </>
  );
}

function Banner({ children }: { children: ReactNode }) {
  return (
    <div role="note" className="border-b border-line bg-sunken">
      <p className="mx-auto max-w-5xl px-4 py-2 text-sm leading-relaxed">{children}</p>
    </div>
  );
}
