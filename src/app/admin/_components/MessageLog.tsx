import type { Message, MessageRole } from '@/lib/db';
import { formatCostUsd, formatJstDateTime, formatLatency } from '../_lib/format';
import { INTENT_LABEL, MESSAGE_ROLE_LABEL } from '../_lib/labels';
import { describeSlotDiff } from '../_lib/slotDiff';
import { Chip } from './ui';

const ROLE_TONE = { user: 'outline', ai: 'soft', staff: 'solid' } as const satisfies Record<MessageRole, 'outline' | 'soft' | 'solid'>;

/** 発言者ごとに枠を変える。利用者は左、AI と担当者は右に寄せる（幅の広い画面だけ） */
const ROLE_BOX: Record<MessageRole, string> = {
  user: 'border-line bg-surface sm:mr-12',
  ai: 'border-line bg-sunken sm:ml-12',
  staff: 'border-accent bg-accent-soft sm:ml-12',
};

/** 会話ログ（時系列）。AI の行には 意図・そのターンの条件の差分・根拠検証の差し替え・応答時間・費用 を小さく添える */
export function MessageLog({ messages }: { messages: Message[] }) {
  if (messages.length === 0) return <p className="text-sm text-muted">まだメッセージはありません。</p>;
  return (
    <ol className="space-y-3">
      {messages.map((m) => (
        <li key={m.id} className={`rounded-lg border p-3 sm:p-4 ${ROLE_BOX[m.role]}`}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Chip tone={ROLE_TONE[m.role]}>{MESSAGE_ROLE_LABEL[m.role]}</Chip>
            <time dateTime={m.createdAt} className="text-xs text-muted">
              {formatJstDateTime(m.createdAt)}
            </time>
          </div>
          <p className="mt-2 whitespace-pre-wrap break-words leading-relaxed">{m.text}</p>
          {m.role === 'ai' && <AiDetails message={m} />}
        </li>
      ))}
    </ol>
  );
}

function AiDetails({ message }: { message: Message }) {
  const diff = message.slotDiff ? describeSlotDiff(message.slotDiff) : [];
  const meta = [
    message.intent ? `意図: ${INTENT_LABEL[message.intent]}` : null,
    message.latencyMs !== null ? `応答 ${formatLatency(message.latencyMs)}` : null,
    message.costUsd > 0 ? `費用 ${formatCostUsd(message.costUsd)}` : null,
  ].filter((part): part is string => part !== null);

  if (meta.length === 0 && diff.length === 0 && message.verification !== 'replaced') return null;
  return (
    <div className="mt-2 space-y-1 border-t border-line pt-2 text-xs leading-relaxed text-muted">
      {message.verification === 'replaced' && (
        <p>
          <Chip tone="danger">根拠検証で差し替え</Chip>
          <span className="ml-2">回答が物件の記載と一致しなかったため、定型の引き継ぎ文に差し替えました。</span>
        </p>
      )}
      {diff.length > 0 && <p>条件の変更: {diff.join(' / ')}</p>}
      {meta.length > 0 && <p>{meta.join(' ・ ')}</p>}
    </div>
  );
}
