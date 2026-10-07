/**
 * 条件スロットの差分更新（純関数）。LLM の条件抽出が返す SlotOp[] を現在のスロットに当てる。
 * 条件の変更も優先度の変更（「やっぱり2階以上は必須」）も同じ経路で扱う（DESIGN.md 3.2.1）。
 */
import { conditionLabel } from './labels';
import { DEFAULT_PRIORITY } from './rules';
import {
  SCALAR_SLOT_KEYS,
  type ConditionRef,
  type Priority,
  type ScalarSlotKey,
  type SlotOp,
  type Slots,
} from './types';

export function emptySlots(): Slots {
  return { tags: [] };
}

function cloneSlots(slots: Slots): Slots {
  return JSON.parse(JSON.stringify(slots)) as Slots;
}

/**
 * 差分を順に当てた新しいスロットを返す（元は変えない）。
 * - set: 値を置き換える。priority 省略時は既存の優先度を保ち、新規なら DEFAULT_PRIORITY
 * - setPriority / setTagPriority: スロットに無い条件は無視する（条件を足すのは set / addTag）
 * - addTag: 既にあれば priority 指定時だけ優先度を更新する
 */
export function applySlotOps(slots: Slots, ops: readonly SlotOp[]): Slots {
  const next = cloneSlots(slots);
  for (const op of ops) {
    switch (op.op) {
      case 'set': {
        const existing = next[op.key];
        const priority = op.priority ?? existing?.priority ?? DEFAULT_PRIORITY[op.key];
        // key と value の対応は SlotOp の型で保証されている
        (next as Record<ScalarSlotKey, unknown>)[op.key] = { value: op.value, priority };
        break;
      }
      case 'unset':
        delete next[op.key];
        break;
      case 'setPriority': {
        const existing = next[op.key];
        if (existing) existing.priority = op.priority;
        break;
      }
      case 'addTag': {
        const existing = next.tags.find((t) => t.value === op.tag);
        if (existing) {
          if (op.priority) existing.priority = op.priority;
        } else {
          next.tags.push({ value: op.tag, priority: op.priority ?? DEFAULT_PRIORITY.tag });
        }
        break;
      }
      case 'removeTag':
        next.tags = next.tags.filter((t) => t.value !== op.tag);
        break;
      case 'setTagPriority': {
        const existing = next.tags.find((t) => t.value === op.tag);
        if (existing) existing.priority = op.priority;
        break;
      }
    }
  }
  return next;
}

export interface ConditionSummary {
  ref: ConditionRef;
  priority: Priority;
  label: string;
}

/** スロットにある条件の一覧（エリア・予算・間取り・徒歩・階・入居時期・タグの順） */
export function listConditions(slots: Slots): ConditionSummary[] {
  const result: ConditionSummary[] = [];
  for (const key of SCALAR_SLOT_KEYS) {
    const slot = slots[key];
    if (!slot) continue;
    const ref: ConditionRef = { kind: 'slot', key };
    result.push({ ref, priority: slot.priority, label: conditionLabel(ref, slots)! });
  }
  for (const tag of slots.tags) {
    result.push({ ref: { kind: 'tag', tag: tag.value }, priority: tag.priority, label: tag.value });
  }
  return result;
}

/** 検索に最低限要る条件（エリアと予算）のうち、まだ無いもの。揃ったら即検索する（DESIGN.md 2.1） */
export function missingForSearch(slots: Slots): ScalarSlotKey[] {
  const required: ScalarSlotKey[] = ['area', 'rentMax'];
  return required.filter((key) => !slots[key]);
}

/** 条件1つの優先度を変える差分 */
export function priorityOp(ref: ConditionRef, priority: Priority): SlotOp {
  return ref.kind === 'tag'
    ? { op: 'setTagPriority', tag: ref.tag, priority }
    : { op: 'setPriority', key: ref.key, priority };
}

export function sameRef(a: ConditionRef, b: ConditionRef): boolean {
  if (a.kind === 'tag' && b.kind === 'tag') return a.tag === b.tag;
  if (a.kind === 'slot' && b.kind === 'slot') return a.key === b.key;
  return false;
}

/** 全条件を must にしたスロット（Web サイトの絞り込み検索の再現。評価のベースラインに使う） */
export function asAllMust(slots: Slots): Slots {
  const next = cloneSlots(slots);
  for (const key of SCALAR_SLOT_KEYS) {
    const slot = next[key];
    if (slot) slot.priority = 'must';
  }
  for (const tag of next.tags) tag.priority = 'must';
  return next;
}
