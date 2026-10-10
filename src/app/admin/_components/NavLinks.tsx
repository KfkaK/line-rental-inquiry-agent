'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ITEMS = [
  { href: '/admin', label: '引き継ぎ一覧', section: ['/admin/viewings'] },
  { href: '/admin/conversations', label: '会話', section: [] },
  { href: '/admin/settings', label: '営業時間', section: [] },
] as const;

function isActive(pathname: string, item: (typeof ITEMS)[number]): boolean {
  if (item.href === '/admin') return pathname === '/admin' || item.section.some((s) => pathname.startsWith(s));
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/**
 * ナビゲーション。いまいるページに aria-current を付ける。
 * 動的な URL（/admin/viewings/[id] など）では、パスがリクエストまで分からず usePathname が待つので、使う側で <Suspense> に入れる
 * （待つあいだは `NavFallback`。リンクだけ出す）。
 */
export function NavLinks() {
  return <NavList pathname={usePathname()} />;
}

export function NavFallback() {
  return <NavList pathname={null} />;
}

function NavList({ pathname }: { pathname: string | null }) {
  return (
    <nav aria-label="管理画面" className="-mx-1 flex gap-1 overflow-x-auto">
      {ITEMS.map((item) => {
        const active = pathname !== null && isActive(pathname, item);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={`inline-flex min-h-11 items-center whitespace-nowrap rounded-md px-3 text-sm ${
              active ? 'bg-accent-soft font-semibold text-accent' : 'text-fg'
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
