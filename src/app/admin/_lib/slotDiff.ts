/**
 * 会話ログの「そのターンの条件の差分」（`SlotOp[]`）を担当者向けの日本語にする（純関数）。
 * 例: 「予算: 9万円まで（外せない）」「オートロックを外す」「静かを「できれば」にする」
 */
import { PRIORITY_LABEL } from '@/domain/messages';
import { formatManYen, formatYearMonth } from '@/domain/labels';
import type { Priority, ScalarSlotKey, ScalarSlotValues, SlotOp } from '@/domain/types';

export const SLOT_KEY_LABEL: Record<ScalarSlotKey, string> = {
  area: 'エリア',
  rentMax: '予算',
  layouts: '間取り',
  walkMax: '駅徒歩',
  floorMin: '階数',
  moveIn: '入居時期',
};

/** 値の言い方（ラベルと並べて「予算: 9万円まで」の形にするので、スロットの文言（labels.ts の slotLabel）とは別にする） */
function valueText<K extends ScalarSlotKey>(key: K, value: ScalarSlotValues[K]): string {
  switch (key) {
    case 'area': {
      const v = value as ScalarSlotValues['area'];
      return [...v.stations, ...v.wards].join('・');
    }
    case 'rentMax':
      return `${formatManYen(value as number)}円まで`;
    case 'layouts':
      return (value as ScalarSlotValues['layouts']).join('・');
    case 'walkMax':
      return `${value as number}分以内`;
    case 'floorMin':
      return `${value as number}階以上`;
    case 'moveIn':
      return `${formatYearMonth(value as string)}までに入居`;
  }
  return String(value);
}

function priorityText(priority: Priority | undefined): string {
  return priority ? `（${PRIORITY_LABEL[priority]}）` : '';
}

export function describeSlotOp(op: SlotOp): string {
  switch (op.op) {
    case 'set':
      return `${SLOT_KEY_LABEL[op.key]}: ${valueText(op.key, op.value)}${priorityText(op.priority)}`;
    case 'unset':
      return `${SLOT_KEY_LABEL[op.key]}の指定を外す`;
    case 'setPriority':
      return `${SLOT_KEY_LABEL[op.key]}を「${PRIORITY_LABEL[op.priority]}」にする`;
    case 'addTag':
      return `${op.tag}を追加${priorityText(op.priority)}`;
    case 'removeTag':
      return `${op.tag}を外す`;
    case 'setTagPriority':
      return `${op.tag}を「${PRIORITY_LABEL[op.priority]}」にする`;
  }
}

export function describeSlotDiff(ops: readonly SlotOp[]): string[] {
  return ops.map(describeSlotOp);
}
