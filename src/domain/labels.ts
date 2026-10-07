/**
 * 条件と金額の表示文言（純関数）。カード・回答文・管理画面で同じ言い方にそろえる。
 */
import type { ConditionRef, ScalarSlotKey, ScalarSlotValues, Slots } from './types';

/** 90000 → '9万'、93000 → '9.3万'、93500 → '9.35万' */
export function formatManYen(yen: number): string {
  const man = (yen / 10000).toFixed(2).replace(/\.?0+$/, '');
  return `${man}万`;
}

/** 93000 → '93,000円' */
export function formatYen(yen: number): string {
  return `${yen.toLocaleString('ja-JP')}円`;
}

/** '2026-11' → '2026年11月' */
export function formatYearMonth(ym: string): string {
  const [y, m] = ym.split('-');
  return `${y}年${Number(m)}月`;
}

/** '2026-11-05' → '2026年11月5日' */
export function formatDate(ymd: string): string {
  const [y, m, d] = ymd.split('-');
  return `${y}年${Number(m)}月${Number(d)}日`;
}

export function slotLabel<K extends ScalarSlotKey>(key: K, value: ScalarSlotValues[K]): string {
  switch (key) {
    case 'area': {
      const v = value as ScalarSlotValues['area'];
      return `${[...v.stations, ...v.wards].join('・')}エリア`;
    }
    case 'rentMax':
      return `予算${formatManYen(value as number)}円以内`;
    case 'layouts':
      return (value as ScalarSlotValues['layouts']).join('・');
    case 'walkMax':
      return `徒歩${value as number}分以内`;
    case 'floorMin':
      return `${value as number}階以上`;
    case 'moveIn':
      return `${formatYearMonth(value as string)}までに入居`;
    default:
      return String(key);
  }
}

/** スロットにある条件の文言。スロットに無い条件なら undefined */
export function conditionLabel(ref: ConditionRef, slots: Slots): string | undefined {
  if (ref.kind === 'tag') {
    return slots.tags.some((t) => t.value === ref.tag) ? ref.tag : undefined;
  }
  const slot = slots[ref.key];
  if (!slot) return undefined;
  return slotLabel(ref.key, slot.value as ScalarSlotValues[typeof ref.key]);
}
