/**
 * 候補が少ないときの緩和提案（純関数。DESIGN.md 2.1「緩和提案」・4.2）。
 * 1. must を1つずつ want に下げて件数を試算し、最も増える1つを提案する（エリア・予算・徒歩は対象外）
 * 2. どれも増えなければ従来型: 予算＋5,000円 → 徒歩＋5分 → 隣の駅を含める、の順で最初に増えるもの
 */
import { formatManYen } from './labels';
import { FALLBACK_RELAX_RENT_YEN, FALLBACK_RELAX_WALK_MIN } from './rules';
import { countMatches } from './search';
import { applySlotOps, listConditions, priorityOp } from './slots';
import { adjacentStations } from './stations';
import type { Property, RelaxationSuggestion, SlotOp, Slots } from './types';

/**
 * 下げる候補にしない条件。エリア外・予算超え・駅から遠い物件まで「できれば」で混ぜると提案として不自然なので、
 * 幅を少し広げる従来型の緩和に回す
 */
const NOT_DOWNGRADABLE = new Set(['area', 'rentMax', 'walkMax']);

export function suggestRelaxation(properties: readonly Property[], slots: Slots): RelaxationSuggestion | null {
  const current = countMatches(properties, slots);

  let best: RelaxationSuggestion | null = null;
  for (const c of listConditions(slots)) {
    if (c.priority !== 'must') continue;
    if (c.ref.kind === 'slot' && NOT_DOWNGRADABLE.has(c.ref.key)) continue;
    const ops = [priorityOp(c.ref, 'want')];
    const totalAfter = countMatches(properties, applySlotOps(slots, ops));
    const gained = totalAfter - current;
    // 同数なら条件の並び順で先のものを残す（決定的）
    if (gained > 0 && (!best || gained > best.gained)) {
      best = { kind: 'downgrade', ref: c.ref, label: `${c.label}を「できれば」にする`, ops, gained, totalAfter };
    }
  }
  if (best) return best;

  for (const candidate of widenCandidates(slots)) {
    const totalAfter = countMatches(properties, applySlotOps(slots, candidate.ops));
    const gained = totalAfter - current;
    if (gained > 0) return { kind: 'widen', ...candidate, gained, totalAfter };
  }
  return null;
}

type WidenCandidate = Pick<RelaxationSuggestion, 'ref' | 'label' | 'ops'>;

/** 従来型の緩和の候補（must の条件だけ。want なら絞り込みに効いていないので広げても増えない） */
function widenCandidates(slots: Slots): WidenCandidate[] {
  const result: WidenCandidate[] = [];
  const { rentMax, walkMax, area } = slots;

  if (rentMax?.priority === 'must') {
    const value = rentMax.value + FALLBACK_RELAX_RENT_YEN;
    result.push({
      ref: { kind: 'slot', key: 'rentMax' },
      label: `予算を${formatManYen(value)}円まで広げる`,
      ops: [{ op: 'set', key: 'rentMax', value }],
    });
  }
  if (walkMax?.priority === 'must') {
    const value = walkMax.value + FALLBACK_RELAX_WALK_MIN;
    result.push({
      ref: { kind: 'slot', key: 'walkMax' },
      label: `徒歩${value}分まで広げる`,
      ops: [{ op: 'set', key: 'walkMax', value }],
    });
  }
  if (area?.priority === 'must' && area.value.stations.length > 0) {
    const added: string[] = [];
    for (const s of area.value.stations) {
      for (const n of adjacentStations(s)) {
        if (!area.value.stations.includes(n) && !added.includes(n)) added.push(n);
      }
    }
    if (added.length > 0) {
      const op: SlotOp = {
        op: 'set',
        key: 'area',
        value: { stations: [...area.value.stations, ...added], wards: area.value.wards },
      };
      result.push({
        ref: { kind: 'slot', key: 'area' },
        label: `隣の駅（${added.join('・')}）も含める`,
        ops: [op],
      });
    }
  }
  return result;
}
