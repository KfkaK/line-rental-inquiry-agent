/**
 * 引き継ぎメモ（AI が答えずに担当者へ回した質問）の表示用の整形（純関数）。
 */
import { TOPIC_LABEL } from '@/domain/messages';
import type { HandoffNote } from '@/domain/types';

/** 会話ログの保存期間を過ぎて発話の原文を消したメモ（SQL の purge_old_messages が text を空にする）の表示 */
export const EXPIRED_NOTE_TEXT = '（保存期間を過ぎたため削除）';

/**
 * 「AIが聞き取れなかったこと」の1件。話題が分かれば「空室状況: 『1番目は今空いてますか？』」、分からなければ質問だけ『…』。
 * 一覧の1行に収めるため、改行は空白にし、`maxChars` を超えたら切って「…」を付ける。原文を消したメモは `EXPIRED_NOTE_TEXT`
 */
export function describeHandoffNote(note: HandoffNote, maxChars?: number): string {
  const flat = note.text.replace(/\s+/g, ' ').trim();
  const question = maxChars !== undefined && flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
  const quoted = flat === '' ? EXPIRED_NOTE_TEXT : `『${question}』`;
  return note.topic ? `${TOPIC_LABEL[note.topic]}: ${quoted}` : quoted;
}
