import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { openHandoffNotes } from '@/domain/staff';
import { requireAdmin } from '@/server/admin/session';
import { Chip } from '../_components/ui';
import { displayNameOf, formatJstDateTime } from '../_lib/format';
import { CONVERSATION_STATE_LABEL } from '../_lib/labels';

export const metadata: Metadata = { title: '会話' };

/** 一覧に出す件数（新しい順） */
const LIMIT = 50;

export default function ConversationsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">会話</h1>
        <p className="mt-1 text-sm leading-relaxed text-muted">最終動作の新しい順に、直近 {LIMIT} 件を表示します。</p>
      </div>
      <Suspense fallback={<p className="text-sm text-muted">読み込み中…</p>}>
        <ConversationList />
      </Suspense>
    </div>
  );
}

async function ConversationList() {
  const { repos } = await requireAdmin();
  const conversations = await repos.conversations.listRecent({ limit: LIMIT });
  if (conversations.length === 0) {
    return <p className="rounded-lg border border-line bg-surface p-4 text-sm text-muted">会話はまだありません。</p>;
  }
  return (
    <ul className="space-y-3">
      {conversations.map((c) => {
        const openNotes = openHandoffNotes(c.handoffNotes, c.handoffResolvedCount).length;
        return (
          <li key={c.id}>
            <Link href={`/admin/conversations/${c.id}`} className="block rounded-lg border border-line bg-surface p-4 hover:border-line-strong">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-semibold">{displayNameOf(c.displayName)}</span>
                <span className="text-sm text-muted">{CONVERSATION_STATE_LABEL[c.state]}</span>
                {c.aiPaused && <Chip tone="soft">AI停止中</Chip>}
                {openNotes > 0 && <Chip tone="solid">未対応のメモ {openNotes}件</Chip>}
                {c.isDemo && <Chip tone="outline">デモ</Chip>}
              </div>
              <p className="mt-2 text-sm text-muted">
                最終動作 <time dateTime={c.updatedAt}>{formatJstDateTime(c.updatedAt)}</time>
              </p>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
