/**
 * 会話の「いまの条件」（`Slots`）を優先度ごとにまとめる（純関数）。文言は利用者への返信と同じ（domain/labels.ts）。
 */
import { PRIORITY_LABEL } from '@/domain/messages';
import { listConditions } from '@/domain/slots';
import { PRIORITIES, type Priority, type Slots } from '@/domain/types';

export interface ConditionGroup {
  priority: Priority;
  /** 外せない / できれば / あれば */
  label: string;
  items: string[];
}

/** 外せない → できれば → あれば の順。条件が1つも無い優先度は出さない */
export function groupConditions(slots: Slots): ConditionGroup[] {
  const conditions = listConditions(slots);
  return PRIORITIES.map((priority) => ({
    priority,
    label: PRIORITY_LABEL[priority],
    items: conditions.filter((c) => c.priority === priority).map((c) => c.label),
  })).filter((group) => group.items.length > 0);
}
