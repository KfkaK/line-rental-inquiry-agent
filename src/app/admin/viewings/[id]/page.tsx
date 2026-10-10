import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense, type ReactNode } from 'react';
import { formatManYen } from '@/domain/labels';
import { formatViewingTime } from '@/domain/messages';
import { monthlyCost } from '@/domain/search';
import { openHandoffNotes, VIEWING_STATUS_LABEL } from '@/domain/staff';
import type { Property, ViewingStatus } from '@/domain/types';
import { requireAdmin } from '@/server/admin/session';
import { ViewingActions } from '../../_components/ViewingActions';
import { cardClass, Chip, StatusBadge } from '../../_components/ui';
import { candidateTimePart, displayNameOf, formatJstDateTime } from '../../_lib/format';
import { describeHandoffNote } from '../../_lib/notes';

export const metadata: Metadata = { title: '内見の仮受付' };

export default function ViewingPage({ params }: PageProps<'/admin/viewings/[id]'>) {
  return (
    <div className="space-y-6">
      <Link href="/admin" className="inline-flex min-h-11 items-center text-sm text-accent underline underline-offset-4">
        引き継ぎ一覧へ戻る
      </Link>
      <Suspense fallback={<p className="text-sm text-muted">読み込み中…</p>}>
        <ViewingContent params={params} />
      </Suspense>
    </div>
  );
}

async function ViewingContent({ params }: { params: PageProps<'/admin/viewings/[id]'>['params'] }) {
  const { id } = await params;
  const { user, repos } = await requireAdmin();
  const viewing = await repos.viewingRequests.getById(id);
  if (!viewing) notFound();
  const [property] = await repos.properties.getByIds([viewing.propertyId]);
  const openNotes = openHandoffNotes(viewing.handoffNotes, viewing.handoffResolvedCount);
  const canEdit = user.role === 'staff';

  return (
    <>
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">内見の仮受付</h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <StatusBadge status={viewing.status} />
          {viewing.receivedOutsideHours && <Chip>時間外に受付</Chip>}
          {viewing.isDemo && <Chip tone="outline">デモの会話</Chip>}
        </div>
      </div>

      <section aria-labelledby="summary-heading" className={`${cardClass} space-y-4`}>
        <h2 id="summary-heading" className="text-base font-semibold">
          受付の内容
        </h2>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[8rem_1fr]">
          <Row label="表示名">{displayNameOf(viewing.displayName)}</Row>
          <Row label="届いた時刻">{formatJstDateTime(viewing.createdAt)}</Row>
          <Row label="希望物件">
            <PropertySummary property={property} fallbackName={viewing.propertyName ?? viewing.propertyId} propertyId={viewing.propertyId} />
          </Row>
          <Row label="候補日時">
            <ul className="space-y-1">
              {viewing.candidateTimes.map((time) => (
                <li key={time}>{formatViewingTime(time)}</li>
              ))}
            </ul>
          </Row>
          <Row label="会話">
            <Link href={`/admin/conversations/${viewing.conversationId}`} className="text-accent underline underline-offset-4">
              会話ログを見る
            </Link>
          </Row>
        </dl>
      </section>

      <section aria-labelledby="notes-heading" className={`${cardClass} space-y-3`}>
        <h2 id="notes-heading" className="text-base font-semibold">
          AIが聞き取れなかったこと
        </h2>
        {openNotes.length === 0 ? (
          <p className="text-sm text-muted">未対応のメモはありません。</p>
        ) : (
          <ul className="space-y-2 text-sm leading-relaxed">
            {openNotes.map((note, i) => (
              <li key={`${i}-${note.at}`}>
                <span className="text-muted">{formatJstDateTime(note.at)}　</span>
                {describeHandoffNote(note)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Result
        status={viewing.status}
        confirmedTime={viewing.confirmedTime}
        staffNote={viewing.staffNote}
        updatedAt={viewing.updatedAt}
        isDemo={viewing.isDemo}
      />

      {canEdit ? (
        <ViewingActions
          viewingRequestId={viewing.id}
          status={viewing.status}
          candidates={viewing.candidateTimes.map((value) => ({ value, label: formatViewingTime(value), time: candidateTimePart(value) }))}
          isDemo={viewing.isDemo}
        />
      ) : (
        <p className="text-sm text-muted">閲覧用のアカウントでは、確定・却下などの操作はできません。</p>
      )}
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="leading-relaxed">{children}</dd>
    </>
  );
}

function PropertySummary({ property, fallbackName, propertyId }: { property: Property | undefined; fallbackName: string; propertyId: string }) {
  if (!property) {
    return (
      <span>
        {fallbackName}（{propertyId}）
      </span>
    );
  }
  const access = property.access[0];
  return (
    <div className="space-y-1">
      <p className="font-semibold">
        {property.name}
        <span className="ml-2 text-sm font-normal text-muted">{property.id}</span>
      </p>
      <p>
        月額 {formatManYen(monthlyCost(property))}円（家賃 {property.rent.toLocaleString('ja-JP')}円 + 管理費 {property.managementFee.toLocaleString('ja-JP')}円）
        ・{property.layout}
        {access && `・${access.station}駅 徒歩${access.walkMin}分`}
      </p>
    </div>
  );
}

/** 確定・却下した後の結果。それ以外は何も出さない */
function Result({
  status,
  confirmedTime,
  staffNote,
  updatedAt,
  isDemo,
}: {
  status: ViewingStatus;
  confirmedTime: string | null;
  staffNote: string | null;
  updatedAt: string;
  isDemo: boolean;
}) {
  if (status !== 'confirmed' && status !== 'rejected') return null;
  const sent = isDemo
    ? 'デモの会話のため LINE には送っていません。'
    : '利用者に送った文は会話ログで確かめられます（LINE に送れなかったときは会話ログに残りません）。';
  return (
    <section aria-labelledby="result-heading" className={`${cardClass} space-y-3`}>
      <h2 id="result-heading" className="text-base font-semibold">
        {VIEWING_STATUS_LABEL[status]}した結果
      </h2>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[8rem_1fr]">
        {status === 'confirmed' && confirmedTime && <Row label="確定した日時">{formatViewingTime(confirmedTime)}</Row>}
        <Row label={status === 'confirmed' ? 'ひとこと' : '却下の理由'}>
          {staffNote ? <span className="whitespace-pre-wrap">{staffNote}</span> : <span className="text-muted">なし</span>}
        </Row>
        <Row label="対応した時刻">{formatJstDateTime(updatedAt)}</Row>
      </dl>
      <p className="text-sm text-muted">{sent}</p>
    </section>
  );
}
