import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { NavFallback, NavLinks } from './_components/NavLinks';
import { Notices, UserBar } from './_components/UserBar';

export const metadata: Metadata = {
  title: { default: '管理画面 | お部屋探しAI', template: '%s | お部屋探しAI 管理画面' },
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: LayoutProps<'/admin'>) {
  return (
    <div className="flex min-h-screen flex-col bg-background text-fg">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-5xl flex-col gap-1 px-4 pt-3">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1">
            <Link href="/admin" className="text-base font-semibold">
              お部屋探しAI 管理画面
            </Link>
            <Suspense fallback={null}>
              <UserBar />
            </Suspense>
          </div>
          <Suspense fallback={<NavFallback />}>
            <NavLinks />
          </Suspense>
        </div>
      </header>
      <Suspense fallback={null}>
        <Notices />
      </Suspense>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:py-8">{children}</main>
    </div>
  );
}
