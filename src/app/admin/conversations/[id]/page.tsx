import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense, type ReactNode } from 'react';
import { PRIORITY_LABEL, formatViewingTime } from '@/domain/messages';
import { STAFF_REPLY_MAX_CHARS } from '@/domain/rules';
import { openHandoffNotes } from '@/domain/staff';
import { requireAdmin } from '@/server/admin/session';
import { ResolveHandoffForm, ResumeAiForm, StaffReplyForm } from '../../_components/ConversationActions';
import { MessageLog } from '../../_components/MessageLog';
import { cardClass, Chip, StatusBadge } from '../../_components/ui';
import { groupConditions } from '../../_lib/conditions';
import { displayNameOf, formatCandidates, formatJstDateTime } from '../../_lib/format';
import { CONVERSATION_STATE_LABEL } from '../../_lib/labels';
import { describeHandoffNote } from '../../_lib/notes';
import { aiResumeAt } from '../../_lib/resume';

export const metadata: Metadata = { title: '会話ログ' };

export default function ConversationPage({ params }: PageProps<'/admin/conversations/[id]'>) {
  return (
    <div className="space-y-6">
      <Link href="/admin/conversations" className="inline-flex min-h-11 items-center text-sm text-accent underline underline-offset-4">
        会話の一覧へ戻る
      </Link>
      <Suspense fallback={<p className="text-sm text-muted">読み込み中…</p>}>
        <ConversationContent params={params} />
      </Suspense>
    </div>
  );
}

async function ConversationContent({ params }: { params: PageProps<'/admin/conversations/[id]'>['params'] }) {
  const { id } = await params;
  const { user, repos } = await requireAdmin();
  // `lineUserId` を含む getById は管理画面では使わない（表示名だけを持つ getSummary）
  const conversation = await repos.conversations.getSummary(id);
  if (!conversation) notFound();
  const [messages, viewings] = await Promise.all([repos.messages.listByConversation(id), repos.viewingRequests.listByConversation(id)]);

  const canEdit = user.role === 'staff';
  const conditions = groupConditions(conversation.slots);
  const notes = conversation.handoffNotes;
  const openNotes = openHandoffNotes(notes, conversation.handoffResolvedCount);
  const resumeAt = aiResumeAt(conversation.lastStaffReplyAt);

  // 引き継ぎメモ・仮受付に出す物件名
  const propertyIds = [...new Set([...notes.flatMap((n) => n.propertyIds), ...viewings.map((v) => v.propertyId)])];
  const properties = propertyIds.length > 0 ? await repos.properties.getByIds(propertyIds) : [];
  const propertyNames = new Map(properties.map((p) => [p.id, p.name]));

  return (
    <>
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">{displayNameOf(conversation.displayName)}さんの会話</h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span>{CONVERSATION_STATE_LABEL[conversation.state]}</span>
          {conversation.isDemo && <Chip tone="outline">デモの会話</Chip>}
          <span className="text-muted">最終動作 {formatJstDateTime(conversation.updatedAt)}</span>
        </div>
      </div>

      <section aria-labelledby="ai-heading" className={`${cardClass} space-y-3`}>
        <h2 id="ai-heading" className="text-base font-semibold">
          AI の状態
        </h2>
        {conversation.aiPaused ? (
          <>
            <p className="leading-relaxed">
              <Chip tone="soft">停止中</Chip>
              <span className="ml-2 text-sm">
                {conversation.pausedAt ? `${formatJstDateTime(conversation.pausedAt)} に停止しました。` : '担当者の対応のため停止しています。'}
              </span>
            </p>
            <p className="text-sm leading-relaxed text-muted">
              {resumeAt
                ? `最終の担当者返信から24時間（${formatJstDateTime(resumeAt)}）で自動で再開します。`
                : '担当者の返信が無いため、自動では再開しません。「AIに戻す」で再開できます。'}
            </p>
            {canEdit && <ResumeAiForm conversationId={conversation.id} />}
          </>
        ) : (
          <p className="leading-relaxed">
            <Chip tone="plain">自動応答中</Chip>
            <span className="ml-2 text-sm text-muted">担当者が返信すると、AI の自動応答を止めます。</span>
          </p>
        )}
      </section>

      <section aria-labelledby="conditions-heading" className={`${cardClass} space-y-3`}>
        <h2 id="conditions-heading" className="text-base font-semibold">
          いまの条件
        </h2>
        {conditions.length === 0 ? (
          <p className="text-sm text-muted">まだ条件は伝えられていません。</p>
        ) : (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[6rem_1fr]">
            {conditions.map((group) => (
              <Group key={group.priority} label={PRIORITY_LABEL[group.priority]}>
                {group.items.join('、')}
              </Group>
            ))}
          </dl>
        )}
      </section>

      <section aria-labelledby="notes-heading" className={`${cardClass} space-y-3`}>
        <h2 id="notes-heading" className="text-base font-semibold">
          引き継ぎメモ
          <span className="ml-2 text-sm font-normal text-muted">AI が答えずに担当者へ回した質問</span>
        </h2>
        {notes.length === 0 ? (
          <p className="text-sm text-muted">引き継ぎメモはありません。</p>
        ) : (
          <ul className="space-y-2">
            {notes.map((note, i) => {
              const resolved = i < conversation.handoffResolvedCount;
              const names = note.propertyIds.map((pid) => propertyNames.get(pid) ?? pid);
              return (
                <li
                  key={`${i}-${note.at}`}
                  className={`rounded-md border p-3 text-sm leading-relaxed ${
                    resolved ? 'border-line text-muted' : 'border-accent bg-accent-soft text-fg'
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {resolved ? <Chip tone="plain">対応済み</Chip> : <Chip tone="solid">未対応</Chip>}
                    <span className={resolved ? '' : 'text-muted'}>{formatJstDateTime(note.at)}</span>
                  </div>
                  <p className={`mt-1 ${resolved ? '' : 'font-semibold'}`}>{describeHandoffNote(note)}</p>
                  {names.length > 0 && <p className="mt-1">対象物件: {names.join('、')}</p>}
                </li>
              );
            })}
          </ul>
        )}
        {canEdit && openNotes.length > 0 && <ResolveHandoffForm conversationId={conversation.id} seen={notes.length} />}
      </section>

      <section aria-labelledby="viewings-heading" className={`${cardClass} space-y-3`}>
        <h2 id="viewings-heading" className="text-base font-semibold">
          内見の仮受付
        </h2>
        {viewings.length === 0 ? (
          <p className="text-sm text-muted">この会話の仮受付はありません。</p>
        ) : (
          <ul className="space-y-2">
            {viewings.map((v) => (
              <li key={v.id}>
                <Link href={`/admin/viewings/${v.id}`} className="block rounded-md border border-line p-3 hover:border-line-strong">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <StatusBadge status={v.status} />
                    <span className="font-semibold">{propertyNames.get(v.propertyId) ?? v.propertyName ?? v.propertyId}</span>
                    <span className="text-sm text-muted">{formatJstDateTime(v.createdAt)} 受付</span>
                  </div>
                  <p className="mt-1 text-sm leading-relaxed">
                    {v.status === 'confirmed' && v.confirmedTime
                      ? `確定: ${formatViewingTime(v.confirmedTime)}`
                      : `候補: ${formatCandidates(v.candidateTimes)}`}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="log-heading" className="space-y-3">
        <h2 id="log-heading" className="text-base font-semibold">
          会話ログ
          <span className="ml-2 text-sm font-normal text-muted">{messages.length}件・古い順</span>
        </h2>
        <MessageLog messages={messages} />
      </section>

      <section aria-labelledby="reply-heading" className={`${cardClass} space-y-3`}>
        <h2 id="reply-heading" className="text-base font-semibold">
          手動で返信する
        </h2>
        {canEdit ? (
          <StaffReplyForm conversationId={conversation.id} isDemo={conversation.isDemo} />
        ) : (
          <p className="text-sm text-muted">
            閲覧用のアカウントでは返信できません（担当者の返信は {STAFF_REPLY_MAX_CHARS} 字までです）。
          </p>
        )}
      </section>
    </>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="font-semibold">{label}</dt>
      <dd className="leading-relaxed">{children}</dd>
    </>
  );
}
