/**
 * 物件 CSV の取込で、CSV の行に tags を付けて Property にする（純関数）。
 * 備考から抽出したタグ（辞書・LLM・正解ファイルのいずれか）に、数値列から決まる「敷金なし」「礼金なし」を足す。
 */
import { TAGS, type Property, type Tag } from '@/domain/types';
import type { PropertyRow } from './properties';

/** 敷金・礼金が 0 か月なら付けるタグ（備考からは抽出しない） */
export function numericTags(row: Pick<PropertyRow, 'depositMonths' | 'keyMoneyMonths'>): Tag[] {
  const tags: Tag[] = [];
  if (row.depositMonths === 0) tags.push('敷金なし');
  if (row.keyMoneyMonths === 0) tags.push('礼金なし');
  return tags;
}

/**
 * 行にタグを付ける。noteTags に無い行は備考のタグなし。
 * 「敷金なし」「礼金なし」は noteTags に入っていても数値列で決め直す（備考と数値が食い違ったら数値を正とする）
 */
export function attachTags(rows: readonly PropertyRow[], noteTags: ReadonlyMap<string, readonly Tag[]>): Property[] {
  return rows.map((row) => {
    const fromNote = (noteTags.get(row.id) ?? []).filter((t) => t !== '敷金なし' && t !== '礼金なし');
    const set = new Set<Tag>([...fromNote, ...numericTags(row)]);
    return { ...row, tags: TAGS.filter((t) => set.has(t)) };
  });
}
