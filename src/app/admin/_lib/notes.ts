/**
 * 引き継ぎメモ（AI が答えずに担当者へ回した質問）の表示用の整形（純関数）。
 */
import { TOPIC_LABEL } from '@/domain/messages';
import type { HandoffNote } from '@/domain/types';

/**
 * 「AIが聞き取れなかったこと」の1件。話題が分かれば「空室状況: 『1番目は今空いてますか？』」、分からなければ質問だけ『…』。
 * 一覧の1行に収めるため、改行は空白にし、`maxChars` を超えたら切って「…」を付ける
 */
export function describeHandoffNote(note: HandoffNote, maxChars?: number): string {
  const flat = note.text.replace(/\s+/g, ' ').trim();
  const question = maxChars !== undefined && flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
  const quoted = `『${question}』`;
  return note.topic ? `${TOPIC_LABEL[note.topic]}: ${quoted}` : quoted;
}
