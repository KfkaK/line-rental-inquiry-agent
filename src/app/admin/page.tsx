import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { displayNameOf, formatJstDateTime } from './_lib/format';
import { aiResumeAt } from './_lib/resume';
import { MorningRow } from './_components/MorningRow';
import { Chip } from './_components/ui';
import { loadMorningList, type MorningItem } from '@/server/admin/morningList';
import { requireAdmin } from '@/server/admin/session';

export const metadata: Metadata = { title: '引き継ぎ一覧' };

export default function MorningPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">朝の引き継ぎ一覧</h1>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          前回の営業終了以降に届いた案件と、それ以前で手が要るものです。届いた順（古い順）に並べているので、上から順に対応できます。
        </p>
      </div>
      <Suspense fallback={<p className="text-sm text-muted">読み込み中…</p>}>
        <MorningContent />
      </Suspense>
    </div>
  );
}

async function MorningContent() {
  const { repos } = await requireAdmin();
  const now = new Date();
  const calendar = await repos.businessCalendar.get();
  const [list, paused] = await Promise.all([
    loadMorningList(repos, now, calendar),
    // 担当者が手動返信して AI を止めている会話（人の会話が続いている。利用者の返信はメールでも知らせる）
    repos.conversations.listRecent({ aiPaused: true, limit: 50 }),
  ]);

  // 引き継ぎ（仮受付の無い会話）の行に、メモの対象物件の名前を出す
  const propertyIds = [
    ...new Set(
      [...list.overnight, ...list.earlier].flatMap((item) => (item.kind === 'handoff' ? item.openNotes.flatMap((n) => n.propertyIds) : [])),
    ),
  ];
  const properties = propertyIds.length > 0 ? await repos.properties.getByIds(propertyIds) : [];
  const propertyNames = new Map(properties.map((p) => [p.id, p.name]));

  const section = (items: MorningItem[], empty: string) =>
    items.length === 0 ? (
      <p className="rounded-lg border border-line bg-surface p-4 text-sm text-muted">{empty}</p>
    ) : (
      <ul className="space-y-3">
        {items.map((item) => (
          <MorningRow
            key={item.kind === 'viewing' ? `v-${item.viewing.id}` : `h-${item.conversation.id}`}
            item={item}
            calendar={calendar}
            propertyNames={propertyNames}
          />
        ))}
      </ul>
    );

  return (
    <>
      <section aria-labelledby="overnight-heading" className="space-y-3">
        <h2 id="overnight-heading" className="text-base font-semibold">
          夜間・休日分（{formatJstDateTime(list.since)} 以降）
          <span className="ml-2 text-sm font-normal text-muted">{list.overnight.length}件</span>
        </h2>
        {section(list.overnight, '夜間・休日に届いた案件はありません')}
      </section>
      <section aria-labelledby="earlier-heading" className="space-y-3">
        <h2 id="earlier-heading" className="text-base font-semibold">
          それ以前の未対応
          <span className="ml-2 text-sm font-normal text-muted">{list.earlier.length}件</span>
        </h2>
        {section(list.earlier, 'それ以前の未対応はありません')}
      </section>
      <section aria-labelledby="paused-heading" className="space-y-3">
        <h2 id="paused-heading" className="text-base font-semibold">
          担当者が対応中の会話（AI 停止中）
          <span className="ml-2 text-sm font-normal text-muted">{paused.length}件</span>
        </h2>
        {paused.length === 0 ? (
          <p className="rounded-lg border border-line bg-surface p-4 text-sm text-muted">AI を止めている会話はありません</p>
        ) : (
          <ul className="space-y-3">
            {paused.map((c) => {
              const resumeAt = aiResumeAt(c.lastStaffReplyAt);
              return (
                <li key={c.id}>
                  <Link href={`/admin/conversations/${c.id}`} className="block rounded-lg border border-line bg-surface p-4 hover:border-line-strong">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <Chip tone="soft">AI停止中</Chip>
                      {c.isDemo && <Chip tone="outline">デモ</Chip>}
                      <span className="font-semibold">{displayNameOf(c.displayName)}</span>
                    </div>
                    <p className="mt-2 text-sm leading-relaxed text-muted">
                      最終動作 <time dateTime={c.updatedAt}>{formatJstDateTime(c.updatedAt)}</time>
                      {resumeAt ? ` ・ ${formatJstDateTime(resumeAt)} に AI が自動で再開` : ' ・ 「AIに戻す」まで停止'}
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
