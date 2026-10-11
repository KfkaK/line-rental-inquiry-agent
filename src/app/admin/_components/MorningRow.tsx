import type { ReactNode } from 'react';
import Link from 'next/link';
import { isOpenAt } from '@/domain/businessHours';
import type { BusinessCalendar } from '@/domain/types';
import type { MorningItem } from '@/server/admin/morningList';
import { displayNameOf, formatCandidates, formatJstDateTime } from '../_lib/format';
import { describeHandoffNote } from '../_lib/notes';
import { Chip, StatusBadge } from './ui';

/** 1行に載せるメモの数と、1件あたりの字数（朝の一覧は1行で読めることが大事。詳しくは詳細画面） */
const MAX_NOTES = 3;
const NOTE_CHARS = 40;

/**
 * 朝の引き継ぎ一覧の1行。仮受付は /admin/viewings/{id}、引き継ぎ（仮受付の無い会話）は /admin/conversations/{id} へ。
 * 表示は 状態・時間外の印・デモの印（種まきしたデモ会話。本物の問い合わせと見分ける）・届いた時刻・表示名 / 希望物件・候補日時 / AIが聞き取れなかったこと。
 */
export function MorningRow({
  item,
  calendar,
  propertyNames,
}: {
  item: MorningItem;
  calendar: BusinessCalendar;
  /** 引き継ぎメモの対象物件の名前（物件 ID → 名前） */
  propertyNames: ReadonlyMap<string, string>;
}) {
  const notes = item.openNotes;
  const noteText = notes.slice(0, MAX_NOTES).map((n) => describeHandoffNote(n, NOTE_CHARS)).join(' / ');
  const moreNotes = notes.length > MAX_NOTES ? `（ほか ${notes.length - MAX_NOTES} 件）` : '';

  if (item.kind === 'viewing') {
    const v = item.viewing;
    return (
      <RowLink href={`/admin/viewings/${v.id}`}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <StatusBadge status={v.status} />
          {v.receivedOutsideHours && <Chip>時間外</Chip>}
          {v.isDemo && <Chip tone="outline">デモ</Chip>}
          <time dateTime={v.createdAt} className="text-sm text-muted">
            {formatJstDateTime(v.createdAt)}
          </time>
          <span className="font-semibold">{displayNameOf(v.displayName)}</span>
        </div>
        <p className="mt-2 text-sm leading-relaxed">
          <span className="font-semibold">{v.propertyName ?? v.propertyId}</span>
          <span className="text-muted"> / 候補: </span>
          {formatCandidates(v.candidateTimes)}
        </p>
        {notes.length > 0 && <p className="mt-1 text-sm leading-relaxed text-muted">AIが聞き取れなかったこと: {noteText}{moreNotes}</p>}
      </RowLink>
    );
  }

  const conversation = item.conversation;
  const targets = [...new Set(notes.flatMap((n) => n.propertyIds))].map((id) => propertyNames.get(id) ?? id);
  const outsideHours = !isOpenAt(new Date(item.at), calendar);
  return (
    <RowLink href={`/admin/conversations/${conversation.id}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Chip tone="outline">引き継ぎ</Chip>
        {outsideHours && <Chip>時間外</Chip>}
        {conversation.isDemo && <Chip tone="outline">デモ</Chip>}
        <time dateTime={item.at} className="text-sm text-muted">
          {formatJstDateTime(item.at)}
        </time>
        <span className="font-semibold">{displayNameOf(conversation.displayName)}</span>
      </div>
      {targets.length > 0 && (
        <p className="mt-2 text-sm leading-relaxed">
          <span className="text-muted">対象物件: </span>
          {targets.join('、')}
        </p>
      )}
      <p className="mt-1 text-sm leading-relaxed text-muted">AIが聞き取れなかったこと: {noteText}{moreNotes}</p>
    </RowLink>
  );
}

function RowLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <li>
      <Link href={href} className="block rounded-lg border border-line bg-surface p-4 hover:border-line-strong">
        {children}
      </Link>
    </li>
  );
}
