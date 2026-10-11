import Link from 'next/link';
import { LEGAL_UPDATED, SERVICE_NAME, type LegalDocument } from './content';

/**
 * プライバシーポリシー・利用規約の共通の見た目。読み物なので、細い一列（スマホ幅でそのまま読める）・行間広め・太字は 600 まで。
 * 色は globals.css の `@theme inline`（= src/constants/theme.ts のトークン）経由のクラスだけを使う。
 */
export function LegalPage({ document }: { document: LegalDocument }) {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:py-14">
      <p className="text-sm text-muted">
        <Link href="/" className="underline underline-offset-4">
          {SERVICE_NAME}
        </Link>
      </p>
      <h1 className="mt-3 text-2xl font-semibold leading-relaxed">{document.title}</h1>
      <p className="mt-1 text-sm text-muted">最終更新: {LEGAL_UPDATED}</p>
      <p className="mt-6 leading-relaxed">{document.lead}</p>

      {document.sections.map((section) => (
        <section key={section.heading} className="mt-10">
          <h2 className="text-lg font-semibold leading-relaxed">{section.heading}</h2>
          <div className="mt-3 space-y-3 leading-relaxed">
            {section.paragraphs?.map((text) => <p key={text}>{text}</p>)}
            {section.items && (
              <ul className="list-disc space-y-2 pl-5">
                {section.items.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            )}
            {section.closing?.map((text) => <p key={text}>{text}</p>)}
          </div>
        </section>
      ))}

      <nav aria-label="関連ページ" className="mt-14 flex flex-wrap gap-x-6 border-t border-line pt-6 text-sm">
        <Link href="/privacy" className="inline-flex min-h-11 items-center text-accent underline underline-offset-4">
          プライバシーポリシー
        </Link>
        <Link href="/terms" className="inline-flex min-h-11 items-center text-accent underline underline-offset-4">
          利用規約
        </Link>
        <Link href="/" className="inline-flex min-h-11 items-center text-accent underline underline-offset-4">
          トップへ
        </Link>
      </nav>
    </main>
  );
}
